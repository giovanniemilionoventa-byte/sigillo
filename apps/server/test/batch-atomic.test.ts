import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyFile, loadKeyFile, startSignerDaemon, type SignerDaemon } from "../../signer/src/index.js";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { buildServer } from "../src/http/server.js";
import { SignerClient } from "../src/signer/client.js";
import { ReceiptStore, type SigningService } from "../src/storage/store.js";

/** These tests write at fixed dates; the signer's clock check has tests of its own. */
const ANY_CLOCK = Number.POSITIVE_INFINITY;

/**
 * Review point 6: when the signer failed part-way through an OTLP batch, the
 * server answered 503, the exporter sent the whole batch again, and the spans
 * written the first time were written twice, for good. A real signer daemon,
 * killed after it has signed the first receipt of a batch; a real
 * SignerClient; real SQLite.
 *
 * The batch used to be one transaction, all or nothing. Since the signer
 * keeps its own record of every chain, a receipt it has signed must not be
 * rolled back here: each receipt is committed as soon as it is signed, and
 * the resend is written once because the spans already written are found by
 * trace_id/span_id.
 */

const SYSTEM = "acme-support-bot";

let directory: string;
let socketPath: string;
let keyPath: string;
let daemon: SignerDaemon | undefined;
let client: SignerClient;
let store: ReceiptStore;
let keys: ApiKeyStore;
let token: string;
let app: FastifyInstance;
/** Set to make the signer daemon go away right after the next signature. */
let dieAfterNextSignature = false;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-batch-"));
  socketPath = join(directory, "signer.sock");
  keyPath = join(directory, "signer.key");
  daemon = await startSignerDaemon({ socketPath, stateDir: join(directory, "signer-state"), clockToleranceMs: ANY_CLOCK, key: generateKeyFile(keyPath) });
  client = await SignerClient.connect(socketPath, { timeoutMs: 1000 });
  // The real client, with one hook: the moment the daemon dies is chosen by
  // the test, so that it falls between two receipts of the same batch.
  const signer: SigningService = {
    keyId: client.keyId,
    publicKeyBase64: client.publicKeyBase64,
    checkpoint: (systemId) => client.checkpoint(systemId),
    head: (systemId) => client.head(systemId),
    signReceipt: async (receipt) => {
      const signature = await client.signReceipt(receipt);
      if (dieAfterNextSignature) {
        dieAfterNextSignature = false;
        await daemon?.close();
        daemon = undefined;
      }
      return signature;
    },
  };
  const databasePath = join(directory, "sigillo.db");
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
  keys = ApiKeyStore.open(databasePath);
  token = keys.issue(SYSTEM, "2026-03-29T14:00:00.000Z").token;
  app = buildServer({ store, keys });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  client.close();
  await daemon?.close();
  rmSync(directory, { recursive: true, force: true });
});

function batch(count: number): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: Array.from({ length: count }, (_, index) => ({
              traceId: "0af7651916cd43dd8448eb211c80319c",
              spanId: `b7ad6b716920333${index}`,
              name: `tool-${index}`,
              startTimeUnixNano: String(1774795801000000000n + BigInt(index)),
              endTimeUnixNano: String(1774795802000000000n + BigInt(index)),
              attributes: [
                { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
                { key: "tool.name", value: { stringValue: `tool-${index}` } },
              ],
            })),
          },
        ],
      },
    ],
  };
}

const send = (count: number): Promise<number> =>
  app
    .inject({
      method: "POST",
      url: "/v1/traces",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: batch(count),
    })
    .then((response) => response.statusCode);

describe("an OTLP batch", () => {
  it("keeps what the signer signed before it failed, so the exporter's retry writes each span once", async () => {
    dieAfterNextSignature = true;
    expect(await send(3)).toBe(503);
    // The one receipt the signer signed is kept, and nothing after it.
    expect(store.readChain(SYSTEM).map((receipt) => receipt.action.name)).toEqual([SYSTEM, "tool-0"]);

    // The signer comes back, and the exporter sends the same batch again.
    daemon = await startSignerDaemon({ socketPath, stateDir: join(directory, "signer-state"), clockToleranceMs: ANY_CLOCK, key: loadKeyFile(keyPath) });
    expect(await send(3)).toBe(200);
    const names = store.readChain(SYSTEM).map((receipt) => receipt.action.name);
    expect(names).toEqual([SYSTEM, "tool-0", "tool-1", "tool-2"]);
  });

  it("still leaves no gap and no half-written row behind", async () => {
    dieAfterNextSignature = true;
    await send(3);
    daemon = await startSignerDaemon({ socketPath, stateDir: join(directory, "signer-state"), clockToleranceMs: ANY_CLOCK, key: loadKeyFile(keyPath) });
    expect(await send(2)).toBe(200);
    expect(store.readChain(SYSTEM).map((receipt) => receipt.seq)).toEqual([0, 1, 2]);
  });
});
