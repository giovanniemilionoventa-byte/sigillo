import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * What an agent holding its own system's key must not be able to do (the
 * security audit of 2026-11-07): write a receipt that reads as the server's
 * or the gateway's own, or flood the chain past a per-minute limit.
 */

const SYSTEM = "agent-under-test";
const NOW = "2026-11-07T08:00:00.000Z";

let directory: string;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-audit-"));
  const databasePath = join(directory, "sigillo.db");
  store = ReceiptStore.open(databasePath, createTestSigner());
  await store.createSystem(SYSTEM, "2026-11-07T07:00:00.000Z");
  keys = ApiKeyStore.open(databasePath);
  token = keys.issue(SYSTEM, "2026-11-07T07:00:01.000Z").token;
  app = buildServer({ store, keys, now: () => new Date(NOW), systemReceiptsPerMinute: 5 });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const auth = { authorization: "" };
const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: { ...auth, authorization: `Bearer ${token}` }, payload: payload as object });

const receipt = (name: string, kind = "tool_call") => ({
  actor: { agent: "a" },
  action: { kind, name },
  outcome: "ok",
});

const otlpSpan = (name: string) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: "service.name", value: { stringValue: SYSTEM } }] },
      scopeSpans: [
        {
          spans: [
            {
              traceId: "0af7651916cd43dd8448eb211c80319c",
              spanId: "b7ad6b7169203331",
              name,
              kind: 1,
              startTimeUnixNano: "1762502400000000000",
              endTimeUnixNano: "1762502401000000000",
              attributes: [
                { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
                { key: "tool.name", value: { stringValue: name } },
              ],
              status: {},
            },
          ],
        },
      ],
    },
  ],
});

describe("names only sigillo writes", () => {
  it.each(["sigillo.local_model.open", "sigillo.check.tool_unrecorded", "SIGILLO.connection.stop", "model_requested.send_email", " model_requested.x"])(
    "the native API refuses %s",
    async (name) => {
      const answer = await post("/api/v1/receipts", receipt(name));
      expect(answer.statusCode).toBe(400);
      expect(store.readChain(SYSTEM)).toHaveLength(1);
    },
  );

  it("OTLP drops a span named like one of them, and keeps an ordinary one", async () => {
    const forged = await post("/v1/traces", otlpSpan("model_requested.send_email"));
    expect(forged.statusCode).toBe(200);
    expect(forged.json().sigillo.accepted).toBe(0);
    const honest = await post("/v1/traces", otlpSpan("send_email"));
    expect(honest.json().sigillo.accepted).toBe(1);
    expect(store.readChain(SYSTEM).map((r) => r.action.name)).toEqual([SYSTEM, "send_email"]);
  });

  it("an ordinary name is still written", async () => {
    expect((await post("/api/v1/receipts", receipt("payments.refund"))).statusCode).toBe(201);
  });
});

describe("the guard's alarms", () => {
  const session = "0123456789abcdef0123456789abcdef";

  it("are written by the server, once per session and kind, for an open session", async () => {
    expect((await post("/api/v1/heartbeat", { session, event: "start" })).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect((await post("/api/v1/heartbeat", { session, event: "alarm", alarm: "model_foreign" })).statusCode).toBe(200);
    }
    await post("/api/v1/heartbeat", { session, event: "alarm", alarm: "model_open" });
    const names = store.readChain(SYSTEM).map((r) => r.action.name);
    expect(names.filter((n) => n === "sigillo.connection.model_foreign")).toHaveLength(1);
    expect(names.filter((n) => n === "sigillo.connection.model_open")).toHaveLength(1);
    const alarm = store.readChain(SYSTEM).find((r) => r.action.name === "sigillo.connection.model_foreign");
    expect(alarm?.outcome).toBe("error");
  });

  it("need a kind, and write nothing for a session never opened", async () => {
    expect((await post("/api/v1/heartbeat", { session, event: "alarm" })).statusCode).toBe(400);
    expect((await post("/api/v1/heartbeat", { session, event: "alarm", alarm: "model_open" })).statusCode).toBe(200);
    expect(store.readChain(SYSTEM)).toHaveLength(1);
  });
});

describe("a per-system limit per minute", () => {
  it("refuses with 429 and Retry-After past it, writing nothing", async () => {
    for (let i = 0; i < 5; i++) expect((await post("/api/v1/receipts", receipt(`step${i}`))).statusCode).toBe(201);
    const refused = await post("/api/v1/receipts", receipt("one too many"));
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    expect(store.readChain(SYSTEM)).toHaveLength(6);
  });

  it("does not count heartbeats", async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post("/api/v1/heartbeat", { session: `${"a".repeat(31)}${i}`, event: "start" })).statusCode).toBe(200);
    }
  });
});
