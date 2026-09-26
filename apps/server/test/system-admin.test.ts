import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readZip } from "@sigillo/core";
import { verifyBundle } from "@sigillo/verifier";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { buildArchive } from "../src/export/archive.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import {
  normaliseDisplayName,
  ReceiptStore,
  StorageError,
  SystemNotDeletableError,
  type ChainEvent,
} from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Renaming, archiving and deleting a system (redesign session, M1–M3), on the
 * real store, the real signer and the real verifier. What these operations
 * touch is labels and, for an empty system only, its whole footprint; what
 * they must never touch is a receipt of a chain that recorded anything.
 */

const SYSTEM = "acme-support-bot";
const EMPTY = "prova-per-errore";
const ADMIN = { actor: "cli tester@test", ts: "2026-09-26T10:00:00.000Z" };

let directory: string;
let databasePath: string;
let signer: TestSigner;
let store: ReceiptStore;

function event(index: number, systemId = SYSTEM): ChainEvent {
  return {
    system_id: systemId,
    ts_event: "2026-09-26T09:00:00.000Z",
    ts_received: `2026-09-26T09:0${index}:00.000Z`,
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  };
}

/** Every stored byte of every receipt: what must not change. */
function receiptRows(): unknown[] {
  const raw = new Database(databasePath, { readonly: true });
  try {
    return raw.prepare("SELECT system_id, seq, hash, prev_hash, canonical, sig, key_id FROM receipts ORDER BY id").all();
  } finally {
    raw.close();
  }
}

async function exportOf(systemId: string, exportedAt: string): Promise<Map<string, string>> {
  const archive = await buildArchive({
    systemId,
    displayName: store.systemRecord(systemId)?.display_name ?? null,
    receipts: store.readChain(systemId),
    checkpoints: store.readCheckpoints(systemId).map((stored) => ({
      stored,
      timestamps: store.readTimestamps(stored.id),
    })),
    chainLeaves: store.readReceiptHashes(systemId),
    keys: store.signingKeys(),
    exportedAt,
  });
  return new Map(readZip(archive.zip).map((entry) => [entry.name, new TextDecoder().decode(entry.data)]));
}

