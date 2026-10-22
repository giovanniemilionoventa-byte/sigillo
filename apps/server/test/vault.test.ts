import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateSealingKey, ProviderKeyStore, VaultLockedError, VaultError } from "../src/gateway/provider-keys.js";

/**
 * The customer's vault: model keys sealed under a data key that only the
 * customer's passphrase (or recovery key) can open. Real scrypt and AES-GCM
 * from node:crypto, never mocked. What the database holds must open nothing
 * without that passphrase, and the server forgets the data key on its own.
 */

const OPENAI_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const PASSPHRASE = "correct horse battery staple";
const AT = new Date("2026-10-22T10:00:00.000Z");
const ISO = AT.toISOString();
const HOUR = 3_600_000;

let directory: string;
let databasePath: string;
let keys: ProviderKeyStore;
const owners: Record<string, string> = { bot: "acme", "other-bot": "globex" };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-vault-"));
  databasePath = join(directory, "sigillo.db");
  keys = ProviderKeyStore.open(databasePath, loadOrCreateSealingKey(join(directory, "llm-gateway.key")), (id) => owners[id] ?? "operator");
});

afterEach(() => {
  keys.close();
  rmSync(directory, { recursive: true, force: true });
});

const dump = (): string => {
  const db = new Database(databasePath, { readonly: true });
  try {
    return JSON.stringify([db.prepare("SELECT * FROM vaults").all(), db.prepare("SELECT * FROM provider_keys").all()]);
  } finally {
    db.close();
  }
};

