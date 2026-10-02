import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readZip } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { NotVisibleError, OPERATOR, storeFor, type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Two customers on one hosted installation, and the operator's own system
 * beside them. Whatever one organization does in the web view, it sees and
 * touches its own systems and nothing else: not the other organization's,
 * not the operator's, and not even whether they exist.
 */

const PASSWORD = "an administrator password";
const NOW = "2026-03-29T16:00:00.000Z";
const ONE_DAY_MS = 24 * 60 * 60_000;
const ADMIN = { actor: "cli test", ts: "2026-03-29T13:00:00.000Z" };

const ACME: Viewer = { kind: "organization", organizationId: "acme" };
const GLOBEX: Viewer = { kind: "organization", organizationId: "globex" };
const ACME_BOT = "acme.cv-bot";
const GLOBEX_BOT = "globex.cv-bot";
const OPERATOR_BOT = "operator-bot";
/** One document, read by an agent of each organization. */
const SHARED_DOCUMENT = "d".repeat(64);
/** One person, on whose behalf an agent of each organization acted. */
const SHARED_PERSON = "mario.rossi@example.com";

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let sessions: UiSessions;
let app: FastifyInstance;

function event(systemId: string, index: number, overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    system_id: systemId,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: `2026-03-29T14:3${index % 10}:01.005Z`,
    actor: { agent: "screener", on_behalf_of: SHARED_PERSON },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
    artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256: SHARED_DOCUMENT }],
    ...overrides,
  };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-tenancy-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createOrganization("globex", "Globex S.r.l.", ADMIN, { approved: true });
  await store.createSystem(ACME_BOT, "2026-03-29T14:00:00.000Z", "acme");
  await store.createSystem(GLOBEX_BOT, "2026-03-29T14:00:00.000Z", "globex");
  await store.createSystem(OPERATOR_BOT, "2026-03-29T14:00:00.000Z");
  for (const systemId of [ACME_BOT, GLOBEX_BOT, OPERATOR_BOT]) {
    for (let index = 1; index < 4; index += 1) await store.append(event(systemId, index));
  }
  keys = ApiKeyStore.open(databasePath);
  const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
  healthMonitor.check();
  const checkpointer = new Checkpointer({ store, now: () => new Date(NOW) });
  await checkpointer.runOnce();
  sessions = new UiSessions();
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer,
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

/** A session cookie for `viewer`, as an identity login would issue it. */
function cookieFor(viewer: Viewer): string {
  return `sigillo_session=${sessions.issue(viewer, new Date(NOW).getTime()).value}`;
}

async function get(viewer: Viewer, url: string) {
  return app.inject({ method: "GET", url, headers: { cookie: cookieFor(viewer) } });
}

async function post(viewer: Viewer, url: string, form: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers: { cookie: cookieFor(viewer), "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(form).toString(),
  });
}

