import Database from "better-sqlite3";
import {
  canonicalReceiptBytes,
  checkpointHash,
  fromHex,
  GENESIS_PREV_HASH,
  merkleRoot,
  parseCheckpoint,
  parseReceipt,
  parseUnsignedReceipt,
  receiptHash,
  RECEIPT_VERSION,
  toHex,
  type Action,
  type Actor,
  type Checkpoint,
  type Outcome,
  type Receipt,
  type Source,
} from "@sigillo/core";
import { SCHEMA_SQL } from "./schema.js";

/** Whatever holds the private key. In production this is the separate signer process. */
export interface SigningService {
  readonly keyId: string;
  sign(digest: Uint8Array): Promise<string>;
}

/** An action to be recorded. Its position in the chain is not the caller's to choose. */
export interface ChainEvent {
  system_id: string;
  ts_event: string;
  ts_received: string;
  actor: Actor;
  action: Action;
  input_hash: string | null;
  output_hash: string | null;
  outcome: Outcome;
  source: Source;
}

export interface ChainTip {
  seq: number;
  hash: string;
}

/** A checkpoint as stored, with the row id that timestamp tokens hang from. */
export interface StoredCheckpoint {
  id: number;
  checkpoint: Checkpoint;
}

export interface StoredTimestamp {
  tsaUrl: string;
  tokenBase64: string;
  obtainedAt: string;
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

interface StoredRow {
  canonical: string;
  sig: string;
}

interface CheckpointRow {
  id: number;
  system_id: string;
  tree_size: number;
  root_hash: string;
  ts: string;
  key_id: string;
  sig: string;
}

function rowToCheckpoint(row: CheckpointRow): StoredCheckpoint {
  return {
    id: row.id,
    checkpoint: parseCheckpoint({
      v: RECEIPT_VERSION,
      system_id: row.system_id,
      tree_size: row.tree_size,
      root_hash: row.root_hash,
      ts: row.ts,
      key_id: row.key_id,
      sig: row.sig,
    }),
  };
}

function rowToReceipt(row: StoredRow): Receipt {
  return parseReceipt({ ...(JSON.parse(row.canonical) as object), sig: row.sig });
}

/**
 * One process owns the database. Writes inside that process are serialised by a
 * promise chain, and the SQLite IMMEDIATE transaction is what makes the position
 * assignment atomic against anything else holding the file.
 *
 * A second writing process is out of scope, by design and by the specification:
 * because the signer is called while the write transaction is open, two writers
 * in one process would hold the lock across each other's await. What is
 * supported, and tested, is a new process taking over the file after the
 * previous one stopped — the tip is always read from the database, never
 * remembered in memory.
 */
export class ReceiptStore {
  /** Writes are serialised through this promise: one open transaction at a time. */
  private writes: Promise<unknown> = Promise.resolve();

  private readonly tipStatement: Database.Statement;
  private readonly insertStatement: Database.Statement;
  private readonly registerStatement: Database.Statement;

  private constructor(
    private readonly write: Database.Database,
    private readonly read: Database.Database,
    private readonly signer: SigningService | undefined,
  ) {
    this.tipStatement = this.write.prepare(
      "SELECT seq, hash FROM receipts WHERE system_id = ? ORDER BY seq DESC LIMIT 1",
    );
    this.registerStatement = this.write.prepare(
      "INSERT INTO systems (system_id, created_at) VALUES (@system_id, @created_at)",
    );
    this.insertStatement = this.write.prepare(
      `INSERT INTO receipts (system_id, seq, hash, prev_hash, canonical, sig, key_id,
                             ts_event, ts_received, action_kind, action_name, outcome)
       VALUES (@system_id, @seq, @hash, @prev_hash, @canonical, @sig, @key_id,
               @ts_event, @ts_received, @action_kind, @action_name, @outcome)`,
    );
  }

  /**
   * Opens the database at `location`, which must be a file path: reads use a
   * second, read-only connection so that a query can never see rows from a
   * write transaction that is still open.
   *
   * Without a signer the store reads but cannot write, which is what a listing
   * or an export needs.
   */
  static open(location: string, signer?: SigningService): ReceiptStore {
    const write = new Database(location);
    write.pragma("journal_mode = WAL");
    // Evidence is worth an fsync per commit.
    write.pragma("synchronous = FULL");
    write.pragma("foreign_keys = ON");
    write.pragma("busy_timeout = 5000");
    write.exec(SCHEMA_SQL);

    const read = new Database(location, { readonly: true });
    read.pragma("busy_timeout = 5000");

    return new ReceiptStore(write, read, signer);
  }

