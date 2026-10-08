import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { it } from "./helpers/italian.js";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR, type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { UI } from "../src/http/strings.js";
import { ReceiptStore, TRANSFER_TTL_MS, TransferUnavailableError, transferHash } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Handing a system to another account with a link: made by the giver, shown
 * once, kept only as a hash, used once, and only by an approved organization.
 */

const PASSWORD = "an administrator password";
const START = Date.parse("2026-10-08T12:00:00.000Z");
const OPERATOR_BOT = "operator-bot";
const ACME_BOT = "acme-bot";
const ACME: Viewer = { kind: "organization", organizationId: "acme" };
const GLOBEX: Viewer = { kind: "organization", organizationId: "globex" };
const ADMIN = { actor: "cli test", ts: "2026-10-01T09:00:00.000Z" };

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let sessions: UiSessions;
let app: FastifyInstance;
let nowMs: number;

async function start(transfer?: "off" | "operator" | "all"): Promise<void> {
  const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
  healthMonitor.check();
  app = buildServer({
    store,
    keys,
    now: () => new Date(nowMs),
    ...(transfer === undefined ? {} : { transfer }),
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer: new Checkpointer({ store, now: () => new Date(nowMs) }),
      sessions,
    },
  });
  await app.ready();
}

beforeEach(async () => {
  nowMs = START;
  directory = mkdtempSync(join(tmpdir(), "sigillo-transfer-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createOrganization("globex", "Globex S.r.l.", ADMIN, { approved: true });
  await store.createOrganization("pending", "Pending S.r.l.", ADMIN, { approved: false });
  await store.createSystem(OPERATOR_BOT, "2026-10-01T09:00:00.000Z");
  await store.createSystem(ACME_BOT, "2026-10-01T09:00:00.000Z", "acme");
  keys = ApiKeyStore.open(databasePath);
  sessions = new UiSessions();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const cookieFor = (viewer: Viewer): string => `sigillo_session=${sessions.issue(viewer, nowMs).value}`;
const get = (viewer: Viewer | null, url: string) =>
  app.inject({ method: "GET", url, headers: viewer === null ? {} : { cookie: cookieFor(viewer) } });
const post = (viewer: Viewer, url: string) =>
  app.inject({ method: "POST", url, headers: { cookie: cookieFor(viewer), "content-type": "application/x-www-form-urlencoded" }, payload: "" });

/** Makes a link for the operator's system and returns its secret, read out of the page that shows it once. */
async function linkFor(viewer: Viewer, systemId: string): Promise<string> {
  const response = await post(viewer, `/ui/systems/${systemId}/transfer`);
  expect(response.statusCode).toBe(200);
  const found = /\/ui\/trasferimento\/([A-Za-z0-9_-]{43})/.exec(response.body);
  if (found?.[1] === undefined) throw new Error("no link in the page");
  return found[1];
}

describe("making a transfer link", () => {
  it("is offered to the operator for their own system, shown once, and kept only as a hash", async () => {
    await start();
    expect((await get(OPERATOR, `/ui/systems/${OPERATOR_BOT}/manage`)).body).toContain(UI.manage.transferSubmit);
    const secret = await linkFor(OPERATOR, OPERATOR_BOT);
    const stored = store.transferTarget(secret, new Date(nowMs).toISOString());
    expect(stored?.system_id).toBe(OPERATOR_BOT);
    const rows = (store as unknown as { read: { prepare(sql: string): { all(): Record<string, unknown>[] } } }).read
      .prepare("SELECT * FROM transfer_links")
      .all();
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0]?.["token_hash"]).toBe(transferHash(secret));
    expect(store.adminLog().some((entry) => entry.action === "system.transfer.create")).toBe(true);
  });

  it("stays out of an organization's settings and endpoints until the switch is opened", async () => {
    await start();
    expect((await get(ACME, `/ui/systems/${ACME_BOT}/manage`)).body).not.toContain(UI.manage.transferSubmit);
    expect((await post(ACME, `/ui/systems/${ACME_BOT}/transfer`)).statusCode).toBe(404);
    await app.close();
    await start("all");
    expect((await get(ACME, `/ui/systems/${ACME_BOT}/manage`)).body).toContain(UI.manage.transferSubmit);
    expect((await post(ACME, `/ui/systems/${ACME_BOT}/transfer`)).statusCode).toBe(200);
  });

  it("is off for everyone when the switch says off", async () => {
    await start("off");
    expect((await get(OPERATOR, `/ui/systems/${OPERATOR_BOT}/manage`)).body).not.toContain(UI.manage.transferSubmit);
    expect((await post(OPERATOR, `/ui/systems/${OPERATOR_BOT}/transfer`)).statusCode).toBe(404);
  });

  it("cannot be made for another organization's system", async () => {
    await start("all");
    expect((await post(GLOBEX, `/ui/systems/${ACME_BOT}/transfer`)).statusCode).toBe(404);
  });

  it("replaces the link it had, and can be taken back", async () => {
    await start();
    const first = await linkFor(OPERATOR, OPERATOR_BOT);
    const second = await linkFor(OPERATOR, OPERATOR_BOT);
    const at = new Date(nowMs).toISOString();
    expect(store.transferTarget(first, at)).toBeNull();
    expect(store.transferTarget(second, at)).not.toBeNull();
    expect((await post(OPERATOR, `/ui/systems/${OPERATOR_BOT}/transfer/annulla`)).statusCode).toBe(303);
    expect(store.transferTarget(second, at)).toBeNull();
  });
});

describe("accepting a transfer link", () => {
  it("sends someone not signed in to sign in, keeping the link meanwhile", async () => {
    await start();
    const secret = await linkFor(OPERATOR, OPERATOR_BOT);
    const response = await get(null, `/ui/trasferimento/${secret}`);
    expect(response.statusCode).toBe(302);
    expect(response.headers["location"]).toBe("/ui/login");
    const header = String(response.headers["set-cookie"]);
    expect(header).toContain("sigillo_transfer=");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain(secret);
  });

  it("asks a signed-in account, and then the system is theirs, with its chain untouched", async () => {
    await start();
    const before = store.tip(OPERATOR_BOT);
    const secret = await linkFor(OPERATOR, OPERATOR_BOT);
    const page = await get(GLOBEX, `/ui/trasferimento/${secret}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(UI.transfer.acceptSubmit);
    // Looking is not accepting.
    expect(store.systemRecord(OPERATOR_BOT)?.organization_id).toBeNull();

    const done = await post(GLOBEX, `/ui/trasferimento/${secret}`);
    expect(done.statusCode).toBe(303);
    expect(done.headers["location"]).toBe(`/ui/systems/${OPERATOR_BOT}`);
    expect(store.systemRecord(OPERATOR_BOT)?.organization_id).toBe("globex");
    expect(store.tip(OPERATOR_BOT)).toEqual(before);
    expect((await get(GLOBEX, `/ui/systems/${OPERATOR_BOT}`)).statusCode).toBe(200);
    expect((await get(OPERATOR, `/ui/systems/${OPERATOR_BOT}`)).statusCode).toBe(404);
    const entry = store.adminLog().find((logged) => logged.action === "system.assign");
    expect(entry?.detail).toMatchObject({ from: null, to: "globex", via: "transfer link" });
  });

  it("works once only", async () => {
    await start();
    const secret = await linkFor(OPERATOR, OPERATOR_BOT);
    expect((await post(GLOBEX, `/ui/trasferimento/${secret}`)).statusCode).toBe(303);
    expect((await post(ACME, `/ui/trasferimento/${secret}`)).statusCode).toBe(410);
    expect((await get(ACME, `/ui/trasferimento/${secret}`)).statusCode).toBe(410);
    expect(store.systemRecord(OPERATOR_BOT)?.organization_id).toBe("globex");
  });

  it("stops working after seven days, and for a guessed secret", async () => {
    await start();
    const secret = await linkFor(OPERATOR, OPERATOR_BOT);
    nowMs += TRANSFER_TTL_MS + 1;
    expect((await get(GLOBEX, `/ui/trasferimento/${secret}`)).statusCode).toBe(410);
    expect((await post(GLOBEX, `/ui/trasferimento/${secret}`)).statusCode).toBe(410);
    expect((await post(GLOBEX, `/ui/trasferimento/${"A".repeat(43)}`)).statusCode).toBe(410);
    expect(store.systemRecord(OPERATOR_BOT)?.organization_id).toBeNull();
  });

  it("is refused for the administrator, and for an organization not approved", async () => {
    await start();
    const secret = await linkFor(OPERATOR, OPERATOR_BOT);
    expect((await get(OPERATOR, `/ui/trasferimento/${secret}`)).statusCode).toBe(403);
    expect((await post(OPERATOR, `/ui/trasferimento/${secret}`)).statusCode).toBe(403);
    await expect(store.acceptTransfer(secret, "pending", { actor: "test", ts: new Date(nowMs).toISOString() })).rejects.toThrow(
      "approved",
    );
    expect(store.systemRecord(OPERATOR_BOT)?.organization_id).toBeNull();
    // A refusal does not spend the link.
    expect((await post(GLOBEX, `/ui/trasferimento/${secret}`)).statusCode).toBe(303);
  });

  it("refuses an organization that already has the system", async () => {
    await start("all");
    const secret = await linkFor(ACME, ACME_BOT);
    const request = { actor: "test", ts: new Date(nowMs).toISOString() };
    await expect(store.acceptTransfer(secret, "acme", request)).rejects.toThrow("already");
    await expect(store.acceptTransfer("nope", "acme", request)).rejects.toBeInstanceOf(TransferUnavailableError);
  });

  it("is gone with the system it was for", async () => {
    await start();
    const secret = await linkFor(OPERATOR, OPERATOR_BOT);
    await store.deleteEmptySystem(OPERATOR_BOT, { actor: "test", ts: new Date(nowMs).toISOString() });
    expect(store.transferTarget(secret, new Date(nowMs).toISOString())).toBeNull();
  });
});