describe("the store as an organization sees it", () => {
  it("lists its own systems and nobody else's", () => {
    const acme = storeFor(store, ACME);
    expect(acme.listSystemRecords().map((record) => record.system_id)).toEqual([ACME_BOT]);
    expect(acme.listSystems()).toEqual([ACME_BOT]);
    expect(storeFor(store, GLOBEX).listSystems()).toEqual([GLOBEX_BOT]);
  });

  it("answers for another's system as if it did not exist", () => {
    const acme = storeFor(store, ACME);
    for (const other of [GLOBEX_BOT, OPERATOR_BOT, "no-such-system"]) {
      expect(acme.systemRecord(other)).toBeNull();
      expect(acme.hasSystem(other)).toBe(false);
    }
    expect(acme.systemRecord(ACME_BOT)?.organization_id).toBe("acme");
  });

  it("refuses to read another's chain, by any method", () => {
    const acme = storeFor(store, ACME);
    const attempts: (() => unknown)[] = [
      () => acme.readChain(GLOBEX_BOT),
      () => acme.readChainFrom(GLOBEX_BOT, 0),
      () => acme.readChainInRange(GLOBEX_BOT),
      () => acme.readReceiptHashes(GLOBEX_BOT),
      () => acme.readCheckpoints(GLOBEX_BOT),
      () => acme.latestCheckpoint(GLOBEX_BOT),
      () => acme.receiptAt(OPERATOR_BOT, 1),
      () => acme.tip(GLOBEX_BOT),
      () => acme.openingsOf(GLOBEX_BOT, [1]),
      () => acme.subjectIdentifierIn(GLOBEX_BOT, "x"),
      () => acme.searchReceipts({ systemId: GLOBEX_BOT }),
      () => acme.countReceiptsByKind({ systemId: OPERATOR_BOT }),
    ];
    for (const attempt of attempts) expect(attempt).toThrow(NotVisibleError);
    expect(acme.readChain(ACME_BOT)).toHaveLength(4);
  });

  it("refuses another's checkpoint tokens by checkpoint number", () => {
    const theirs = store.latestCheckpoint(GLOBEX_BOT);
    const ours = store.latestCheckpoint(ACME_BOT);
    expect(theirs).not.toBeNull();
    expect(ours).not.toBeNull();
    const acme = storeFor(store, ACME);
    expect(() => acme.readTimestamps(theirs?.id ?? -1)).toThrow(NotVisibleError);
    expect(() => acme.readTimestamps(999_999)).toThrow(NotVisibleError);
    expect(acme.readTimestamps(ours?.id ?? -1)).toEqual([]);
  });

  it("refuses to change another's system", async () => {
    const acme = storeFor(store, ACME);
    const attempt = async (work: () => Promise<unknown>) => work();
    await expect(attempt(() => acme.renameSystem(GLOBEX_BOT, "mine now", ADMIN))).rejects.toThrow(NotVisibleError);
    await expect(attempt(() => acme.archiveSystem(GLOBEX_BOT, ADMIN))).rejects.toThrow(NotVisibleError);
    await expect(attempt(() => acme.unarchiveSystem(OPERATOR_BOT, ADMIN))).rejects.toThrow(NotVisibleError);
    await expect(attempt(() => acme.deleteEmptySystem(GLOBEX_BOT, ADMIN))).rejects.toThrow(NotVisibleError);
    expect(store.systemRecord(GLOBEX_BOT)?.display_name).toBeNull();
    expect(store.systemRecord(GLOBEX_BOT)?.archived_at).toBeNull();
  });

  it("finds a document only in its own systems", () => {
    const fingerprints = { bytes: SHARED_DOCUMENT, text: null, lines: [], json: null, jsonLines: [] };
    expect(new Set(store.findDocument(fingerprints).map((match) => match.system_id))).toEqual(
      new Set([ACME_BOT, GLOBEX_BOT, OPERATOR_BOT]),
    );
    expect(new Set(storeFor(store, ACME).findDocument(fingerprints).map((match) => match.system_id))).toEqual(
      new Set([ACME_BOT]),
    );
  });

  it("reads only its own systems' administrative log, deletions included", async () => {
    await store.renameSystem(GLOBEX_BOT, "Globex screening", ADMIN);
    await store.renameSystem(ACME_BOT, "Acme screening", ADMIN);
    const acme = storeFor(store, ACME);
    await acme.createSystem("acme.empty", "2026-03-29T15:00:00.000Z");
    await acme.deleteEmptySystem("acme.empty", ADMIN);
    const log = acme.adminLog();
    expect(log.map((entry) => entry.system_id).sort()).toEqual([ACME_BOT, "acme.empty"]);
    expect(acme.deletionOf("acme.empty")).not.toBeNull();
    // Globex does not learn that acme.empty ever existed.
    expect(storeFor(store, GLOBEX).deletionOf("acme.empty")).toBeNull();
    expect(storeFor(store, GLOBEX).adminLog().map((entry) => entry.system_id)).toEqual([GLOBEX_BOT]);
  });

  it("makes every system it creates its own, from the genesis on", async () => {
    await storeFor(store, ACME).createSystem("acme.second", "2026-03-29T15:00:00.000Z");
    expect(store.systemRecord("acme.second")?.organization_id).toBe("acme");
    expect(storeFor(store, GLOBEX).hasSystem("acme.second")).toBe(false);
  });

  it("is closed by default: a method not allowed throws, and no other property is reachable", async () => {
    const acme = storeFor(store, ACME) as unknown as Record<string, unknown>;
    for (const name of ["subjectToken", "subjectIdentifier", "receiptsOnBehalfOf", "legacyReceiptsNaming", "listOrganizations", "checkpointsAwaitingTimestamp"]) {
      expect(() => (acme[name] as () => unknown)()).toThrow(NotVisibleError);
    }
    for (const name of ["eraseSubject", "assignSystem", "append", "appendBatch", "createOrganization"]) {
      expect(() => (acme[name] as () => unknown)()).toThrow(NotVisibleError);
    }
    expect(acme["read"]).toBeUndefined();
    expect(acme["write"]).toBeUndefined();
  });

  it("leaves the operator's view as it was", () => {
    expect(storeFor(store, OPERATOR)).toBe(store);
  });
});

