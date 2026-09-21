import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyError, ApiKeyStore } from "../src/auth/api-keys.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";

const SYSTEM = "acme-support-bot";
const OTHER = "acme-billing-bot";
const AT = "2026-03-29T14:00:00.000Z";

let directory: string;
let databasePath: string;
let store: ReceiptStore;
let keys: ApiKeyStore;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-keys-"));
  databasePath = join(directory, "sigillo.db");
  store = ReceiptStore.open(databasePath, createTestSigner());
  await store.createSystem(SYSTEM, AT);
  await store.createSystem(OTHER, AT);
  keys = ApiKeyStore.open(databasePath);
});

afterEach(() => {
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("issuing a key", () => {
  it("returns a token that authenticates its system", () => {
    const issued = keys.issue(SYSTEM, AT);
    expect(issued.token).toMatch(/^sigillo_[0-9a-f]{16}_[0-9a-f]{64}$/);
    expect(issued.token).toContain(issued.keyId);
    expect(keys.verify(issued.token)).toBe(SYSTEM);
  });

  it("keeps each system's keys to that system", () => {
    const first = keys.issue(SYSTEM, AT);
    const second = keys.issue(OTHER, AT);
    expect(keys.verify(first.token)).toBe(SYSTEM);
    expect(keys.verify(second.token)).toBe(OTHER);
  });

  it("issues distinct keys every time", () => {
    const tokens = new Set(Array.from({ length: 5 }, () => keys.issue(SYSTEM, AT).token));
    expect(tokens.size).toBe(5);
    for (const token of tokens) {
      expect(keys.verify(token)).toBe(SYSTEM);
    }
  });

  it("refuses to issue a key for a system that does not exist", () => {
    expect(() => keys.issue("never-created", AT)).toThrow(ApiKeyError);
  });
});

describe("what the database holds", () => {
  it("never contains the secret, in any form that could be replayed", () => {
    const issued = keys.issue(SYSTEM, AT);
    const secret = issued.token.split("_")[2] ?? "";
    expect(secret).toHaveLength(64);

    // Force the write-ahead log out so the check sees everything on disk.
    const raw = new Database(databasePath);
    raw.pragma("wal_checkpoint(TRUNCATE)");
    const row = raw.prepare("SELECT * FROM api_keys WHERE key_id = ?").get(issued.keyId) as {
      secret_hash: string;
      salt: string;
    };
    raw.close();

    for (const file of ["", "-wal", "-shm"]) {
      const bytes = (() => {
        try {
          return readFileSync(`${databasePath}${file}`);
        } catch {
          return Buffer.alloc(0);
        }
      })();
      expect(bytes.includes(secret)).toBe(false);
    }

    // Not the secret, and not a plain digest of it either: scrypt with a salt.
    expect(row.secret_hash).not.toBe(secret);
    expect(row.secret_hash).not.toBe(createHash("sha256").update(secret).digest("base64"));
    expect(Buffer.from(row.secret_hash, "base64")).toHaveLength(32);
    expect(row.salt.length).toBeGreaterThan(0);
  });

  it("gives two keys with the same system different salts and hashes", () => {
    const first = keys.issue(SYSTEM, AT);
    const second = keys.issue(SYSTEM, AT);
    const raw = new Database(databasePath);
    const rows = raw
      .prepare("SELECT salt, secret_hash FROM api_keys WHERE key_id IN (?, ?)")
      .all(first.keyId, second.keyId) as { salt: string; secret_hash: string }[];
    raw.close();
    expect(rows[0]?.salt).not.toBe(rows[1]?.salt);
    expect(rows[0]?.secret_hash).not.toBe(rows[1]?.secret_hash);
  });
});

describe("rejecting a token", () => {
  it("rejects anything that is not a token this store issued", () => {
    const issued = keys.issue(SYSTEM, AT);
    const [prefix, keyId, secret] = issued.token.split("_") as [string, string, string];

    const rejected = [
      "",
      "not-a-token",
      prefix,
      `${prefix}_${keyId}`,
      // Right shape, wrong secret.
      `${prefix}_${keyId}_${"a".repeat(64)}`,
      // Right secret, unknown key id.
      `${prefix}_0123456789abcdef_${secret}`,
      // Right parts, wrong prefix.
      `sigillio_${keyId}_${secret}`,
      // The key id alone is not a credential.
      keyId,
      `${issued.token} `,
      `${issued.token}x`,
    ];

    for (const token of rejected) {
      expect(keys.verify(token), token).toBeNull();
    }
    expect(keys.verify(issued.token)).toBe(SYSTEM);
  });

  it("rejects a secret that differs from the real one in a single character", () => {
    const issued = keys.issue(SYSTEM, AT);
    const [prefix, keyId, secret] = issued.token.split("_") as [string, string, string];
    const flipped = `${secret[0] === "a" ? "b" : "a"}${secret.slice(1)}`;
    expect(keys.verify(`${prefix}_${keyId}_${flipped}`)).toBeNull();
  });
});

describe("revoking a key", () => {
  it("stops the key working, even one that had been used", () => {
    const issued = keys.issue(SYSTEM, AT);
    expect(keys.verify(issued.token)).toBe(SYSTEM);

    expect(keys.revoke(issued.keyId, "2026-03-29T15:00:00.000Z")).toBe(true);
    expect(keys.verify(issued.token)).toBeNull();
  });

  it("leaves the other keys of the same system alone", () => {
    const revoked = keys.issue(SYSTEM, AT);
    const kept = keys.issue(SYSTEM, AT);
    keys.revoke(revoked.keyId, "2026-03-29T15:00:00.000Z");
    expect(keys.verify(revoked.token)).toBeNull();
    expect(keys.verify(kept.token)).toBe(SYSTEM);
  });

  it("reports that there was nothing to revoke", () => {
    const issued = keys.issue(SYSTEM, AT);
    keys.revoke(issued.keyId, "2026-03-29T15:00:00.000Z");
    expect(keys.revoke(issued.keyId, "2026-03-29T15:01:00.000Z")).toBe(false);
    expect(keys.revoke("0123456789abcdef", "2026-03-29T15:01:00.000Z")).toBe(false);
  });
});

describe("listing keys", () => {
  it("shows which keys are live and which were revoked", () => {
    const live = keys.issue(SYSTEM, AT);
    const dead = keys.issue(SYSTEM, AT);
    keys.revoke(dead.keyId, "2026-03-29T15:00:00.000Z");

    const listed = keys.list(SYSTEM);
    expect(listed).toHaveLength(2);
    expect(listed.find((record) => record.keyId === live.keyId)?.revokedAt).toBeNull();
    expect(listed.find((record) => record.keyId === dead.keyId)?.revokedAt).toBe(
      "2026-03-29T15:00:00.000Z",
    );
  });

  it("never lists a secret", () => {
    const issued = keys.issue(SYSTEM, AT);
    const secret = issued.token.split("_")[2] ?? "";
    expect(JSON.stringify(keys.list())).not.toContain(secret);
  });

  it("can be narrowed to one system", () => {
    keys.issue(SYSTEM, AT);
    keys.issue(OTHER, AT);
    expect(keys.list(SYSTEM)).toHaveLength(1);
    expect(keys.list()).toHaveLength(2);
  });
});
