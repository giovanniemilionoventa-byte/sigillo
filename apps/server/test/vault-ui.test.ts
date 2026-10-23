import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { loadOrCreateSealingKey, ProviderKeyStore } from "../src/gateway/provider-keys.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The key vault through the console and the gateway: a customer makes it,
 * saves a model key, and once the vault is locked an agent's call is refused
 * until the customer opens it again. Nobody else's session opens it.
 */

const NOW = "2026-10-22T10:00:00.000Z";
const ADMIN = { actor: "test", ts: NOW };
const ACME: Viewer = { kind: "organization", organizationId: "acme" };
const GLOBEX: Viewer = { kind: "organization", organizationId: "globex" };
const ACME_BOT = "acme.bot";
const OPENAI_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const PASSPHRASE = "correct horse battery staple";

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let providerKeys: ProviderKeyStore;
let sessions: UiSessions;
let app: FastifyInstance;
let agentToken: string;
let provider: Server;
let providerUrl: string;
let providerSaw: string[];
let clock = NOW;

beforeAll(async () => {
  provider = createServer((request, response) => {
    providerSaw.push(String(request.headers.authorization));
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => provider.close(() => resolve())));

beforeEach(async () => {
  providerSaw = [];
  clock = NOW;
  directory = mkdtempSync(join(tmpdir(), "sigillo-vault-ui-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createOrganization("acme", "Acme", ADMIN, { approved: true });
  await store.createOrganization("globex", "Globex", ADMIN, { approved: true });
  await store.createSystem(ACME_BOT, NOW, "acme");
  keys = ApiKeyStore.open(databasePath);
  agentToken = keys.issue(ACME_BOT, NOW).token;
  providerKeys = ProviderKeyStore.open(
    databasePath,
    loadOrCreateSealingKey(join(directory, "llm-gateway.key")),
    (id) => store.systemRecord(id)?.organization_id ?? "operator",
  );
  sessions = new UiSessions();
  app = buildServer({
    store,
    keys,
    gateway: { keys: providerKeys, access: "all", upstream: { openai: providerUrl } },
    now: () => new Date(clock),
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000),
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
      sessions,
      agentUpload: "all",
      agentProtection: "all",
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  providerKeys.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const cookie = (viewer: Viewer): string => `sigillo_session=${sessions.issue(viewer, Date.parse(clock)).value}`;
const post = (viewer: Viewer, url: string, payload: Record<string, string>) =>
  app.inject({
    method: "POST",
    url,
    headers: { cookie: cookie(viewer), "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(payload).toString(),
  });
const chat = () =>
  app.inject({
    method: "POST",
    url: "/llm/openai/v1/chat/completions",
    headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
    payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
  });

describe("the key vault in the console", () => {
  it("refuses a model key until the account has a vault, and saves it once it has", async () => {
    const early = await post(ACME, `/ui/systems/${ACME_BOT}/llm-key`, { provider: "openai", key: OPENAI_KEY });
    expect(early.statusCode).toBe(409);
    expect(early.body).toContain("/ui/vault");
    expect(providerKeys.list(ACME_BOT)).toEqual([]);

    expect((await post(ACME, "/ui/vault/create", { passphrase: PASSPHRASE, again: "something else entirely" })).statusCode).toBe(400);
    expect((await post(ACME, "/ui/vault/create", { passphrase: "short", again: "short" })).statusCode).toBe(400);
    const made = await post(ACME, "/ui/vault/create", { passphrase: PASSPHRASE, again: PASSPHRASE });
    expect(made.statusCode).toBe(200);
    expect(made.body).toMatch(/([0-9a-f]{4}-){15}[0-9a-f]{4}/);
    expect(made.body).not.toContain(PASSPHRASE);
    expect((await post(ACME, "/ui/vault/create", { passphrase: PASSPHRASE, again: PASSPHRASE })).statusCode).toBe(400);

    const saved = await post(ACME, `/ui/systems/${ACME_BOT}/llm-key`, { provider: "openai", key: OPENAI_KEY });
    expect(saved.statusCode).toBe(303);
    expect(providerKeys.list(ACME_BOT)).toHaveLength(1);
  });

  it("answers an agent with 423 while the vault is locked, and serves it once unlocked", async () => {
    await post(ACME, "/ui/vault/create", { passphrase: PASSPHRASE, again: PASSPHRASE });
    await post(ACME, `/ui/systems/${ACME_BOT}/llm-key`, { provider: "openai", key: OPENAI_KEY });
    providerSaw = []; // saving a key makes the console check it with the provider once
    expect((await chat()).statusCode).toBe(200);
    expect(providerSaw).toEqual([`Bearer ${OPENAI_KEY}`]);

    expect((await post(ACME, "/ui/vault/lock", {})).statusCode).toBe(303);
    const locked = await chat();
    expect(locked.statusCode).toBe(423);
    expect(providerSaw).toHaveLength(1);

    expect((await post(ACME, "/ui/vault/unlock", { secret: "not the passphrase at all" })).statusCode).toBe(400);
    expect((await chat()).statusCode).toBe(423);
    expect((await post(ACME, "/ui/vault/unlock", { secret: PASSPHRASE })).statusCode).toBe(303);
    expect((await chat()).statusCode).toBe(200);
  });

  it("is each account's own: another account's session neither opens nor sees it", async () => {
    await post(ACME, "/ui/vault/create", { passphrase: PASSPHRASE, again: PASSPHRASE });
    await post(ACME, "/ui/vault/lock", {});
    const other = await post(GLOBEX, "/ui/vault/unlock", { secret: PASSPHRASE });
    expect(other.statusCode).toBe(400);
    expect(providerKeys.vaults.exists("globex")).toBe(false);
    const page = await app.inject({ method: "GET", url: "/ui/vault", headers: { cookie: cookie(GLOBEX) } });
    expect(page.body).toContain('action="/ui/vault/create"');
  });

  it("is not served to someone who has not signed in", async () => {
    expect((await app.inject({ method: "GET", url: "/ui/vault" })).statusCode).toBe(302);
  });

  it("seals on the customer's hours, shows it, and refuses every way of opening it until the hours end", async () => {
    await post(ACME, "/ui/vault/create", { passphrase: PASSPHRASE, again: PASSPHRASE });
    await post(ACME, `/ui/systems/${ACME_BOT}/llm-key`, { provider: "openai", key: OPENAI_KEY });
    expect((await post(ACME, "/ui/vault/schedule/add", { from: "22:00", to: "06:00", timezone: "Europe/Rome" })).statusCode).toBe(400); // no day chosen
    expect((await post(ACME, "/ui/vault/schedule/add", { day1: "1", from: "22:00", to: "06:00", timezone: "Nowhere/City" })).statusCode).toBe(400);
    const added = await app.inject({
      method: "POST",
      url: "/ui/vault/schedule/add",
      headers: { cookie: cookie(ACME), "content-type": "application/x-www-form-urlencoded" },
      payload: "day4=1&day5=1&from=22%3A00&to=06%3A00&timezone=Europe%2FRome",
    });
    expect(added.statusCode).toBe(303);
    expect(providerKeys.vaults.schedule("acme")?.windows).toEqual([{ days: [4, 5], from: "22:00", to: "06:00" }]);
    expect((await chat()).statusCode).toBe(200); // Thursday 12:00 in Rome: not sealed

    clock = "2026-10-22T21:00:00.000Z"; // Thursday 23:00 in Rome
    const refused = await chat();
    expect(refused.statusCode).toBe(423);
    expect(refused.body).toContain("sealed by its schedule");
    expect((await post(ACME, "/ui/vault/unlock", { secret: PASSPHRASE })).statusCode).toBe(423);
    const page = await app.inject({ method: "GET", url: "/ui/vault", headers: { cookie: cookie(ACME) } });
    expect(page.body).toContain("sealed by your hours");
    expect(page.body).not.toContain('action="/ui/vault/unlock"');

    clock = "2026-10-23T05:00:00.000Z"; // Friday 07:00: the window is over, the vault is still locked
    expect((await chat()).statusCode).toBe(423);
    expect((await post(ACME, "/ui/vault/unlock", { secret: PASSPHRASE })).statusCode).toBe(303);
    expect((await chat()).statusCode).toBe(200);

    expect((await post(ACME, "/ui/vault/schedule/remove", { index: "0" })).statusCode).toBe(303);
    expect(providerKeys.vaults.schedule("acme")?.windows).toEqual([]);
  });

  it("lets the customer's own agent lock and unlock the vault with its API key and the passphrase", async () => {
    await post(ACME, "/ui/vault/create", { passphrase: PASSPHRASE, again: PASSPHRASE });
    await post(ACME, `/ui/systems/${ACME_BOT}/llm-key`, { provider: "openai", key: OPENAI_KEY });
    const call = (path: string, payload: object, token = agentToken) =>
      app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${token}` }, payload });

    expect((await call("/vault/unlock", { secret: PASSPHRASE }, "sgl_not_a_key")).statusCode).toBe(401);
    expect((await call("/vault/lock", {})).statusCode).toBe(200);
    expect((await chat()).statusCode).toBe(423);
    expect((await call("/vault/unlock", { secret: "not the passphrase at all" })).statusCode).toBe(403);
    expect((await call("/vault/unlock", {})).statusCode).toBe(400);
    expect((await call("/vault/unlock", { secret: PASSPHRASE })).statusCode).toBe(200);
    expect((await chat()).statusCode).toBe(200);

    await post(ACME, "/ui/vault/schedule/add", { day4: "1", from: "00:00", to: "23:59", timezone: "Europe/Rome" });
    const sealed = await call("/vault/unlock", { secret: PASSPHRASE });
    expect(sealed.statusCode).toBe(423);
  });

  it("shows the vault, with its state, on the system's settings page", async () => {
    const manage = () => app.inject({ method: "GET", url: `/ui/systems/${ACME_BOT}/manage`, headers: { cookie: cookie(ACME) } });
    let page = await manage();
    expect(page.body).toContain('href="/ui/vault"');
    expect(page.body).toContain("Not created yet");
    await post(ACME, "/ui/vault/create", { passphrase: PASSPHRASE, again: PASSPHRASE });
    expect((await manage()).body).toContain("Open: agents can use");
    await post(ACME, "/ui/vault/lock", {});
    expect((await manage()).body).toContain("Locked: agents cannot");
    await post(ACME, "/ui/vault/schedule/add", { day4: "1", from: "00:00", to: "23:59", timezone: "Europe/Rome" });
    page = await manage();
    expect(page.body).toContain("Sealed by your hours");
  });
});
