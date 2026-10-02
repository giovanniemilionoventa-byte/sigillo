import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromHex, hashCanonicalJson, openSaltedDigest, saltedDigest, verifyReceiptSignature } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

const SYSTEM = "acme-support-bot";
const NOW = "2026-03-29T15:00:00.000Z";

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-http-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
  keys = ApiKeyStore.open(databasePath);
  token = keys.issue(SYSTEM, "2026-03-29T14:00:01.000Z").token;
  app = buildServer({ store, keys, now: () => new Date(NOW) });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const auth = (value = token): Record<string, string> => ({ authorization: `Bearer ${value}` });

describe("health", () => {
  it("answers without a key", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("health of the chains", () => {
  it("answers 503, naming no system, when a chain is not intact", async () => {
    let intact = false;
    const checked = buildServer({ store, keys, now: () => new Date(NOW), chainsIntact: () => intact });
    await checked.ready();
    try {
      const broken = await checked.inject({ method: "GET", url: "/healthz" });
      expect(broken.statusCode).toBe(503);
      expect(broken.json()).toEqual({ status: "a chain failed its check or disagrees with the signer" });
      expect(broken.body).not.toContain(SYSTEM);
      intact = true;
      expect((await checked.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    } finally {
      await checked.close();
    }
  });
});

describe("authentication", () => {
  const requests = [
    { method: "POST" as const, url: "/v1/traces" },
    { method: "POST" as const, url: "/api/v1/receipts" },
  ];

  for (const request of requests) {
    it(`refuses ${request.url} without a key`, async () => {
      const response = await app.inject({ ...request, payload: {} });
      expect(response.statusCode).toBe(401);
    });

    it(`refuses ${request.url} with a key that was never issued`, async () => {
      const response = await app.inject({
        ...request,
        headers: auth("sigillo_0000000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    });

    it(`refuses ${request.url} with a malformed header`, async () => {
      for (const authorization of ["", "Bearer", "Basic abc", token]) {
        const response = await app.inject({ ...request, headers: { authorization }, payload: {} });
        expect(response.statusCode).toBe(401);
      }
    });
  }

  it("refuses a revoked key, and says so immediately", async () => {
    const issued = keys.issue(SYSTEM, "2026-03-29T14:00:02.000Z");
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(issued.token),
      payload: { actor: { agent: "planner" }, action: { kind: "tool_call", name: "x" }, outcome: "ok" },
    });
    expect(accepted.statusCode).toBe(201);

    keys.revoke(issued.keyId, "2026-03-29T14:05:00.000Z");

    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(issued.token),
      payload: { actor: { agent: "planner" }, action: { kind: "tool_call", name: "x" }, outcome: "ok" },
    });
    expect(refused.statusCode).toBe(401);
  });
});

describe("writes paused for maintenance", () => {
  const OTHER = "prova-aggiornamento";
  let paused: FastifyInstance;
  let otherToken: string;

  beforeEach(async () => {
    await store.createSystem(OTHER, "2026-03-29T14:00:02.000Z");
    otherToken = keys.issue(OTHER, "2026-03-29T14:00:03.000Z").token;
    paused = buildServer({ store, keys, now: () => new Date(NOW), ingestPause: { except: new Set([OTHER]) } });
    await paused.ready();
  });

  afterEach(async () => {
    await paused.close();
  });

  const receipt = { actor: { agent: "planner" }, action: { kind: "tool_call", name: "x" }, outcome: "ok" };

  it("answers 503 with Retry-After on both endpoints, and writes nothing", async () => {
    const before = store.readChain(SYSTEM).length;
    const native = await paused.inject({ method: "POST", url: "/api/v1/receipts", headers: auth(), payload: receipt });
    const otlp = await paused.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(), "content-type": "application/x-protobuf" },
      payload: fixture("otel-genai.protobuf.bin"),
    });
    for (const response of [native, otlp]) {
      expect(response.statusCode).toBe(503);
      expect(response.headers["retry-after"]).toBe("60");
      expect(response.json()).toEqual({ error: "writes are paused for maintenance: retry later" });
    }
    expect(store.readChain(SYSTEM)).toHaveLength(before);
  });

  it("still checks the key first", async () => {
    const response = await paused.inject({ method: "POST", url: "/api/v1/receipts", payload: receipt });
    expect(response.statusCode).toBe(401);
  });

  it("lets the excepted systems write, and leaves /healthz alone", async () => {
    const response = await paused.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(otherToken),
      payload: receipt,
    });
    expect(response.statusCode).toBe(201);
    expect(store.readChain(OTHER)).toHaveLength(2);
    expect((await paused.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("a digest salted by the client", () => {
  const nonce = "ab".repeat(32);
  const content = "score: 7";
  const salted = (): string => saltedDigest(new Uint8Array(Buffer.from(nonce, "hex")), content);

  it("is recorded as salted, with its nonce kept apart, and opens with the content", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(),
      payload: {
        actor: { agent: "planner" },
        action: { kind: "tool_call", name: "x" },
        outcome: "ok",
        input_hash: salted(),
        input_nonce: nonce,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const receipt = store.readChain(SYSTEM).at(-1);
    expect(receipt?.v).toBe(4);
    if (receipt?.v !== 4) throw new Error("not v4");
    expect(receipt.input_hash).toBe(salted());
    expect(receipt.input_hash_scheme).toBe("salted");
    expect(JSON.stringify(receipt)).not.toContain(nonce);
    expect(store.opening(SYSTEM, receipt.seq, "input")).toBe(nonce);
    expect(openSaltedDigest(receipt.input_hash ?? "", fromHex(nonce), content)).toBe(true);
  });

  it("refuses a nonce without its digest, beside the value, or malformed", async () => {
    const base = { actor: { agent: "planner" }, action: { kind: "tool_call", name: "x" }, outcome: "ok" };
    for (const payload of [
      { ...base, input_nonce: nonce },
      { ...base, input: content, input_nonce: nonce },
      { ...base, input_hash: salted(), input_nonce: "AB".repeat(32) },
      { ...base, output_hash: null, output_nonce: nonce },
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/v1/receipts", headers: auth(), payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe("POST /v1/traces", () => {
  it("accepts a protobuf export from the official exporter", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(), "content-type": "application/x-protobuf" },
      payload: fixture("otel-genai.protobuf.bin"),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { partialSuccess: unknown; sigillo: { accepted: number; ignored: number } };
    expect(body.partialSuccess).toEqual({});
    expect(body.sigillo.accepted).toBe(5);
    expect(body.sigillo.ignored).toBe(1);

    const chain = store.readChain(SYSTEM);
    expect(chain).toHaveLength(6);
    expect(chain.map((receipt) => receipt.action.kind)).toEqual([
      "genesis",
      "agent_step",
      "llm_call",
      "tool_call",
      "llm_call",
      "agent_step",
    ]);
  });

  it("accepts the same export as JSON and produces the same chain", async () => {
    const asJson = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(), "content-type": "application/json" },
      payload: JSON.parse(fixture("otel-genai.hexids.json").toString("utf8")),
    });
    expect(asJson.statusCode).toBe(200);

    const fromJson = store.readChain(SYSTEM).map((receipt) => ({
      action: receipt.action,
      actor: receipt.actor,
      outcome: receipt.outcome,
      source: receipt.source,
    }));

    // Replay the protobuf encoding into a second system and compare.
    await store.createSystem("second-system", "2026-03-29T14:00:00.000Z");
    const otherToken = keys.issue("second-system", "2026-03-29T14:00:01.000Z").token;
    const asProtobuf = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(otherToken), "content-type": "application/x-protobuf" },
      payload: fixture("otel-genai.protobuf.bin"),
    });
    expect(asProtobuf.statusCode).toBe(200);

    const fromProtobuf = store.readChain("second-system").map((receipt) => ({
      action: receipt.action,
      actor: receipt.actor,
      outcome: receipt.outcome,
      source: receipt.source,
    }));

    expect(fromProtobuf.slice(1)).toEqual(fromJson.slice(1));
  });

  it("accepts an OpenInference export and records digests, never payloads", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(), "content-type": "application/x-protobuf" },
      payload: fixture("openinference.protobuf.bin"),
    });
    expect(response.statusCode).toBe(200);

    const chain = store.readChain(SYSTEM);
    const tool = chain.find((receipt) => receipt.action.name === "search_orders");
    expect(tool?.v === 4 && tool.input_hash_scheme).toBe("salted");
    const nonce = store.opening(SYSTEM, tool?.seq ?? -1, "input") ?? "";
    expect(openSaltedDigest(tool?.input_hash ?? "", fromHex(nonce), '{"order_id":"A-1099"}')).toBe(true);

    const everything = JSON.stringify(chain);
    expect(everything).not.toContain("A-1099");
    expect(everything).not.toContain("where is my order");
  });

  it("reports what it did not recognise instead of hiding it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(), "content-type": "application/x-protobuf" },
      payload: fixture("otel-genai.protobuf.bin"),
    });
    const body = response.json() as { sigillo: { unknown: string[] } };
    expect(body.sigillo.unknown).toContain("gen_ai.operation.name=rerank_documents");
  });

  it("signs every receipt it writes", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(), "content-type": "application/x-protobuf" },
      payload: fixture("openinference.protobuf.bin"),
    });
    for (const receipt of store.readChain(SYSTEM)) {
      expect(verifyReceiptSignature(receipt, signer.publicKey)).toBe(true);
    }
  });

  it("rejects a body that is not an OTLP export", async () => {
    const asProtobuf = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(), "content-type": "application/x-protobuf" },
      payload: Buffer.from([0xff, 0xff, 0xff, 0xff]),
    });
    expect(asProtobuf.statusCode).toBe(400);

    const asJson = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(), "content-type": "application/json" },
      payload: { nothing: "here" },
    });
    expect(asJson.statusCode).toBe(400);
    expect(store.readChain(SYSTEM)).toHaveLength(1);
  });

  it("writes nothing for an export with no spans", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { ...auth(), "content-type": "application/json" },
      payload: { resourceSpans: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(store.readChain(SYSTEM)).toHaveLength(1);
  });
});