function verifies(files: Map<string, string>): boolean {
  return verifyBundle({
    manifestJson: files.get("manifest.json") ?? "",
    receiptsJsonl: files.get("receipts.jsonl") ?? "",
    checkpointsJsonl: files.get("checkpoints.jsonl") ?? "",
    artifactsIndexJsonl: files.get("artifacts-index.jsonl") ?? "",
  }).ok;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-admin-"));
  databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, "2026-09-26T08:00:00.000Z");
  for (let index = 1; index <= 3; index += 1) await store.append(event(index));
  await store.createSystem(EMPTY, "2026-09-26T08:30:00.000Z");
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("M1: display_name", () => {
  it("starts empty, so the system_id is what is shown", () => {
    expect(store.systemRecord(SYSTEM)).toMatchObject({
      system_id: SYSTEM,
      display_name: null,
      archived_at: null,
      receipts: 4,
    });
  });

  it("renames without touching the system_id or a single byte of any receipt", async () => {
    const before = receiptRows();
    await store.renameSystem(SYSTEM, "Assistente clienti", ADMIN);
    expect(store.systemRecord(SYSTEM)?.display_name).toBe("Assistente clienti");
    expect(store.listSystems()).toEqual([SYSTEM, EMPTY].sort());
    expect(receiptRows()).toEqual(before);
    expect(store.readChain(SYSTEM).every((receipt) => receipt.system_id === SYSTEM)).toBe(true);
  });

  it("renames as often as asked, and an empty name clears it", async () => {
    const before = receiptRows();
    expect(await store.renameSystem(SYSTEM, "Primo", ADMIN)).toBeNull();
    expect(await store.renameSystem(SYSTEM, "  Secondo  ", ADMIN)).toBe("Primo");
    expect(store.systemRecord(SYSTEM)?.display_name).toBe("Secondo");
    expect(await store.renameSystem(SYSTEM, "Secondo", ADMIN)).toBe("Secondo");
    expect(await store.renameSystem(SYSTEM, "   ", ADMIN)).toBe("Secondo");
    expect(store.systemRecord(SYSTEM)?.display_name).toBeNull();
    // Two systems may share a label: it identifies nothing.
    await store.renameSystem(EMPTY, "Primo", ADMIN);
    await store.renameSystem(SYSTEM, "Primo", ADMIN);
    expect(receiptRows()).toEqual(before);
  });

  it("logs every rename with who, when, and the name before and after", async () => {
    await store.renameSystem(SYSTEM, "Primo", ADMIN);
    await store.renameSystem(SYSTEM, "Secondo", { actor: "web 203.0.113.9", ts: "2026-09-26T11:00:00.000Z" });
    const [latest, first] = store.adminLog();
    expect(first).toMatchObject({ action: "system.rename", system_id: SYSTEM, actor: ADMIN.actor, ts: ADMIN.ts });
    expect(first?.detail).toEqual({ from: null, to: "Primo" });
    expect(latest).toMatchObject({ actor: "web 203.0.113.9", detail: { from: "Primo", to: "Secondo" } });
  });

  it("accepts almost anything as a label, but not control characters or more than 128 characters", async () => {
    expect(normaliseDisplayName("Selezione CV — 2026 «pilota» 🤖")).toBe("Selezione CV — 2026 «pilota» 🤖");
    expect(normaliseDisplayName("x".repeat(128))).toBe("x".repeat(128));
    for (const bad of ["due\nrighe", "tab\there", "x".repeat(129)]) {
      await expect(store.renameSystem(SYSTEM, bad, ADMIN)).rejects.toBeInstanceOf(StorageError);
    }
    expect(store.systemRecord(SYSTEM)?.display_name).toBeNull();
    expect(store.adminLog()).toEqual([]);
  });

  it("refuses to rename a system that does not exist", async () => {
    await expect(store.renameSystem("never-created", "x", ADMIN)).rejects.toThrow(/unknown system/);
  });

  it("never lets the system_id itself change, from any connection", () => {
    const raw = new Database(databasePath);
    try {
      expect(() => raw.prepare("UPDATE systems SET system_id = 'altro' WHERE system_id = ?").run(SYSTEM)).toThrow(
        /cannot be changed/,
      );
      expect(() => raw.prepare("UPDATE systems SET created_at = 'x' WHERE system_id = ?").run(SYSTEM)).toThrow(
        /cannot be changed/,
      );
    } finally {
      raw.close();
    }
  });

  it("keeps an export made before a rename verifiable, with the name it had then; a new export has the new one", async () => {
    await store.renameSystem(SYSTEM, "Nome di allora", ADMIN);
    const before = await exportOf(SYSTEM, "2026-09-26T12:00:00.000Z");
    await store.renameSystem(SYSTEM, "Nome di adesso", ADMIN);
    const after = await exportOf(SYSTEM, "2026-09-26T13:00:00.000Z");

    expect(verifies(before)).toBe(true);
    expect(verifies(after)).toBe(true);
    expect(before.get("VERIFY.md")).toContain('"Nome di allora"');
    expect(before.get("VERIFY.md")).not.toContain("Nome di adesso");
    expect(after.get("VERIFY.md")).toContain('"Nome di adesso"');
    // The same chain either way: the name is in neither the receipts nor the manifest.
    expect(after.get("receipts.jsonl")).toBe(before.get("receipts.jsonl"));
    for (const files of [before, after]) {
      expect(files.get("manifest.json")).not.toContain("Nome di");
      expect(files.get("receipts.jsonl")).not.toContain("Nome di");
      expect(JSON.parse(files.get("manifest.json") ?? "{}")).not.toHaveProperty("display_name");
    }
  });

  it("says nothing about a name in an export of a system that never had one", async () => {
    const files = await exportOf(SYSTEM, "2026-09-26T12:00:00.000Z");
    expect(files.get("VERIFY.md")).not.toContain("web view showed this system");
  });
});

describe("M2: archiving", () => {
  it("archives and unarchives without touching the chain, and logs both", async () => {
    const before = receiptRows();
    await store.archiveSystem(SYSTEM, ADMIN);
    expect(store.systemRecord(SYSTEM)?.archived_at).toBe(ADMIN.ts);
    // Archiving twice is not a second event.
    await store.archiveSystem(SYSTEM, { ...ADMIN, ts: "2026-09-26T10:05:00.000Z" });
    expect(store.systemRecord(SYSTEM)?.archived_at).toBe(ADMIN.ts);

    await store.unarchiveSystem(SYSTEM, { ...ADMIN, ts: "2026-09-26T10:10:00.000Z" });
    expect(store.systemRecord(SYSTEM)?.archived_at).toBeNull();
    expect(receiptRows()).toEqual(before);
    expect(store.adminLog().map((entry) => entry.action)).toEqual(["system.unarchive", "system.archive"]);
  });

  it("leaves an archived system whole: exportable, verifiable, check pointed and monitored", async () => {
    await store.archiveSystem(SYSTEM, ADMIN);
    const files = await exportOf(SYSTEM, "2026-09-26T12:00:00.000Z");
    expect(verifies(files)).toBe(true);
    expect(files.get("receipts.jsonl")?.trim().split("\n")).toHaveLength(4);

    const checkpointer = new Checkpointer({ store, now: () => new Date("2026-09-26T12:00:00.000Z") });
    const run = await checkpointer.runOnce();
    expect(run.checkpoints.map((written) => written.checkpoint.system_id)).toContain(SYSTEM);

    const monitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000);
    monitor.check();
    expect(monitor.statusFor(SYSTEM, new Date("2026-09-26T12:00:00.000Z")).status).not.toBe("red");
  });

  it("does not by itself stop the store from writing to an archived chain: what refuses new receipts is the API key check, below", async () => {
    // ReceiptStore.append has no notion of archived: a receipt already
    // authenticated (or written by another path entirely, such as the CLI)
    // is still an append-only chain, and archiving is not a second gate on
    // it. The gate is at authentication, in ApiKeyStore.verify.
    await store.archiveSystem(SYSTEM, ADMIN);
    const receipt = await store.append(event(4));
    expect(receipt.seq).toBe(4);
  });
});

