import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR, type Viewer } from "../src/auth/tenancy.js";
import { newCanary, scanScope, unclassifiedColumns, unscopedTables } from "../src/assurance/privacy-check.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The privacy page, through the real web view: a customer puts a phrase
 * through its agent, presses the button, and is told whether anything stored
 * for its account holds it. The answer is about its own data only.
 */

const NOW = "2026-10-22T12:00:00.000Z";
const ACME: Viewer = { kind: "organization", organizationId: "acme" };
const GLOBEX: Viewer = { kind: "organization", organizationId: "globex" };
const ADMIN = { actor: "cli test", ts: NOW };

let directory: string;
let databasePath: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let sessions: UiSessions;
let app: FastifyInstance;
let clock = Date.parse(NOW);

const ev = (systemId: string, name: string, extra: Partial<ChainEvent> = {}): ChainEvent => ({
  system_id: systemId,
  ts_event: NOW,
  ts_received: NOW,
  actor: { agent: "screener" },
  action: { kind: "tool_call", name },
  input_hash: null,
  output_hash: null,
  outcome: "ok",
  source: { type: "sdk" },
  artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256: "d".repeat(64) }],
  ...extra,
});

beforeEach(async () => {
  clock = Date.parse(NOW);
  directory = mkdtempSync(join(tmpdir(), "sigillo-privacy-page-"));
  databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme", ADMIN, { approved: true });
  await store.createOrganization("globex", "Globex", ADMIN, { approved: true });
  await store.createSystem("acme.bot", NOW, "acme");
  await store.createSystem("globex.bot", NOW, "globex");
  await store.createSystem("operator-bot", NOW);
  keys = ApiKeyStore.open(databasePath);
  const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000);
  sessions = new UiSessions();
  app = buildServer({
    store,
    keys,
    now: () => new Date(clock),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer: new Checkpointer({ store, now: () => new Date(clock) }),
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

const cookieFor = (viewer: Viewer): string => `sigillo_session=${sessions.issue(viewer, clock).value}`;
const get = (viewer: Viewer, url: string) => app.inject({ method: "GET", url, headers: { cookie: cookieFor(viewer) } });
const check = (viewer: Viewer, phrase: string) =>
  app.inject({
    method: "POST",
    url: "/ui/privacy/check",
    headers: { cookie: cookieFor(viewer), "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ phrase }).toString(),
  });

describe("the privacy page", () => {
  it("is in the menu, offers a fresh phrase each time, and needs a sign-in", async () => {
    const first = await get(ACME, "/ui/privacy");
    const second = await get(ACME, "/ui/privacy");
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain('href="/ui/privacy"');
    const phrase = (body: string): string => /name="phrase" value="([^"]+)"/.exec(body)?.[1] ?? "";
    expect(phrase(first.body)).toMatch(/^sigillo-check-[0-9a-f]{24}$/);
    expect(phrase(first.body)).not.toBe(phrase(second.body));
    expect((await app.inject({ method: "GET", url: "/ui/privacy" })).statusCode).not.toBe(200);
    expect((await app.inject({ method: "POST", url: "/ui/privacy/check", payload: "phrase=sigillo-check-aaaaaaaaaaaa" })).statusCode).not.toBe(200);
  });

  it("does not find content an agent sent, however it reached sigillo", async () => {
    const phrase = newCanary();
    await store.append(ev("acme.bot", "lookup", { raw_input: { value: `Customer file ${phrase}` }, raw_output: { value: phrase } } as Partial<ChainEvent>));
    const answer = await check(ACME, phrase);
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toContain("Not found.");
    store.close();
    expect(readFileSync(databasePath).includes(Buffer.from(phrase))).toBe(false);
    store = ReceiptStore.open(databasePath, signer);
  });

  it("finds a phrase that sits in a name the agent sent, and says so in words", async () => {
    const phrase = newCanary();
    await store.append(ev("acme.bot", `reply to ${phrase}`));
    const answer = await check(ACME, phrase);
    expect(answer.body).toContain("Found.");
    expect(answer.body).toContain("your recorded actions");
    expect(answer.body).toContain("use neutral names");
    expect(answer.body).not.toContain("Not found.");
  });

  it("finds a person's id where it is kept, for the account whose agent sent it", async () => {
    const phrase = newCanary();
    await store.append(ev("acme.bot", "lookup", { actor: { agent: "screener", on_behalf_of: phrase } }));
    const own = await check(ACME, phrase);
    expect(own.body).toContain("the people your agents acted for");
    clock += 10_000;
    expect((await check(GLOBEX, phrase)).body).toContain("Not found.");
  });

  it("answers about one's own data only: another account's phrase is not found, and not mentioned", async () => {
    const phrase = newCanary();
    await store.append(ev("globex.bot", `reply to ${phrase}`));
    await store.append(ev("operator-bot", `note ${phrase}`));
    for (const viewer of [ACME, OPERATOR]) {
      clock += 10_000;
      const answer = await check(viewer, phrase);
      if (viewer.kind === "operator") expect(answer.body).toContain("Found.");
      else {
        expect(answer.body).toContain("Not found.");
        expect(answer.body).not.toContain("globex");
        expect(answer.body).not.toContain("operator");
      }
    }
    clock += 10_000;
    const globex = await check(GLOBEX, phrase);
    expect(globex.body).toContain("Found.");
    expect(globex.body).toContain("1 entry");
    // The operator's own search has not reached the customer's rows either.
    clock += 10_000;
    const operator = await check(OPERATOR, phrase);
    expect(operator.body).toContain("1 entry");
  });

  it("refuses a phrase too short or too long, and a second check within seconds", async () => {
    expect((await check(ACME, "short")).statusCode).toBe(400);
    expect((await check(ACME, "x".repeat(201))).statusCode).toBe(400);
    expect((await check(ACME, "sigillo-check-with\u0000control")).statusCode).toBe(400);
    expect((await check(ACME, "a phrase long enough")).statusCode).toBe(200);
    const again = await check(ACME, "a phrase long enough");
    expect(again.statusCode).toBe(429);
    expect(again.body).toContain("Wait a few seconds");
    expect((await check(GLOBEX, "a phrase long enough")).statusCode).toBe(200);
    clock += 4_000;
    expect((await check(ACME, "a phrase long enough")).statusCode).toBe(200);
  });

  it("escapes the phrase it shows back", async () => {
    const answer = await check(ACME, `<script>alert("${newCanary()}")</script>`);
    expect(answer.body).not.toContain("<script>alert(");
    expect(answer.body).toContain("&lt;script&gt;");
  });
});

describe("what the search covers", () => {
  it("knows every table of the schema: none is left out without a decision", () => {
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(unscopedTables(db)).toEqual([]);
      expect(unclassifiedColumns(db)).toEqual([]);
      expect(scanScope(db, "nothing here at all", { systemIds: ["acme.bot"], organizationId: "acme" })).toEqual([]);
    } finally {
      db.close();
    }
  });
});