  /** Registers a system and opens its chain by writing the genesis receipt. */
  async createSystem(systemId: string, ts: string): Promise<Receipt> {
    return this.enqueue(() =>
      this.writeReceipt(
        {
          system_id: systemId,
          ts_event: ts,
          ts_received: ts,
          actor: { agent: systemId },
          action: { kind: "genesis", name: systemId },
          input_hash: null,
          output_hash: null,
          outcome: "ok",
          source: { type: "api" },
        },
        "genesis",
      ),
    );
  }

  async append(event: ChainEvent): Promise<Receipt> {
    if (event.action.kind === "genesis") {
      throw new StorageError("a genesis receipt is written by createSystem, not by append");
    }
    return this.enqueue(() => this.writeReceipt(event, "continuation"));
  }

  tip(systemId: string): ChainTip | null {
    const row = this.read
      .prepare("SELECT seq, hash FROM receipts WHERE system_id = ? ORDER BY seq DESC LIMIT 1")
      .get(systemId) as ChainTip | undefined;
    return row ?? null;
  }

  readChain(systemId: string): Receipt[] {
    const rows = this.read
      .prepare("SELECT canonical, sig FROM receipts WHERE system_id = ? ORDER BY seq")
      .all(systemId) as StoredRow[];
    return rows.map(rowToReceipt);
  }

  /** Every receipt hash of a chain, in order: the leaves of its Merkle tree. */
  readReceiptHashes(systemId: string): string[] {
    const rows = this.read
      .prepare("SELECT hash FROM receipts WHERE system_id = ? ORDER BY seq")
      .all(systemId) as { hash: string }[];
    return rows.map((row) => row.hash);
  }

  /**
   * Signs and stores a checkpoint over everything the chain holds right now.
   * Returns null when the last checkpoint already covered the same receipts:
   * a chain with nothing new does not need another statement about it.
   */
  async createCheckpoint(systemId: string, ts: string): Promise<StoredCheckpoint | null> {
    return this.enqueue(() => this.writeCheckpoint(systemId, ts));
  }

