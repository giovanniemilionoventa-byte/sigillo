import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../storage/schema.js";

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

export class ApiKeyStore {
  /**
   * Tokens that have already been checked, so that ingest does not pay for an
   * scrypt on every request. Lives only in memory, and holds the presented
   * token, which the caller sent us anyway.
   */
  private readonly verified = new Map<string, string>();

  private constructor(private readonly db: Database.Database) {}

  static open(location: string): ApiKeyStore {
    const db = new Database(location);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA_SQL);
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
    this.verified.clear();
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

  /** Returns the system the token speaks for, or null if it does not. */
  verify(token: string): string | null {
    const cached = this.verified.get(token);
    if (cached !== undefined) {
      // A revocation clears the cache, so a hit here is still a live key.
      return cached;
    }

    const parsed = TOKEN.exec(token);
    if (parsed === null) return null;
    const [, keyId, secret] = parsed;
    if (keyId === undefined || secret === undefined) return null;

    const row = this.db.prepare("SELECT * FROM api_keys WHERE key_id = ?").get(keyId) as
      | KeyRow
      | undefined;
    if (row === undefined || row.revoked_at !== null) return null;

    const expected = Buffer.from(row.secret_hash, "base64");
    const actual = hashSecret(secret, row.salt);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return null;
    }

    this.verified.set(token, row.system_id);
    return row.system_id;
  }

  close(): void {
    this.db.close();
  }
}