describe("POST /api/v1/receipts", () => {
  const minimal = {
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: "search_orders" },
    outcome: "ok",
  };

  it("appends a signed receipt and reports its position", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(),
      payload: minimal,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ seq: 1, system_id: SYSTEM, ts_received: NOW });

    const receipt = store.readChain(SYSTEM)[1];
    expect(receipt?.action).toEqual({ kind: "tool_call", name: "search_orders" });
    expect(receipt?.ts_received).toBe(NOW);
    expect(receipt && verifyReceiptSignature(receipt, signer.publicKey)).toBe(true);
  });

  it("digests a value the caller sends with a salt, and stores no trace of it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(),
      payload: { ...minimal, input: { order_id: "A-1099" }, output: "shipped" },
    });
    expect(response.statusCode).toBe(201);

    const receipt = store.readChain(SYSTEM)[1];
    expect(receipt?.v === 4 && [receipt.input_hash_scheme, receipt.output_hash_scheme]).toEqual(["salted", "salted"]);
    expect(receipt?.input_hash).not.toBe(hashCanonicalJson({ order_id: "A-1099" }));
    const opens = (role: "input" | "output", value: unknown): boolean =>
      openSaltedDigest(receipt?.[`${role}_hash`] ?? "", fromHex(store.opening(SYSTEM, 1, role) ?? ""), value);
    expect(opens("input", { order_id: "A-1099" })).toBe(true);
    expect(opens("output", "shipped")).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("A-1099");
  });

  it("accepts a digest the caller computed instead", async () => {
    const digest = hashCanonicalJson({ order_id: "A-1099" });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(),
      payload: { ...minimal, input_hash: digest },
    });
    expect(response.statusCode).toBe(201);
    expect(store.readChain(SYSTEM)[1]?.input_hash).toBe(digest);
  });

  it("refuses both a value and a digest for the same field", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(),
      payload: { ...minimal, input: "x", input_hash: "a".repeat(64) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toMatch(/not both/);
  });

  it("refuses to write to a system the key does not speak for", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(),
      payload: { ...minimal, system_id: "someone-elses-system" },
    });
    expect(response.statusCode).toBe(403);
    expect(store.readChain(SYSTEM)).toHaveLength(1);
  });

  it("refuses to forge a genesis receipt", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(),
      payload: { ...minimal, action: { kind: "genesis", name: SYSTEM } },
    });
    expect(response.statusCode).toBe(400);
  });

  it("names the offending field when the body is wrong", async () => {
    const cases: [unknown, RegExp][] = [
      [{ ...minimal, outcome: "maybe" }, /outcome/],
      [{ ...minimal, actor: { agent: "" } }, /actor/],
      [{ ...minimal, action: { kind: "tool_call" } }, /action/],
      [{ ...minimal, input_hash: "short" }, /input_hash/],
      [{ ...minimal, extra: true }, /extra/],
      [{}, /actor/],
    ];
    for (const [payload, pattern] of cases) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/receipts",
        headers: auth(),
        payload: payload as Record<string, unknown>,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: string }>().error).toMatch(pattern);
    }
    expect(store.readChain(SYSTEM)).toHaveLength(1);
  });

  it("stamps its own ts_received even when the caller declares a ts_event", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(),
      payload: { ...minimal, ts_event: "2020-01-01T00:00:00.000Z" },
    });
    expect(response.statusCode).toBe(201);
    const receipt = store.readChain(SYSTEM)[1];
    expect(receipt?.ts_event).toBe("2020-01-01T00:00:00.000Z");
    expect(receipt?.ts_received).toBe(NOW);
  });
});

