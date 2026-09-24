import type { KeyObject } from "node:crypto";
import Database from "better-sqlite3";
import {
  canonicalReceiptBytes,
  checkpointHash,
  CHECKPOINT_VERSION,
  fromHex,
  GENESIS_PREV_HASH,
  keyIdFromRawPublicKey,
  merkleRoot,
  parseCheckpoint,
  parseReceipt,
  parseUnsignedReceipt,
  publicKeyFromRaw,
  RECEIPT_VERSION_1,
  RECEIPT_VERSION_2,
  sha256,
  toHex,
  verifyDigestSignature,
  type Action,
  type Actor,
  type ArtifactEntry,
  type Checkpoint,
  type ModelInfo,
  type Outcome,
  type Receipt,
  type Source,
} from "@sigillo/core";
import { genTimeOfToken } from "../timestamp/gentime.js";
import { SCHEMA_SQL } from "./schema.js";

/** Whatever holds the private key. In production this is the separate signer process. */
export interface SigningService {
  readonly keyId: string;
  /**
   * The raw 32 bytes of the public key, base64. The store verifies every
   * signature it is handed against this key before it writes anything.
   */
  readonly publicKeyBase64: string;
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
  /** Either one, present, makes the stored receipt v2 rather than v1. */
  artifacts?: ArtifactEntry[];
  model?: ModelInfo;
}

export interface ChainTip {
  seq: number;
  hash: string;
}

/** One recorded use of a document, joined with enough of its receipt to describe it. */
export interface ArtifactMatch {
  system_id: string;
  seq: number;
  role: string;
  label: string;
  media_type: string;
  ts_received: string;
  action_kind: string;
  action_name: string;
}

/** A checkpoint as stored, with the row id that timestamp tokens hang from. */
export interface StoredCheckpoint {
  id: number;
  checkpoint: Checkpoint;
}

export interface StoredTimestamp {
  tsaUrl: string;
  tokenBase64: string;
  /** When the server received the token, by its own clock. */
  obtainedAt: string;
  /** The time the authority attests inside the token, where it can be read. */
  genTime: string | undefined;
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
      v: CHECKPOINT_VERSION,
      system_id: row.system_id,
      tree_size: row.tree_size,
      root_hash: row.root_hash,
      ts: row.ts,
      key_id: row.key_id,
      sig: row.sig,
    }),
  };
}

/**
 * The key every signature is checked against before it is stored. It must be
 * the key the signer's key_id names: that key_id goes into every receipt, and
 * a verifier finds the key by it.
 */
function verificationKeyOf(signer: SigningService): KeyObject {
  const raw = new Uint8Array(Buffer.from(signer.publicKeyBase64, "base64"));
  if (raw.length !== 32 || keyIdFromRawPublicKey(raw) !== signer.keyId) {
    throw new StorageError(
      `the signer's key_id ${signer.keyId} is not the identifier of the public key it announces`,
    );
  }
  return publicKeyFromRaw(raw);
}

/**
 * The path of the first string in `value` that is not well-formed Unicode —
 * one holding half of a surrogate pair — or null if there is none.
 */
function malformedStringIn(value: unknown, path: string): string | null {
  if (typeof value === "string") {
    return value.isWellFormed() ? null : path;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      const found = malformedStringIn(inner, path === "" ? key : `${path}.${key}`);
      if (found !== null) return found;
    }
  }
  return null;
}