describe("M3: deleting", () => {
  it("refuses, on the server, a system with any receipt beyond its genesis — and changes nothing", async () => {
    const before = receiptRows();
    const error = await store.deleteEmptySystem(SYSTEM, ADMIN).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SystemNotDeletableError);
    expect((error as SystemNotDeletableError).receipts).toBe(4);
    expect(receiptRows()).toEqual(before);
    expect(store.hasSystem(SYSTEM)).toBe(true);
    expect(store.adminLog()).toEqual([]);
  });

  it("refuses even a system with a single real action, archived or not", async () => {
    await store.append(event(1, EMPTY));
    await store.archiveSystem(EMPTY, ADMIN);
    await expect(store.deleteEmptySystem(EMPTY, ADMIN)).rejects.toBeInstanceOf(SystemNotDeletableError);
    expect(store.readChain(EMPTY)).toHaveLength(2);
  });

  it("counts what the database holds when it deletes, not what a page showed: a receipt that just arrived stops it", async () => {
    // Both on the write queue, the append first, as when an agent writes
    // between the page being drawn and the button being pressed.
    const appended = store.append(event(1, EMPTY));
    const deletion = store.deleteEmptySystem(EMPTY, ADMIN);
    await appended;
    await expect(deletion).rejects.toBeInstanceOf(SystemNotDeletableError);
    expect(store.readChain(EMPTY)).toHaveLength(2);
  });

  it("deletes an empty system with its checkpoint, token and API keys, and logs who and when", async () => {
    const checkpoint = await store.createCheckpoint(EMPTY, "2026-09-26T09:00:00.000Z");
    expect(checkpoint).not.toBeNull();
    await store.recordTimestamp(checkpoint?.id ?? 0, "https://freetsa.org/tsr", "MAM=", "2026-09-26T09:00:01.000Z");
    const keys = ApiKeyStore.open(databasePath);
    const issued = keys.issue(EMPTY, "2026-09-26T09:00:00.000Z");
    expect(await keys.verify(issued.token)).toBe(EMPTY);
    const genesisHash = store.readReceiptHashes(EMPTY)[0];
    const otherBefore = receiptRows().filter((row) => (row as { system_id: string }).system_id === SYSTEM);

    const deleted = await store.deleteEmptySystem(EMPTY, ADMIN);

    expect(deleted).toMatchObject({
      system_id: EMPTY,
      genesis_hash: genesisHash,
      checkpoints: 1,
      timestamps: 1,
      api_keys: [issued.keyId],
    });
    expect(store.hasSystem(EMPTY)).toBe(false);
    expect(store.listSystems()).toEqual([SYSTEM]);
    expect(store.readChain(EMPTY)).toEqual([]);
    expect(store.readCheckpoints(EMPTY)).toEqual([]);
    expect(store.readTimestamps(checkpoint?.id ?? 0)).toEqual([]);
    // The key it had stops working at once, in a store that had already accepted it.
    expect(await keys.verify(issued.token)).toBeNull();
    keys.close();
    // The other system is exactly as it was.
    expect(receiptRows()).toEqual(otherBefore);

    const [entry] = store.adminLog();
    expect(entry).toMatchObject({ action: "system.delete", system_id: EMPTY, actor: ADMIN.actor, ts: ADMIN.ts });
    expect(entry?.detail).toMatchObject({ genesis_hash: genesisHash, api_keys: [issued.keyId], checkpoints: 1 });
  });

  it("does not give a deleted system's identifier out again", async () => {
    await store.deleteEmptySystem(EMPTY, ADMIN);
    await expect(store.createSystem(EMPTY, "2026-09-26T11:00:00.000Z")).rejects.toThrow(/is not reused/);
    expect(store.hasSystem(EMPTY)).toBe(false);
  });

  it("keeps the administrative log append-only", async () => {
    await store.deleteEmptySystem(EMPTY, ADMIN);
    const raw = new Database(databasePath);
    try {
      expect(() => raw.exec("DELETE FROM admin_log")).toThrow(/append-only/);
      expect(() => raw.exec("UPDATE admin_log SET actor = 'nobody'")).toThrow(/append-only/);
    } finally {
      raw.close();
    }
  });
});

