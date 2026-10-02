import { randomBytes, type KeyObject } from "node:crypto";
import Database from "better-sqlite3";
import {
  canonicalReceiptBytes,
  checkpointHash,
  CHECKPOINT_VERSION,
  verifyReceiptSignature,
  fromHex,
  GENESIS_PREV_HASH,
  HASH_SCHEME_PLAIN,
  HASH_SCHEME_SALTED,
  isPseudonym,
  keyIdFromRawPublicKey,
  merkleRoot,
  parseCheckpoint,
  parseReceipt,
  parseUnsignedReceipt,
  PSEUDONYM_RANDOM_BYTES,
  pseudonymFromRandom,
  publicKeyFromRaw,
  receiptHashHex,
  RECEIPT_VERSION_4,
  SALT_NONCE_BYTES,
  saltedDigest,
  genTimeOfToken,
  sha256,
  toHex,
  verifyDigestSignature,
  type Action,
  type Actor,
  type ArtifactEntryV3,
  type DocumentFingerprints,
  type Checkpoint,
  type HashScheme,
  type ModelInfo,
  type Outcome,
  type Receipt,
  type Source,
  type UnsignedReceipt,
} from "@sigillo/core";
import { SignerRefusedError } from "../signer/errors.js";
import { applySchema, requireCurrentSchema } from "./schema.js";

/**
 * Whatever holds the private key. In production this is the separate signer
 * process, which keeps its own record of every chain: it signs a receipt only
 * if it is the next one of its chain, and builds checkpoints from that record
 * rather than from anything this process tells it (apps/signer/src/signer.ts).
 * A refusal is a SignerRefusedError; no answer is a SignerUnavailableError.
 */
export interface SigningService {
  readonly keyId: string;
  /**
   * The raw 32 bytes of the public key, base64. The store verifies every
   * signature it is handed against this key before it writes anything.
   */
  readonly publicKeyBase64: string;
  /** The signature over `receipt`'s hash, if the signer accepts it as the next of its chain. */
  signReceipt(receipt: UnsignedReceipt): Promise<string>;
  /** A signed checkpoint over the signer's own record of the chain, at the signer's own time. */
  checkpoint(systemId: string): Promise<Checkpoint>;
  /** The last receipt the signer signed for the system, or null. */
  head(systemId: string): Promise<Receipt | null>;
  /**
   * The receipts the signer signed for the system from `fromSeq` on, at most
   * `limit`, from its journal. Without it, only the one receipt the head
   * holds can be taken back.
   */
  receipts?(systemId: string, fromSeq: number, limit: number): Promise<Receipt[]>;
}

/**
 * An action to be recorded. Its position in the chain is not the caller's to
 * choose. The receipt written for it is always version 4: `actor.on_behalf_of`
 * may name a person here, and leaves as a pseudonym token; an input or output
 * arrives either as a digest the client computed (`input_hash`, recorded as
 * plain, or salted when the client also sends the nonce it salted it under,
 * `input_nonce`) or as the value itself (`raw_input`, digested here under a
 * fresh nonce and never kept), not both.
 */
export interface ChainEvent {
  system_id: string;
  ts_event: string;
  ts_received: string;
  actor: Actor;
  action: Action;
  input_hash: string | null;
  output_hash: string | null;
  raw_input?: { value: unknown };
  raw_output?: { value: unknown };
  /** The 32-byte nonce, hex, the client salted `input_hash` under: the digest is then recorded as salted. */
  input_nonce?: string;
  output_nonce?: string;
  outcome: Outcome;
  source: Source;
  artifacts?: ArtifactEntryV3[];
  model?: ModelInfo;
}

export interface ChainTip {
  seq: number;
  hash: string;
}

/**
 * What comparing a chain's tip in the database with the signer's head found.
 * `recovered`: the signer was one receipt ahead, and that receipt hung off the
 * database's tip, so it was written (a crash between signature and insert).
 * `diverged`: anything else that does not match, recorded and left alone.
 */
export type ReconcileOutcome =
  | { system_id: string; status: "in_sync" }
  | { system_id: string; status: "recovered"; seq: number; hash: string; /** How many receipts were taken back, ending at seq. */ count: number }
  | { system_id: string; status: "diverged"; detail: string };

/** A salt nonce as a client sends it: 32 bytes, lowercase hex. */
const NONCE_HEX = /^[0-9a-f]{64}$/;

/** How many receipts to ask the signer's journal for at a time (its limit is 50). */
const RECOVERY_PAGE = 50;

/** The largest canonical receipt the store asks the signer to sign; its socket takes 256 KiB a line. */
const MAX_RECEIPT_BYTES = 192 * 1024;

/**
 * How a document matched a record, strongest first. `bytes`: the exact bytes
 * an artifact names. `text`: the same text under the artifact's `text.canon`
 * rule. `lines`: the exact bytes of a record, give or take line endings, a
 * final newline and a byte order mark (for records made before text
 * fingerprints existed). `json`/`json-lines`: the text, as is or give or take
 * the same, is the whole input or output of the action.
 */
export type DocumentMatchKind = "bytes" | "text" | "lines" | "json" | "json-lines";

/** One recorded use of a document, joined with enough of its receipt to describe it. */
export interface DocumentMatch {
  kind: DocumentMatchKind;
  system_id: string;
  seq: number;
  role: string;
  /** An artifact's label and media type; null for an input or output digest. */
  label: string | null;
  media_type: string | null;
  text_canon: string | null;
  ts_received: string;
  action_kind: string;
  action_name: string;
}

const MATCH_STRENGTH: Record<DocumentMatchKind, number> = { bytes: 0, text: 1, lines: 2, json: 3, "json-lines": 4 };

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

/**
 * A deletion refused because the chain holds more than its genesis. Never a
 * question of confirming harder: such a system can be archived, not deleted.
 */
export class SystemNotDeletableError extends StorageError {
  constructor(
    readonly systemId: string,
    readonly receipts: number,
  ) {
    super(
      `${systemId} cannot be deleted: its chain holds ${receipts} receipts, and only a system ` +
        "whose chain holds nothing but its genesis can be. Archive it instead",
    );
    this.name = "SystemNotDeletableError";
  }
}

/** The filters of the operator's history, except the kind. */
export interface ReceiptFilter {
  systemId: string;
  /** Received at or after this ISO time. */
  from?: string;
  /** Received at or before this ISO time. */
  to?: string;
  /** Part of the action's name. */
  name?: string;
}

/** A system as the operator's view and the CLI list it. */
export interface SystemRecord {
  system_id: string;
  /** A label, not evidence: null when none was ever set, and then system_id is shown. */
  display_name: string | null;
  created_at: string;
  archived_at: string | null;
  /** How many receipts the chain holds, genesis included. */
  receipts: number;
  /** When the server received the chain's last receipt. */
  last_received: string | null;
  /** Whose system this is in a hosted installation; null for the operator's own (organizations.ts). */
  organization_id: string | null;
}

/** A customer of a hosted installation (organizations.ts). */
export interface Organization {
  organization_id: string;
  name: string;
  created_at: string;
  /** When the operator let it in; null while it waits. */
  approved_at: string | null;
}

/**
 * An organization's identifier: lower-case letters, digits and inner hyphens,
 * at most 32 characters. No dot: the systems an organization creates from the
 * web view are named `<organization_id>.<name>`, so the part before the first
 * dot is always the organization's.
 */
export const ORGANIZATION_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Someone who signs in for an organization (auth/firebase.ts). */
export interface User {
  /** Firebase's identifier for the account. */
  uid: string;
  email: string;
  organization_id: string;
  created_at: string;
}

/**
 * An identifier for an organization that signs itself up: its name, folded to
 * what ORGANIZATION_ID allows, and four random hex digits, so that two
 * companies with the same name never meet and an identifier cannot be
 * claimed ahead of its company by guessing.
 */
export function organizationIdFor(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return `${slug === "" ? "org" : slug}-${randomBytes(2).toString("hex")}`;
}

