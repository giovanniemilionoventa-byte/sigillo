import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateSealingKey, ProviderKeyError, ProviderKeyStore } from "../src/gateway/provider-keys.js";

/**
 * The customers' cloud-model keys, sealed with AES-256-GCM from node:crypto
 * (never mocked). What is stored never shows the key, a sealed key opens only
 * on its own row and under its own sealing key, and anything altered fails.
 */

const OPENAI_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const ANTHROPIC_KEY = "sk-ant-api03-ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210";
const AT = "2026-10-05T17:00:00.000Z";

let directory: string;
let databasePath: string;
let sealingKey: Buffer;
let keys: ProviderKeyStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-provider-keys-"));
  databasePath = join(directory, "sigillo.db");
  sealingKey = loadOrCreateSealingKey(join(directory, "llm-gateway.key"));
  keys = ProviderKeyStore.open(databasePath, sealingKey);
});

afterEach(() => {
  keys.close();
  rmSync(directory, { recursive: true, force: true });
});

const rawRows = (): { system_id: string; provider: string; sealed: string; last4: string }[] => {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare("SELECT system_id, provider, sealed, last4 FROM provider_keys ORDER BY system_id, provider").all() as {
      system_id: string;
      provider: string;
      sealed: string;
      last4: string;
    }[];
  } finally {
    db.close();
  }
};

describe("the sealing key file", () => {
  it("is made once, 32 random bytes in hex, readable by its owner alone, and read back the same", () => {
    const path = join(directory, "llm-gateway.key");
    expect(readFileSync(path, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadOrCreateSealingKey(path).equals(sealingKey)).toBe(true);
    expect(loadOrCreateSealingKey(join(directory, "another.key")).equals(sealingKey)).toBe(false);
  });

  it("refuses a file that does not hold a key, rather than replacing it", () => {
    const path = join(directory, "broken.key");
    writeFileSync(path, "not a key\n");
    expect(() => loadOrCreateSealingKey(path)).toThrow(ProviderKeyError);
    expect(readFileSync(path, "utf8")).toBe("not a key\n");
  });
});

describe("ProviderKeyStore", () => {
  it("gives a saved key back, and stores only its sealed form and last four characters", () => {
    expect(keys.set("bot", "openai", `  ${OPENAI_KEY}\n`, AT)).toEqual({ provider: "openai", last4: "6789", createdAt: AT });
    keys.set("bot", "anthropic", ANTHROPIC_KEY, AT);
    expect(keys.get("bot", "openai")).toBe(OPENAI_KEY);
    expect(keys.get("bot", "anthropic")).toBe(ANTHROPIC_KEY);
    expect(keys.get("other-bot", "openai")).toBeNull();
    expect(keys.list("bot")).toEqual([
      { provider: "anthropic", last4: "3210", createdAt: AT },
      { provider: "openai", last4: "6789", createdAt: AT },
    ]);

    const file = readFileSync(databasePath);
    for (const row of rawRows()) {
      expect(row.sealed).not.toContain("sk-");
      expect(file.includes(Buffer.from(OPENAI_KEY))).toBe(false);
      expect(file.includes(Buffer.from(ANTHROPIC_KEY))).toBe(false);
    }
  });

  it("seals the same key differently each time it is saved", () => {
    keys.set("bot", "openai", OPENAI_KEY, AT);
    const first = rawRows()[0]!.sealed;
    keys.set("bot", "openai", OPENAI_KEY, AT);
    const second = rawRows()[0]!.sealed;
    expect(second).not.toBe(first);
    expect(keys.get("bot", "openai")).toBe(OPENAI_KEY);
  });

  it("replaces a provider's key and removes it", () => {
    keys.set("bot", "openai", OPENAI_KEY, AT);
    keys.set("bot", "openai", `${OPENAI_KEY}NEW1`, AT);
    expect(keys.get("bot", "openai")).toBe(`${OPENAI_KEY}NEW1`);
    expect(keys.remove("bot", "openai")).toBe(true);
    expect(keys.remove("bot", "openai")).toBe(false);
    expect(keys.get("bot", "openai")).toBeNull();
  });

  it("refuses what does not look like a key", () => {
    for (const bad of ["short", `${OPENAI_KEY} extra`, `${OPENAI_KEY}\n${OPENAI_KEY}`, "x".repeat(513), "sk-ünïcödé-0123456789abcdef"]) {
      expect(() => keys.set("bot", "openai", bad, AT)).toThrow(ProviderKeyError);
    }
    expect(keys.list("bot")).toEqual([]);
  });

  it("does not open a sealed key moved to another system or another provider", () => {
    keys.set("bot", "openai", OPENAI_KEY, AT);
    const sealed = rawRows()[0]!.sealed;
    const db = new Database(databasePath);
    db.prepare("INSERT INTO provider_keys (system_id, provider, sealed, last4, created_at) VALUES (?, ?, ?, ?, ?)").run("thief", "openai", sealed, "6789", AT);
    db.prepare("INSERT INTO provider_keys (system_id, provider, sealed, last4, created_at) VALUES (?, ?, ?, ?, ?)").run("bot", "anthropic", sealed, "6789", AT);
    db.close();
    expect(() => keys.get("thief", "openai")).toThrow();
    expect(() => keys.get("bot", "anthropic")).toThrow();
    expect(keys.get("bot", "openai")).toBe(OPENAI_KEY);
  });

  it("does not open a key whose sealed form was altered", () => {
    keys.set("bot", "openai", OPENAI_KEY, AT);
    const sealed = Buffer.from(rawRows()[0]!.sealed, "base64");
    for (const at of [0, 12, sealed.length - 1]) {
      const altered = Buffer.from(sealed);
      altered[at] = altered[at]! ^ 0x01;
      const db = new Database(databasePath);
      db.prepare("UPDATE provider_keys SET sealed = ? WHERE system_id = 'bot'").run(altered.toString("base64"));
      db.close();
      expect(() => keys.get("bot", "openai")).toThrow();
    }
  });

  it("does not open anything under another sealing key", () => {
    keys.set("bot", "openai", OPENAI_KEY, AT);
    const other = ProviderKeyStore.open(databasePath, loadOrCreateSealingKey(join(directory, "another.key")));
    try {
      expect(() => other.get("bot", "openai")).toThrow();
      expect(other.list("bot")).toEqual([{ provider: "openai", last4: "6789", createdAt: AT }]);
    } finally {
      other.close();
    }
    expect(() => ProviderKeyStore.open(databasePath, Buffer.alloc(16))).toThrow(ProviderKeyError);
  });
});