describe("M3: the database itself enforces the rule, against any connection", () => {
  function raw(): Database.Database {
    return new Database(databasePath);
  }

  it("refuses to delete a genesis whose deletion is not logged", () => {
    const connection = raw();
    try {
      expect(() => connection.prepare("DELETE FROM receipts WHERE system_id = ?").run(EMPTY)).toThrow(/append-only/);
      expect(() => connection.prepare("DELETE FROM systems WHERE system_id = ?").run(EMPTY)).toThrow(/append-only/);
    } finally {
      connection.close();
    }
    expect(store.readChain(EMPTY)).toHaveLength(1);
  });

  it("refuses to delete any receipt of a chain with real actions, even with a log entry forged for its genesis", () => {
    const connection = raw();
    try {
      const genesis = store.readReceiptHashes(SYSTEM)[0];
      connection
        .prepare(
          `INSERT INTO admin_log (ts, action, system_id, actor, detail, genesis_hash)
           VALUES ('2026-09-26T10:00:00.000Z', 'system.delete', ?, 'forged', '{}', ?)`,
        )
        .run(SYSTEM, genesis);
      for (const statement of [
        "DELETE FROM receipts WHERE system_id = ?",
        "DELETE FROM receipts WHERE system_id = ? AND seq = 0",
        "DELETE FROM receipts WHERE system_id = ? AND seq = 3",
        "DELETE FROM systems WHERE system_id = ?",
      ]) {
        expect(() => connection.prepare(statement).run(SYSTEM)).toThrow(/append-only/);
      }
    } finally {
      connection.close();
    }
    expect(store.readChain(SYSTEM)).toHaveLength(4);
  });

  it("refuses to delete the checkpoints and tokens of a chain with real actions, log entry or not", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM, "2026-09-26T09:30:00.000Z");
    await store.recordTimestamp(checkpoint?.id ?? 0, "https://freetsa.org/tsr", "MAM=", "2026-09-26T09:30:01.000Z");
    const connection = raw();
    try {
      connection
        .prepare(
          `INSERT INTO admin_log (ts, action, system_id, actor, detail, genesis_hash)
           VALUES ('2026-09-26T10:00:00.000Z', 'system.delete', ?, 'forged', '{}', ?)`,
        )
        .run(SYSTEM, store.readReceiptHashes(SYSTEM)[0]);
      expect(() => connection.exec("DELETE FROM timestamps")).toThrow(/append-only/);
      expect(() => connection.exec("DELETE FROM checkpoints")).toThrow(/append-only/);
    } finally {
      connection.close();
    }
    expect(store.readCheckpoints(SYSTEM)).toHaveLength(1);
  });

  it("migrates a database written before this change: the unconditional triggers give way to the guards", () => {
    store.close();
    const legacyPath = join(directory, "legacy.db");
    const legacy = new Database(legacyPath);
    legacy.exec(`
      CREATE TABLE systems (system_id TEXT PRIMARY KEY, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE receipts (
        id INTEGER PRIMARY KEY, system_id TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL, canonical TEXT NOT NULL, sig TEXT NOT NULL, key_id TEXT NOT NULL,
        ts_event TEXT NOT NULL, ts_received TEXT NOT NULL, action_kind TEXT NOT NULL,
        action_name TEXT NOT NULL, outcome TEXT NOT NULL, UNIQUE (system_id, seq), UNIQUE (hash)
      ) STRICT;
      CREATE TRIGGER receipts_no_delete BEFORE DELETE ON receipts
      BEGIN SELECT RAISE(ABORT, 'append-only: a receipt cannot be deleted'); END;
      INSERT INTO systems VALUES ('old-system', '2026-01-01T00:00:00.000Z');
    `);
    legacy.close();

    store = ReceiptStore.open(legacyPath, signer);
    const check = new Database(legacyPath, { readonly: true });
    try {
      const triggers = (
        check.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string }[]
      ).map((row) => row.name);
      expect(triggers).not.toContain("receipts_no_delete");
      expect(triggers).toContain("receipts_delete_guard");
      expect(triggers).toContain("checkpoints_delete_guard");
      expect(triggers).toContain("timestamps_delete_guard");
      expect(store.systemRecord("old-system")).toMatchObject({ display_name: null, archived_at: null });
    } finally {
      check.close();
    }
  });
});
