import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { applySchema } from "../storage/schema.js";
import { checkSchedule, isSealedAt, type VaultSchedule } from "./vault-schedule.js";

/**
 * The cloud-model keys the gateway holds for a system (gateway/llm.ts): the
 * customer's own key for one of the providers in catalog.ts, given to sigillo so that the agent
 * never has it. An agent that wants the model has to come through the
 * gateway, and every call it makes there becomes a receipt.
 *
 * Each key is sealed with AES-256-GCM under the data key of the account that
 * owns the system (the Vaults class below), which only that account's
 * passphrase or recovery key opens: not the server's operator, not a copy of
 * the disk or of a backup. The system and the provider are bound in as
 * associated data, so a sealed key moved to another row does not open. Only
 * the last four characters are kept in the clear, for the web view. The
 * 32-byte file next to the database is kept for one purpose: opening the keys
 * sealed before vaults existed, until their owner makes a vault.
 */

export { isProvider, PROVIDERS, type Provider } from "./catalog.js";
import type { Provider } from "./catalog.js";

/** What a provider's key looks like: "sk-proj-…", "sk-ant-api03-…", "AIza…". Anything else is refused, not cleaned. */
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

const PASSPHRASE_MIN = 12;
const UNLOCK_TTL_MS = 12 * 3_600_000;
const GUESSES = 5;
const GUESS_WINDOW_MS = 15 * 60_000;
/** scrypt, from node:crypto: 32 MiB of memory per guess. */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

/** The account's vault is closed: its owner has not entered the passphrase since the server last started, or the unlocked time ran out. */
export class VaultLockedError extends VaultError {
  constructor(readonly owner: string, message = "this account's vault is locked: its owner must unlock it in the console") {
    super(message);
    this.name = "VaultLockedError";
  }
}

/** The vault is closed because the owner's schedule says so (vault-schedule.ts): it cannot be opened until the window ends. */
export class VaultSealedError extends VaultLockedError {
  constructor(owner: string) {
    super(owner, "this account's vault is sealed by its schedule: it can be unlocked again when the sealed hours end");
    this.name = "VaultSealedError";
  }
}

function seal(key: Buffer, plain: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
}

/**
 * What lets a customer's model keys be unreadable to the server's operator and
 * to anyone who copies its disk. Each account (organization, or "operator")
 * has one random 32-byte data key. The data key is stored sealed twice: under
 * a key scrypt derives from the customer's passphrase, and under a random
 * recovery key shown to them once and never stored. The data key itself lives
 * only in this process's memory, put there when the customer unlocks, and
 * dropped when they lock, when its time runs out, or when the process ends.
 *
 * What that does not hide: while it is unlocked, and while the passphrase is
 * being typed, the server holds what it needs to open the keys. Someone who
 * controls the running process in that time can read them.
 */
export class Vaults {
  private readonly open = new Map<string, { dataKey: Buffer; until: number }>();
  private readonly failures = new Map<string, number[]>();

  constructor(private readonly db: Database.Database) {}

  exists(owner: string): boolean {
    return this.db.prepare("SELECT 1 FROM vaults WHERE owner = ?").get(owner) !== undefined;
  }

  isUnlocked(owner: string, at: Date): boolean {
    return this.dataKey(owner, at) !== null;
  }

  /** The data key, or null while locked. */
  dataKey(owner: string, at: Date): Buffer | null {
    const held = this.open.get(owner);
    if (held === undefined) return null;
    if (at.getTime() >= held.until || this.isSealed(owner, at)) {
      this.lock(owner);
      return null;
    }
    return held.dataKey;
  }

  /** Makes the vault, leaves it unlocked, and returns the recovery key: the only time it exists outside the customer's hands. */
  create(owner: string, passphrase: string, at: Date): string {
    if (this.exists(owner)) throw new VaultError("this account already has a vault");
    checkPassphrase(passphrase);
    const dataKey = randomBytes(32);
    const recovery = randomBytes(32);
    const salt = randomBytes(16);
    this.db
      .prepare("INSERT INTO vaults (owner, salt, wrapped_by_pass, wrapped_by_recov, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        owner,
        salt.toString("base64"),
        seal(derive(passphrase, salt), dataKey, aad(owner, "pass")).toString("base64"),
        seal(recovery, dataKey, aad(owner, "recovery")).toString("base64"),
        at.toISOString(),
      );
    this.open.set(owner, { dataKey, until: at.getTime() + UNLOCK_TTL_MS });
    return recovery.toString("hex").replace(/(.{4})(?=.)/g, "$1-");
  }

