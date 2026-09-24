import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicKeyFromRaw } from "@sigillo/core";
import { generateKeyFile, startSignerDaemon, type SignerDaemon } from "../../signer/src/index.js";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer, type ServerOptions } from "../src/http/server.js";
import { SignerClient } from "../src/signer/client.js";
import { ReceiptStore } from "../src/storage/store.js";

/**
 * The server as production runs it: a real signer daemon on a real socket, a
 * real SignerClient, real SQLite. What is checked here is how it behaves when
 * something around it fails, and what it writes to its log.
 */

const SYSTEM = "acme-support-bot";
const PASSWORD = "an administrator password";

let directory: string;
let databasePath: string;
let socketPath: string;
let keyPath: string;
let daemon: SignerDaemon | undefined;
let signer: SignerClient;
let store: ReceiptStore;
let keys: ApiKeyStore;
let token: string;
let logLines: string[];
let app: FastifyInstance;

async function start(overrides: Partial<ServerOptions> = {}): Promise<FastifyInstance> {
  const server = buildServer({
    store,
    keys,
    signerHealthy: () => signer.healthy(),
    logStream: new Writable({
      write(chunk: Buffer, _encoding, done) {
        logLines.push(chunk.toString("utf8"));
        done();
      },
    }),
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(
        store,
        publicKeyFromRaw(new Uint8Array(Buffer.from(signer.publicKeyBase64, "base64"))),
        24 * 60 * 60_000,
      ),
      checkpointer: new Checkpointer({ store, now: () => new Date() }),
    },
    ...overrides,
  });
  await server.ready();
  return server;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-hardening-"));
  databasePath = join(directory, "sigillo.db");
  socketPath = join(directory, "signer.sock");
  keyPath = join(directory, "signer.key");
  daemon = await startSignerDaemon({ socketPath, key: generateKeyFile(keyPath) });
  signer = await SignerClient.connect(socketPath, { timeoutMs: 1000 });
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
  keys = ApiKeyStore.open(databasePath);
  token = keys.issue(SYSTEM, "2026-03-29T14:00:00.000Z").token;
  logLines = [];
  app = await start();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  signer.close();
  await daemon?.close();
  rmSync(directory, { recursive: true, force: true });
});

const receipt = {
  actor: { agent: "planner" },
  action: { kind: "tool_call", name: "lookup" },
  outcome: "ok",
};

describe("when the signer goes away", () => {
  it("/healthz says so, and says ok again once it is back", async () => {
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);

    await daemon?.close();
    daemon = undefined;
    const down = await app.inject({ method: "GET", url: "/healthz" });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: "signer unavailable" });

    daemon = await startSignerDaemon({ socketPath, key: generateKeyFile(join(directory, "unused.key")) });
    // A signer with a different key is not "back".
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(503);
    await daemon.close();

    const { loadKeyFile } = await import("../../signer/src/index.js");
    daemon = await startSignerDaemon({ socketPath, key: loadKeyFile(keyPath) });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });

  it("answers a native receipt with 503, which a client may retry, not 400", async () => {
    await daemon?.close();
    daemon = undefined;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: { authorization: `Bearer ${token}` },
      payload: receipt,
    });
    expect(response.statusCode).toBe(503);
    expect(store.readChain(SYSTEM)).toHaveLength(1);
  });

  it("answers an OTLP batch with 503 too, without the internal message", async () => {
    await daemon?.close();
    daemon = undefined;
    const response = await app.inject({
      method: "POST",
      url: "/v1/traces",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: {
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "0af7651916cd43dd8448eb211c80319c",
                    spanId: "b7ad6b7169203331",
                    name: "tool",
                    startTimeUnixNano: "1774795801000000000",
                    endTimeUnixNano: "1774795802000000000",
                    attributes: [
                      { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
                      { key: "tool.name", value: { stringValue: "lookup" } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(socketPath);
  });
});

describe("guessing API keys", () => {
  it("stops paying for scrypt after too many wrong keys from one address", async () => {
    const limited = await start({ ingestLimits: { maxFailures: 3, windowMs: 60_000, lockoutMs: 60_000, maxLockoutMs: 60_000 } });
    try {
      const keyId = token.split("_")[1] ?? "";
      const wrong = `sigillo_${keyId}_${"0".repeat(64)}`;
      for (let i = 0; i < 3; i += 1) {
        const response = await limited.inject({
          method: "POST",
          url: "/api/v1/receipts",
          headers: { authorization: `Bearer ${wrong}` },
          payload: receipt,
        });
        expect(response.statusCode).toBe(401);
      }

      // Locked out: a key the server has never checked is refused without
      // being checked, even a genuine one...
      const fresh = keys.issue(SYSTEM, "2026-03-29T14:00:00.000Z").token;
      const refused = await limited.inject({
        method: "POST",
        url: "/api/v1/receipts",
        headers: { authorization: `Bearer ${fresh}` },
        payload: receipt,
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.body).toBe(
        (
          await limited.inject({
            method: "POST",
            url: "/api/v1/receipts",
            headers: { authorization: `Bearer ${wrong}` },
            payload: receipt,
          })
        ).body,
      );
    } finally {
      await limited.close();
    }
  });

  it("keeps serving an agent whose key it already knows, from the same address", async () => {
    const limited = await start({ ingestLimits: { maxFailures: 3, windowMs: 60_000, lockoutMs: 60_000, maxLockoutMs: 60_000 } });
    try {
      const send = (bearer: string): Promise<number> =>
        limited
          .inject({ method: "POST", url: "/api/v1/receipts", headers: { authorization: `Bearer ${bearer}` }, payload: receipt })
          .then((response) => response.statusCode);

      expect(await send(token)).toBe(201);
      for (let i = 0; i < 5; i += 1) expect(await send(`sigillo_${"1".repeat(16)}_${"0".repeat(64)}`)).toBe(401);
      expect(await send(token)).toBe(201);
    } finally {
      await limited.close();
    }
  });
});

describe("what the log holds", () => {
  it("holds no password, no API key, no request body and no query string", async () => {
    const marker = "a-sentence-from-a-prompt-that-must-never-be-logged";
    const documentHash = "5f".repeat(32);

    const login = await app.inject({
      method: "POST",
      url: "/ui/login",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent(PASSWORD)}`,
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    await app.inject({ method: "GET", url: `/ui/verify-document?sha256=${documentHash}`, headers: { cookie } });
    await app.inject({ method: "GET", url: `/ui/systems/${SYSTEM}?name=${marker}`, headers: { cookie } });
    await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...receipt, input: marker, output: { text: marker } },
    });
    // A body that fails to parse: JSON.parse quotes the text it choked on.
    await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: `{"input": "${marker}" oops`,
    });
    // And a failure inside the server.
    await daemon?.close();
    daemon = undefined;
    await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...receipt, input: marker },
    });

    const log = logLines.join("");
    expect(log.length).toBeGreaterThan(0);
    // The requests are there...
    expect(log).toContain("/ui/verify-document");
    expect(log).toContain("/api/v1/receipts");
    // ...and nothing that was in them.
    for (const secret of [PASSWORD, encodeURIComponent(PASSWORD), token, token.split("_")[2] ?? "", marker, documentHash, "sha256="]) {
      expect(log, secret).not.toContain(secret);
    }
    expect(log).not.toMatch(/sigillo_session=/);
  });
});
