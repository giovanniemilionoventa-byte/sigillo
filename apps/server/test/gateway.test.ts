import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyReceiptSignature, type Receipt } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR, type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { llmGateway } from "../src/config.js";
import { gatewayAllowed, type GatewayAccess } from "../src/gateway/llm.js";
import { loadOrCreateSealingKey, ProviderKeyStore } from "../src/gateway/provider-keys.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { SignerUnavailableError } from "../src/signer/errors.js";
import { ReceiptStore, type SigningService } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The model gateway, end to end: an agent calls its cloud model through
 * sigillo with sigillo's key, sigillo calls a stand-in of the provider on
 * this machine with the customer's own key, and every call is a signed
 * receipt. Open to the operator's own systems only, unless opened to all.
 */

const OPERATOR_BOT = "operator-bot";
const ACME_BOT = "acme.cv-bot";
const ACME: Viewer = { kind: "organization", organizationId: "acme" };
const OPENAI_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const ANTHROPIC_KEY = "sk-ant-api03-ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210";
const PROMPT = "Rank these curricula for the warehouse role";
const ANSWER = "Candidate B fits the role best";
const NOW = "2026-10-05T17:00:00.000Z";
const ADMIN = { actor: "test", ts: "2026-10-05T16:00:00.000Z" };

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** What the stand-in provider answers next, and what it was sent. */
let answer: (seen: Seen, response: import("node:http").ServerResponse) => void;
let seen: Seen[];
let upstream: Server;
let upstreamUrl: string;

let directory: string;
let databasePath: string;
let signer: TestSigner;
let signerDown: boolean;
let store: ReceiptStore;
let keys: ApiKeyStore;
let providerKeys: ProviderKeyStore;
let sessions: UiSessions;
let app: FastifyInstance;
let operatorToken: string;
let acmeToken: string;

async function start(access: GatewayAccess): Promise<void> {
  if (app !== undefined) await app.close();
  const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000);
  sessions = new UiSessions();
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    gateway: { keys: providerKeys, access, upstream: { openai: upstreamUrl, anthropic: `${upstreamUrl}/` } },
    ui: {
      password: "an administrator password",
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
      sessions,
    },
  });
  await app.ready();
}

beforeEach(async () => {
  seen = [];
  answer = (_seen, response) => {
    response.writeHead(200, { "content-type": "application/json", "x-request-id": "req_123", "set-cookie": "upstream=1" });
    response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: ANSWER } }] }));
  };
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const one = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(one);
      answer(one, response);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  directory = mkdtempSync(join(tmpdir(), "sigillo-gateway-"));
  databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  signerDown = false;
  const signing: SigningService = {
    keyId: signer.keyId,
    publicKeyBase64: signer.publicKeyBase64,
    signReceipt: async (receipt) => {
      if (signerDown) throw new SignerUnavailableError("the signer is away");
      return signer.signReceipt(receipt);
    },
    checkpoint: (systemId) => signer.checkpoint(systemId),
    head: (systemId) => signer.head(systemId),
  };
  store = ReceiptStore.open(databasePath, signing);
  await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
  await store.createSystem(OPERATOR_BOT, "2026-10-05T16:00:00.000Z");
  await store.createSystem(ACME_BOT, "2026-10-05T16:00:00.000Z", "acme");
  keys = ApiKeyStore.open(databasePath);
  operatorToken = keys.issue(OPERATOR_BOT, "2026-10-05T16:00:00.000Z").token;
  acmeToken = keys.issue(ACME_BOT, "2026-10-05T16:00:00.000Z").token;
  providerKeys = ProviderKeyStore.open(databasePath, loadOrCreateSealingKey(join(directory, "llm-gateway.key")));
  for (const systemId of [OPERATOR_BOT, ACME_BOT]) {
    providerKeys.set(systemId, "openai", OPENAI_KEY, ADMIN.ts);
    providerKeys.set(systemId, "anthropic", ANTHROPIC_KEY, ADMIN.ts);
  }
  await start("operator");
});

afterEach(async () => {
  await app.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  providerKeys.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
  app = undefined as unknown as FastifyInstance;
});

