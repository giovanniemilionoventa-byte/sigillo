import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROGRAM_ARTIFACT_LABEL } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR, type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ConnectionWatch } from "../src/connection/watch.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { EVIDENCE_CHECK_SOURCE } from "../src/http/evidence-check.js";
import { REVIEW_SCRIPT, REVIEW_SHARED } from "../src/http/review.js";
import { buildServer } from "../src/http/server.js";
import { REVIEW_TTL_MS, ReceiptStore, transferHash } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The auditor's link: made from the export form for one system and one
 * period, shown once and kept only as a hash, written on the system's chain,
 * opened without an account on a page that says whose evidence it is, with
 * the pack to check here or to download; and it stops working when taken
 * back or after REVIEW_TTL_MS.
 */

type CheckResult =
  | {
      ok: true;
      summary: { system_id: string; receipts: number };
      detail: { receipts: { seq: number; name: string; artifacts: { label: string; sha256: string }[] }[] };
    }
  | { ok: false; check: string };
const checkPack = new Function(`${EVIDENCE_CHECK_SOURCE}\nreturn sigilloCheckPack;`)() as (bytes: Uint8Array) => Promise<CheckResult>;

const PASSWORD = "an administrator password";
const START = Date.parse("2026-11-03T12:00:00.000Z");
const ACME_BOT = "acme-rimborsi";
const OPERATOR_BOT = "operator-bot";
const ACME: Viewer = { kind: "organization", organizationId: "acme" };
const GLOBEX: Viewer = { kind: "organization", organizationId: "globex" };
const ADMIN = { actor: "cli test", ts: "2026-11-01T09:00:00.000Z" };
const PROGRAM = "7a3f".repeat(16);

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let sessions: UiSessions;
let app: FastifyInstance;
let nowMs: number;

