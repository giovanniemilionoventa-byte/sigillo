import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { applySchema } from "../storage/schema.js";

/**
 * One API key per system, stored only as an scrypt hash.
 *
 * A token looks like `sigillo_<16 hex key id>_<64 hex secret>`. The key id is
 * stored in the clear and is only a lookup handle: it tells the server which row
 * to check, so verifying costs one scrypt instead of one per key in the
 * database. The secret is 32 random bytes and is never stored, logged, or
 * returned again after it is issued.
 *
 * Both halves are hex so that the separator cannot occur inside them: a token
 * splits on `_` unambiguously, which base64url would not have allowed.
 */

const PREFIX = "sigillo";
const KEY_ID_BYTES = 8;
const SECRET_BYTES = 32;
const HASH_BYTES = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const TOKEN = /^sigillo_([0-9a-f]{16})_([0-9a-f]{64})$/;

export interface IssuedKey {
  keyId: string;
  systemId: string;
  /** The only time the full token exists. It is not recoverable afterwards. */
  token: string;
}

export interface KeyRecord {
  keyId: string;
  systemId: string;
  createdAt: string;
  revokedAt: string | null;
}

export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyError";
  }
}

interface KeyRow {
  key_id: string;
  system_id: string;
  salt: string;
  secret_hash: string;
  revoked_at: string | null;
}

function hashSecret(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, HASH_BYTES, SCRYPT);
}

/**
 * The same derivation, off the event loop. Verifying a presented token is the
 * one scrypt a stranger can ask for, and at about 55 ms each the synchronous
 * form let some twenty requests a second stall the whole process (review
 * point 10).
 */
function hashSecretAsync(secret: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, HASH_BYTES, SCRYPT, (error, derived) =>
      error === null ? resolve(derived) : reject(error),
    );
  });
}

export interface VerifyOptions {
  /**
   * Whether this call may run scrypt. When it may not, only a token this store
   * has already checked can succeed. The server turns it off for a client that
   * has failed too often, so that a flood of guesses costs it nothing while
   * agents whose token is already known carry on.
   */
  hashAllowed?: boolean;
}

export class ApiKeyStore {
  /**
   * The outcome of scrypt for tokens that have already been checked, keyed by
   * a SHA-256 of the token, so that ingest does not pay for an scrypt on every
   * request. Only the expensive half is remembered: whether the key is still
   * live is read from the database on every request, because a revocation is
   * made by another process (`sigillo-server key revoke`) that cannot reach
   * this memory (review point 2).
   */
  private readonly verified = new Map<string, string>();

  private constructor(private readonly db: Database.Database) {}

  static open(location: string): ApiKeyStore {
    const db = new Database(location);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    applySchema(db);
    return new ApiKeyStore(db);
  }

  issue(systemId: string, createdAt: string): IssuedKey {
    const known = this.db.prepare("SELECT 1 FROM systems WHERE system_id = ?").get(systemId);
    if (known === undefined) {
      throw new ApiKeyError(`unknown system ${systemId}: create it before issuing a key for it`);
    }

    const keyId = randomBytes(KEY_ID_BYTES).toString("hex");
    const secret = randomBytes(SECRET_BYTES).toString("hex");
    const salt = randomBytes(16).toString("base64");

    this.db
      .prepare(
        `INSERT INTO api_keys (key_id, system_id, salt, secret_hash, created_at, revoked_at)
         VALUES (@key_id, @system_id, @salt, @secret_hash, @created_at, NULL)`,
      )
      .run({
        key_id: keyId,
        system_id: systemId,
        salt,
        secret_hash: hashSecret(secret, salt).toString("base64"),
        created_at: createdAt,
      });

    return { keyId, systemId, token: `${PREFIX}_${keyId}_${secret}` };
  }

  revoke(keyId: string, revokedAt: string): boolean {
    const result = this.db
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL")
      .run(revokedAt, keyId);
    return result.changes > 0;
  }

  list(systemId?: string): KeyRecord[] {
    const rows = (
      systemId === undefined
        ? this.db.prepare("SELECT * FROM api_keys ORDER BY created_at").all()
        : this.db.prepare("SELECT * FROM api_keys WHERE system_id = ? ORDER BY created_at").all(systemId)
    ) as (KeyRow & { created_at: string })[];

    return rows.map((row) => ({
      keyId: row.key_id,
      systemId: row.system_id,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  /**
   * Resolves to the system the token speaks for, or null if it does not —
   * including a key whose system is archived. Archiving a system is meant to
   * stop new receipts from arriving through it (the display it is hidden
   * from would otherwise be the only sign anything changed); an agent that
   * is still sending is refused, exactly as with a revoked key, and the same
   * key starts working again the moment the system is unarchived, with
   * nothing reissued. Read from the database on every call, like
   * `revoked_at`: archiving is a write from another connection (the web
   * view, `sigillo-server system archive`) that this store's own cache of
   * verified tokens cannot see.
   */
  async verify(token: string, options: VerifyOptions = {}): Promise<string | null> {
    const parsed = TOKEN.exec(token);
    if (parsed === null) return null;
    const [, keyId, secret] = parsed;
    if (keyId === undefined || secret === undefined) return null;

    const row = this.db
      .prepare(
        `SELECT k.*, s.archived_at FROM api_keys k
         JOIN systems s ON s.system_id = k.system_id
         WHERE k.key_id = ?`,
      )
      .get(keyId) as (KeyRow & { archived_at: string | null }) | undefined;
    if (row === undefined || row.revoked_at !== null || row.archived_at !== null) return null;

    const fingerprint = createHash("sha256").update(token).digest("hex");
    if (this.verified.get(fingerprint) === row.key_id) return row.system_id;
    if (options.hashAllowed === false) return null;

    const expected = Buffer.from(row.secret_hash, "base64");
    const actual = await hashSecretAsync(secret, row.salt);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }

    this.verified.set(fingerprint, row.key_id);
    return row.system_id;
  }

  close(): void {
    this.db.close();
  }
}
