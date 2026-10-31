import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashCanonicalJson, saltedDigest, type Receipt } from "@sigillo/core";
import { artifact, init, nonceFor, type Tracing } from "@sigillo/sdk";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { ConnectionWatch } from "../src/connection/watch.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The TypeScript SDK against the real server, nothing mocked but the network
 * hop (a fetch that hands the request to the server in-process): what the SDK
 * sends is recorded, so the test can say what left the process, and what the
 * server wrote on the chain is read back. The bar is the Python SDK's: content
 * leaves as a salted digest only, the customer's key keeps the nonce at home,
 * the heartbeat reaches the server, a failure is recorded as its class only.
 */

const SYSTEM = "agente-ts";
const START = Date.parse("2026-10-31T10:00:00.000Z");
const SECRET_PROMPT = "Summarise the contract of Elena Rizzo, salary 52000";
const SECRET_ANSWER = "Elena Rizzo earns 52000 euro";
const SECRET_ERROR = "database password hunter2 refused";

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;
let token: string;
let sent: Array<{ url: string; body: string }>;
let tracing: Tracing | undefined;
let clock: number;

const otelSlot = Symbol.for("opentelemetry.js.api.1");
type Slot = { trace?: { getTracer: (name: string) => { startActiveSpan: (name: string, options: object, fn: (span: Span) => Promise<void>) => Promise<void> } } };
type Span = { setAttribute: (key: string, value: unknown) => void; setStatus: (status: { code: number; message?: string }) => void; recordException: (error: unknown) => void; end: () => void };

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-sdk-ts-"));
  const databasePath = join(directory, "sigillo.db");
  clock = START;
  const now = (): Date => new Date(clock);
  signer = createTestSigner({ now });
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, new Date(START - 60_000).toISOString());
  keys = ApiKeyStore.open(databasePath);
  token = keys.issue(SYSTEM, new Date(START - 60_000).toISOString()).token;
  app = buildServer({ store, keys, now, connections: new ConnectionWatch({ store, now }) });
  await app.ready();
  sent = [];
  delete (globalThis as unknown as Record<symbol, unknown>)[otelSlot];
});