const chat = (token: string, payload: unknown = { model: "gpt-4o-mini", messages: [{ role: "user", content: PROMPT }] }, url = "/llm/openai/v1/chat/completions") =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}`, "x-sigillo-agent": "cv-screener" }, payload: payload as object });

const calls = (systemId: string): Receipt[] => store.readChain(systemId).filter((receipt) => receipt.action.kind === "llm_call");

describe("the model gateway", () => {
  it("calls the provider with the customer's key, answers as the provider did, and writes a signed receipt", async () => {
    const response = await chat(operatorToken, undefined, "/llm/openai/v1/chat/completions?api-version=1");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ choices: [{ message: { role: "assistant", content: ANSWER } }] });
    expect(response.headers["x-request-id"]).toBe("req_123");
    expect(response.headers["set-cookie"]).toBeUndefined();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("/v1/chat/completions?api-version=1");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    expect(seen[0]!.headers["x-sigillo-agent"]).toBeUndefined();
    expect(JSON.stringify(seen[0]!.headers)).not.toContain(operatorToken);
    expect(JSON.parse(seen[0]!.body)).toEqual({ model: "gpt-4o-mini", messages: [{ role: "user", content: PROMPT }] });

    const [receipt] = calls(OPERATOR_BOT);
    expect(receipt).toBeDefined();
    expect(verifyReceiptSignature(receipt!, signer.publicKey)).toBe(true);
    expect(receipt!.action).toEqual({ kind: "llm_call", name: "v1/chat/completions" });
    expect(receipt!.actor.agent).toBe("cv-screener");
    expect(receipt!.outcome).toBe("ok");
    expect(receipt!.source).toEqual({ type: "api" });
    expect((receipt as { model?: unknown }).model).toEqual({ name: "gpt-4o-mini", provider: "openai", digest: null });
    expect(receipt!.ts_received).toBe(NOW);

    // Digests only: neither the prompt nor the answer is written anywhere.
    const text = JSON.stringify(store.readChain(OPERATOR_BOT));
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(ANSWER);
    store.close();
    const file = readFileSync(databasePath);
    expect(file.includes(Buffer.from(PROMPT))).toBe(false);
    expect(file.includes(Buffer.from(ANSWER))).toBe(false);
    store = ReceiptStore.open(databasePath, signer);
  });

  it("speaks Anthropic's way too: the key as x-api-key, its version header passed on", async () => {
    answer = (_seen, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ content: [{ type: "text", text: ANSWER }] }));
    };
    const response = await app.inject({
      method: "POST",
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": operatorToken, "anthropic-version": "2023-06-01" },
      payload: { model: "claude-sonnet-5-5", max_tokens: 64, messages: [{ role: "user", content: PROMPT }] },
    });
    expect(response.statusCode).toBe(200);
    expect(seen[0]!.url).toBe("/v1/messages");
    expect(seen[0]!.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    const [receipt] = calls(OPERATOR_BOT);
    expect((receipt as { model?: unknown }).model).toEqual({ name: "claude-sonnet-5-5", provider: "anthropic", digest: null });
    expect(receipt!.actor.agent).toBe(OPERATOR_BOT);
  });

  it("records a refusal of the provider as an error, and passes it on with its retry hint", async () => {
    answer = (_seen, response) => {
      response.writeHead(429, { "content-type": "application/json", "retry-after": "20" });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
    };
    const response = await chat(operatorToken);
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("20");
    expect(calls(OPERATOR_BOT).map((receipt) => receipt.outcome)).toEqual(["error"]);
  });

  it("passes a stream on as it comes and writes its receipt at the end", async () => {
    const events = ["data: {\"delta\":\"Candidate \"}\n\n", "data: {\"delta\":\"B\"}\n\n", "data: [DONE]\n\n"];
    answer = (_seen, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) response.write(event);
      response.end();
    };
    const response = await chat(operatorToken, { model: "gpt-4o-mini", stream: true, messages: [{ role: "user", content: PROMPT }] });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(response.body).toBe(events.join(""));
    await expect.poll(() => calls(OPERATOR_BOT).length).toBe(1);
    expect(calls(OPERATOR_BOT)[0]!.outcome).toBe("ok");
  });

  it("works over a real connection, plain and streamed, as an SDK would use it", async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/llm/openai/v1`;
    const call = (stream: boolean) =>
      fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", stream, messages: [{ role: "user", content: PROMPT }] }),
      });
    const plain = await call(false);
    expect(plain.status).toBe(200);
    expect(await plain.text()).toContain(ANSWER);

    answer = (_seen, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: {\"delta\":\"B\"}\n\n");
      setTimeout(() => response.end("data: [DONE]\n\n"), 50);
    };
    const streamed = await call(true);
    expect(await streamed.text()).toBe("data: {\"delta\":\"B\"}\n\ndata: [DONE]\n\n");
    await expect.poll(() => calls(OPERATOR_BOT).map((receipt) => receipt.outcome)).toEqual(["ok", "ok"]);
  });

  it("forwards a model list without a receipt", async () => {
    answer = (_seen, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }));
    };
    const response = await app.inject({ method: "GET", url: "/llm/openai/v1/models", headers: { authorization: `Bearer ${operatorToken}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [{ id: "gpt-4o-mini" }] });
    expect(calls(OPERATOR_BOT)).toEqual([]);
  });

  it("does not hand back an answer whose receipt could not be written", async () => {
    signerDown = true;
    const response = await chat(operatorToken);
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(ANSWER);
    signerDown = false;
    expect(calls(OPERATOR_BOT)).toEqual([]);
  });

  it("refuses a wrong key, a provider it does not know and a path that climbs", async () => {
    expect((await chat("sigillo_nope_0000")).statusCode).toBe(401);
    expect((await chat(operatorToken, undefined, "/llm/mistral/v1/chat/completions")).statusCode).toBe(404);
    expect((await chat(operatorToken, undefined, "/llm/openai/v1/../admin")).statusCode).toBe(404);
    expect((await chat(operatorToken, undefined, "/llm/openai/v2/chat")).statusCode).toBe(404);
    expect(seen).toEqual([]);
  });

  it("asks for a provider key when the system has none", async () => {
    providerKeys.remove(OPERATOR_BOT, "openai");
    const response = await chat(operatorToken);
    expect(response.statusCode).toBe(409);
    expect(seen).toEqual([]);
  });

  it("is closed to customers' systems until it is opened to all", async () => {
    expect((await chat(acmeToken)).statusCode).toBe(403);
    expect(seen).toEqual([]);
    expect(calls(ACME_BOT)).toEqual([]);

    await start("all");
    expect((await chat(acmeToken)).statusCode).toBe(200);
    expect(calls(ACME_BOT)).toHaveLength(1);
  });
});

describe("the AI model block of a system's page", () => {
  const cookie = (viewer: Viewer): string => `sigillo_session=${sessions.issue(viewer, Date.parse(NOW)).value}`;
  const get = (viewer: Viewer, url: string) => app.inject({ method: "GET", url, headers: { cookie: cookie(viewer) } });
  const post = (viewer: Viewer, url: string, form: Record<string, string>) =>
    app.inject({
      method: "POST",
      url,
      headers: { cookie: cookie(viewer), "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(form).toString(),
    });

  it("lets the operator save and remove a provider key, showing only its last four characters", async () => {
    providerKeys.remove(OPERATOR_BOT, "openai");
    providerKeys.remove(OPERATOR_BOT, "anthropic");
    const page = await get(OPERATOR, `/ui/systems/${OPERATOR_BOT}/manage`);
    expect(page.body).toContain("AI model");
    expect(page.body).toContain("/llm/openai/v1");
    expect(page.body).toContain("ANTHROPIC_BASE_URL=");

    const saved = await post(OPERATOR, `/ui/systems/${OPERATOR_BOT}/llm-key`, { provider: "openai", key: OPENAI_KEY });
    expect(saved.statusCode).toBe(303);
    expect(providerKeys.get(OPERATOR_BOT, "openai")).toBe(OPENAI_KEY);
    const after = await get(OPERATOR, `/ui/systems/${OPERATOR_BOT}/manage`);
    expect(after.body).toContain("OpenAI ••••6789");
    expect(after.body).not.toContain(OPENAI_KEY);

    const refused = await post(OPERATOR, `/ui/systems/${OPERATOR_BOT}/llm-key`, { provider: "openai", key: "not a key" });
    expect(refused.statusCode).toBe(400);
    expect(providerKeys.get(OPERATOR_BOT, "openai")).toBe(OPENAI_KEY);

    expect((await post(OPERATOR, `/ui/systems/${OPERATOR_BOT}/llm-key/delete`, { provider: "openai" })).statusCode).toBe(303);
    expect(providerKeys.get(OPERATOR_BOT, "openai")).toBeNull();
  });

  it("is not shown to a customer, nor can it be used by one, until the gateway is opened to all", async () => {
    const page = await get(ACME, `/ui/systems/${ACME_BOT}/manage`);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain("AI model");
    expect(page.body).not.toContain("/llm/");
    expect((await post(ACME, `/ui/systems/${ACME_BOT}/llm-key`, { provider: "openai", key: `${OPENAI_KEY}X` })).statusCode).toBe(404);
    expect(providerKeys.get(ACME_BOT, "openai")).toBe(OPENAI_KEY);

    expect((await get(ACME, `/ui/systems/${ACME_BOT}/collega`)).body).not.toContain("/llm/");

    await start("all");
    expect((await get(ACME, `/ui/systems/${ACME_BOT}/manage`)).body).toContain("AI model");
    const connect = (await get(ACME, `/ui/systems/${ACME_BOT}/collega`)).body;
    expect(connect).toContain('id="way-model"');
    expect(connect).toContain("/llm/openai/v1");
    expect(connect).toContain("ANTHROPIC_BASE_URL=");
  });

  it("leaves the operator's connect page as it was: the operator sets the gateway up from the manage page", async () => {
    await start("all");
    const connect = (await get(OPERATOR, `/ui/systems/${OPERATOR_BOT}/collega`)).body;
    expect(connect).not.toContain('id="way-model"');
    expect(connect).not.toContain("/llm/");
  });
});

describe("who the gateway is open to", () => {
  it("defaults to the operator's own systems, and opens to all only when told", () => {
    expect(llmGateway({})).toBe("operator");
    expect(llmGateway({ SIGILLO_LLM_GATEWAY: "all" })).toBe("all");
    expect(llmGateway({ SIGILLO_LLM_GATEWAY: "off" })).toBe("off");
    expect(() => llmGateway({ SIGILLO_LLM_GATEWAY: "everyone" })).toThrow();
    expect(gatewayAllowed("operator", null)).toBe(true);
    expect(gatewayAllowed("operator", "acme")).toBe(false);
    expect(gatewayAllowed("all", "acme")).toBe(true);
  });
});