  readCheckpoints(systemId: string): StoredCheckpoint[] {
    const rows = this.read
      .prepare("SELECT * FROM checkpoints WHERE system_id = ? ORDER BY tree_size")
      .all(systemId) as CheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  latestCheckpoint(systemId: string): StoredCheckpoint | null {
    const row = this.read
      .prepare("SELECT * FROM checkpoints WHERE system_id = ? ORDER BY tree_size DESC LIMIT 1")
      .get(systemId) as CheckpointRow | undefined;
    return row === undefined ? null : rowToCheckpoint(row);
  }

  /** Checkpoints that no token from this authority covers yet. */
  checkpointsAwaitingTimestamp(tsaUrl: string): StoredCheckpoint[] {
    const rows = this.read
      .prepare(
        `SELECT c.* FROM checkpoints c
         WHERE NOT EXISTS (
           SELECT 1 FROM timestamps t WHERE t.checkpoint_id = c.id AND t.tsa_url = ?
         )
         ORDER BY c.id`,
      )
      .all(tsaUrl) as CheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  recordTimestamp(
    checkpointId: number,
    tsaUrl: string,
    tokenBase64: string,
    obtainedAt: string,
  ): void {
    this.write
      .prepare(
        `INSERT INTO timestamps (checkpoint_id, tsa_url, token_base64, obtained_at)
         VALUES (@checkpoint_id, @tsa_url, @token_base64, @obtained_at)`,
      )
      .run({
        checkpoint_id: checkpointId,
        tsa_url: tsaUrl,
        token_base64: tokenBase64,
        obtained_at: obtainedAt,
      });
  }

  readTimestamps(checkpointId: number): StoredTimestamp[] {
    const rows = this.read
      .prepare("SELECT * FROM timestamps WHERE checkpoint_id = ? ORDER BY obtained_at")
      .all(checkpointId) as { tsa_url: string; token_base64: string; obtained_at: string }[];
    return rows.map((row) => ({
      tsaUrl: row.tsa_url,
      tokenBase64: row.token_base64,
      obtainedAt: row.obtained_at,
    }));
  }

  listSystems(): string[] {
    const rows = this.read
      .prepare("SELECT system_id FROM systems ORDER BY system_id")
      .all() as { system_id: string }[];
    return rows.map((row) => row.system_id);
  }

  hasSystem(systemId: string): boolean {
    return (
      this.read.prepare("SELECT 1 FROM systems WHERE system_id = ?").get(systemId) !== undefined
    );
  }

  close(): void {
    this.read.close();
    this.write.close();
  }

  private async writeCheckpoint(systemId: string, ts: string): Promise<StoredCheckpoint | null> {
    const signer = this.signer;
    if (signer === undefined) {
      throw new StorageError("this store was opened for reading only: it has no signer");
    }
    this.write.exec("BEGIN IMMEDIATE");
    try {
      const hashes = (
        this.write.prepare("SELECT hash FROM receipts WHERE system_id = ? ORDER BY seq").all(
          systemId,
        ) as { hash: string }[]
      ).map((row) => row.hash);

      if (hashes.length === 0) {
        throw new StorageError(`unknown system ${systemId}: it has no receipts to check point`);
      }

      const covered = this.write
        .prepare("SELECT tree_size FROM checkpoints WHERE system_id = ? ORDER BY tree_size DESC LIMIT 1")
        .get(systemId) as { tree_size: number } | undefined;
      if (covered !== undefined && covered.tree_size === hashes.length) {
        this.write.exec("COMMIT");
        return null;
      }

      const unsigned = {
        v: RECEIPT_VERSION,
        system_id: systemId,
        tree_size: hashes.length,
        root_hash: toHex(merkleRoot(hashes.map((hash) => fromHex(hash)))),
        ts,
        key_id: signer.keyId,
      } as const;

      const sig = await signer.sign(checkpointHash(unsigned));
      const checkpoint = parseCheckpoint({ ...unsigned, sig });

      const result = this.write
        .prepare(
          `INSERT INTO checkpoints (system_id, tree_size, root_hash, ts, key_id, sig)
           VALUES (@system_id, @tree_size, @root_hash, @ts, @key_id, @sig)`,
        )
        .run({
          system_id: checkpoint.system_id,
          tree_size: checkpoint.tree_size,
          root_hash: checkpoint.root_hash,
          ts: checkpoint.ts,
          key_id: checkpoint.key_id,
          sig: checkpoint.sig,
        });

      this.write.exec("COMMIT");
      return { id: Number(result.lastInsertRowid), checkpoint };
    } catch (error) {
      if (this.write.inTransaction) {
        this.write.exec("ROLLBACK");
      }
      throw error;
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writes.then(task, task);
    this.writes = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Position and content are decided inside one IMMEDIATE transaction, so two
   * writers can never read the same tip and build the same `seq`. The signer is
   * called while that transaction is open: a signature that cannot be obtained
   * must not leave a gap in the chain.
   */
  private async writeReceipt(event: ChainEvent, mode: "genesis" | "continuation"): Promise<Receipt> {
    const signer = this.signer;
    if (signer === undefined) {
      throw new StorageError("this store was opened for reading only: it has no signer");
    }
    this.write.exec("BEGIN IMMEDIATE");
    try {
      const tip = this.tipStatement.get(event.system_id) as ChainTip | undefined;

      if (mode === "genesis" && tip !== undefined) {
        throw new StorageError(`a chain for ${event.system_id} already exists`);
      }
      if (mode === "genesis") {
        this.registerStatement.run({ system_id: event.system_id, created_at: event.ts_received });
      }
      if (mode === "continuation" && tip === undefined) {
        throw new StorageError(`unknown system ${event.system_id}: create its chain first`);
      }

      const unsigned = parseUnsignedReceipt({
        v: RECEIPT_VERSION,
        system_id: event.system_id,
        seq: tip === undefined ? 0 : tip.seq + 1,
        ts_event: event.ts_event,
        ts_received: event.ts_received,
        actor: event.actor,
        action: event.action,
        input_hash: event.input_hash,
        output_hash: event.output_hash,
        outcome: event.outcome,
        source: event.source,
        prev_hash: tip === undefined ? GENESIS_PREV_HASH : tip.hash,
        key_id: signer.keyId,
      });

      const canonical = new TextDecoder().decode(canonicalReceiptBytes(unsigned));
      const digest = receiptHash(unsigned);
      const sig = await signer.sign(digest);
      // Validated again after signing: the signer is a separate process, and
      // what it returns is not taken on trust.
      const receipt = parseReceipt({ ...unsigned, sig });

      this.insertStatement.run({
        system_id: receipt.system_id,
        seq: receipt.seq,
        hash: Buffer.from(digest).toString("hex"),
        prev_hash: receipt.prev_hash,
        canonical,
        sig: receipt.sig,
        key_id: receipt.key_id,
        ts_event: receipt.ts_event,
        ts_received: receipt.ts_received,
        action_kind: receipt.action.kind,
        action_name: receipt.action.name,
        outcome: receipt.outcome,
      });

      this.write.exec("COMMIT");
      return receipt;
    } catch (error) {
      if (this.write.inTransaction) {
        this.write.exec("ROLLBACK");
      }
      throw error;
    }
  }
}