function refusedSignature(what: string, keyId: string): StorageError {
  return new StorageError(
    `the signer returned a signature that does not verify over this ${what}'s hash under key ` +
      `${keyId}, so nothing was written`,
  );
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
  private readonly insertArtifactStatement: Database.Statement;
  private readonly registerStatement: Database.Statement;

  private constructor(
    private readonly write: Database.Database,
    private readonly read: Database.Database,
    private readonly signer: SigningService | undefined,
    private readonly verificationKey: KeyObject | undefined,
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
    this.insertArtifactStatement = this.write.prepare(
      `INSERT INTO artifacts (system_id, seq, role, label, media_type, sha256)
       VALUES (@system_id, @seq, @role, @label, @media_type, @sha256)`,
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
    const verificationKey = signer === undefined ? undefined : verificationKeyOf(signer);

    const write = new Database(location);
    write.pragma("journal_mode = WAL");
    // Evidence is worth an fsync per commit.
    write.pragma("synchronous = FULL");
    write.pragma("foreign_keys = ON");
    write.pragma("busy_timeout = 5000");
    write.exec(SCHEMA_SQL);

    const read = new Database(location, { readonly: true });
    read.pragma("busy_timeout = 5000");

    return new ReceiptStore(write, read, signer, verificationKey);
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

  /** Everything after `afterSeq`, for a checker that does not want to reread what it already saw. */
  readChainFrom(systemId: string, afterSeq: number): Receipt[] {
    const rows = this.read
      .prepare("SELECT canonical, sig FROM receipts WHERE system_id = ? AND seq > ? ORDER BY seq")
      .all(systemId, afterSeq) as StoredRow[];
    return rows.map(rowToReceipt);
  }

  /** The run of receipts from the first received at or after `from` to the last received at or before `to` (either end optional). */
  readChainInRange(systemId: string, from?: string, to?: string): Receipt[] {
    // The dates only choose where the run starts and ends: the first receipt
    // received at or after `from`, the last at or before `to`. Everything in
    // between is exported, so the run of positions has no gap even when the
    // server's clock stepped back in the middle of it (review point 9) — a
    // gap would make the export fail its own verification.
    const bound = (sql: string, parameters: Record<string, string>): number | null =>
      (this.read.prepare(sql).get(parameters) as { seq: number | null }).seq;
    const firstSeq =
      from === undefined
        ? 0
        : bound("SELECT MIN(seq) AS seq FROM receipts WHERE system_id = @system_id AND ts_received >= @from", {
            system_id: systemId,
            from,
          });
    const lastSeq =
      to === undefined
        ? bound("SELECT MAX(seq) AS seq FROM receipts WHERE system_id = @system_id", { system_id: systemId })
        : bound("SELECT MAX(seq) AS seq FROM receipts WHERE system_id = @system_id AND ts_received <= @to", {
            system_id: systemId,
            to,
          });
    if (firstSeq === null || lastSeq === null || firstSeq > lastSeq) return [];

    const rows = this.read
      .prepare(
        "SELECT canonical, sig FROM receipts WHERE system_id = ? AND seq BETWEEN ? AND ? ORDER BY seq",
      )
      .all(systemId, firstSeq, lastSeq) as StoredRow[];
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
      genTime: genTimeOfToken(new Uint8Array(Buffer.from(row.token_base64, "base64"))),
    }));
  }

  /** Receipts matching a filter, newest first, for the operator's view. */
  searchReceipts(query: {
    systemId: string;
    from?: string;
    to?: string;
    kind?: string;
    name?: string;
    limit?: number;
  }): Receipt[] {
    const clauses = ["system_id = @system_id"];
    const parameters: Record<string, string | number> = { system_id: query.systemId };

    if (query.from !== undefined && query.from.length > 0) {
      clauses.push("ts_received >= @from");
      parameters["from"] = query.from;
    }
    if (query.to !== undefined && query.to.length > 0) {
      clauses.push("ts_received <= @to");
      parameters["to"] = query.to;
    }
    if (query.kind !== undefined && query.kind.length > 0) {
      clauses.push("action_kind = @kind");
      parameters["kind"] = query.kind;
    }
    if (query.name !== undefined && query.name.length > 0) {
      clauses.push("action_name LIKE @name");
      parameters["name"] = `%${query.name}%`;
    }
    parameters["limit"] = Math.min(Math.max(query.limit ?? 100, 1), 1000);

    const rows = this.read
      .prepare(
        `SELECT canonical, sig FROM receipts
         WHERE ${clauses.join(" AND ")}
         ORDER BY seq DESC LIMIT @limit`,
      )
      .all(parameters) as StoredRow[];
    return rows.map(rowToReceipt);
  }

  /** Every recorded use of a document, oldest first, across every system. */
  findArtifactsBySha256(sha256: string): ArtifactMatch[] {
    return this.read
      .prepare(
        `SELECT a.system_id, a.seq, a.role, a.label, a.media_type,
                r.ts_received, r.action_kind, r.action_name
         FROM artifacts a
         JOIN receipts r ON r.system_id = a.system_id AND r.seq = a.seq
         WHERE a.sha256 = ?
         ORDER BY r.ts_received`,
      )
      .all(sha256) as ArtifactMatch[];
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
    const verificationKey = this.verificationKey;
    if (signer === undefined || verificationKey === undefined) {
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
        v: CHECKPOINT_VERSION,
        system_id: systemId,
        tree_size: hashes.length,
        root_hash: toHex(merkleRoot(hashes.map((hash) => fromHex(hash)))),
        ts,
        key_id: signer.keyId,
      } as const;

      const digest = checkpointHash(unsigned);
      const sig = await signer.sign(digest);
      const checkpoint = parseCheckpoint({ ...unsigned, sig });
      // Checked, not trusted, exactly as for a receipt below.
      if (!verifyDigestSignature(digest, checkpoint.sig, verificationKey)) {
        throw refusedSignature("checkpoint", signer.keyId);
      }

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
    const verificationKey = this.verificationKey;
    if (signer === undefined || verificationKey === undefined) {
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

      // A receipt is v2 only when it actually carries something v1 cannot: a
      // chain otherwise stays v1, which is what every reader still expects.
      const isV2 = event.artifacts !== undefined || event.model !== undefined;
      const unsigned = parseUnsignedReceipt({
        v: isV2 ? RECEIPT_VERSION_2 : RECEIPT_VERSION_1,
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
        ...(event.artifacts === undefined ? {} : { artifacts: event.artifacts }),
        ...(event.model === undefined ? {} : { model: event.model }),
      });

      // RFC 8785 is defined over well-formed Unicode. A string holding half of
      // a surrogate pair would be signed here and serialised somehow, but an
      // independent implementation could not reproduce its hash, so it is
      // refused before a signature is ever asked for.
      const malformed = malformedStringIn(unsigned, "");
      if (malformed !== null) {
        throw new StorageError(
          `receipt field ${malformed} is not well-formed Unicode (it holds half of a surrogate ` +
            "pair), so it has no canonical form another implementation would agree on: nothing was signed or written",
        );
      }

      // One set of bytes: the ones stored as `canonical`, whose hash is stored
      // as `hash`, signed, and verified below.
      const canonicalBytes = canonicalReceiptBytes(unsigned);
      const canonical = new TextDecoder().decode(canonicalBytes);
      const digest = sha256(canonicalBytes);
      const sig = await signer.sign(digest);
      // Validated again after signing: the signer is a separate process, and
      // what it returns is not taken on trust. The shape first, then the
      // signature itself: it must verify over exactly these bytes, under the
      // signer's own key, or the transaction is rolled back and the position
      // stays free. A signature over any other digest — another receipt's,
      // say — is refused here whatever route it took to arrive.
      const receipt = parseReceipt({ ...unsigned, sig });
      if (!verifyDigestSignature(digest, receipt.sig, verificationKey)) {
        throw refusedSignature("receipt", signer.keyId);
      }

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

      if (receipt.v === 2 && receipt.artifacts !== undefined) {
        for (const artifact of receipt.artifacts) {
          this.insertArtifactStatement.run({
            system_id: receipt.system_id,
            seq: receipt.seq,
            role: artifact.role,
            label: artifact.label,
            media_type: artifact.media_type,
            sha256: artifact.sha256,
          });
        }
      }

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
