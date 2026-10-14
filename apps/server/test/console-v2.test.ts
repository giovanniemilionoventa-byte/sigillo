import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readZip } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import type { Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { THEME_V2 } from "../src/http/style-v2.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * The redesigned console (SIGILLO_CONSOLE_V2): off for everyone, for the
 * operator's own account, or for every account. CLAUDE.md rule 11: until the
 * owner opens it, an organization sees the console as it was, and the new
 * pages do not exist for it.
 */

const NOW = "2026-10-13T12:00:00.000Z";
const ADMIN = { actor: "test", ts: NOW };
const ORGANIZATION: Viewer = { kind: "organization", organizationId: "acme" };
const OPERATOR: Viewer = { kind: "operator" };

let directory: string;
let store: ReceiptStore;
let keys: ApiKeyStore;
let sessions: UiSessions;
let app: FastifyInstance;

function event(index: number, overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    system_id: "bot",
    ts_event: NOW,
    ts_received: `2026-10-13T11:0${index}:00.000Z`,
    actor: { agent: "screener" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
    ...overrides,
  };
}

async function start(consoleV2: "off" | "operator" | "all" | undefined): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), "sigillo-v2-"));
  const databasePath = join(directory, "sigillo.db");
  const signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createSystem("bot", "2026-10-13T10:00:00.000Z");
  await store.createSystem("acme.bot", "2026-10-13T10:00:00.000Z", "acme");
  await store.append(event(1));
  await store.append(event(2, { outcome: "blocked", action: { kind: "tool_call", name: "refund" } }));
  await store.append(event(3, { system_id: "acme.bot" }));
  keys = ApiKeyStore.open(databasePath);
  const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
  healthMonitor.check();
  sessions = new UiSessions();
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
      sessions,
      ...(consoleV2 === undefined ? {} : { consoleV2 }),
    },
  });
  await app.ready();
}

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const get = (viewer: Viewer, url: string, language = "it") =>
  app.inject({
    method: "GET",
    url,
    headers: { cookie: `sigillo_session=${sessions.issue(viewer, new Date(NOW).getTime()).value}; sigillo_lang=${language}` },
  });

describe("the redesigned console is the operator's first (CLAUDE.md rule 11)", () => {
  beforeEach(() => undefined);

  it("is not served when the switch is off or not given", async () => {
    for (const setting of [undefined, "off"] as const) {
      await start(setting);
      expect((await get(OPERATOR, "/ui/actions")).statusCode).toBe(404);
      expect((await get(OPERATOR, "/ui/evidence")).statusCode).toBe(404);
      expect((await get(OPERATOR, "/ui")).body).not.toContain("È tutto a posto?");
      await app.close();
      keys.close();
      store.close();
    }
    await start(undefined);
  });

  it("gives the operator three places and gives an organization the console as it was", async () => {
    await start("operator");
    const operator = await get(OPERATOR, "/ui");
    expect(operator.statusCode).toBe(200);
    expect(operator.body).toContain("<h1>È tutto a posto?</h1>");
    expect(operator.body).toContain('href="/ui/actions"');
    expect(operator.body).toContain('href="/ui/evidence"');
    expect((await get(OPERATOR, "/ui/actions")).statusCode).toBe(200);
    expect((await get(OPERATOR, "/ui/evidence")).statusCode).toBe(200);

    const organization = await get(ORGANIZATION, "/ui");
    expect(organization.statusCode).toBe(200);
    expect(organization.body).not.toContain("È tutto a posto?");
    expect(organization.body).toContain('href="/ui/sistemi"');
    expect((await get(ORGANIZATION, "/ui/actions")).statusCode).toBe(404);
    expect((await get(ORGANIZATION, "/ui/evidence")).statusCode).toBe(404);
  });

  it("opens to organizations with all, and each sees only its own systems", async () => {
    await start("all");
    const actions = await get(ORGANIZATION, "/ui/actions?period=all");
    expect(actions.statusCode).toBe(200);
    expect(actions.body).toContain("call-3");
    expect(actions.body).not.toContain("refund");
    expect((await get(ORGANIZATION, "/ui/actions?system=bot")).statusCode).toBe(404);
  });
});