describe("text that would not survive canonicalisation", () => {
  it("refuses a native receipt with half a surrogate pair in a name, and writes nothing", async () => {
    const before = store.readChain(SYSTEM).length;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: auth(),
      payload: {
        actor: { agent: "planner", on_behalf_of: "utente\ud83d" },
        action: { kind: "tool_call", name: "search_orders" },
        outcome: "ok",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/well-formed Unicode/);
    expect(store.readChain(SYSTEM)).toHaveLength(before);
  });

  it("accepts an OTLP span whose model provider is longer than a receipt allows, cut to fit", async () => {
    const before = store.readChain(SYSTEM).length;
    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: auth(),
      payload: {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "4bf92f3577b34da6a3ce929d0e0e0001",
                    spanId: "00f067aa0ba90001",
                    name: "chat",
                    startTimeUnixNano: "1789971053648178106",
                    endTimeUnixNano: "1789971053648204813",
                    attributes: [
                      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
                      { key: "gen_ai.request.model", value: { stringValue: "qwen2.5:3b" } },
                      { key: "gen_ai.provider.name", value: { stringValue: "p".repeat(300) } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const chain = store.readChain(SYSTEM);
    expect(chain).toHaveLength(before + 1);
    const last = chain[chain.length - 1];
    expect(last !== undefined && last.v !== 1 ? last.model?.provider : undefined).toBe("p".repeat(256));
  });
});
