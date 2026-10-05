import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { applySchema } from "../storage/schema.js";

/**
 * The cloud-model keys the gateway holds for a system (gateway/llm.ts): the
 * customer's own OpenAI or Anthropic key, given to sigillo so that the agent
 * never has it. An agent that wants the model has to come through the
 * gateway, and every call it makes there becomes a receipt.
 *
 * Each key is sealed with AES-256-GCM under a 32-byte key that lives in its
 * own file, next to the database and never inside it: a copy of the database
 * (a backup, `cli backup`) holds the sealed keys and nothing that opens them.
 * The system and the provider are bound in as associated data, so a sealed
 * key moved to another row does not open. Only the last four characters are
 * kept in the clear, for the web view.
 */

export const PROVIDERS = ["openai", "anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** What a provider's key looks like: "sk-proj-…", "sk-ant-api03-…". Anything else is refused, not cleaned. */
const KEY_SHAPE = /^[A-Za-z0-9_.-]{20,512}$/;

export class ProviderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderKeyError";
  }
}

export interface ProviderKeyRecord {
  provider: Provider;
  last4: string;
  createdAt: string;
}

/**
 * The sealing key, from `path`: read if the file exists, otherwise made once,
 * readable by this user alone. `wx` so that two processes starting together
 * never both write one.
 */
export function loadOrCreateSealingKey(path: string): Buffer {
  try {
    return parseSealingKey(readFileSync(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return parseSealingKey(readFileSync(path, "utf8"), path);
}

function parseSealingKey(text: string, path: string): Buffer {
  const hex = text.trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new ProviderKeyError(`${path} does not hold a 32-byte key in hex`);
  return Buffer.from(hex, "hex");
}

export class ProviderKeyStore {
  private constructor(
    private readonly db: Database.Database,
    private readonly sealingKey: Buffer,
  ) {}

  static open(location: string, sealingKey: Buffer): ProviderKeyStore {
    if (sealingKey.length !== 32) throw new ProviderKeyError("the sealing key must be 32 bytes");
    const db = new Database(location);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    applySchema(db);
    return new ProviderKeyStore(db, sealingKey);
  }

  /** Saves `key` for the system, replacing any it had for that provider. */
  set(systemId: string, provider: Provider, key: string, createdAt: string): ProviderKeyRecord {
    const cleaned = key.trim();
    if (!KEY_SHAPE.test(cleaned)) {
      throw new ProviderKeyError(
        "this does not look like an API key: letters, digits, '-', '_' and '.', 20 characters or more, nothing else",
      );
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.sealingKey, iv);
    cipher.setAAD(associatedData(systemId, provider));
    const sealed = Buffer.concat([iv, cipher.update(cleaned, "utf8"), cipher.final(), cipher.getAuthTag()]);
    const last4 = cleaned.slice(-4);
    this.db
      .prepare(
        `INSERT INTO provider_keys (system_id, provider, sealed, last4, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (system_id, provider) DO UPDATE
         SET sealed = excluded.sealed, last4 = excluded.last4, created_at = excluded.created_at`,
      )
      .run(systemId, provider, sealed.toString("base64"), last4, createdAt);
    return { provider, last4, createdAt };
  }

  /** The key in the clear, for one call to the provider, or null if the system has none. */
  get(systemId: string, provider: Provider): string | null {
    const row = this.db
      .prepare("SELECT sealed FROM provider_keys WHERE system_id = ? AND provider = ?")
      .get(systemId, provider) as { sealed: string } | undefined;
    if (row === undefined) return null;
    const sealed = Buffer.from(row.sealed, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.sealingKey, sealed.subarray(0, 12));
    decipher.setAAD(associatedData(systemId, provider));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString("utf8");
  }

  /** What the web view shows: which providers have a key, and its last four characters. */
  list(systemId: string): ProviderKeyRecord[] {
    const rows = this.db
      .prepare("SELECT provider, last4, created_at FROM provider_keys WHERE system_id = ? ORDER BY provider")
      .all(systemId) as { provider: Provider; last4: string; created_at: string }[];
    return rows.map((row) => ({ provider: row.provider, last4: row.last4, createdAt: row.created_at }));
  }

  remove(systemId: string, provider: Provider): boolean {
    return this.db.prepare("DELETE FROM provider_keys WHERE system_id = ? AND provider = ?").run(systemId, provider).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

function associatedData(systemId: string, provider: Provider): Buffer {
  return Buffer.from(`sigillo provider key\n${systemId}\n${provider}`, "utf8");
}
