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
 * The key vault suspended (2026-10-23): off, the default of the server, the
 * model key is sealed under the server's own key and nothing asks for a
 * passphrase; the code is still there and SIGILLO_KEY_VAULT=on brings it back.
 */

const NOW = "2026-10-22T10:00:00.000Z";
const ADMIN = { actor: "test", ts: NOW };
const ACME: Viewer = { kind: "organization", organizationId: "acme" };
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
  directory = mkdtempSync(join(tmpdir(), "sigillo-vault-off-"));
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
    false,
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

describe("the key vault, suspended (SIGILLO_KEY_VAULT off)", () => {
  it("saves a model key with no vault and passphrase, and the gateway uses it", async () => {
    const saved = await post(ACME, `/ui/systems/${ACME_BOT}/llm-key`, { provider: "openai", key: OPENAI_KEY });
    expect(saved.statusCode).toBe(303);
    expect(providerKeys.list(ACME_BOT)[0]?.last4).toBe(OPENAI_KEY.slice(-4));
    expect((await chat()).statusCode).toBe(200);
    expect(providerSaw.at(-1)).toBe(`Bearer ${OPENAI_KEY}`);
  });

  it("has no vault page, no vault calls, and no link to them", async () => {
    for (const url of ["/ui/vault"]) {
      const page = await app.inject({ method: "GET", url, headers: { cookie: cookie(ACME) } });
      expect(page.statusCode).toBe(404);
    }
    const create = await post(ACME, "/ui/vault/create", { passphrase: PASSPHRASE, again: PASSPHRASE });
    expect(create.statusCode).toBe(404);
    for (const url of ["/vault/lock", "/vault/unlock"]) {
      const call = await app.inject({ method: "POST", url, headers: { authorization: `Bearer ${agentToken}` }, payload: {} });
      expect(call.statusCode).toBe(404);
    }
    const manage = await app.inject({ method: "GET", url: `/ui/systems/${ACME_BOT}/manage`, headers: { cookie: cookie(ACME) } });
    expect(manage.statusCode).toBe(200);
    expect(manage.body).not.toContain("/ui/vault");
  });

  it("reads a key a vault sealed earlier as not set, so it is entered again", async () => {
    providerKeys.vaults.create("acme", PASSPHRASE, new Date(NOW));
    const on = ProviderKeyStore.open(join(directory, "sigillo.db"), loadOrCreateSealingKey(join(directory, "llm-gateway.key")), () => "acme", true);
    on.vaults.unlock("acme", PASSPHRASE, new Date(NOW));
    on.set(ACME_BOT, "openai", OPENAI_KEY, NOW, new Date(NOW));
    on.close();
    expect(providerKeys.get(ACME_BOT, "openai", new Date(NOW))).toBeNull();
    providerKeys.set(ACME_BOT, "openai", OPENAI_KEY, NOW);
    expect(providerKeys.get(ACME_BOT, "openai", new Date(NOW))).toBe(OPENAI_KEY);
  });
});
