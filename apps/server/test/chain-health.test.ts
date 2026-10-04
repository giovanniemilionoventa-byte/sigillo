import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { it } from "./helpers/italian.js";
import { ChainHealthMonitor, durationWords } from "../src/health/chain-health.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createLocalTsa } from "./helpers/local-tsa.js";
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
  // The signer dates checkpoints by its own clock: here, the test's NOW.
  signer = createTestSigner({ now: () => new Date(NOW) });
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

  it("is green while it waits for its first checkpoint, within the tolerance", () => {
    // The checkpointer seals on its own timer: a system opened a minute ago
    // that has not met it yet has nothing to look at.
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS, 60 * 60_000);
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(Date.parse(NOW) + 60 * 60_000));
    expect(health.status).toBe("green");
    expect(health.message).toContain("primo sigillo in arrivo entro 1 ora");
  });

  it("is yellow once it has waited for its first checkpoint beyond the tolerance", () => {
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS, 60 * 60_000);
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(Date.parse(NOW) + 61 * 60_000));
    expect(health.status).toBe("yellow");
    expect(health.message).toContain("non è ancora stato sigillato, da oltre 1 ora");
  });

  it("stays green while a checkpoint's timestamp is late by less than the tolerance", async () => {
    // The authority may be down for a while: the checkpointer retries, and
    // within the tolerance that is not yet something to look at.
    await store.createCheckpoint(SYSTEM);
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS, 60 * 60_000);
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(Date.parse(NOW) + 60 * 60_000));
    expect(health.status).toBe("green");
    expect(health.message).toContain("marca temporale in arrivo");
  });

  it("turns yellow once a checkpoint has waited for its timestamp beyond the tolerance", async () => {
    await store.createCheckpoint(SYSTEM);
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS, 60 * 60_000);
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(Date.parse(NOW) + 61 * 60_000));
    expect(health.status).toBe("yellow");
    expect(health.message).toContain("manca la marca temporale da oltre 1 ora");
  });

  it("turns yellow when the newest checkpoint was timestamped beyond the tolerance", async () => {
    // What sigillo-verify will warn about in the next export (anchor-delay).
    const checkpoint = await store.createCheckpoint(SYSTEM);
    if (checkpoint === null) throw new Error("no checkpoint");
    const tsa = createLocalTsa();
    try {
      const late = tsa.stampAt(checkpoint.checkpoint.root_hash, new Date(Date.parse(NOW) + 90 * 60_000));
      await store.recordTimestamp(checkpoint.id, "http://tsa.test/", late.toString("base64"), NOW);
    } finally {
      tsa.close();
    }
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS, 60 * 60_000);
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(Date.parse(NOW) + 91 * 60_000));
    expect(health.status).toBe("yellow");
    expect(health.message).toContain("marca temporale è arrivata 90 minuti dopo il sigillo");
  }, 30_000);

  it("is green once anchored and recently active", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM);
    if (checkpoint !== null) {
      await store.recordTimestamp(checkpoint.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), NOW);
    }
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    monitor.check();
    const health = monitor.statusFor(SYSTEM, new Date(NOW));
    expect(health.status).toBe("green");
    expect(health.message).toContain("integro");
  });

  it("turns yellow again once anchored but stale for too long", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM);
    if (checkpoint !== null) {
      await store.recordTimestamp(checkpoint.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), NOW);
    }
    const monitor = new ChainHealthMonitor(store, signer.publicKey, 60_000); // stale after one minute
    monitor.check();
    const muchLater = new Date(Date.parse(NOW) + ONE_DAY_MS);
    const health = monitor.statusFor(SYSTEM, muchLater);
    expect(health.status).toBe("yellow");
    expect(health.message).toContain("nessuna nuova azione da oltre 1 minuto");
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

    const checkpoint = await store.createCheckpoint(SYSTEM);
    if (checkpoint !== null) {
      await store.recordTimestamp(checkpoint.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), NOW);
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

describe("the signer", () => {
  beforeEach(async () => {
    await store.createSystem(SYSTEM, NOW);
  });

  it("not answering turns every system red, and answering again lifts it", async () => {
    let answers = false;
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS, undefined, async () => answers);
    monitor.check();
    await monitor.checkSigner();
    const down = monitor.statusFor(SYSTEM, new Date(NOW));
    expect(down.status).toBe("red");
    expect(down.message).toContain("Il firmatario non risponde");

    answers = true;
    await monitor.checkSigner();
    expect(monitor.statusFor(SYSTEM, new Date(NOW)).status).not.toBe("red");
  });

  it("failing to be asked counts as not answering", async () => {
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS, undefined, async () => {
      throw new Error("socket gone");
    });
    await monitor.checkSigner();
    expect(monitor.statusFor(SYSTEM, new Date(NOW)).status).toBe("red");
  });
});

describe("failedSystems", () => {
  it("names the systems whose chain failed its check, and only those", async () => {
    await store.createSystem(SYSTEM, NOW);
    await store.createSystem("other-bot", NOW);
    await store.append(event());
    const raw = new Database(databasePath);
    raw.exec("DROP TRIGGER receipts_no_update");
    raw.prepare("UPDATE receipts SET sig = ? WHERE system_id = ? AND seq = 1").run("A".repeat(86) + "==", SYSTEM);
    raw.close();
    const monitor = new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS);
    monitor.check();
    expect(monitor.failedSystems()).toEqual([SYSTEM]);
  });
});

describe("durationWords", () => {
  it("says minutes, hours or days as a person would", () => {
    expect(durationWords(1)).toBe("1 minuto");
    expect(durationWords(90)).toBe("90 minuti");
    expect(durationWords(60)).toBe("1 ora");
    expect(durationWords(1440)).toBe("24 ore");
    expect(durationWords(2880)).toBe("2 giorni");
  });
});