export type AdminAction =
  | "system.rename"
  | "system.archive"
  | "system.unarchive"
  | "system.delete"
  /** The signer's state was built from this database's chains (sigillo-signer init-from-db). */
  | "signer.init"
  /** A receipt the signer had signed but this database lacked was written (a crash between the two). */
  | "signer.recovered"
  /** The signer's head and this database's tip disagree in a way nothing here corrects. */
  | "signer.divergence"
  | "subject.erase"
  | "openings.erase"
  | "organization.create"
  | "organization.approve"
  /** Someone signed up and was given a new organization, waiting for approval. */
  | "user.register"
  /** A system was given to an organization, moved to another, or taken back by the operator. */
  | "system.assign";

/** One line of the administrative log: something done to a system outside its chain. */
export interface AdminLogEntry {
  id: number;
  ts: string;
  action: AdminAction;
  /** Empty for what concerns no one system: erasing a subject, creating an organization. */
  system_id: string;
  /** Who did it: "web <address>" from the web view, "cli <user>@<host>" from the command line. */
  actor: string;
  detail: Record<string, unknown>;
}

/** Who asks for an administrative change, and when. */
export interface AdminRequest {
  actor: string;
  ts: string;
}

/** What a deletion removed, as the administrative log records it. */
export interface DeletedSystem {
  system_id: string;
  display_name: string | null;
  created_at: string;
  genesis_hash: string;
  checkpoints: number;
  timestamps: number;
  api_keys: string[];
  /** Whose it was: an organization's view shows its own deletions (tenancy.ts). */
  organization_id: string | null;
}

const SYSTEM_RECORDS = `
  SELECT s.system_id, s.display_name, s.created_at, s.archived_at, s.organization_id,
         (SELECT COUNT(*) FROM receipts r WHERE r.system_id = s.system_id) AS receipts,
         (SELECT MAX(ts_received) FROM receipts r WHERE r.system_id = s.system_id) AS last_received
  FROM systems s`;

const DISPLAY_NAME_MAX = 128;

/**
 * A display name as it is stored: trimmed, and null when empty, which means
 * "show the system_id". It is a label, so almost anything goes; control
 * characters do not, because the CLI prints one system per line.
 */
export function normaliseDisplayName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if ([...trimmed].length > DISPLAY_NAME_MAX) {
    throw new StorageError(`a display name is at most ${DISPLAY_NAME_MAX} characters`);
  }
  if (/\p{Cc}/u.test(trimmed)) {
    throw new StorageError("a display name cannot contain line breaks or other control characters");
  }
  return trimmed;
}

const SUBJECT_IDENTIFIER_MAX = 256;

/**
 * An identifier as the subjects table keys it, so that one person gets one
 * token however a source spells them: Unicode NFC, no space at either end,
 * lower case. It is never written anywhere else.
 */
export function normaliseSubjectIdentifier(value: string): string {
  if (!value.isWellFormed()) {
    throw new StorageError(
      "receipt field actor.on_behalf_of is not well-formed Unicode (it holds half of a surrogate pair): nothing was signed or written",
    );
  }
  const normalised = value.normalize("NFC").trim().toLowerCase();
  if (normalised.length === 0) throw new StorageError("an on_behalf_of identifier cannot be empty");
  if (normalised.length > SUBJECT_IDENTIFIER_MAX) {
    throw new StorageError(`an on_behalf_of identifier is at most ${SUBJECT_IDENTIFIER_MAX} characters`);
  }
  return normalised;
}

/** Which receipts of a system to cut off from their content: see receiptsOfDocument. */
export interface ReceiptPositions {
  system_id: string;
  seqs: number[];
}

interface StoredRow {
  canonical: string;
  sig: string;
}

/** An input or output digest as a version 4 receipt holds it, and the nonce of a salted one. */
interface Digest {
  hash: string | null;
  scheme: HashScheme | null;
  nonce: string | null;
}

/** What an event becomes before its position is known: its actor and its two digests. */
interface Prepared {
  actor: Actor;
  input: Digest;
  output: Digest;
}

interface TipRow extends ChainTip {
  ts_received: string;
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
  private readonly duplicateStatement: Database.Statement;
  /** Chains found to disagree with the signer since this store was opened: system_id → what was found. */
  private readonly divergences = new Map<string, string>();