afterEach(async () => {
  await tracing?.shutdown();
  tracing = undefined;
  delete (globalThis as unknown as Record<symbol, unknown>)[otelSlot];
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/** A fetch that records the request and gives it to the server, as the network would. */
const toServer: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const body = String(init?.body ?? "");
  sent.push({ url: url.pathname, body });
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const response = await app.inject({ method: "POST", url: url.pathname, headers, payload: body });
  return new Response(response.body, { status: response.statusCode, headers: { "content-type": "application/json" } });
};

const chain = (): Receipt[] => store.readChain(SYSTEM);
const named = (name: string): Receipt | undefined => chain().find((receipt) => receipt.action.name === name);

function start(extra: Record<string, unknown> = {}): Tracing {
  tracing = init({ endpoint: "http://sigillo.test", apiKey: token, systemId: SYSTEM, fetch: toServer, guard: false, ...extra });
  return tracing;
}

/** What the Vercel AI SDK does with the tracer it finds: a model call, then a tool call. */
async function aiSdkRun(): Promise<void> {
  const slot = (globalThis as unknown as Record<symbol, Slot>)[otelSlot];
  const tracer = slot?.trace?.getTracer("ai");
  if (tracer === undefined) throw new Error("no tracer registered");
  await tracer.startActiveSpan(
    "ai.generateText.doGenerate",
    { attributes: { "ai.model.id": "gpt-5", "ai.model.provider": "openai.chat", "ai.prompt.messages": SECRET_PROMPT, "ai.response.text": SECRET_ANSWER, "ai.settings.maxRetries": 2 } },
    async (span) => span.end(),
  );
  await tracer.startActiveSpan("ai.toolCall", { attributes: { "ai.toolCall.name": "read_contract", "ai.toolCall.args": '{"file":"rizzo.pdf"}', "ai.toolCall.result": SECRET_ANSWER } }, async (span) => span.end());
}

describe("the TypeScript SDK against the server", () => {
  it("records a framework's model and tool calls through the global tracer, as digests only", async () => {
    const t = start();
    expect(t.instrumented).toEqual(["opentelemetry"]);
    await aiSdkRun();
    expect(await t.flush()).toBe(true);

    const model = named("gpt-5");
    const tool = named("read_contract");
    expect(model?.action.kind).toBe("llm_call");
    expect(model?.outcome).toBe("ok");
    expect(model?.actor.agent).toBe(SYSTEM);
    expect(tool?.action.kind).toBe("tool_call");

    const traces = sent.filter((request) => request.url === "/v1/traces");
    expect(traces.length).toBeGreaterThan(0);
    for (const request of sent) {
      for (const secret of [SECRET_PROMPT, SECRET_ANSWER, "rizzo.pdf", "maxRetries"]) {
        expect(request.body.includes(secret), `${secret} left the process in ${request.url}`).toBe(false);
      }
    }
    // The digest on the chain is a salted one: it matches neither the plain hash nor anything guessable.
    expect(model?.input_hash).not.toBe(hashCanonicalJson(SECRET_PROMPT));
    expect(model?.input_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the nonce at home with a customer key, and the customer can open the digest", async () => {
    const t = start({ customerKey: "a secret of my own" });
    await aiSdkRun();
    await t.flush();

    const trace = sent.find((request) => request.url === "/v1/traces");
    expect(trace?.body).toContain('"customer"');
    const spans = JSON.parse(trace?.body ?? "{}") as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; spanId: string }> }> }> };
    const span = spans.resourceSpans[0]?.scopeSpans[0]?.spans.find((candidate) => candidate.name.endsWith("doGenerate"));
    expect(span).toBeDefined();

    // Sigillo got a digest and no nonce. The customer rebuilds the nonce from the key and opens the digest.
    const nonce = nonceFor("a secret of my own", span?.traceId ?? "", span?.spanId ?? "", "input");
    expect(trace?.body.includes(nonce)).toBe(false);
    expect(named("gpt-5")?.input_hash).toBe(saltedDigest(Buffer.from(nonce, "hex"), SECRET_PROMPT));
    expect(named("gpt-5")?.input_hash).not.toBe(saltedDigest(Buffer.alloc(32), SECRET_PROMPT));
  });

  it("records a failed tool as an error, with the exception's class and none of its message", async () => {
    const t = start();
    await expect(
      t.tool("query_database", () => {
        throw new TypeError(SECRET_ERROR);
      }),
    ).rejects.toThrow(SECRET_ERROR);
    await t.flush();

    expect(named("query_database")?.outcome).toBe("error");
    for (const request of sent) expect(request.body.includes(SECRET_ERROR)).toBe(false);
    expect(sent.some((request) => request.body.includes("TypeError"))).toBe(true);
  });

  it("fingerprints a document without sending it", async () => {
    const t = start();
    await t.tool("read_contract", () => artifact("Contract between A and B.\n", { role: "input", label: "contract" }));
    await t.flush();

    const receipt = named("read_contract");
    const entry = (receipt as { artifacts?: Array<{ label: string; sha256: string; text?: { canon: string } }> }).artifacts?.[0];
    expect(entry?.label).toBe("contract");
    expect(entry?.text?.canon).toBe("sigillo-text/1");
    for (const request of sent) expect(request.body.includes("Contract between")).toBe(false);
  });

  it("tells the server the agent started and closed, and the server writes both on the chain", async () => {
    const t = start();
    await t.flush();
    await t.shutdown();
    tracing = undefined;
    const heartbeats = sent.filter((request) => request.url === "/api/v1/heartbeat").map((request) => JSON.parse(request.body) as { event: string; session: string });
    expect(heartbeats.map((beat) => beat.event)).toEqual(["start", "stop"]);
    expect(heartbeats[0]?.session).toMatch(/^[0-9a-f]{32}$/);
    expect(named("sigillo.connection.start")).toBeDefined();
    expect(named("sigillo.connection.stop")).toBeDefined();
  });

  it("leaves another provider alone and says so", () => {
    (globalThis as unknown as Record<symbol, unknown>)[otelSlot] = { version: "1.9.0", trace: {} };
    const t = start();
    expect(t.instrumented).toEqual([]);
  });

  it("refuses a placeholder key and an empty one", () => {
    expect(() => init({ endpoint: "http://x", apiKey: "k", systemId: "s", customerKey: "<a secret>", guard: false })).toThrow(/placeholder/);
    expect(() => init({ endpoint: "http://x", apiKey: "", systemId: "s", guard: false })).toThrow();
  });
});
