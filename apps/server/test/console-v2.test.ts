import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
