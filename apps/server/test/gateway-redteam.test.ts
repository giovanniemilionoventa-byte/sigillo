import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { loadOrCreateSealingKey, ProviderKeyStore } from "../src/gateway/provider-keys.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * A malicious agent against the model gateway. The agent holds only sigillo's
 * key; the customer's provider key is sealed in sigillo. The properties that
 * make "the brain is cut off from the body" true, tried with raw HTTP so that
 * paths, headers and connections are exactly what the attacker chooses:
 *
 *   1. every call that reaches the provider with the customer's key is a receipt;
 *   2. the customer's key is in no answer the agent can read;
 *   3. the agent cannot choose where the key is sent, nor swap it for its own;
 *   4. one system's sigillo key opens nothing of another's.
 */

const NOW = "2026-10-09T17:00:00.000Z";
const SYSTEM = "victim-bot";
const OTHER = "other-bot";
const OPENAI_KEY = "sk-proj-REALKEYOFTHECUSTOMER0123456789abcd";
const ANTHROPIC_KEY = "sk-ant-api03-REALANTHROPICKEY0123456789abcdef";

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let directory: string;
let store: ReceiptStore;
let keys: ApiKeyStore;
let providerKeys: ProviderKeyStore;
let app: FastifyInstance;
let provider: Server;
let evil: Server;
let seen: Seen[];
let evilSeen: Seen[];
let port: number;
let agentKey: string;
let otherKey: string;
let slow: boolean;

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));

const stand = (into: () => Seen[]) =>
  createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      into().push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const reply = (): void => {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "x=1" });
        res.end(JSON.stringify({ data: [{ id: "model-a" }], choices: [{ message: { content: "ok" } }] }));
      };
      if (slow) setTimeout(reply, 300);
      else reply();
    });
  });

beforeAll(async () => {
  provider = stand(() => seen);
  evil = stand(() => evilSeen);
  const providerPort = await listen(provider);
  const evilPort = await listen(evil);
  directory = mkdtempSync(join(tmpdir(), "sigillo-redteam-"));
  const databasePath = join(directory, "sigillo.db");
  const signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, NOW);
  await store.createSystem(OTHER, NOW);
  keys = ApiKeyStore.open(databasePath);
  agentKey = keys.issue(SYSTEM, NOW).token;
  otherKey = keys.issue(OTHER, NOW).token;
  providerKeys = ProviderKeyStore.open(databasePath, loadOrCreateSealingKey(join(directory, "llm-gateway.key")));
  providerKeys.set(SYSTEM, "openai", OPENAI_KEY, NOW);
  providerKeys.set(SYSTEM, "anthropic", ANTHROPIC_KEY, NOW);
  const now = (): Date => new Date(NOW);
  app = buildServer({
    store,
    keys,
    now,
    gateway: {
      keys: providerKeys,
      access: "all",
      upstream: { openai: `http://127.0.0.1:${providerPort}`, anthropic: `http://127.0.0.1:${providerPort}`, gemini: `http://127.0.0.1:${providerPort}` },
    },
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000),
      checkpointer: new Checkpointer({ store, now }),
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  port = (app.server.address() as AddressInfo).port;
  // The attacker's own server, to see whether the key is ever sent there.
  void evilPort;
  evilSeen = [];
  (globalThis as { __evilPort?: number }).__evilPort = evilPort;
}, 30_000);

afterAll(async () => {
  await app?.close();
  provider?.close();
  evil?.close();
  providerKeys?.close();
  keys?.close();
  store?.close();
  rmSync(directory, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  evilSeen = [];
  slow = false;
});

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Raw HTTP: the path is sent byte for byte, headers as given. */
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string, abortAfterMs?: number): Promise<Answer> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
    if (body !== undefined) req.write(body);
    req.end();
    if (abortAfterMs !== undefined) setTimeout(() => req.destroy(), abortAfterMs);
  });
}