describe("the vault of an account", () => {
  it("is made with a passphrase and hands back a recovery key shown once", () => {
    expect(keys.vaults.exists("acme")).toBe(false);
    const recovery = keys.vaults.create("acme", PASSPHRASE, AT);
    expect(recovery).toMatch(/^([0-9a-f]{4}-){15}[0-9a-f]{4}$/);
    expect(keys.vaults.exists("acme")).toBe(true);
    expect(keys.vaults.isUnlocked("acme", AT)).toBe(true);
    expect(() => keys.vaults.create("acme", PASSPHRASE, AT)).toThrow(VaultError);
  });

  it("refuses a short passphrase", () => {
    expect(() => keys.vaults.create("acme", "too short", AT)).toThrow(VaultError);
  });

  it("holds model keys that nothing in the database or the key file opens", () => {
    keys.vaults.create("acme", PASSPHRASE, AT);
    keys.set("bot", "openai", OPENAI_KEY, ISO, AT);
    const text = dump();
    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain(PASSPHRASE);
    expect(keys.get("bot", "openai", AT)).toBe(OPENAI_KEY);
    // A fresh process: same database, same key file, nobody has unlocked.
    keys.close();
    keys = ProviderKeyStore.open(databasePath, loadOrCreateSealingKey(join(directory, "llm-gateway.key")), (id) => owners[id] ?? "operator");
    expect(keys.vaults.isUnlocked("acme", AT)).toBe(false);
    expect(() => keys.get("bot", "openai", AT)).toThrow(VaultLockedError);
    expect(() => keys.set("bot", "openai", OPENAI_KEY, ISO, AT)).toThrow(VaultLockedError);
    expect(keys.list("bot")).toEqual([{ provider: "openai", last4: "6789", createdAt: ISO }]);
  });

  it("opens with the passphrase and not with a wrong one", () => {
    keys.vaults.create("acme", PASSPHRASE, AT);
    keys.set("bot", "openai", OPENAI_KEY, ISO, AT);
    keys.vaults.lock("acme");
    expect(keys.vaults.unlock("acme", "wrong passphrase here", AT)).toBe(false);
    expect(keys.vaults.isUnlocked("acme", AT)).toBe(false);
    expect(keys.vaults.unlock("acme", PASSPHRASE, AT)).toBe(true);
    expect(keys.get("bot", "openai", AT)).toBe(OPENAI_KEY);
  });

  it("locks itself after its time and when the owner locks it", () => {
    keys.vaults.create("acme", PASSPHRASE, AT);
    keys.set("bot", "openai", OPENAI_KEY, ISO, AT);
    expect(keys.get("bot", "openai", new Date(AT.getTime() + 11 * HOUR))).toBe(OPENAI_KEY);
    expect(() => keys.get("bot", "openai", new Date(AT.getTime() + 13 * HOUR))).toThrow(VaultLockedError);
    keys.vaults.unlock("acme", PASSPHRASE, AT);
    keys.vaults.lock("acme");
    expect(() => keys.get("bot", "openai", AT)).toThrow(VaultLockedError);
  });

  it("does not open one account's keys with another account's vault", () => {
    keys.vaults.create("acme", PASSPHRASE, AT);
    keys.vaults.create("globex", "another long passphrase", AT);
    keys.set("bot", "openai", OPENAI_KEY, ISO, AT);
    const db = new Database(databasePath);
    const row = db.prepare("SELECT sealed FROM provider_keys WHERE system_id = 'bot'").get() as { sealed: string };
    db.prepare("INSERT INTO provider_keys (system_id, provider, sealed, last4, created_at, vault_owner) VALUES ('other-bot', 'openai', ?, '6789', ?, 'globex')").run(row.sealed, ISO);
    db.close();
    expect(() => keys.get("other-bot", "openai", AT)).toThrow();
  });

  it("opens with the recovery key, and the passphrase can then be replaced", () => {
    const recovery = keys.vaults.create("acme", PASSPHRASE, AT);
    keys.set("bot", "openai", OPENAI_KEY, ISO, AT);
    keys.vaults.lock("acme");
    expect(keys.vaults.unlock("acme", recovery.toUpperCase().replaceAll("-", " "), AT)).toBe(true);
    keys.vaults.changePassphrase("acme", "a brand new passphrase", AT);
    keys.vaults.lock("acme");
    expect(keys.vaults.unlock("acme", PASSPHRASE, AT)).toBe(false);
    expect(keys.vaults.unlock("acme", "a brand new passphrase", AT)).toBe(true);
    expect(keys.get("bot", "openai", AT)).toBe(OPENAI_KEY);
  });

  it("changes the passphrase only while unlocked", () => {
    keys.vaults.create("acme", PASSPHRASE, AT);
    keys.vaults.lock("acme");
    expect(() => keys.vaults.changePassphrase("acme", "a brand new passphrase", AT)).toThrow(VaultLockedError);
  });

  it("slows down someone guessing", () => {
    keys.vaults.create("acme", PASSPHRASE, AT);
    keys.vaults.lock("acme");
    for (let i = 0; i < 5; i++) expect(keys.vaults.unlock("acme", `wrong guess number ${i}`, AT)).toBe(false);
    expect(() => keys.vaults.unlock("acme", PASSPHRASE, AT)).toThrow(VaultError);
    expect(keys.vaults.unlock("acme", PASSPHRASE, new Date(AT.getTime() + 16 * 60_000))).toBe(true);
  });

  it("takes over the keys sealed before vaults existed, and then the server's own key opens nothing of theirs", () => {
    // Written the old way: under the server's key, no vault.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", loadOrCreateSealingKey(join(directory, "llm-gateway.key")), iv);
    cipher.setAAD(Buffer.from("sigillo provider key\nbot\nopenai", "utf8"));
    const sealed = Buffer.concat([iv, cipher.update(OPENAI_KEY, "utf8"), cipher.final(), cipher.getAuthTag()]);
    const db = new Database(databasePath);
    db.prepare("INSERT INTO provider_keys (system_id, provider, sealed, last4, created_at) VALUES ('bot', 'openai', ?, '6789', ?)").run(sealed.toString("base64"), ISO);
    db.close();
    expect(() => keys.get("bot", "openai", AT)).not.toThrow(); // still opens under the server key until the account has a vault
    keys.createVault("acme", PASSPHRASE, AT);
    expect(keys.get("bot", "openai", AT)).toBe(OPENAI_KEY);
    const other = ProviderKeyStore.open(databasePath, loadOrCreateSealingKey(join(directory, "llm-gateway.key")), (id) => owners[id] ?? "operator");
    try {
      expect(() => other.get("bot", "openai", AT)).toThrow(VaultLockedError);
    } finally {
      other.close();
    }
  });
});
