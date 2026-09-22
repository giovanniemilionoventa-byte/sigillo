import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

const SYSTEM = "acme-support-bot";
const NOW = "2026-03-29T14:30:00.000Z";
const ONE_DAY_MS = 24 * 60 * 60_000;

let directory: string;
let databasePath: string;
let signer: TestSigner;
let store: ReceiptStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-health-"));
  databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function event(overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: NOW,
    ts_received: NOW,
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: "search_orders" },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
    ...overrides,
  };
}

describe("a system with no receipts", () => {
  it("is yellow: nothing has been recorded yet", () => {
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    // listSystems() is empty, but statusFor must still answer sanely for a name it has never seen.
    expect(monitor.statusFor("never-created", new Date(NOW)).status).toBe("yellow");
  });
});

describe("a freshly created system", () => {
  beforeEach(async () => {
    await store.createSystem(SYSTEM, NOW);
  });

  it("is yellow before any checkpoint anchors it", () => {
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(NOW));
    expect(health.status).toBe("yellow");
    expect(health.message).toContain("marca temporale");
  });

  it("is yellow when a checkpoint exists but has no timestamp yet", async () => {
    await store.createCheckpoint(SYSTEM, NOW);
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    monitor.check();
    expect(monitor.statusFor(SYSTEM, new Date(NOW)).status).toBe("yellow");
  });

  it("is green once anchored and recently active", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM, NOW);
    if (checkpoint !== null) {
      store.recordTimestamp(checkpoint.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), NOW);
    }
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(NOW));
    expect(health.status).toBe("green");
    expect(health.message).toContain("integro");
  });

  it("turns yellow again once anchored but stale for too long", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM, NOW);
    if (checkpoint !== null) {
      store.recordTimestamp(checkpoint.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), NOW);
    }
    const monitor = new ChainHealthMonitor(store, signer.publicKey, 60_000); // stale after one minute
    monitor.check();
    const muchLater = new Date(Date.parse(NOW) + ONE_DAY_MS);
    const health = monitor.statusFor(SYSTEM, muchLater);
    expect(health.status).toBe("yellow");
    expect(health.message).toContain("nessuna attività");
  });

  it("checks incrementally: a second call does not re-read what the first already verified", async () => {
    await store.append(event());
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    monitor.check();

    let called = 0;
    const originalReadChainFrom = store.readChainFrom.bind(store);
    store.readChainFrom = (systemId: string, afterSeq: number) => {
      called += 1;
      expect(afterSeq).toBeGreaterThanOrEqual(0); // not -1: it remembers where it left off
      return originalReadChainFrom(systemId, afterSeq);
    };

    monitor.check();
    expect(called).toBeGreaterThan(0);
  });

  it("stays green across multiple checks as new valid receipts arrive", async () => {
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    monitor.check();
    await store.append(event());
    monitor.check();
    await store.append(event({ action: { kind: "tool_call", name: "call-2" } }));
    monitor.check();

    const checkpoint = await store.createCheckpoint(SYSTEM, NOW);
    if (checkpoint !== null) {
      store.recordTimestamp(checkpoint.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), NOW);
    }
    monitor.check();
    expect(monitor.statusFor(SYSTEM, new Date(NOW)).status).toBe("green");
  });

  it("turns red, and stays red, once a receipt's signature no longer verifies", async () => {
    await store.append(event());
    await store.append(event({ action: { kind: "tool_call", name: "call-2" } }));

    // Simulate what SECURITY.md says the append-only triggers cannot stop: an
    // attacker with the file itself. A live connection cannot do this through
    // the store's own API, so the trigger is dropped on a second connection,
    // exactly as a determined attacker would have to work around it too.
    const raw = new Database(databasePath);
    raw.exec("DROP TRIGGER receipts_no_update");
    const row = raw
      .prepare("SELECT canonical FROM receipts WHERE system_id = ? AND seq = 1")
      .get(SYSTEM) as { canonical: string };
    const tampered = JSON.parse(row.canonical) as { outcome: string };
    tampered.outcome = tampered.outcome === "ok" ? "error" : "ok";
    raw
      .prepare("UPDATE receipts SET canonical = ? WHERE system_id = ? AND seq = 1")
      .run(JSON.stringify(tampered), SYSTEM);
    raw.close();

    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(NOW));
    expect(health.status).toBe("red");
    expect(health.message).toContain("Verifica fallita");

    // Sticky: appending a perfectly good receipt afterwards does not clear it.
    await store.append(event({ action: { kind: "tool_call", name: "call-3" } })).catch(() => undefined);
    monitor.check();
    expect(monitor.statusFor(SYSTEM, new Date(NOW)).status).toBe("red");
  });
});

describe("chains of different systems", () => {
  it("keeps one system's red status from affecting another's", async () => {
    const OTHER = "acme-billing-bot";
    await store.createSystem(SYSTEM, NOW);
    await store.createSystem(OTHER, NOW);
    await store.append(event());
    await store.append(event({ system_id: OTHER }));

    const raw = new Database(databasePath);
    raw.exec("DROP TRIGGER receipts_no_update");
    const row = raw
      .prepare("SELECT canonical FROM receipts WHERE system_id = ? AND seq = 1")
      .get(SYSTEM) as { canonical: string };
    const tampered = JSON.parse(row.canonical) as { outcome: string };
    tampered.outcome = "error";
    raw
      .prepare("UPDATE receipts SET canonical = ? WHERE system_id = ? AND seq = 1")
      .run(JSON.stringify(tampered), SYSTEM);
    raw.close();

    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    monitor.check();
    expect(monitor.statusFor(SYSTEM, new Date(NOW)).status).toBe("red");
    expect(monitor.statusFor(OTHER, new Date(NOW)).status).not.toBe("red");
  });
});
