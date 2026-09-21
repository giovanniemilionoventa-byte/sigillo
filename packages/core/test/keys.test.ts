import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fromHex,
  keyIdFromRawPublicKey,
  publicKeyFromRaw,
  rawPublicKeyBytes,
  toHex,
} from "@sigillo/core";

// RFC 8032 section 7.1, TEST 1: public key of the first Ed25519 test vector.
const RFC8032_PUBLIC_KEY = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
// sha256 of those 32 bytes, computed with python hashlib and openssl:
// 21fe31dfa154a261626bf854046fd2271b7bed4b6abe45aa58877ef47f9721b9
const RFC8032_KEY_ID = "21fe31dfa154a261";

describe("key identifiers", () => {
  it("is the first 16 hex characters of SHA-256 over the raw public key", () => {
    expect(keyIdFromRawPublicKey(fromHex(RFC8032_PUBLIC_KEY))).toBe(RFC8032_KEY_ID);
    expect(keyIdFromRawPublicKey(fromHex(RFC8032_PUBLIC_KEY))).toHaveLength(16);
  });

  it("is taken over the raw key, not over its DER or PEM framing", () => {
    const key = publicKeyFromRaw(fromHex(RFC8032_PUBLIC_KEY));
    const der = new Uint8Array(key.export({ format: "der", type: "spki" }));
    // A DER SPKI Ed25519 key is 44 bytes: 12 of framing, then the 32 raw bytes.
    expect(der).toHaveLength(44);
    expect(toHex(der.slice(12))).toBe(RFC8032_PUBLIC_KEY);
    expect(keyIdFromRawPublicKey(der.slice(12))).toBe(RFC8032_KEY_ID);
  });

  it("round-trips a raw key through a Node key object", () => {
    const raw = fromHex(RFC8032_PUBLIC_KEY);
    expect(toHex(rawPublicKeyBytes(publicKeyFromRaw(raw)))).toBe(RFC8032_PUBLIC_KEY);
  });

  it("reads the raw bytes out of a freshly generated key pair", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const raw = rawPublicKeyBytes(publicKey);
    expect(raw).toHaveLength(32);
    expect(keyIdFromRawPublicKey(raw)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives different keys different identifiers", () => {
    const first = rawPublicKeyBytes(generateKeyPairSync("ed25519").publicKey);
    const second = rawPublicKeyBytes(generateKeyPairSync("ed25519").publicKey);
    expect(keyIdFromRawPublicKey(first)).not.toBe(keyIdFromRawPublicKey(second));
  });

  it("refuses a public key that is not 32 bytes", () => {
    expect(() => keyIdFromRawPublicKey(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => publicKeyFromRaw(new Uint8Array(33))).toThrow(/32 bytes/);
  });

  it("refuses to read raw bytes from a key that is not Ed25519", () => {
    const { publicKey } = generateKeyPairSync("x25519");
    expect(() => rawPublicKeyBytes(publicKey)).toThrow(/Ed25519/);
  });
});