const asAgent = (extra: Record<string, string> = {}): Record<string, string> => ({ authorization: `Bearer ${agentKey}`, ...extra });
const calls = (): number => store.readChain(SYSTEM).filter((r) => r.action.kind === "llm_call").length;
const settle = (ms = 500): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("1. every call that reaches the provider with the customer's key leaves a receipt", () => {
  it("a POST does", async () => {
    const before = calls();
    const answer = await raw("POST", "/llm/openai/v1/chat/completions", asAgent(), JSON.stringify({ model: "m", messages: [] }));
    expect(answer.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(calls()).toBe(before + 1);
  });

  it.each([
    ["a stored file's content", "/llm/openai/v1/files/file-abc/content"],
    ["a stored response", "/llm/openai/v1/responses/resp_123"],
    ["an Anthropic batch's results", "/llm/anthropic/v1/messages/batches/msgbatch_1/results"],
  ])("a GET of %s that reaches the provider is a receipt too, or does not reach it", async (_name, path) => {
    const before = calls();
    await raw("GET", path, asAgent());
    expect(seen.length === 0 || calls() === before + seen.length).toBe(true);
  });

  it("the list of model names is the one GET without a receipt: it holds nothing of the customer's", async () => {
    const before = calls();
    expect((await raw("GET", "/llm/openai/v1/models", asAgent())).status).toBe(200);
    expect(calls()).toBe(before);
    expect(seen).toHaveLength(1);
    // A path that only looks like it is not excused.
    await raw("GET", "/llm/openai/v1/models/../files", asAgent());
    await raw("GET", "/llm/openai/v1/models/x/y", asAgent());
    expect(calls()).toBe(before + seen.length - 1);
  });

  it("a request the agent drops before the answer either never reaches the provider or is a receipt", async () => {
    slow = true;
    const before = calls();
    await raw("POST", "/llm/openai/v1/chat/completions", asAgent(), JSON.stringify({ model: "m", messages: [] }), 100);
    await settle(800);
    expect(seen.length === 0 || calls() === before + seen.length).toBe(true);
  });
});

describe("2. the customer's key is in nothing the agent can read", () => {
  it("not in an answer, a header, or an error", async () => {
    const answers = await Promise.all([
      raw("POST", "/llm/openai/v1/chat/completions", asAgent(), JSON.stringify({ model: "m" })),
      raw("GET", "/llm/openai/v1/models", asAgent()),
      raw("POST", "/llm/openai/v1/chat/completions", asAgent(), "{not json"),
      raw("POST", "/llm/gemini/v1beta/models/x:generateContent", asAgent(), JSON.stringify({})),
      raw("GET", "/llm/openai/v1/../../etc", asAgent()),
      raw("POST", "/llm/openai/v1/x", { authorization: "Bearer sigillo_wrong" }, "{}"),
    ]);
    for (const a of answers) {
      expect(a.body).not.toContain(OPENAI_KEY);
      expect(a.body).not.toContain("REALKEY");
      expect(JSON.stringify(a.headers)).not.toContain("REALKEY");
    }
  });
});

describe("3. the agent cannot choose where the key goes, nor replace it", () => {
  const evilHost = (): string => `127.0.0.1:${(globalThis as { __evilPort?: number }).__evilPort}`;

  it.each([
    "/llm/openai/v1/../../..//evil",
    "/llm/openai/v1/%2e%2e/%2e%2e/x",
    "/llm/openai/v1/%2E%2E%2Fx",
    "/llm/openai/v1/x%00y",
    "/llm/openai/v1/x%0d%0aHost:%20evil",
    "/llm/openai/v1/@evil/x",
    "/llm/openai/v1/\\evil",
    "/llm/openai//evil/x",
    "/llm/openai/http://evil/x",
    "/llm/openai/v1/x?redirect=http://evil",
  ])("path %s", async (path) => {
    await raw("GET", path, asAgent());
    await raw("POST", path, asAgent(), "{}");
    expect(evilSeen).toEqual([]);
    for (const hit of seen) {
      expect(hit.url.startsWith("/v1/") || hit.url.startsWith("//") === false).toBe(true);
      expect(hit.url).not.toContain("..");
    }
  });

  it("the agent's own authorization headers never replace the customer's key", async () => {
    await raw("POST", "/llm/openai/v1/chat/completions", asAgent({
      "x-api-key": "sk-attacker",
      "x-goog-api-key": "AIzaattacker",
      host: evilHost(),
      "openai-organization": "org-attacker",
      "x-forwarded-host": evilHost(),
      "proxy-authorization": "Basic YQ==",
      forwarded: `host=${evilHost()}`,
    }), JSON.stringify({ model: "m" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined();
    expect(seen[0]!.headers["x-goog-api-key"]).toBeUndefined();
    expect(seen[0]!.headers["proxy-authorization"]).toBeUndefined();
    expect(JSON.stringify(seen[0]!.headers)).not.toContain("attacker.example");
    expect(evilSeen).toEqual([]);
  });

  it("the sigillo key never goes to the provider", async () => {
    await raw("POST", `/llm/openai/v1/chat/completions?key=${agentKey}`, {}, JSON.stringify({ model: "m" }));
    for (const hit of seen) {
      expect(hit.url).not.toContain(agentKey);
      expect(JSON.stringify(hit.headers)).not.toContain(agentKey);
    }
  });

  it("the provider key of one provider is never sent as another's", async () => {
    await raw("POST", "/llm/anthropic/v1/messages", asAgent(), JSON.stringify({ model: "m" }));
    expect(seen[0]?.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(OPENAI_KEY);
  });
});

describe("4. one system's sigillo key opens nothing of another's", () => {
  it("another system's key finds no provider key, and a wrong or missing key finds nothing", async () => {
    expect((await raw("POST", "/llm/openai/v1/chat/completions", { authorization: `Bearer ${otherKey}` }, "{}")).status).toBe(409);
    expect((await raw("POST", "/llm/openai/v1/chat/completions", {}, "{}")).status).toBe(401);
    expect((await raw("POST", "/llm/openai/v1/chat/completions", { authorization: "Bearer sigillo_nope" }, "{}")).status).toBe(401);
    expect(seen).toEqual([]);
  });
});