describe("Stato, Azioni and Prove", () => {
  it("answers the question first, in the text colour, and says «Nuovo» for a register with no action", async () => {
    await start("operator");
    await store.createSystem("fresh", "2026-10-13T10:30:00.000Z");
    const body = (await get(OPERATOR, "/ui")).body;
    // The answer is the first line under the question; with no seal yet the register is «da controllare», said with its reason.
    expect(body).toMatch(/<h1>È tutto a posto\?<\/h1><p class="answer (green|yellow)"/);
    expect(body).toContain("Mai collegato");
    expect(body).toContain(">Nuovo<");
  });

  it("filters the actions by outcome and keeps the opening of the register out of them", async () => {
    await start("operator");
    const all = (await get(OPERATOR, "/ui/actions?period=all&system=bot")).body;
    expect(all).toContain("call-1");
    expect(all).not.toContain("Registro aperto");
    const problems = (await get(OPERATOR, "/ui/actions?period=all&system=bot&outcome=problems")).body;
    expect(problems).toContain("refund");
    expect(problems).not.toContain("call-1");
    expect(problems).toContain('data-outcome="blocked"');
  });

  it("offers one form for the evidence pack, with what it does not prove and the key code in groups of four", async () => {
    await start("operator");
    const body = (await get(OPERATOR, "/ui/evidence?system=bot")).body;
    expect(body).toContain('action="/ui/export"');
    expect(body).toContain("Non provato");
    expect(body).toMatch(/[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}/);
  });

  it("works in English with the same structure", async () => {
    await start("operator");
    const body = (await get(OPERATOR, "/ui", "en")).body;
    expect(body).toContain("<h1>Is everything all right?</h1>");
  });

  it("uses the new palette, and no state is told by colour alone", async () => {
    await start("operator");
    const body = (await get(OPERATOR, "/ui")).body;
    expect(body).toContain("--action: #2846a8");
    expect(THEME_V2).toContain("--ok: #6ccb88");
    // Every sign in the sidebar carries a word for a screen reader.
    expect(body).toMatch(/<span class="sign (green|yellow|red|neutral)">[\s\S]*?<span class="sr">/);
  });
});

describe("design/tokens-v2.json", () => {
  it("is the palette of the stylesheet, one token for one", async () => {
    const { readFileSync } = await import("node:fs");
    const tokens = JSON.parse(readFileSync(new URL("../../../design/tokens-v2.json", import.meta.url), "utf8")) as {
      color: { light: Record<string, string>; dark: Record<string, string> };
    };
    for (const [name, value] of Object.entries(tokens.color.light)) expect(THEME_V2).toContain(`--${name}: ${value}`);
    for (const [name, value] of Object.entries(tokens.color.dark)) expect(THEME_V2).toContain(`--${name}: ${value}`);
    expect(Object.keys(tokens.color.light).sort()).toEqual(Object.keys(tokens.color.dark).sort());
  });
});

/** The rest of the redesign, each feature behind its own switch. */
const ALL = { runs: "operator", extraKeys: "operator", exportRegister: "operator", reportLanguage: "operator", packReader: "operator", siteV2: "operator" } as const;
const TRACE = "a".repeat(32);

async function startFull(features: Record<string, string> = ALL): Promise<void> {
  directory = mkdtempSync(join(tmpdir(), "sigillo-v2f-"));
  const databasePath = join(directory, "sigillo.db");
  const signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createSystem("bot", "2026-10-13T10:00:00.000Z");
  await store.createSystem("acme.bot", "2026-10-13T10:00:00.000Z", "acme");
  // One run of three actions, with another run's action in the middle of its window.
  for (const [index, trace] of [[1, TRACE], [2, "b".repeat(32)], [3, TRACE], [4, TRACE]] as const) {
    await store.append(
      event(index, {
        source: { type: "otlp", trace_id: trace, span_id: `${index}`.repeat(16) },
        ...(index === 1 ? { artifacts: [{ role: "input" as const, label: "curriculum", media_type: "text/plain", sha256: "c".repeat(64) }] } : {}),
      }),
    );
  }
  await store.append(event(5, { system_id: "acme.bot", source: { type: "otlp", trace_id: TRACE, span_id: "9".repeat(16) } }));
  keys = ApiKeyStore.open(databasePath);
  const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
  healthMonitor.check();
  sessions = new UiSessions();
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
      sessions,
      consoleV2: "operator",
      features: features as never,
    },
  });
  await app.ready();
}

