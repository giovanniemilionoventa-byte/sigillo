import Database from "better-sqlite3";
import {
  canonicalReceiptBytes,
  GENESIS_PREV_HASH,
  parseReceipt,
  parseUnsignedReceipt,
  receiptHash,
  RECEIPT_VERSION,
  type Action,
  type Actor,
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

  private constructor(
    private readonly write: Database.Database,
    private readonly read: Database.Database,
    private readonly signer: SigningService,
  ) {
    this.tipStatement = this.write.prepare(
      "SELECT seq, hash FROM receipts WHERE system_id = ? ORDER BY seq DESC LIMIT 1",
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
   */
  static open(location: string, signer: SigningService): ReceiptStore {
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

  /** Opens a chain by writing its genesis receipt. */
  async createChain(systemId: string, ts: string): Promise<Receipt> {
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
      throw new StorageError("a genesis receipt is written by createChain, not by append");
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

  listSystems(): string[] {
    const rows = this.read
      .prepare("SELECT DISTINCT system_id FROM receipts ORDER BY system_id")
      .all() as { system_id: string }[];
    return rows.map((row) => row.system_id);
  }

  close(): void {
    this.read.close();
    this.write.close();
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
    this.write.exec("BEGIN IMMEDIATE");
    try {
      const tip = this.tipStatement.get(event.system_id) as ChainTip | undefined;

      if (mode === "genesis" && tip !== undefined) {
        throw new StorageError(`a chain for ${event.system_id} already exists`);
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
        key_id: this.signer.keyId,
      });

      const canonical = new TextDecoder().decode(canonicalReceiptBytes(unsigned));
      const digest = receiptHash(unsigned);
      const sig = await this.signer.sign(digest);
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
