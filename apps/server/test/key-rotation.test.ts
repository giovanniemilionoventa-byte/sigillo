import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readZip } from "@sigillo/core";
import { verifyBundle } from "@sigillo/verifier";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Review point 7: the signing key changes (the key volume was lost and a new
 * key generated, or the key was replaced on purpose). The receipts signed with
 * the old key are still genuine and must stay verifiable: in every export, and
 * on the web view's traffic light. Real SQLite, real Ed25519, two keys.
 */

const SYSTEM = "acme-support-bot";
const PASSWORD = "an administrator password";

let directory: string;
let databasePath: string;
let oldSigner: TestSigner;
let newSigner: TestSigner;

function event(index: number): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: `2026-03-29T14:3${index}:01.005Z`,
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-rotation-"));
  databasePath = join(directory, "sigillo.db");
  oldSigner = createTestSigner();
  newSigner = createTestSigner();

  // The server under the old key...
  const before = ReceiptStore.open(databasePath, oldSigner);
  await before.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
  for (let index = 1; index <= 3; index += 1) await before.append(event(index));
  await before.createCheckpoint(SYSTEM, "2026-03-29T14:40:00.000Z");
  before.close();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("a chain whose signing key changed", () => {
  it("still exports an archive that verifies, publishing both keys", async () => {
    // ...and, after the change, under the new one.
    const store = ReceiptStore.open(databasePath, newSigner);
    const keys = ApiKeyStore.open(databasePath);
    try {
      for (let index = 4; index <= 5; index += 1) await store.append(event(index));
      const monitor = new ChainHealthMonitor(store, newSigner.publicKey, 24 * 60 * 60_000);
      const app = buildServer({
        store,
        keys,
        now: () => new Date("2026-03-29T16:00:00.000Z"),
        ui: {
          password: PASSWORD,
          signerKey: { key_id: newSigner.keyId, public_key_base64: newSigner.publicKeyBase64 },
          healthMonitor: monitor,
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
        const exported = await app.inject({ method: "POST", url: `/ui/systems/${SYSTEM}/export`, headers: { cookie } });
        expect(exported.statusCode).toBe(200);

        const files = new Map(readZip(new Uint8Array(exported.rawPayload)).map((entry) => [entry.name, entry.data]));
        const decode = (name: string): string => new TextDecoder().decode(files.get(name) ?? new Uint8Array());
        const result = verifyBundle({
          manifestJson: decode("manifest.json"),
          receiptsJsonl: decode("receipts.jsonl"),
          checkpointsJsonl: decode("checkpoints.jsonl"),
        });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        if (result.ok) expect(result.summary.key_ids.sort()).toEqual([oldSigner.keyId, newSigner.keyId].sort());

        // The traffic light verifies the old receipts with the old key: not red.
        monitor.check();
        const home = await app.inject({ method: "GET", url: "/ui", headers: { cookie } });
        expect(home.body).not.toContain('class="status-word red"');
      } finally {
        await app.close();
      }
    } finally {
      keys.close();
      store.close();
    }
  });

  it("remembers every key it has signed with, and nothing can erase one", async () => {
    const store = ReceiptStore.open(databasePath, newSigner);
    try {
      expect(store.signingKeys().map((key) => key.key_id).sort()).toEqual([oldSigner.keyId, newSigner.keyId].sort());
      expect(store.signingKeys().find((key) => key.key_id === oldSigner.keyId)?.public_key_base64).toBe(
        oldSigner.publicKeyBase64,
      );
    } finally {
      store.close();
    }
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(databasePath);
    try {
      expect(() => raw.prepare("DELETE FROM signing_keys").run()).toThrow(/append-only/);
      expect(() => raw.prepare("UPDATE signing_keys SET public_key_base64 = 'x'").run()).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });
});
