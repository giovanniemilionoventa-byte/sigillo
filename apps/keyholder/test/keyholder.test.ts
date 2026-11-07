import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
type FastifyInstance = ReturnType<typeof buildServer>;
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../../server/src/auth/api-keys.js";
import { boxPublicKey } from "../../server/src/gateway/key-box.js";
import { KeyholderClient } from "../../server/src/gateway/keyholder-client.js";
import { loadOrCreateSealingKey, ProviderKeyStore } from "../../server/src/gateway/provider-keys.js";
import { buildServer } from "../../server/src/http/server.js";
import { ReceiptStore } from "../../server/src/storage/store.js";
import { createTestSigner } from "../../server/test/helpers/signer.js";
import { startKeyholder, type Keyholder } from "../src/keyholder.js";

/**
 * The customers' model keys held by a separate process (security audit
 * 2026-11-07): the server seals, only the keyholder opens and calls the
 * provider. Real sockets, real crypto, a stand-in provider.
 */

const NOW = "2026-11-07T10:00:00.000Z";
const SYSTEM = "held-bot";
const OPENAI_KEY = "sk-proj-HELDKEYOFTHECUSTOMER0123456789";
const OLD_KEY = "sk-proj-OLDKEYSEALEDBEFORE0123456789";

let directory: string;
let provider: Server;
let seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
let keyholder: Keyholder;
let store: ReceiptStore;
let keys: ApiKeyStore;
let providerKeys: ProviderKeyStore;
let app: FastifyInstance;
let token: string;
let databasePath: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-keyholder-"));
  provider = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if ((req.url ?? "").includes("stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => res.end("data: two\n\n"), 50);
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "req_1", "set-cookie": "no=1" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
  const upstream = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

  databasePath = join(directory, "sigillo.db");
  store = ReceiptStore.open(databasePath, createTestSigner());
  await store.createSystem(SYSTEM, NOW);
  keys = ApiKeyStore.open(databasePath);
  token = keys.issue(SYSTEM, NOW).token;

  // A key sealed the old way, before the keyholder existed.
  const legacyKey = loadOrCreateSealingKey(join(directory, "llm-gateway.key"));
  const before = ProviderKeyStore.open(databasePath, legacyKey, () => "operator", false);
  before.set(SYSTEM, "anthropic", OLD_KEY, NOW);
  before.close();

  const keyholderDir = mkdtempSync(join(tmpdir(), "sigillo-keyholder-state-"));
  const socketPath = join(directory, "keyholder.sock");
  keyholder = await startKeyholder({ socketPath, directory: keyholderDir, upstream: { openai: upstream, anthropic: upstream } });
  const client = new KeyholderClient(socketPath);
  expect(await client.adopt(legacyKey)).toBe(true);
  expect(await client.adopt(Buffer.alloc(32, 7))).toBe(false); // never replaced
  providerKeys = ProviderKeyStore.open(databasePath, null, () => "operator", false, boxPublicKey(await client.publicKey()));
  providerKeys.set(SYSTEM, "openai", OPENAI_KEY, NOW);

  app = buildServer({ store, keys, now: () => new Date(NOW), gateway: { keys: providerKeys, access: "all", keyholder: client } });
  await app.listen({ host: "127.0.0.1", port: 0 });
}, 30_000);

afterAll(async () => {
  await app?.close();
  await keyholder?.close();
  provider?.close();
  providerKeys?.close();
  keys?.close();
  store?.close();
  rmSync(directory, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

describe("the keyholder", () => {
  it("adds the customer's key the server cannot open, and the call is a receipt", async () => {
    seen = [];
    const answer = await fetch(`${base()}/llm/openai/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("x-request-id")).toBe("req_1");
    expect(answer.headers.get("set-cookie")).toBeNull();
    expect(await answer.json()).toEqual({ choices: [{ message: { content: "ok" } }] });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(seen[0]?.url).toBe("/v1/chat/completions");
    expect(store.readChain(SYSTEM).some((r) => r.action.kind === "llm_call")).toBe(true);
    expect(() => providerKeys.get(SYSTEM, "openai")).toThrow();
    expect(readFileSync(databasePath).includes(Buffer.from(OPENAI_KEY))).toBe(false);
  });

  it("opens a key sealed before it existed, with the key the server handed over", async () => {
    seen = [];
    const answer = await fetch(`${base()}/llm/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-x", messages: [] }),
    });
    expect(answer.status).toBe(200);
    expect(seen[0]?.headers["x-api-key"]).toBe(OLD_KEY);
  });

  it("passes a stream on", async () => {
    const answer = await fetch(`${base()}/llm/openai/v1/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o", stream: true }),
    });
    expect(await answer.text()).toBe("data: one\n\ndata: two\n\n");
  });

  it("refuses paths that leave the catalogue or hand out access, on its own side too", async () => {
    const client = new KeyholderClient(join(directory, "keyholder.sock"));
    const sealed = providerKeys.sealedFor(SYSTEM, "openai")!;
    for (const rest of ["v1/realtime/client_secrets", "v1/../x", "x/y"]) {
      const reply = await client.call({ systemId: SYSTEM, provider: "openai", rest, query: "", method: "POST", sealed, headers: {}, body: "{}", signal: new AbortController().signal });
      expect(reply.status).toBe(404);
    }
    // Bound to its system: the same box under another system's name does not open.
    const other = await client.call({ systemId: "another", provider: "openai", rest: "v1/chat/completions", query: "", method: "POST", sealed, headers: {}, body: "{}", signal: new AbortController().signal });
    expect(other.status).toBe(409);
  });
});
