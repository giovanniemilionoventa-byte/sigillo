import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore, type ChainEvent, type SigningService } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Review point 13: writes that did not go through the store's write queue.
 * While a receipt waits for its signature, its IMMEDIATE transaction is open;
 * a timestamp recorded on the same connection joined that transaction (and
 * was lost if it rolled back), and an API key issued from the web view, on
 * another connection, waited for the lock synchronously, freezing the process.
 *
 * The signatures are real Ed25519; the test only decides when each one is
 * handed back, the way a slow signer would.
 */

const SYSTEM = "acme-support-bot";
const PASSWORD = "an administrator password";

let directory: string;
let databasePath: string;
let real: TestSigner;
let store: ReceiptStore;
/** Signatures held back until released, in the order they were asked for. */
let held: { release: () => void; fail: () => void }[];
let holding = false;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-queue-"));
  databasePath = join(directory, "sigillo.db");
  real = createTestSigner();
  held = [];
  holding = false;
  const slow: SigningService = {
    keyId: real.keyId,
    publicKeyBase64: real.publicKeyBase64,
    sign: async (digest) => {
      const signature = await real.sign(digest);
      if (!holding) return signature;
      return new Promise<string>((resolve, reject) => {
        held.push({ release: () => resolve(signature), fail: () => reject(new Error("the signer gave up")) });
      });
    },
  };
  store = ReceiptStore.open(databasePath, slow);
  await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
  await store.append(event(1));
  await store.createCheckpoint(SYSTEM, "2026-03-29T14:10:00.000Z");
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function event(index: number): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: "2026-03-29T14:30:01.005Z",
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  };
}

async function heldSignatures(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && held.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(held).toHaveLength(count);
}

describe("a timestamp recorded while a receipt waits for its signature", () => {
  it("is kept when that receipt's write fails", async () => {
    const checkpoint = store.latestCheckpoint(SYSTEM);
    if (checkpoint === null) throw new Error("no checkpoint");

    holding = true;
    const append = store.append(event(2));
    await heldSignatures(1);

    const recorded = store.recordTimestamp(checkpoint.id, "https://tsa.test/", "MAMCAQA=", "2026-03-29T14:10:05.000Z");
    held[0]?.fail();
    await expect(append).rejects.toThrow(/gave up/);
    await recorded;

    expect(store.readTimestamps(checkpoint.id)).toHaveLength(1);
  });
});

describe("an API key issued from the web view while a receipt waits for its signature", () => {
  it("waits its turn without freezing the process, and is issued", async () => {
    const keys = ApiKeyStore.open(databasePath);
    const app = buildServer({
      store,
      keys,
      now: () => new Date("2026-03-29T16:00:00.000Z"),
      ui: {
        password: PASSWORD,
        signerKey: { key_id: real.keyId, public_key_base64: real.publicKeyBase64 },
        healthMonitor: new ChainHealthMonitor(store, real.publicKey, 24 * 60 * 60_000),
        checkpointer: new Checkpointer({ store, now: () => new Date("2026-03-29T16:00:00.000Z") }),
      },
    });
    await app.ready();
    try {
      const login = await app.inject({
        method: "POST",
        url: "/ui/login",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `password=${encodeURIComponent(PASSWORD)}`,
      });
      const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";

      // The genesis of the new system is signed (held, then released); right
      // behind it in the queue, an agent's receipt, whose signature is held.
      holding = true;
      const creating = app.inject({
        method: "POST",
        url: "/ui/sistemi",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        payload: "system_id=new-system",
      });
      await heldSignatures(1);
      const agent = store.append(event(3));
      held[0]?.release();
      await heldSignatures(2);

      // The process must stay responsive while that receipt waits.
      const started = Date.now();
      await new Promise((resolve) => setImmediate(resolve));
      expect(Date.now() - started).toBeLessThan(1000);

      held[1]?.release();
      const created = await creating;
      await agent;
      expect(created.statusCode, created.body).toBe(200);
      expect(created.body).toMatch(/sigillo_[0-9a-f]{16}_[0-9a-f]{64}/);
      expect(keys.list("new-system")).toHaveLength(1);
    } finally {
      await app.close();
      keys.close();
    }
  }, 30_000);
});