  /** Opens with the passphrase or the recovery key. False for a wrong one; throws when too many were wrong lately. */
  unlock(owner: string, secret: string, at: Date): boolean {
    const row = this.db.prepare("SELECT salt, wrapped_by_pass, wrapped_by_recov FROM vaults WHERE owner = ?").get(owner) as
      | { salt: string; wrapped_by_pass: string; wrapped_by_recov: string }
      | undefined;
    if (row === undefined) throw new VaultError("this account has no vault yet");
    if (this.isSealed(owner, at)) throw new VaultSealedError(owner);
    const recent = (this.failures.get(owner) ?? []).filter((t) => at.getTime() - t < GUESS_WINDOW_MS);
    if (recent.length >= GUESSES) throw new VaultError("too many wrong attempts: try again in a few minutes");
    const dataKey = this.tryOpen(owner, secret, row);
    if (dataKey === null) {
      this.failures.set(owner, [...recent, at.getTime()]);
      return false;
    }
    this.failures.delete(owner);
    this.open.set(owner, { dataKey, until: at.getTime() + UNLOCK_TTL_MS });
    return true;
  }

  private tryOpen(owner: string, secret: string, row: { salt: string; wrapped_by_pass: string; wrapped_by_recov: string }): Buffer | null {
    const asRecovery = secret.replace(/[\s-]/g, "").toLowerCase();
    try {
      if (/^[0-9a-f]{64}$/.test(asRecovery)) {
        return open(Buffer.from(asRecovery, "hex"), Buffer.from(row.wrapped_by_recov, "base64"), aad(owner, "recovery"));
      }
    } catch {
      return null;
    }
    try {
      return open(derive(secret, Buffer.from(row.salt, "base64")), Buffer.from(row.wrapped_by_pass, "base64"), aad(owner, "pass"));
    } catch {
      return null;
    }
  }

  /** The owner's sealed hours, or null if they have set none. */
  schedule(owner: string): VaultSchedule | null {
    const row = this.db.prepare("SELECT timezone, windows FROM vault_schedule WHERE owner = ?").get(owner) as
      | { timezone: string; windows: string }
      | undefined;
    if (row === undefined) return null;
    return { timezone: row.timezone, windows: JSON.parse(row.windows) as VaultSchedule["windows"] };
  }

  /** Saves the sealed hours (an empty list of windows clears them) and closes the vault at once if one is running. Throws ScheduleError for a malformed one. */
  setSchedule(owner: string, schedule: unknown, at: Date): void {
    if (!this.exists(owner)) throw new VaultError("this account has no vault yet");
    const checked = checkSchedule(schedule);
    this.db
      .prepare(
        `INSERT INTO vault_schedule (owner, timezone, windows, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (owner) DO UPDATE SET timezone = excluded.timezone, windows = excluded.windows, updated_at = excluded.updated_at`,
      )
      .run(owner, checked.timezone, JSON.stringify(checked.windows), at.toISOString());
    if (this.isSealed(owner, at)) this.lock(owner);
  }

  isSealed(owner: string, at: Date): boolean {
    const schedule = this.schedule(owner);
    return schedule !== null && isSealedAt(schedule, at);
  }

  /** Closes every vault whose sealed hours have begun or whose time ran out, so the data key leaves memory when the window starts and not at the next request. */
  sweep(at: Date): string[] {
    const closed: string[] = [];
    for (const owner of [...this.open.keys()]) {
      if (this.dataKey(owner, at) === null) closed.push(owner);
    }
    return closed;
  }

  lock(owner: string): void {
    this.open.get(owner)?.dataKey.fill(0);
    this.open.delete(owner);
  }

  /** A new passphrase for an unlocked vault. The recovery key stays the same. */
  changePassphrase(owner: string, passphrase: string, at: Date): void {
    const dataKey = this.dataKey(owner, at);
    if (dataKey === null) throw new VaultLockedError(owner);
    checkPassphrase(passphrase);
    const salt = randomBytes(16);
    this.db
      .prepare("UPDATE vaults SET salt = ?, wrapped_by_pass = ? WHERE owner = ?")
      .run(salt.toString("base64"), seal(derive(passphrase, salt), dataKey, aad(owner, "pass")).toString("base64"), owner);
  }
}

function checkPassphrase(passphrase: string): void {
  if (passphrase.length < PASSPHRASE_MIN) throw new VaultError(`the passphrase needs at least ${PASSPHRASE_MIN} characters`);
}