  private constructor(
    private readonly write: Database.Database,
    private readonly read: Database.Database,
    private readonly signer: SigningService | undefined,
    private readonly verificationKey: KeyObject | undefined,
  ) {
    this.tipStatement = this.write.prepare(
      "SELECT seq, hash, ts_received FROM receipts WHERE system_id = ? ORDER BY seq DESC LIMIT 1",
    );
    this.registerStatement = this.write.prepare(
      `INSERT INTO systems (system_id, created_at, organization_id)
       VALUES (@system_id, @created_at, @organization_id)`,
    );
    this.insertStatement = this.write.prepare(
      `INSERT INTO receipts (system_id, seq, hash, prev_hash, canonical, sig, key_id,
                             ts_event, ts_received, action_kind, action_name, outcome,
                             source_trace_id, source_span_id)
       VALUES (@system_id, @seq, @hash, @prev_hash, @canonical, @sig, @key_id,
               @ts_event, @ts_received, @action_kind, @action_name, @outcome,
               @source_trace_id, @source_span_id)`,
    );
    this.insertArtifactStatement = this.write.prepare(
      `INSERT INTO artifacts (system_id, seq, role, label, media_type, sha256, text_canon, text_sha256)
       VALUES (@system_id, @seq, @role, @label, @media_type, @sha256, @text_canon, @text_sha256)`,
    );
    // A span an OTLP batch already wrote, found by the identifiers that name
    // it (fase 9 / review point 6): an exporter whose response was lost
    // resends the whole batch unchanged, and this is what lets that batch be
    // recognised rather than duplicated.
    this.duplicateStatement = this.write.prepare(
      `SELECT canonical, sig FROM receipts
       WHERE system_id = ? AND source_trace_id = ? AND source_span_id = ?
       LIMIT 1`,
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
    // A deleted subject or nonce is overwritten with zeros, not left in a
    // free page of the file for anyone with a copy to read (eraseSubject).
    write.pragma("secure_delete = ON");
    try {
      applySchema(write);
    } catch (error) {
      write.close();
      throw error;
    }

    if (signer !== undefined) {
      // Remembered before anything is signed with it, and never forgotten.
      write
        .prepare(
          "INSERT OR IGNORE INTO signing_keys (key_id, public_key_base64, first_seen) VALUES (?, ?, ?)",
        )
        .run(signer.keyId, signer.publicKeyBase64, new Date().toISOString());
    }

    const read = new Database(location, { readonly: true });
    read.pragma("busy_timeout = 5000");

    return new ReceiptStore(write, read, signer, verificationKey);
  }

  /**
   * Opens the database at `location` for reading only: one read-only
   * connection, no schema applied, nothing written, the file left exactly as
   * it was. The schema must already be this release's (requireCurrentSchema).
   * For the commands that only look: a listing, the administrative log, a
   * lookup.
   */
  static openReadOnly(location: string): ReceiptStore {
    const read = new Database(location, { readonly: true, fileMustExist: true });
    try {
      read.pragma("busy_timeout = 5000");
      requireCurrentSchema(read);
      // The write statements are prepared on this connection too, and fail
      // if anything ever tries to run them.
      return new ReceiptStore(read, read, undefined, undefined);
    } catch (error) {
      read.close();
      throw error;
    }
  }

  /** Every key this database has been signed with, in the order they were first used. */
  signingKeys(): { key_id: string; public_key_base64: string }[] {
    return this.read
      .prepare("SELECT key_id, public_key_base64 FROM signing_keys ORDER BY first_seen, key_id")
      .all() as { key_id: string; public_key_base64: string }[];
  }

  /** The public key a receipt or checkpoint names by `keyId`, if this database has signed with it. */
  publicKeyFor(keyId: string): KeyObject | undefined {
    const row = this.read.prepare("SELECT public_key_base64 FROM signing_keys WHERE key_id = ?").get(keyId) as
      | { public_key_base64: string }
      | undefined;
    return row === undefined ? undefined : publicKeyFromRaw(new Uint8Array(Buffer.from(row.public_key_base64, "base64")));
  }

  /**
   * Registers a system and opens its chain by writing the genesis receipt. With
   * an organization, the system is that organization's from the same
   * transaction that writes its genesis: there is no moment at which it
   * exists and belongs to nobody, or to the wrong one.
   */
  async createSystem(systemId: string, ts: string, organizationId: string | null = null): Promise<Receipt> {
    return this.enqueue(async () => {
      // An identifier whose chain was once deleted is not given out again: an
      // export of the deleted chain, or a timestamp over its root, may exist
      // somewhere, and a second genesis under the same name would contradict it.
      if (organizationId !== null && this.organization(organizationId, this.write) === null) {
        throw new StorageError(`unknown organization ${organizationId}`);
      }
      const deletedOn = this.deletionOf(systemId, this.write);
      if (deletedOn !== null) {
        throw new StorageError(
          `${systemId} belonged to a system deleted on ${deletedOn}, and is not reused: choose another identifier`,
        );
      }
      const written = await this.writeReceipt(
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
        organizationId,
      );
      return written.receipt;
    });
  }

  /** Every system with its labels and the size of its chain, by system_id. */
  listSystemRecords(): SystemRecord[] {
    return this.read
      .prepare(
        `${SYSTEM_RECORDS} ORDER BY s.system_id`,
      )
      .all() as SystemRecord[];
  }

  systemRecord(systemId: string): SystemRecord | null {
    const row = this.read.prepare(`${SYSTEM_RECORDS} WHERE s.system_id = ?`).get(systemId) as
      | SystemRecord
      | undefined;
    return row ?? null;
  }

  /**
   * Registers a customer. `approved` is for the operator creating one by hand,
   * who has nothing to wait for; an organization that signs itself up waits
   * for the operator. Logged like any other administrative change.
   */
  async createOrganization(
    organizationId: string,
    name: string,
    request: AdminRequest,
    options: { approved: boolean },
  ): Promise<Organization> {
    if (!ORGANIZATION_ID.test(organizationId)) {
      throw new StorageError(
        "an organization identifier is 1 to 32 lower-case letters, digits and hyphens, not starting or ending with a hyphen",
      );
    }
    const label = normaliseDisplayName(name);
    if (label === null) throw new StorageError("an organization needs a name");
    return this.enqueue(() =>
      this.inTransaction(async () => {
        if (this.organization(organizationId, this.write) !== null) {
          throw new StorageError(`an organization called ${organizationId} already exists`);
        }
        const organization: Organization = {
          organization_id: organizationId,
          name: label,
          created_at: request.ts,
          approved_at: options.approved ? request.ts : null,
        };
        this.write
          .prepare(
            `INSERT INTO organizations (organization_id, name, created_at, approved_at)
             VALUES (@organization_id, @name, @created_at, @approved_at)`,
          )
          .run(organization);
        this.logAdmin("organization.create", "", request, { ...organization });
        return organization;
      }),
    );
  }

  organization(organizationId: string, connection: Database.Database = this.read): Organization | null {
    const row = connection
      .prepare("SELECT organization_id, name, created_at, approved_at FROM organizations WHERE organization_id = ?")
      .get(organizationId) as Organization | undefined;
    return row ?? null;
  }

  /**
   * A new organization for someone who has just signed in for the first time,
   * waiting for the operator, and its first member, in one transaction.
   */
  async registerOrganization(
    user: { uid: string; email: string },
    name: string,
    request: AdminRequest,
  ): Promise<Organization> {
    const label = normaliseDisplayName(name);
    if (label === null) throw new StorageError("an organization needs a name");
    return this.enqueue(() =>
      this.inTransaction(async () => {
        if (this.userByUid(user.uid, this.write) !== null) {
          throw new StorageError("this account already belongs to an organization");
        }
        let organizationId = organizationIdFor(label);
        while (this.organization(organizationId, this.write) !== null) organizationId = organizationIdFor(label);
        const organization: Organization = {
          organization_id: organizationId,
          name: label,
          created_at: request.ts,
          approved_at: null,
        };
        this.write
          .prepare(
            `INSERT INTO organizations (organization_id, name, created_at, approved_at)
             VALUES (@organization_id, @name, @created_at, @approved_at)`,
          )
          .run(organization);
        this.write
          .prepare("INSERT INTO users (uid, email, organization_id, created_at) VALUES (?, ?, ?, ?)")
          .run(user.uid, user.email, organizationId, request.ts);
        this.logAdmin("user.register", "", request, { organization_id: organizationId, name: label, email: user.email });
        return organization;
      }),
    );
  }

  /** Lets an organization's members in. A no-op for one already approved. */
  async approveOrganization(organizationId: string, request: AdminRequest): Promise<Organization> {
    return this.enqueue(() =>
      this.inTransaction(async () => {
        const organization = this.organization(organizationId, this.write);
        if (organization === null) throw new StorageError(`unknown organization ${organizationId}`);
        if (organization.approved_at !== null) return organization;
        this.write
          .prepare("UPDATE organizations SET approved_at = ? WHERE organization_id = ?")
          .run(request.ts, organizationId);
        this.logAdmin("organization.approve", "", request, { organization_id: organizationId, name: organization.name });
        return { ...organization, approved_at: request.ts };
      }),
    );
  }

  userByUid(uid: string, connection: Database.Database = this.read): User | null {
    const row = connection
      .prepare("SELECT uid, email, organization_id, created_at FROM users WHERE uid = ?")
      .get(uid) as User | undefined;
    return row ?? null;
  }

  usersOf(organizationId: string): User[] {
    return this.read
      .prepare("SELECT uid, email, organization_id, created_at FROM users WHERE organization_id = ? ORDER BY created_at")
      .all(organizationId) as User[];
  }

  /**
   * How many receipts an organization's systems have received since `since`
   * (an ISO time), genesis receipts aside: its quota's measure. Opening a
   * system is not a use of it.
   */
  receiptsSince(organizationId: string, since: string): number {
    const row = this.read
      .prepare(
        `SELECT COUNT(*) AS n FROM receipts r
         JOIN systems s ON s.system_id = r.system_id
         WHERE s.organization_id = ? AND r.ts_received >= ? AND r.action_kind <> 'genesis'`,
      )
      .get(organizationId, since) as { n: number };
    return row.n;
  }

  listOrganizations(): Organization[] {
    return this.read
      .prepare("SELECT organization_id, name, created_at, approved_at FROM organizations ORDER BY organization_id")
      .all() as Organization[];
  }

  /**
   * Gives a system to an organization, moves it to another, or, with null,
   * takes it back to the operator alone. The chain is not touched: who may see
   * a system in the web view is not evidence. Returns the organization it had.
   */
  async assignSystem(systemId: string, organizationId: string | null, request: AdminRequest): Promise<string | null> {
    return this.administer(systemId, (record) => {
      if (organizationId !== null && this.organization(organizationId, this.write) === null) {
        throw new StorageError(`unknown organization ${organizationId}`);
      }
      this.write.prepare("UPDATE systems SET organization_id = ? WHERE system_id = ?").run(organizationId, systemId);
      this.logAdmin("system.assign", systemId, request, { from: record.organization_id, to: organizationId });
      return record.organization_id;
    });
  }

  /**
   * Sets the label shown for a system, or clears it with an empty string.
   * Nothing about the chain changes: not the system_id, not a receipt, not an
   * export already made. Returns the label it replaced.
   */
  async renameSystem(systemId: string, displayName: string, request: AdminRequest): Promise<string | null> {
    const next = normaliseDisplayName(displayName);
    return this.administer(systemId, (record) => {
      this.write.prepare("UPDATE systems SET display_name = ? WHERE system_id = ?").run(next, systemId);
      this.logAdmin("system.rename", systemId, request, { from: record.display_name, to: next });
      return record.display_name;
    });
  }

  /** Takes a system off the main listings. Its chain stays exactly as it was. */
  async archiveSystem(systemId: string, request: AdminRequest): Promise<void> {
    await this.administer(systemId, (record) => {
      if (record.archived_at !== null) return;
      this.write.prepare("UPDATE systems SET archived_at = ? WHERE system_id = ?").run(request.ts, systemId);
      this.logAdmin("system.archive", systemId, request, {});
    });
  }

  async unarchiveSystem(systemId: string, request: AdminRequest): Promise<void> {
    await this.administer(systemId, (record) => {
      if (record.archived_at === null) return;
      this.write.prepare("UPDATE systems SET archived_at = NULL WHERE system_id = ?").run(systemId);
      this.logAdmin("system.unarchive", systemId, request, { archived_at: record.archived_at });
    });
  }

  /**
   * Deletes a system whose chain holds nothing but its genesis, with its
   * checkpoint, timestamp tokens and API keys, after writing the deletion to
   * the administrative log. What is counted is what the database holds inside
   * this transaction, never what a page showed earlier: a receipt that
   * arrived since makes this refuse. A chain with any real action is refused
   * here, and again by the database's own triggers (schema.ts).
   */
  async deleteEmptySystem(systemId: string, request: AdminRequest): Promise<DeletedSystem> {
    return this.administer(systemId, (record) => {
      const rows = this.write
        .prepare("SELECT seq, hash FROM receipts WHERE system_id = ? ORDER BY seq LIMIT 2")
        .all(systemId) as ChainTip[];
      const genesis = rows[0];
      if (rows.length !== 1 || genesis === undefined || genesis.seq !== 0) {
        throw new SystemNotDeletableError(systemId, record.receipts);
      }

      const checkpointIds = (
        this.write.prepare("SELECT id FROM checkpoints WHERE system_id = ?").all(systemId) as { id: number }[]
      ).map((row) => row.id);
      const timestamps = checkpointIds.reduce(
        (total, id) =>
          total +
          (this.write.prepare("SELECT COUNT(*) AS n FROM timestamps WHERE checkpoint_id = ?").get(id) as { n: number }).n,
        0,
      );
      const apiKeys = (
        this.write.prepare("SELECT key_id FROM api_keys WHERE system_id = ? ORDER BY created_at").all(systemId) as {
          key_id: string;
        }[]
      ).map((row) => row.key_id);

      const deleted: DeletedSystem = {
        system_id: systemId,
        display_name: record.display_name,
        created_at: record.created_at,
        genesis_hash: genesis.hash,
        checkpoints: checkpointIds.length,
        timestamps,
        api_keys: apiKeys,
        organization_id: record.organization_id,
      };

      // The log first: the triggers let the genesis go only once its deletion
      // is on record, by its hash.
      this.logAdmin("system.delete", systemId, request, { ...deleted }, genesis.hash);
      for (const id of checkpointIds) {
        this.write.prepare("DELETE FROM timestamps WHERE checkpoint_id = ?").run(id);
      }
      this.write.prepare("DELETE FROM checkpoints WHERE system_id = ?").run(systemId);
      this.write.prepare("DELETE FROM receipts WHERE system_id = ? AND seq = 0").run(systemId);
      this.write.prepare("DELETE FROM api_keys WHERE system_id = ?").run(systemId);
      this.write.prepare("DELETE FROM systems WHERE system_id = ?").run(systemId);
      return deleted;
    });
  }

  /** When a system by this identifier was deleted, from the administrative log, or null if it never was. */
  deletionOf(systemId: string, connection: Database.Database = this.read): string | null {
    const row = connection
      .prepare("SELECT ts FROM admin_log WHERE action = 'system.delete' AND system_id = ? ORDER BY id LIMIT 1")
      .get(systemId) as { ts: string } | undefined;
    return row?.ts ?? null;
  }

  /** The administrative log, newest first. */
  adminLog(limit = 100): AdminLogEntry[] {
    const rows = this.read
      .prepare("SELECT id, ts, action, system_id, actor, detail FROM admin_log ORDER BY id DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 10_000)) as (Omit<AdminLogEntry, "detail"> & { detail: string })[];
    return rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
  }

  async append(event: ChainEvent): Promise<Receipt> {
    if (event.action.kind === "genesis") {
      throw new StorageError("a genesis receipt is written by createSystem, not by append");
    }
    this.checkEvent(event);
    return this.enqueue(async () => (await this.writeReceipt(event, "continuation")).receipt);
  }

  /**
   * Appends several receipts, in order, each in a transaction of its own. An
   * OTLP exporter resends a whole batch when a request fails, or when the
   * response never reached it; a span already on the chain is found by the
   * `trace_id`/`span_id` that name it and not written again, so the resend
   * writes each span exactly once (review point 6). `duplicates` is how many
   * of `events` were found that way.
   *
   * Every event is checked before the first is signed, so a malformed one
   * refuses the batch with nothing written. Once signing has started, each
   * receipt is committed as soon as it is signed: the signer remembers what
   * it signed, and a receipt it signed must not be rolled back here. A failure
   * part-way (the signer gone) leaves the batch's first receipts written, and
   * the exporter's resend finds them as duplicates. A crash part-way leaves
   * the signer at most one receipt ahead, which is what reconcile recovers.
   */
  async appendBatch(events: readonly ChainEvent[]): Promise<{ receipts: Receipt[]; duplicates: number }> {
    if (events.some((event) => event.action.kind === "genesis")) {
      throw new StorageError("a genesis receipt is written by createSystem, not by append");
    }
    if (events.length === 0) return { receipts: [], duplicates: 0 };
    for (const event of events) this.checkEvent(event);
    return this.enqueue(async () => {
      const receipts: Receipt[] = [];
      let duplicates = 0;
      for (const event of events) {
        const written = await this.writeReceipt(event, "continuation");
        receipts.push(written.receipt);
        if (written.duplicate) duplicates += 1;
      }
      return { receipts, duplicates };
    });
  }

  /**
   * Compares the tip of each chain (all of them, or those named) with the
   * signer's head, and recovers the one case that has a safe answer: the
   * signer one receipt ahead, that receipt hanging off the database's tip.
   * Anything else is recorded — signerDivergence(), the administrative log —
   * and nothing is corrected. The server runs this at start-up; a refusal of
   * a receipt's position runs it for that chain.
   */
  async reconcileWithSigner(systemIds: readonly string[] = this.listSystems()): Promise<ReconcileOutcome[]> {
    return this.enqueue(async () => {
      const outcomes: ReconcileOutcome[] = [];
      for (const systemId of systemIds) outcomes.push(await this.reconcileNow(systemId));
      return outcomes;
    });
  }

  /** Every chain the last comparison with the signer found wrong, sorted. */
  divergentSystems(): string[] {
    return [...this.divergences.keys()].sort();
  }

  /** What the last comparison with the signer found wrong with this chain, or null. */
  signerDivergence(systemId: string): string | null {
    return this.divergences.get(systemId) ?? null;
  }

  /**
   * Runs `work` on the write queue, with no write transaction of this store
   * open, for writes that go through another connection to the same file (an
   * API key issued from the web view). Outside the queue such a write would
   * wait for the lock synchronously, while a receipt waits for its signature,
   * and freeze the process that has to read that signature (review point 13).
   */
  async exclusive<T>(work: () => T): Promise<T> {
    return this.enqueue(async () => work());
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
   * Asks the signer for a checkpoint over the chain and stores it, once it is
   * shown to cover exactly what the chain holds here. The root and the time
   * are the signer's, from its own record: this process cannot have a
   * checkpoint signed over a tree the signer did not build. Returns null when
   * the last checkpoint already covered the same receipts: a chain with
   * nothing new does not need another statement about it.
   */
  async createCheckpoint(systemId: string): Promise<StoredCheckpoint | null> {
    return this.enqueue(() => this.writeCheckpoint(systemId));
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

  /**
   * Stores a token, through the write queue like every other write: were it
   * written directly, it would join whatever receipt transaction happened to
   * be open, and be lost if that one rolled back (review point 13).
   */
  async recordTimestamp(
    checkpointId: number,
    tsaUrl: string,
    tokenBase64: string,
    obtainedAt: string,
  ): Promise<void> {
    await this.enqueue(async () => {
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

  /**
   * The WHERE clause of the operator's history filters, shared by the search
   * and the counts so that the two can never disagree about what a filter
   * lets through.
   */
  private historyFilter(query: ReceiptFilter & { kind?: string }): { where: string; parameters: Record<string, string | number> } {
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
    return { where: clauses.join(" AND "), parameters };
  }

  /** Receipts matching a filter, newest first, for the operator's view. */
  searchReceipts(query: ReceiptFilter & { kind?: string; limit?: number }): Receipt[] {
    const { where, parameters } = this.historyFilter(query);
    parameters["limit"] = Math.min(Math.max(query.limit ?? 100, 1), 1000);

    const rows = this.read
      .prepare(
        `SELECT canonical, sig FROM receipts
         WHERE ${where}
         ORDER BY seq DESC LIMIT @limit`,
      )
      .all(parameters) as StoredRow[];
    return rows.map(rowToReceipt);
  }

  /**
   * How many receipts of each action kind the same filters let through, for
   * the history's filter by kind. A kind with none is absent. A read: nothing
   * is written, and nothing new is stored to answer it.
   */
  countReceiptsByKind(query: ReceiptFilter): Record<string, number> {
    const { where, parameters } = this.historyFilter(query);
    const rows = this.read
      .prepare(`SELECT action_kind AS kind, COUNT(*) AS count FROM receipts WHERE ${where} GROUP BY action_kind`)
      .all(parameters) as { kind: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
  }

  /** One receipt by its position in its chain, or null: the receipt the history's inspector shows. */
  receiptAt(systemId: string, seq: number): Receipt | null {
    const row = this.read
      .prepare("SELECT canonical, sig FROM receipts WHERE system_id = ? AND seq = ?")
      .get(systemId, seq) as StoredRow | undefined;
    return row === undefined ? null : rowToReceipt(row);
  }

  /**
   * Every recorded use of a document, oldest first, across every system,
   * searched by the fingerprints `documentFingerprints` computed (here or, from
   * the same code, in the browser). Each use is reported once, under the
   * strongest kind of match it has.
   */
  findDocument(fingerprints: DocumentFingerprints): DocumentMatch[] {
    const found = new Map<string, DocumentMatch>();
    const keep = (key: string, match: DocumentMatch): void => {
      const previous = found.get(key);
      if (previous === undefined || MATCH_STRENGTH[match.kind] < MATCH_STRENGTH[previous.kind]) found.set(key, match);
    };
    const artifactRows = this.read.prepare(
      `SELECT a.id, a.system_id, a.seq, a.role, a.label, a.media_type, a.text_canon,
              r.ts_received, r.action_kind, r.action_name
       FROM artifacts a
       JOIN receipts r ON r.system_id = a.system_id AND r.seq = a.seq
       WHERE a.sha256 = @digest OR (@text = 1 AND a.text_sha256 = @digest)`,
    );
    const byArtifact = (kind: DocumentMatchKind, digest: string, text: 0 | 1): void => {
      for (const row of artifactRows.all({ digest, text }) as (Omit<DocumentMatch, "kind"> & { id: number })[]) {
        const { id, ...match } = row;
        keep(`artifact:${id}`, { kind, ...match });
      }
    };
    byArtifact("bytes", fingerprints.bytes, 0);
    if (fingerprints.text !== null) byArtifact("text", fingerprints.text, 1);
    for (const digest of fingerprints.lines) byArtifact("lines", digest, 0);

    for (const role of ["input", "output"] as const) {
      const payloadRows = this.read.prepare(
        `SELECT system_id, seq, ts_received, action_kind, action_name FROM receipts
         WHERE json_extract(canonical, '$.${role}_hash') = ?`,
      );
      const byPayload = (kind: DocumentMatchKind, digest: string): void => {
        for (const row of payloadRows.all(digest) as Pick<DocumentMatch, "system_id" | "seq" | "ts_received" | "action_kind" | "action_name">[]) {
          keep(`${role}:${row.system_id}:${row.seq}`, { kind, role, label: null, media_type: null, text_canon: null, ...row });
        }
      };
      if (fingerprints.json !== null) byPayload("json", fingerprints.json);
      for (const digest of fingerprints.jsonLines) byPayload("json-lines", digest);
    }

    return [...found.values()].sort(
      (a, b) => a.ts_received.localeCompare(b.ts_received) || a.system_id.localeCompare(b.system_id) || a.seq - b.seq,
    );
  }

  /** The token standing for this identifier, in any spelling normaliseSubjectIdentifier folds together; null if none. */
  subjectToken(identifier: string): string | null {
    let normalised: string;
    try {
      normalised = normaliseSubjectIdentifier(identifier);
    } catch {
      return null;
    }
    const row = this.read.prepare("SELECT token FROM subjects WHERE identifier = ?").get(normalised) as
      | { token: string }
      | undefined;
    return row?.token ?? null;
  }

  /**
   * How many receipts written before version 4 name this identifier in clear,
   * in any spelling normaliseSubjectIdentifier folds together. Those receipts
   * carry `on_behalf_of` as the client sent it, cannot be changed, and are
   * not reached by eraseSubject: whoever erases a person is told how many
   * there are (SECURITY.md, "Erasing a person").
   */
  legacyReceiptsNaming(identifier: string): number {
    let wanted: string;
    try {
      wanted = normaliseSubjectIdentifier(identifier);
    } catch {
      return 0;
    }
    const rows = this.read
      .prepare(
        `SELECT json_extract(canonical, '$.actor.on_behalf_of') AS who, count(*) AS n
         FROM receipts
         WHERE json_extract(canonical, '$.v') < 4 AND json_extract(canonical, '$.actor.on_behalf_of') IS NOT NULL
         GROUP BY who`,
      )
      .all() as { who: string; n: number }[];
    let count = 0;
    for (const row of rows) {
      try {
        if (normaliseSubjectIdentifier(row.who) === wanted) count += row.n;
      } catch {
        // Too long or empty once normalised: it cannot be anyone's identifier today.
      }
    }
    return count;
  }

  /** The identifier a token stands for, or null: never known, or erased. */
  subjectIdentifier(token: string): string | null {
    const row = this.read.prepare("SELECT identifier FROM subjects WHERE token = ?").get(token) as
      | { identifier: string }
      | undefined;
    return row?.identifier ?? null;
  }

  /**
   * The identifier a token stands for, but only if some receipt of this
   * system was made on its behalf: what an export of the system may disclose.
   * A token from another system's chain, which an organization has no
   * business naming, gets null here, exactly like an erased one.
   */
  subjectIdentifierIn(systemId: string, token: string): string | null {
    const row = this.read
      .prepare(
        `SELECT s.identifier FROM subjects s
         WHERE s.token = @token AND EXISTS (
           SELECT 1 FROM receipts r
           WHERE r.system_id = @system_id AND json_extract(r.canonical, '$.actor.on_behalf_of') = @token
         )`,
      )
      .get({ token, system_id: systemId }) as { identifier: string } | undefined;
    return row?.identifier ?? null;
  }

  /** Which system a checkpoint belongs to, or null if there is no such checkpoint. */
  checkpointSystemId(checkpointId: number): string | null {
    const row = this.read.prepare("SELECT system_id FROM checkpoints WHERE id = ?").get(checkpointId) as
      | { system_id: string }
      | undefined;
    return row?.system_id ?? null;
  }

  /** Every receipt made on behalf of `token`, across systems, newest first. */
  receiptsOnBehalfOf(token: string, limit = 500): Receipt[] {
    const rows = this.read
      .prepare(
        `SELECT canonical, sig FROM receipts
         WHERE json_extract(canonical, '$.actor.on_behalf_of') = ?
         ORDER BY ts_received DESC, system_id, seq DESC LIMIT ?`,
      )
      .all(token, Math.min(Math.max(limit, 1), 10_000)) as StoredRow[];
    return rows.map(rowToReceipt);
  }

  /**
   * Erases a person: deletes the row that says who `token` stands for, and
   * logs the erasure by the token alone. Every receipt stays exactly as it
   * was, valid and verifiable, and no longer leads to anyone. The file's
   * write-ahead log is folded back and emptied straight after, so the deleted
   * identifier is not left behind in it (copies made before, backups
   * included, still hold it until they are rotated away: SECURITY.md).
   * False when there was no such row, and then nothing is logged.
   */
  async eraseSubject(token: string, request: AdminRequest): Promise<boolean> {
    const erased = await this.enqueue(() =>
      this.inTransaction(async () => {
        const removed = this.write.prepare("DELETE FROM subjects WHERE token = ?").run(token).changes;
        if (removed > 0) this.logAdmin("subject.erase", "", request, { token });
        return removed > 0;
      }),
    );
    if (erased) await this.foldWriteAheadLog();
    return erased;
  }

  /** The nonce of a salted digest, hex, or null: a plain digest, none at all, or erased. */
  opening(systemId: string, seq: number, role: "input" | "output"): string | null {
    const row = this.read
      .prepare("SELECT nonce FROM openings WHERE system_id = ? AND seq = ? AND role = ?")
      .get(systemId, seq, role) as { nonce: string } | undefined;
    return row?.nonce ?? null;
  }

  /** Every nonce still held for these receipts of a system, for an export that is asked to disclose them. */
  openingsOf(systemId: string, seqs: readonly number[]): { seq: number; role: "input" | "output"; nonce: string }[] {
    const statement = this.read.prepare(
      "SELECT seq, role, nonce FROM openings WHERE system_id = ? AND seq = ? ORDER BY role",
    );
    return [...new Set(seqs)]
      .sort((a, b) => a - b)
      .flatMap((seq) => statement.all(systemId, seq) as { seq: number; role: "input" | "output"; nonce: string }[]);
  }

  /**
   * Cuts receipts off from their content: deletes the nonces of their salted
   * digests, after which neither the operator nor anyone else can show what
   * they were computed over. Logged with the positions and the count, never a
   * nonce. Returns how many nonces were deleted.
   */
  async eraseOpenings(systemId: string, seqs: readonly number[], request: AdminRequest): Promise<number> {
    const positions = [...new Set(seqs)].sort((a, b) => a - b);
    const erased = await this.administer(systemId, () => {
      const statement = this.write.prepare("DELETE FROM openings WHERE system_id = ? AND seq = ?");
      const count = positions.reduce((total, seq) => total + statement.run(systemId, seq).changes, 0);
      this.logAdmin("openings.erase", systemId, request, { seqs: positions, erased: count });
      return count;
    });
    await this.foldWriteAheadLog();
    return erased;
  }

  /**
   * The receipts to cut off when a document's subject asks to be forgotten
   * (a candidate and their CV): every receipt that names the document by its
   * exact or its text fingerprint, and every receipt of the same system that
   * shares a trace with one of those — the rest of that run of the agent,
   * whose inputs and outputs were the document's content or came from it.
   */
  receiptsOfDocument(sha256: string): ReceiptPositions[] {
    const rows = this.read
      .prepare(
        `WITH named AS (
           SELECT DISTINCT system_id, seq FROM artifacts WHERE sha256 = @digest OR text_sha256 = @digest
         )
         SELECT DISTINCT r.system_id, r.seq FROM receipts r
         WHERE EXISTS (SELECT 1 FROM named n WHERE n.system_id = r.system_id AND n.seq = r.seq)
            OR r.source_trace_id IN (
                 SELECT n2.source_trace_id FROM named n JOIN receipts n2 ON n2.system_id = n.system_id AND n2.seq = n.seq
                 WHERE n2.source_trace_id IS NOT NULL AND n2.system_id = r.system_id
               )
         ORDER BY r.system_id, r.seq`,
      )
      .all({ digest: sha256 }) as { system_id: string; seq: number }[];
    const bySystem = new Map<string, number[]>();
    for (const row of rows) bySystem.set(row.system_id, [...(bySystem.get(row.system_id) ?? []), row.seq]);
    return [...bySystem].map(([system_id, seqs]) => ({ system_id, seqs }));
  }

  /**
   * Moves everything in the write-ahead log into the database file and
   * empties the log, so that rows just overwritten by secure_delete do not
   * survive in it. On the write queue, so that no receipt transaction of
   * this store is open meanwhile. Best effort: a reader in another process
   * can hold the log open, and then SQLite's next automatic checkpoint does
   * it; the erasure itself is already committed.
   */
  private async foldWriteAheadLog(): Promise<void> {
    await this.enqueue(async () => {
      try {
        this.write.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // Committed either way: see above.
      }
    });
  }

  /**
   * One administrative change, on the write queue and inside one IMMEDIATE
   * transaction: the change and its log entry are written together or not at
   * all.
   */
  private async administer<T>(systemId: string, work: (record: SystemRecord) => T): Promise<T> {
    return this.enqueue(() =>
      this.inTransaction(async () => {
        const record = this.write
          .prepare(
            `${SYSTEM_RECORDS} WHERE s.system_id = ?`,
          )
          .get(systemId) as SystemRecord | undefined;
        if (record === undefined) throw new StorageError(`unknown system ${systemId}`);
        return work(record);
      }),
    );
  }

  private logAdmin(
    action: AdminAction,
    systemId: string,
    request: AdminRequest,
    detail: Record<string, unknown>,
    genesisHash: string | null = null,
  ): void {
    this.write
      .prepare(
        `INSERT INTO admin_log (ts, action, system_id, actor, detail, genesis_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(request.ts, action, systemId, request.actor, JSON.stringify(detail), genesisHash);
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
    if (this.write !== this.read) this.write.close();
  }

  private async writeCheckpoint(systemId: string): Promise<StoredCheckpoint | null> {
    const { signer, verificationKey } = this.writer();

    // The chain here first agrees with the signer's record, or is brought
    // level with it (a receipt signed and lost to a crash), or nothing is
    // signed at all.
    const agreement = await this.reconcileNow(systemId);
    if (agreement.status === "diverged") {
      throw new SignerRefusedError("sequence", `no checkpoint for ${systemId}: ${agreement.detail}`);
    }

    const hashes = (
      this.write.prepare("SELECT hash FROM receipts WHERE system_id = ? ORDER BY seq").all(systemId) as { hash: string }[]
    ).map((row) => row.hash);
    if (hashes.length === 0) {
      throw new StorageError(`unknown system ${systemId}: it has no receipts to check point`);
    }
    const covered = this.write
      .prepare("SELECT tree_size FROM checkpoints WHERE system_id = ? ORDER BY tree_size DESC LIMIT 1")
      .get(systemId) as { tree_size: number } | undefined;
    if (covered !== undefined && covered.tree_size === hashes.length) {
      return null;
    }

    const checkpoint = await signer.checkpoint(systemId);
    // Checked, not trusted, exactly as for a receipt: the signature first,
    // then that the tree it describes is the tree this database holds.
    if (
      checkpoint.system_id !== systemId ||
      checkpoint.key_id !== signer.keyId ||
      !verifyDigestSignature(checkpointHash(checkpoint), checkpoint.sig, verificationKey)
    ) {
      throw refusedSignature("checkpoint", signer.keyId);
    }
    const root = toHex(merkleRoot(hashes.map((hash) => fromHex(hash))));
    if (checkpoint.tree_size !== hashes.length || checkpoint.root_hash !== root) {
      const detail =
        `the signer's checkpoint covers ${checkpoint.tree_size} receipts with root ${checkpoint.root_hash}, ` +
        `and this database holds ${hashes.length} with root ${root}`;
      this.recordDivergence(systemId, detail);
      throw new SignerRefusedError("sequence", `no checkpoint for ${systemId}: ${detail}`);
    }

    return this.inTransaction(async () => {
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
      return { id: Number(result.lastInsertRowid), checkpoint };
    });
  }

  /** The signer and its key, for a store that writes; a store opened without one cannot. */
  private writer(): { signer: SigningService; verificationKey: KeyObject } {
    if (this.signer === undefined || this.verificationKey === undefined) {
      throw new StorageError("this store was opened for reading only: it has no signer");
    }
    return { signer: this.signer, verificationKey: this.verificationKey };
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
   *
   * When the signer refuses the position — it has signed a receipt this
   * database does not hold — the chain is reconciled with it, and the receipt
   * is tried once more if that recovered the missing one. Any other
   * disagreement is recorded, and the refusal stands.
   */
  private async writeReceipt(
    event: ChainEvent,
    mode: "genesis" | "continuation",
    organizationId: string | null = null,
  ): Promise<{ receipt: Receipt; duplicate: boolean }> {
    try {
      return await this.inTransaction(() => this.insertReceipt(event, mode, organizationId));
    } catch (error) {
      if (!(error instanceof SignerRefusedError) || error.code !== "sequence") throw error;
      const outcome = await this.reconcileNow(event.system_id);
      if (outcome.status !== "recovered") {
        throw new SignerRefusedError(
          "sequence",
          outcome.status === "diverged" ? `${error.message}; ${outcome.detail}` : error.message,
        );
      }
      return this.inTransaction(() => this.insertReceipt(event, mode, organizationId));
    }
  }

  /** One IMMEDIATE transaction around `work`: committed if it succeeds, rolled back if it throws. */
  private async inTransaction<T>(work: () => Promise<T>): Promise<T> {
    this.write.exec("BEGIN IMMEDIATE");
    try {
      const result = await work();
      this.write.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.write.inTransaction) {
        this.write.exec("ROLLBACK");
      }
      throw error;
    }
  }

  /**
   * An input or output digest and its scheme: as the client computed it
   * (plain), or computed here from the value under a fresh 32-byte nonce
   * (salted), which insertRow stores in `openings` with the receipt.
   * The value itself goes no further than this function.
   */
  private digestFor(
    role: "input" | "output",
    clientHash: string | null,
    raw: { value: unknown } | undefined,
    clientNonce?: string,
  ): Digest {
    if (raw !== undefined && clientHash !== null) {
      throw new StorageError(`an action carries either its ${role} or a digest of it, not both`);
    }
    if (clientNonce !== undefined) {
      // Salted by the client, which never sent the value: the nonce is kept
      // in `openings` exactly like one made here, and erased the same way.
      if (clientHash === null || !NONCE_HEX.test(clientNonce)) {
        throw new StorageError(`a ${role} nonce is 64 lowercase hex characters, sent with the digest it salted`);
      }
      return { hash: clientHash, scheme: HASH_SCHEME_SALTED, nonce: clientNonce };
    }
    if (raw === undefined) {
      return { hash: clientHash, scheme: clientHash === null ? null : HASH_SCHEME_PLAIN, nonce: null };
    }
    const nonce = new Uint8Array(randomBytes(SALT_NONCE_BYTES));
    return { hash: saltedDigest(nonce, raw.value), scheme: HASH_SCHEME_SALTED, nonce: toHex(nonce) };
  }

  /**
   * The actor as a receipt may hold it: `on_behalf_of` replaced by the
   * person's token, created on first sight inside the caller's transaction (so
   * a receipt that is rolled back takes its new subject with it). A value that
   * is already a token is the caller's own pseudonym, and passes as it is.
   * With `write` false nothing is written: a new person gets a stand-in
   * token, for checkEvent, which only needs to know the receipt would be valid.
   */
  private pseudonymous(actor: Actor, ts: string, write: boolean): Actor {
    const named = actor.on_behalf_of;
    if (named === undefined || isPseudonym(named)) return actor;
    const identifier = normaliseSubjectIdentifier(named);
    const known = this.write.prepare("SELECT token FROM subjects WHERE identifier = ?").get(identifier) as
      | { token: string }
      | undefined;
    if (known !== undefined) return { ...actor, on_behalf_of: known.token };
    const token = pseudonymFromRandom(new Uint8Array(randomBytes(PSEUDONYM_RANDOM_BYTES)));
    if (write) {
      this.write.prepare("INSERT INTO subjects (token, identifier, created_at) VALUES (?, ?, ?)").run(token, identifier, ts);
    }
    return { ...actor, on_behalf_of: token };
  }

  /**
   * The receipt an event becomes after `tip`, with its actor and digests as
   * `prepared` made them. Every receipt is written as version 4, whatever it
   * carries: the version that holds no identifier in the clear and says how
   * each digest was made. Receipts already written keep their own version.
   *
   * ts_received is never earlier than the receipt before it: the signer
   * refuses one that is, so a server clock stepping back is absorbed here
   * (the receipt says "received no earlier than the one before") instead of
   * stopping the chain until the clock catches up.
   */
  private buildUnsigned(event: ChainEvent, tip: TipRow | undefined, keyId: string, prepared: Prepared): UnsignedReceipt {
    const tsReceived =
      tip !== undefined && Date.parse(event.ts_received) < Date.parse(tip.ts_received) ? tip.ts_received : event.ts_received;
    const unsigned = parseUnsignedReceipt({
      v: RECEIPT_VERSION_4,
      system_id: event.system_id,
      seq: tip === undefined ? 0 : tip.seq + 1,
      ts_event: event.ts_event,
      ts_received: tsReceived,
      actor: prepared.actor,
      action: event.action,
      input_hash: prepared.input.hash,
      input_hash_scheme: prepared.input.scheme,
      output_hash: prepared.output.hash,
      output_hash_scheme: prepared.output.scheme,
      outcome: event.outcome,
      source: event.source,
      prev_hash: tip === undefined ? GENESIS_PREV_HASH : tip.hash,
      key_id: keyId,
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
    if (canonicalReceiptBytes(unsigned).length > MAX_RECEIPT_BYTES) {
      throw new StorageError(`a receipt is at most ${MAX_RECEIPT_BYTES} bytes in canonical form: nothing was signed or written`);
    }
    return unsigned;
  }

  /** The actor and digests of an event as its receipt holds them; `write` as in pseudonymous. */
  private prepare(event: ChainEvent, write: boolean): Prepared {
    return {
      actor: this.pseudonymous(event.actor, event.ts_received, write),
      input: this.digestFor("input", event.input_hash, event.raw_input, event.input_nonce),
      output: this.digestFor("output", event.output_hash, event.raw_output, event.output_nonce),
    };
  }

  /**
   * Everything about an event that can be refused before its position is
   * known, so that a batch with a bad event in it is refused before any of it
   * is signed. The position used here is a stand-in; the real one is
   * assigned in insertReceipt. Nothing is written: no subject, no nonce.
   */
  private checkEvent(event: ChainEvent): void {
    this.buildUnsigned(
      event,
      { seq: 0, hash: GENESIS_PREV_HASH, ts_received: event.ts_received },
      this.writer().signer.keyId,
      this.prepare(event, false),
    );
  }

  /**
   * Builds, signs, checks and inserts one receipt. The caller holds the
   * transaction. `duplicate` is true when this span was already on the
   * chain — found by `trace_id`/`span_id`, not written again, and no
   * signature was asked for it — rather than newly written now.
   */
  private async insertReceipt(
    event: ChainEvent,
    mode: "genesis" | "continuation",
    organizationId: string | null,
  ): Promise<{ receipt: Receipt; duplicate: boolean }> {
    const { signer, verificationKey } = this.writer();

    // An OTLP exporter resends a whole batch when it never sees the server's
    // response, even one the server did write; the span it names is found
    // here before anything else is touched, so a duplicate costs no seq and
    // no signature (fase 9 / review point 6).
    if (mode === "continuation" && event.source.trace_id !== undefined && event.source.span_id !== undefined) {
      const existing = this.duplicateStatement.get(
        event.system_id,
        event.source.trace_id,
        event.source.span_id,
      ) as StoredRow | undefined;
      if (existing !== undefined) {
        return { receipt: rowToReceipt(existing), duplicate: true };
      }
    }

    const tip = this.tipStatement.get(event.system_id) as TipRow | undefined;

    if (mode === "genesis" && tip !== undefined) {
      throw new StorageError(`a chain for ${event.system_id} already exists`);
    }
    if (mode === "continuation" && tip === undefined) {
      throw new StorageError(`unknown system ${event.system_id}: create its chain first`);
    }

    const prepared = this.prepare(event, true);
    const unsigned = this.buildUnsigned(event, tip, signer.keyId, prepared);
    const digest = sha256(canonicalReceiptBytes(unsigned));
    const sig = await signer.signReceipt(unsigned);
    // Validated again after signing: the signer is a separate process, and
    // what it returns is not taken on trust. The shape first, then the
    // signature itself: it must verify over exactly these bytes, under the
    // signer's own key, or the transaction is rolled back. A signature over
    // any other digest — another receipt's, say — is refused here whatever
    // route it took to arrive.
    const receipt = parseReceipt({ ...unsigned, sig });
    if (!verifyDigestSignature(digest, receipt.sig, verificationKey)) {
      throw refusedSignature("receipt", signer.keyId);
    }

    if (mode === "genesis") {
      this.registerStatement.run({
        system_id: event.system_id,
        created_at: event.ts_received,
        organization_id: organizationId,
      });
    }
    this.insertRow(receipt, prepared);
    return { receipt, duplicate: false };
  }

  /**
   * Writes a signed receipt, its artifact rows, and the nonces of its salted
   * digests when they are known: a receipt recovered from the signer's head
   * comes without them (reconcileNow). The caller holds the transaction.
   */
  private insertRow(receipt: Receipt, nonces?: Pick<Prepared, "input" | "output">): void {
    // One set of bytes: the ones stored as `canonical`, whose hash is stored
    // as `hash`, and which the signature was checked over.
    const canonicalBytes = canonicalReceiptBytes(receipt);
    this.insertStatement.run({
      system_id: receipt.system_id,
      seq: receipt.seq,
      hash: toHex(sha256(canonicalBytes)),
      prev_hash: receipt.prev_hash,
      canonical: new TextDecoder().decode(canonicalBytes),
      sig: receipt.sig,
      key_id: receipt.key_id,
      ts_event: receipt.ts_event,
      ts_received: receipt.ts_received,
      action_kind: receipt.action.kind,
      action_name: receipt.action.name,
      outcome: receipt.outcome,
      source_trace_id: receipt.source.trace_id ?? null,
      source_span_id: receipt.source.span_id ?? null,
    });

    for (const [role, digest] of [["input", nonces?.input], ["output", nonces?.output]] as const) {
      if (digest === undefined || digest.nonce === null) continue;
      this.write
        .prepare("INSERT INTO openings (system_id, seq, role, nonce) VALUES (?, ?, ?, ?)")
        .run(receipt.system_id, receipt.seq, role, digest.nonce);
    }

    if (receipt.v !== 1 && receipt.artifacts !== undefined) {
      for (const artifact of receipt.artifacts) {
        const text = "text" in artifact ? artifact.text : undefined;
        this.insertArtifactStatement.run({
          system_id: receipt.system_id,
          seq: receipt.seq,
          role: artifact.role,
          label: artifact.label,
          media_type: artifact.media_type,
          sha256: artifact.sha256,
          text_canon: text?.canon ?? null,
          text_sha256: text?.sha256 ?? null,
        });
      }
    }
  }

  /**
   * One chain against the signer's head. Called on the write queue with no
   * transaction open; whatever it writes, it commits itself, so a recovered
   * receipt is never rolled back by a later failure.
   */
  private async reconcileNow(systemId: string): Promise<ReconcileOutcome> {
    const { signer, verificationKey } = this.writer();
    const head = await signer.head(systemId);

    // Receipts the signer is ahead by, beyond the one its head holds, come
    // from its journal, fetched before the transaction: the queue this runs
    // on keeps the database's tip where it is meanwhile.
    const tipBefore = this.tipStatement.get(systemId) as TipRow | undefined;
    const firstMissing = (tipBefore?.seq ?? -1) + 1;
    let journal: Receipt[] | null = null;
    if (head !== null && head.seq > firstMissing && signer.receipts !== undefined) {
      journal = [];
      try {
        while (journal.length < head.seq - firstMissing + 1) {
          const page = await signer.receipts(systemId, firstMissing + journal.length, RECOVERY_PAGE);
          if (page.length === 0) break;
          journal.push(...page);
        }
      } catch {
        // A signer without a journal: only the one receipt its head holds can come back.
        journal = null;
      }
    }

    return this.inTransaction(async () => {
      const tip = this.tipStatement.get(systemId) as TipRow | undefined;
      const here = tip === undefined ? "this database holds no chain for it" : `this database is at seq ${tip.seq} (${tip.hash})`;
      const diverged = (detail: string): ReconcileOutcome => {
        this.recordDivergence(systemId, detail);
        return { system_id: systemId, status: "diverged", detail };
      };

      if (head === null) {
        if (tip === undefined) return { system_id: systemId, status: "in_sync" };
        return diverged(
          `the signer has signed nothing for ${systemId}, and ${here}: if this installation predates the ` +
            "signer's own state, run `sigillo-signer init-from-db` once",
        );
      }

      const keyFor = (receipt: Receipt): KeyObject | undefined =>
        this.publicKeyFor(receipt.key_id) ?? (receipt.key_id === signer.keyId ? verificationKey : undefined);
      const headHash = receiptHashHex(head);
      const headKey = keyFor(head);
      if (head.system_id !== systemId || headKey === undefined || !verifyReceiptSignature(head, headKey)) {
        return diverged(`the head the signer returned for ${systemId} is not a receipt of it under a known key`);
      }
      const there = `the signer is at seq ${head.seq} (${headHash})`;

      if (tip !== undefined && head.seq === tip.seq && headHash === tip.hash) {
        return { system_id: systemId, status: "in_sync" };
      }
      const tipSeq = tip?.seq ?? -1;
      if (head.seq <= tipSeq || tipSeq + 1 !== firstMissing) return diverged(`${there}, and ${here}`);

      // The signer signed receipts this database does not hold: the process
      // that asked for the last one never stored it, or the database was put
      // back to a copy older than the signer. They are taken back only if
      // every one is the next of the chain here, under a known key, ending
      // exactly at the signer's head.
      const missing = head.seq === firstMissing ? [head] : (journal ?? []);
      let previous = tip?.hash ?? GENESIS_PREV_HASH;
      const taken: Receipt[] = [];
      for (const [index, receipt] of missing.entries()) {
        const seq = firstMissing + index;
        const key = keyFor(receipt);
        if (
          receipt.system_id !== systemId ||
          receipt.seq !== seq ||
          receipt.prev_hash !== previous ||
          key === undefined ||
          !verifyReceiptSignature(receipt, key)
        ) {
          return diverged(`${there}, and ${here}; the signer's receipt for seq ${seq} does not continue this chain`);
        }
        previous = receiptHashHex(receipt);
        taken.push(receipt);
        if (seq === head.seq) break;
      }
      const last = taken.at(-1);
      if (last === undefined || last.seq !== head.seq || previous !== headHash) {
        return diverged(
          `${there}, and ${here}; the signer's journal does not hold every receipt in between ` +
            `(it reaches seq ${last?.seq ?? tipSeq})`,
        );
      }

      if (this.deletionOf(systemId, this.write) !== null) {
        return diverged(`${there}, but ${systemId} was deleted here, so its receipts are not restored`);
      }
      for (const receipt of taken) {
        const { trace_id, span_id } = receipt.source;
        if (trace_id !== undefined && span_id !== undefined && this.duplicateStatement.get(systemId, trace_id, span_id) !== undefined) {
          return diverged(`${there}, and the span ${trace_id}/${span_id} of seq ${receipt.seq} is already on the chain at another position`);
        }
      }

      for (const receipt of taken) {
        if (receipt.seq === 0) {
          // Whose it was is not in the signer's record: the operator decides again.
          this.registerStatement.run({ system_id: systemId, created_at: receipt.ts_received, organization_id: null });
        }
        this.insertRow(receipt);
        const { trace_id, span_id } = receipt.source;
        this.logAdmin(
          "signer.recovered",
          systemId,
          { actor: "server (reconciliation with the signer)", ts: new Date().toISOString() },
          {
            seq: receipt.seq,
            hash: receiptHashHex(receipt),
            ...(trace_id === undefined ? {} : { trace_id }),
            ...(span_id === undefined ? {} : { span_id }),
          },
        );
      }
      this.divergences.delete(systemId);
      return { system_id: systemId, status: "recovered", seq: head.seq, hash: headHash, count: taken.length };
    });
  }

  /**
   * Remembers a disagreement with the signer, and writes it to the
   * administrative log the first time this process finds it. Nothing is
   * corrected: which side is right is for a person to establish.
   */
  private recordDivergence(systemId: string, detail: string): void {
    if (this.divergences.get(systemId) === detail) return;
    this.divergences.set(systemId, detail);
    const log = (): void =>
      this.logAdmin(
        "signer.divergence",
        systemId,
        { actor: "server (reconciliation with the signer)", ts: new Date().toISOString() },
        { detail },
      );
    if (this.write.inTransaction) log();
    else this.write.transaction(log)();
  }
}