const postForm = (viewer: Viewer, url: string, form: Record<string, string>, language = "it") =>
  app.inject({
    method: "POST",
    url,
    headers: {
      cookie: `sigillo_session=${sessions.issue(viewer, new Date(NOW).getTime()).value}; sigillo_lang=${language}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams(form).toString(),
  });

describe("runs (SIGILLO_RUNS)", () => {
  it("groups the actions of a run under one header, and opens the run as a list of its own", async () => {
    await startFull();
    const list = (await get(OPERATOR, "/ui/actions?period=all&system=bot")).body;
    expect(list).toContain("Esecuzione delle");
    expect(list).toContain(`run=${TRACE}`);
    const run = await get(OPERATOR, `/ui/actions?system=bot&run=${TRACE}`);
    expect(run.statusCode).toBe(200);
    expect(run.body).toContain("call-1");
    expect(run.body).toContain("call-3");
    expect(run.body).not.toContain("call-2");
    expect(run.body).toContain("Prepara il fascicolo di questa esecuzione");
  });

  it("says in the preview which actions of other runs fall inside the window, and is off for an organization", async () => {
    await startFull();
    const preview = (await get(OPERATOR, `/ui/evidence?system=bot&run=${TRACE}`)).body;
    expect(preview).toContain("altre esecuzioni avvenute in mezzo");
    expect(preview).toContain('name="run"');
    await app.close();
    keys.close();
    store.close();
    await startFull({ ...ALL, runs: "off" });
    expect((await get(OPERATOR, `/ui/actions?period=all&system=bot&run=${TRACE}`)).body).not.toContain("Esecuzione delle");
  });

  it("builds the pack of one run from its first to its last action, with an Italian cover, and registers it", async () => {
    await startFull();
    const response = await postForm(OPERATOR, "/ui/export", { system_id: "bot", run: TRACE, reveal: "nothing" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    const zip = Buffer.from(response.rawPayload);
    // The window runs from the run's first to its last action: three of its own, one of another run between them.
    const files = new Map(readZip(new Uint8Array(zip)).map((entry) => [entry.name, entry.data]));
    const lines = new TextDecoder().decode(files.get("receipts.jsonl")).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(new TextDecoder().decode(files.get("VERIFY.md"))).toContain("Come controllare questo fascicolo (in italiano)");
    expect(files.has("report.pdf")).toBe(true);
    expect(files.has("openings.jsonl")).toBe(false);
    const register = (await get(OPERATOR, "/ui/evidence?system=bot")).body;
    expect(register).toContain("Consegnati");
    expect(register).toContain("esecuzione");
    expect(store.listExports("bot")).toHaveLength(1);
    expect(store.listExports("bot")[0]?.zipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.listExports("bot")[0]?.trace).toBe(TRACE);
  });

  it("does not register a pack, or add the Italian cover, when those switches are off", async () => {
    await startFull({ ...ALL, exportRegister: "off", reportLanguage: "off" });
    await postForm(OPERATOR, "/ui/export", { system_id: "bot" });
    expect(store.listExports("bot")).toHaveLength(0);
  });
});

describe("keys (SIGILLO_EXTRA_KEYS)", () => {
  it("adds a key without retiring the others, retires one, and never the last", async () => {
    await startFull();
    const first = keys.issue("bot", NOW);
    const added = await postForm(OPERATOR, "/ui/systems/bot/key", { mode: "add" });
    expect(added.statusCode).toBe(200);
    expect(added.body).toContain("Chiave visibile solo ora");
    const active = keys.list("bot").filter((key) => key.revokedAt === null);
    expect(active).toHaveLength(2);
    expect(active.map((key) => key.keyId)).toContain(first.keyId);
    const retired = await postForm(OPERATOR, "/ui/systems/bot/key/retire", { key_id: first.keyId });
    expect(retired.statusCode).toBe(303);
    expect(keys.list("bot").filter((key) => key.revokedAt === null)).toHaveLength(1);
    const lastOne = keys.list("bot").find((key) => key.revokedAt === null);
    const refused = await postForm(OPERATOR, "/ui/systems/bot/key/retire", { key_id: lastOne?.keyId ?? "" });
    expect(refused.headers["location"]).toContain("fatto=ultima");
    expect(keys.list("bot").filter((key) => key.revokedAt === null)).toHaveLength(1);
  });

  it("keeps the old rotation, which replaces every key, when the switch is off", async () => {
    await startFull({ ...ALL, extraKeys: "off" });
    keys.issue("bot", NOW);
    await postForm(OPERATOR, "/ui/systems/bot/key", { mode: "add" });
    expect(keys.list("bot").filter((key) => key.revokedAt === null)).toHaveLength(1);
    expect((await postForm(OPERATOR, "/ui/systems/bot/key/retire", { key_id: "x" })).statusCode).toBe(404);
  });
});

describe("Amministrazione, Account and the pack reader", () => {
  it("shows the service to the operator alone", async () => {
    await startFull();
    const service = await get(OPERATOR, "/ui/admin/service");
    expect(service.statusCode).toBe(200);
    expect(service.body).toContain("Firmatario");
    expect(service.body).toContain("SIGILLO_RUNS");
    expect((await get(ORGANIZATION, "/ui/admin/service")).statusCode).toBe(404);
  });

  it("opens the account from the avatar, with the theme and language", async () => {
    await startFull();
    const account = await get(OPERATOR, "/ui/account");
    expect(account.statusCode).toBe(200);
    expect(account.body).toContain('action="/ui/impostazioni/tema"');
    expect((await get(OPERATOR, "/ui")).body).toContain('href="/ui/account"');
  });

  it("serves the pack reader only where its switch allows, with a script from this origin", async () => {
    await startFull();
    const page = await get(OPERATOR, "/ui/verify");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<script src="/ui/pack-reader.js" defer></script>');
    expect(page.body).not.toMatch(/<script>/);
    const script = await get(OPERATOR, "/ui/pack-reader.js");
    expect(script.body).toContain("sigilloCheckPack");
    await app.close();
    keys.close();
    store.close();
    await startFull({ ...ALL, packReader: "off" });
    expect((await get(OPERATOR, "/ui/verify")).statusCode).toBe(404);
  });

  it("shows the seals a day a line, and the changes", async () => {
    await startFull();
    expect((await get(OPERATOR, "/ui/evidence/seals")).statusCode).toBe(200);
    expect((await get(OPERATOR, "/ui/evidence/changes")).statusCode).toBe(200);
  });
});

describe("the redesigned public home (SIGILLO_SITE_V2)", () => {
  it("is previewed for the operator alone, in both languages, with the same marks as the console", async () => {
    await startFull();
    const page = await get(OPERATOR, "/ui/admin/site");
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Cosa ha fatto la tua AI?");
    expect(page.body).toContain("--action: #2846a8");
    expect(page.body).not.toContain("#1a73e8");
    expect(page.body).not.toContain("Pronto per l'AI Act");
    expect(page.body).toMatch(/<script src="\/site\.js" defer><\/script>/);
    expect(page.body).not.toMatch(/<script>/);
    expect((await get(OPERATOR, "/ui/admin/site", "en")).body).toContain("What did your AI do?");
    expect((await get(ORGANIZATION, "/ui/admin/site")).statusCode).toBe(404);
  });

  it("is not served when its switch is off", async () => {
    await startFull({ ...ALL, siteV2: "off" });
    expect((await get(OPERATOR, "/ui/admin/site")).statusCode).toBe(404);
  });
});