function derive(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, SCRYPT);
}

function aad(owner: string, kind: "pass" | "recovery"): Buffer {
  return Buffer.from(`sigillo vault ${kind}\n${owner}`, "utf8");
}

export class ProviderKeyStore {
  readonly vaults: Vaults;

  private constructor(
    private readonly db: Database.Database,
    /** Opens only keys sealed before vaults existed; the customer's vault takes them over when it is made. */
    private readonly legacyKey: Buffer,
    private readonly ownerOf: (systemId: string) => string,
  ) {
    this.vaults = new Vaults(db);
  }

  /** `ownerOf`: whose vault a system's keys belong to (its organization's id, or "operator"). */
  static open(location: string, legacyKey: Buffer, ownerOf: (systemId: string) => string = () => "operator"): ProviderKeyStore {
    if (legacyKey.length !== 32) throw new ProviderKeyError("the sealing key must be 32 bytes");
    const db = new Database(location);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    applySchema(db);
    return new ProviderKeyStore(db, legacyKey, ownerOf);
  }

  /** Saves `key` for the system, replacing any it had for that provider. Needs the owner's vault, unlocked. */
  set(systemId: string, provider: Provider, key: string, createdAt: string, at: Date = new Date(createdAt)): ProviderKeyRecord {
    const cleaned = key.trim();
    if (!KEY_SHAPE.test(cleaned)) {
      throw new ProviderKeyError(
        "this does not look like an API key: letters, digits, '-', '_' and '.', 20 characters or more, nothing else",
      );
    }
    const owner = this.ownerOf(systemId);
    if (!this.vaults.exists(owner)) throw new VaultError("create the account's vault first");
    const dataKey = this.vaults.dataKey(owner, at);
    if (dataKey === null) throw new VaultLockedError(owner);
    const sealed = seal(dataKey, Buffer.from(cleaned, "utf8"), associatedData(systemId, provider));
    const last4 = cleaned.slice(-4);
    this.db
      .prepare(
        `INSERT INTO provider_keys (system_id, provider, sealed, last4, created_at, vault_owner)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (system_id, provider) DO UPDATE
         SET sealed = excluded.sealed, last4 = excluded.last4, created_at = excluded.created_at, vault_owner = excluded.vault_owner`,
      )
      .run(systemId, provider, sealed.toString("base64"), last4, createdAt, owner);
    return { provider, last4, createdAt };
  }

  /**
   * The key in the clear, for one call to the provider, or null if the system
   * has none. Throws VaultLockedError while its owner's vault is locked.
   */
  get(systemId: string, provider: Provider, at: Date = new Date()): string | null {
    const row = this.db
      .prepare("SELECT sealed, vault_owner FROM provider_keys WHERE system_id = ? AND provider = ?")
      .get(systemId, provider) as { sealed: string; vault_owner: string | null } | undefined;
    if (row === undefined) return null;
    const sealed = Buffer.from(row.sealed, "base64");
    const aadBytes = associatedData(systemId, provider);
    if (row.vault_owner === null) return open(this.legacyKey, sealed, aadBytes).toString("utf8");
    const dataKey = this.vaults.dataKey(row.vault_owner, at);
    if (dataKey === null) throw this.vaults.isSealed(row.vault_owner, at) ? new VaultSealedError(row.vault_owner) : new VaultLockedError(row.vault_owner);
    return open(dataKey, sealed, aadBytes).toString("utf8");
  }

  /** Makes an account's vault and re-seals under it every key of the account's still sealed under the server's own key. Returns the recovery key. */
  createVault(owner: string, passphrase: string, at: Date): string {
    const recovery = this.vaults.create(owner, passphrase, at);
    const dataKey = this.vaults.dataKey(owner, at)!;
    const rows = this.db
      .prepare("SELECT system_id, provider, sealed FROM provider_keys WHERE vault_owner IS NULL")
      .all() as { system_id: string; provider: Provider; sealed: string }[];
    const update = this.db.prepare("UPDATE provider_keys SET sealed = ?, vault_owner = ? WHERE system_id = ? AND provider = ?");
    for (const row of rows) {
      if (this.ownerOf(row.system_id) !== owner) continue;
      const aadBytes = associatedData(row.system_id, row.provider);
      const plain = open(this.legacyKey, Buffer.from(row.sealed, "base64"), aadBytes);
      update.run(seal(dataKey, plain, aadBytes).toString("base64"), owner, row.system_id, row.provider);
    }
    return recovery;
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