beforeEach(async () => {
  nowMs = START;
  directory = mkdtempSync(join(tmpdir(), "sigillo-review-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner({ now: () => new Date(nowMs) });
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createOrganization("globex", "Globex S.r.l.", ADMIN, { approved: true });
  await store.createSystem(ACME_BOT, "2026-11-01T09:00:00.000Z", "acme");
  await store.createSystem(OPERATOR_BOT, "2026-11-01T09:00:00.000Z");
  // The agent connects with its program, on the 3rd of November.
  const watch = new ConnectionWatch({ store, now: () => new Date(nowMs) });
  await watch.heartbeat(ACME_BOT, "a".repeat(32), "start", { hash: PROGRAM }, { program: PROGRAM });
  keys = ApiKeyStore.open(databasePath);
  sessions = new UiSessions();
  const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
  healthMonitor.check();
  app = buildServer({
    store,
    keys,
    now: () => new Date(nowMs),
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer: new Checkpointer({ store, now: () => new Date(nowMs) }),
      sessions,
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const cookieFor = (viewer: Viewer): string => `sigillo_session=${sessions.issue(viewer, nowMs).value}`;
const post = (viewer: Viewer, url: string, form: Record<string, string>) =>
  app.inject({
    method: "POST",
    url,
    headers: { cookie: cookieFor(viewer), "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(form).toString(),
  });
const get = (url: string) => app.inject({ method: "GET", url });

async function makeLink(viewer: Viewer, form: Record<string, string>): Promise<string> {
  const response = await post(viewer, "/ui/review-links", form);
  expect(response.statusCode).toBe(200);
  const found = /\/revisione\/([A-Za-z0-9_-]{43})/.exec(response.body);
  if (found?.[1] === undefined) throw new Error("no link in the page");
  return found[1];
}

describe("the auditor's link", () => {
  it("is made from the export form, shown once, stored only as a hash, and written on the system's chain", async () => {
    const secret = await makeLink(ACME, { system_id: ACME_BOT, from: "2026-11-01", to: "2026-11-10" });
    const row = (store as unknown as { read: { prepare: (sql: string) => { all: () => Record<string, unknown>[] } } }).read
      .prepare("SELECT * FROM review_links")
      .all();
    expect(row).toHaveLength(1);
    expect(row[0]!["token_hash"]).toBe(transferHash(secret));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(store.readChain(ACME_BOT).at(-1)?.action.name).toBe(REVIEW_SHARED);
  });

  it("opens without an account, on a page that names the company and the agent, with Verifica qui and Scarica", async () => {
    const secret = await makeLink(ACME, { system_id: ACME_BOT, from: "2026-11-01", to: "2026-11-10" });
    const page = await get(`/revisione/${secret}`);
    expect(page.statusCode).toBe(200);
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.body).toContain("Acme S.p.A.");
    expect(page.body).toContain(ACME_BOT);
    expect(page.body).toContain('id="verify"');
    expect(page.body).toContain(`/revisione/${secret}/pacchetto.zip`);
    expect(page.body).toContain('<script src="/review.js" defer></script>');
    // No inline script: the CSP allows script files from this origin only.
    expect(page.body).not.toMatch(/<script>(?!\s*<\/script>)/);
  });

  it("downloads a pack that the browser check finds intact, carrying the agent's program", async () => {
    const secret = await makeLink(ACME, { system_id: ACME_BOT });
    const pack = await get(`/revisione/${secret}/pacchetto.zip`);
    expect(pack.statusCode).toBe(200);
    expect(pack.headers["content-type"]).toBe("application/zip");
    const result = await checkPack(new Uint8Array(pack.rawPayload));
    if (!result.ok) throw new Error(`the pack does not verify: ${result.check}`);
    expect(result.summary.system_id).toBe(ACME_BOT);
    const programs = result.detail.receipts.flatMap((receipt) =>
      receipt.artifacts.filter((artifact) => artifact.label === PROGRAM_ARTIFACT_LABEL).map((artifact) => artifact.sha256),
    );
    expect(programs).toEqual([PROGRAM]);
  });

  it("is only for one's own systems", async () => {
    const response = await post(GLOBEX, "/ui/review-links", { system_id: ACME_BOT });
    expect(response.statusCode).toBe(404);
    expect(store.readChain(ACME_BOT).at(-1)?.action.name).not.toBe(REVIEW_SHARED);
    // The operator's own system: the page says so instead of an account name.
    const secret = await makeLink(OPERATOR, { system_id: OPERATOR_BOT });
    expect((await get(`/revisione/${secret}`)).body).toContain("Operator of this Sigillo installation");
    // In the reader's language.
    const italian = await app.inject({ method: "GET", url: `/revisione/${secret}`, headers: { "accept-language": "it-IT,it" } });
    expect(italian.body).toContain("Gestore di questa installazione");
    expect(italian.body).toContain("Verifica qui");
  });

  it("stops working when taken back, and after it expires", async () => {
    const first = await makeLink(ACME, { system_id: ACME_BOT });
    const second = await makeLink(ACME, { system_id: ACME_BOT });
    const id = (store.reviewLinks(ACME_BOT, new Date(nowMs).toISOString()).at(-1) as { id: number }).id;
    const revoked = await post(ACME, `/ui/review-links/${id}/revoke`, { system_id: ACME_BOT });
    expect(revoked.statusCode).toBe(200);
    expect((await get(`/revisione/${first}`)).statusCode).toBe(404);
    expect((await get(`/revisione/${first}/pacchetto.zip`)).statusCode).toBe(404);
    expect((await get(`/revisione/${second}`)).statusCode).toBe(200);
    // Another account cannot take it back.
    const otherId = (store.reviewLinks(ACME_BOT, new Date(nowMs).toISOString())[0] as { id: number }).id;
    await post(GLOBEX, `/ui/review-links/${otherId}/revoke`, { system_id: ACME_BOT });
    expect((await get(`/revisione/${second}`)).statusCode).toBe(200);
    nowMs += REVIEW_TTL_MS + 1;
    expect((await get(`/revisione/${second}`)).statusCode).toBe(404);
    expect((await get("/revisione/not-a-real-link")).statusCode).toBe(404);
  });

  it("serves the page's script with the browser check in it", async () => {
    const script = await get("/review.js");
    expect(script.statusCode).toBe(200);
    expect(script.body).toBe(REVIEW_SCRIPT);
    expect(script.body).toContain("async function sigilloCheckPack");
    // The script parses.
    expect(() => new Function(REVIEW_SCRIPT)).not.toThrow();
  });
});