describe("the web view, signed in as an organization", () => {
  it("shows its own systems only, on the main page and in the systems list", async () => {
    for (const url of ["/ui", "/ui/sistemi", "/ui/sistemi?vista=tutti"]) {
      const response = await get(ACME, url);
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(ACME_BOT);
      expect(response.body).not.toContain(GLOBEX_BOT);
      expect(response.body).not.toContain(OPERATOR_BOT);
    }
  });

  it("answers 404 for every page of a system that is not its own", async () => {
    for (const systemId of [GLOBEX_BOT, OPERATOR_BOT]) {
      const path = `/ui/systems/${encodeURIComponent(systemId)}`;
      for (const url of [path, `${path}?seq=1`, `${path}/checkpoints`, `${path}/manage`]) {
        const response = await get(ACME, url);
        expect(response.statusCode, url).toBe(404);
        expect(response.body).not.toContain("call-1");
      }
    }
    // Its own system's pages all work through the closed store.
    for (const url of ["", "?seq=1", "/checkpoints", "/manage"]) {
      expect((await get(ACME, `/ui/systems/${ACME_BOT}${url}`)).statusCode, url).toBe(200);
    }
    expect((await post(ACME, `/ui/systems/${ACME_BOT}/rename`, { display_name: "Acme" })).statusCode).toBe(303);
    expect(store.systemRecord(ACME_BOT)?.display_name).toBe("Acme");
  });

  it("cannot change, delete or export another's system", async () => {
    const path = `/ui/systems/${GLOBEX_BOT}`;
    expect((await post(ACME, `${path}/rename`, { display_name: "taken" })).statusCode).toBe(404);
    expect((await post(ACME, `${path}/archive`)).statusCode).toBe(404);
    expect((await post(ACME, `${path}/unarchive`)).statusCode).toBe(404);
    expect((await post(ACME, `${path}/delete`, { confirm: GLOBEX_BOT })).statusCode).toBe(404);
    expect((await post(ACME, `${path}/export`)).statusCode).toBe(404);
    expect((await post(ACME, "/ui/export", { system_id: GLOBEX_BOT })).statusCode).toBe(404);
    expect((await post(ACME, "/ui/export", { system_id: OPERATOR_BOT })).statusCode).toBe(404);
    const record = store.systemRecord(GLOBEX_BOT);
    expect(record?.display_name).toBeNull();
    expect(record?.archived_at).toBeNull();
  });

  it("exports its own system, and names only people its own chain acted for", async () => {
    await store.append(event(GLOBEX_BOT, 5, { actor: { agent: "screener", on_behalf_of: "only.globex@example.com" } }));
    const shared = store.subjectToken(SHARED_PERSON);
    const theirs = store.subjectToken("only.globex@example.com");
    expect(shared).not.toBeNull();
    expect(theirs).not.toBeNull();
    const own = await post(ACME, `/ui/systems/${ACME_BOT}/export`, { subjects: `${shared} ${theirs}` });
    expect(own.statusCode).toBe(200);
    const entry = readZip(new Uint8Array(own.rawPayload)).find((file) => file.name === "subjects.jsonl");
    const subjects = Buffer.from(entry?.data ?? new Uint8Array()).toString("utf8");
    expect(subjects).toContain(SHARED_PERSON);
    expect(subjects).not.toContain("only.globex@example.com");
  });

  it("does not have the people pages, which work across every system", async () => {
    const page = await get(ACME, "/ui");
    expect(page.body).not.toContain('href="/ui/persone"');
    expect((await get(ACME, "/ui/persone")).statusCode).toBe(404);
    expect((await post(ACME, "/ui/persone", { identifier: SHARED_PERSON })).statusCode).toBe(404);
    const token = store.subjectToken(SHARED_PERSON) ?? "";
    expect((await post(ACME, "/ui/persone/cancella", { token, confirm: token })).statusCode).toBe(404);
    expect(store.subjectIdentifier(token)).toBe(SHARED_PERSON);
    // The operator still has them.
    expect((await get(OPERATOR, "/ui/persone")).statusCode).toBe(200);
  });

  it("finds a document in its own systems only", async () => {
    const response = await get(ACME, `/ui/verify-document?sha256=${SHARED_DOCUMENT}`);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(encodeURIComponent(ACME_BOT));
    expect(response.body).not.toContain(GLOBEX_BOT);
    expect(response.body).not.toContain(OPERATOR_BOT);
  });

  it("creates systems under its own name, which the other organization never sees", async () => {
    const created = await post(ACME, "/ui/sistemi", { system_id: "support-bot", display_name: "Assistenza" });
    expect(created.statusCode).toBe(200);
    expect(store.systemRecord("acme.support-bot")?.organization_id).toBe("acme");
    expect(store.hasSystem("support-bot")).toBe(false);
    // Typing the prefix does not double it.
    await post(ACME, "/ui/sistemi", { system_id: "acme.third" });
    expect(store.hasSystem("acme.third")).toBe(true);
    expect((await get(GLOBEX, "/ui/sistemi?vista=tutti")).body).not.toContain("acme.support-bot");
    // Globex creating the same name gets its own system, not a refusal about Acme's.
    expect((await post(GLOBEX, "/ui/sistemi", { system_id: "support-bot" })).statusCode).toBe(200);
    expect(store.systemRecord("globex.support-bot")?.organization_id).toBe("globex");
  });

  it("refuses an organization that is not approved, or does not exist", async () => {
    await store.createOrganization("initech", "Initech", ADMIN, { approved: false });
    for (const viewer of [
      { kind: "organization", organizationId: "initech" },
      { kind: "organization", organizationId: "nobody" },
    ] as const) {
      const response = await get(viewer, "/ui");
      expect(response.statusCode).toBe(302);
      expect(response.headers["location"]).toBe("/ui/login");
    }
  });

  it("signs an organization out without signing out the operator, or the other organization", async () => {
    const acme = cookieFor(ACME);
    const globex = cookieFor(GLOBEX);
    const operator = cookieFor(OPERATOR);
    await app.inject({ method: "POST", url: "/ui/logout", headers: { cookie: acme } });
    const status = async (cookie: string) => (await app.inject({ method: "GET", url: "/ui", headers: { cookie } })).statusCode;
    expect(await status(acme)).toBe(302);
    expect(await status(globex)).toBe(200);
    expect(await status(operator)).toBe(200);
  });

  it("lets the operator see every system, as before", async () => {
    const body = (await get(OPERATOR, "/ui/sistemi?vista=tutti")).body;
    for (const systemId of [ACME_BOT, GLOBEX_BOT, OPERATOR_BOT]) expect(body).toContain(systemId);
  });
});

describe("session cookies", () => {
  const now = new Date(NOW).getTime();

  it("cannot be turned from one viewer into another", () => {
    const issued = new UiSessions().issue(ACME, now).value;
    const sessionsHere = new UiSessions();
    const mine = sessionsHere.issue(ACME, now).value;
    expect(sessionsHere.read(mine, now)).toEqual(ACME);
    // Another process's secret.
    expect(sessionsHere.read(issued, now)).toBeNull();
    // The same signature over another viewer.
    expect(sessionsHere.read(mine.replace("org_acme", "org_globex"), now)).toBeNull();
    expect(sessionsHere.read(mine.replace("org_acme", "operator"), now)).toBeNull();
  });

  it("refuses expired, malformed and impossible values", () => {
    const sessionsHere = new UiSessions(1);
    const value = sessionsHere.issue(ACME, now).value;
    expect(sessionsHere.read(value, now + 2 * 3600 * 1000)).toBeNull();
    for (const bad of ["", "1.2", "x.operator.ab", `${now + 1000}.org_ACME.00`, `${now + 1000}.org_a.b.c.00`, `${now + 1000}.admin.00`]) {
      expect(sessionsHere.read(bad, now)).toBeNull();
    }
  });
});
