import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromHex, keyIdFromRawPublicKey, signDigest, verifyDigestSignature } from "@sigillo/core";
import { generateKeyFile, loadKeyFile } from "../src/key-file.js";

let directory: string;
let keyPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-key-"));
  keyPath = join(directory, "signer.key");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("generating a key file", () => {
  it("writes a file readable only by its owner", () => {
    generateKeyFile(keyPath);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("writes a PKCS#8 PEM, so an operator can inspect it with openssl", () => {
    generateKeyFile(keyPath);
    expect(readFileSync(keyPath, "utf8")).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it("returns a key identifier that matches the public key it wrote", () => {
    const key = generateKeyFile(keyPath);
    const raw = new Uint8Array(Buffer.from(key.publicKeyBase64, "base64"));
    expect(raw).toHaveLength(32);
    expect(key.keyId).toBe(keyIdFromRawPublicKey(raw));
  });

  it("refuses to overwrite an existing key", () => {
    generateKeyFile(keyPath);
    const before = readFileSync(keyPath, "utf8");
    expect(() => generateKeyFile(keyPath)).toThrow(/exists/i);
    expect(readFileSync(keyPath, "utf8")).toBe(before);
  });

  it("generates a different key every time", () => {
    const first = generateKeyFile(keyPath);
    const second = generateKeyFile(join(directory, "other.key"));
    expect(first.keyId).not.toBe(second.keyId);
  });
});

describe("loading a key file", () => {
  it("loads back the key that was generated", () => {
    const generated = generateKeyFile(keyPath);
    const loaded = loadKeyFile(keyPath);
    expect(loaded.keyId).toBe(generated.keyId);
    expect(loaded.publicKeyBase64).toBe(generated.publicKeyBase64);
  });

  it("loads a key that signs verifiably", () => {
    generateKeyFile(keyPath);
    const key = loadKeyFile(keyPath);
    const digest = fromHex("74a67e081df5c321729640090e63ca95991f9657bfaab0af51e4504cc2056241");
    const signature = signDigest(digest, key.privateKey);
    expect(verifyDigestSignature(digest, signature, key.publicKey)).toBe(true);
  });

  it("refuses a key file that others can read", () => {
    generateKeyFile(keyPath);
    chmodSync(keyPath, 0o644);
    expect(() => loadKeyFile(keyPath)).toThrow(/permission/i);
    chmodSync(keyPath, 0o640);
    expect(() => loadKeyFile(keyPath)).toThrow(/permission/i);
  });

  it("reports a missing key file clearly", () => {
    expect(() => loadKeyFile(join(directory, "absent.key"))).toThrow(/no key file/i);
  });

  it("reports a key file that is not an Ed25519 key", () => {
    writeFileSync(keyPath, "not a key at all\n", { mode: 0o600 });
    expect(() => loadKeyFile(keyPath)).toThrow();
  });
});
