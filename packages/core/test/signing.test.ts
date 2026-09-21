import { createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fromHex,
  GENESIS_PREV_HASH,
  keyIdFromRawPublicKey,
  publicKeyFromRaw,
  receiptHash,
  signDigest,
  verifyDigestSignature,
  verifyReceiptSignature,
  type Receipt,
} from "@sigillo/core";

interface SigningVector {
  seed_hex: string;
  public_key_hex: string;
  key_id: string;
  digest_hex: string;
  signature_base64: string;
}

const vector = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/signing-vector.json", import.meta.url)), "utf8"),
) as SigningVector;

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** Rebuilds the vector's private key without going through a key file. */
function vectorPrivateKey(): KeyObject {
  return createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: base64url(fromHex(vector.seed_hex)),
      x: base64url(fromHex(vector.public_key_hex)),
    },
    format: "jwk",
  });
}

const vectorPublicKey = (): KeyObject => publicKeyFromRaw(fromHex(vector.public_key_hex));

describe("signing a digest", () => {
  it("reproduces a signature made by openssl over the same 32 bytes", () => {
    expect(signDigest(fromHex(vector.digest_hex), vectorPrivateKey())).toBe(
      vector.signature_base64,
    );
  });

  it("produces standard base64 of 64 bytes, as the receipt format requires", () => {
    const signature = signDigest(fromHex(vector.digest_hex), vectorPrivateKey());
    expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(Buffer.from(signature, "base64")).toHaveLength(64);
  });

  it("agrees with the key identifier derived from the same key", () => {
    expect(keyIdFromRawPublicKey(fromHex(vector.public_key_hex))).toBe(vector.key_id);
  });

  it("refuses anything that is not a 32-byte digest", () => {
    const key = vectorPrivateKey();
    expect(() => signDigest(new Uint8Array(31), key)).toThrow(/32 bytes/);
    expect(() => signDigest(new Uint8Array(33), key)).toThrow(/32 bytes/);
    expect(() => signDigest(new Uint8Array(0), key)).toThrow(/32 bytes/);
  });
});

describe("verifying a signature over a digest", () => {
  it("accepts the openssl signature", () => {
    expect(
      verifyDigestSignature(fromHex(vector.digest_hex), vector.signature_base64, vectorPublicKey()),
    ).toBe(true);
  });

  it("rejects a signature over a different digest", () => {
    const altered = fromHex(vector.digest_hex);
    altered[0] = (altered[0] ?? 0) ^ 0x01;
    expect(verifyDigestSignature(altered, vector.signature_base64, vectorPublicKey())).toBe(false);
  });

  it("rejects a signature made by another key", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(
      verifyDigestSignature(fromHex(vector.digest_hex), vector.signature_base64, publicKey),
    ).toBe(false);
  });

  it("rejects an altered or malformed signature instead of throwing", () => {
    const digest = fromHex(vector.digest_hex);
    const key = vectorPublicKey();
    const flipped = `${vector.signature_base64[0] === "A" ? "B" : "A"}${vector.signature_base64.slice(1)}`;
    expect(verifyDigestSignature(digest, flipped, key)).toBe(false);
    expect(verifyDigestSignature(digest, vector.signature_base64.slice(0, 80), key)).toBe(false);
    expect(verifyDigestSignature(digest, "not base64 at all!!", key)).toBe(false);
    expect(verifyDigestSignature(digest, "", key)).toBe(false);
  });

  it("round-trips with a freshly generated key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const digest = fromHex(vector.digest_hex);
    const signature = signDigest(digest, privateKey);
    expect(verifyDigestSignature(digest, signature, publicKey)).toBe(true);
  });
});

describe("verifying a receipt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  function signedReceipt(): Receipt {
    const unsigned = {
      v: 1 as const,
      system_id: "acme-support-bot",
      seq: 0,
      ts_event: "2026-03-29T14:30:00.123Z",
      ts_received: "2026-03-29T14:30:00.456Z",
      actor: { agent: "acme-support-bot" },
      action: { kind: "genesis" as const, name: "acme-support-bot" },
      input_hash: null,
      output_hash: null,
      outcome: "ok" as const,
      source: { type: "api" as const },
      prev_hash: GENESIS_PREV_HASH,
      key_id: "3f2a1c9d8e7b6a5f",
    };
    return { ...unsigned, sig: signDigest(receiptHash(unsigned), privateKey) };
  }

  it("accepts a receipt signed with the matching key", () => {
    expect(verifyReceiptSignature(signedReceipt(), publicKey)).toBe(true);
  });

  it("rejects a receipt whose content changed after it was signed", () => {
    const mutations: Receipt[] = [
      { ...signedReceipt(), outcome: "error" },
      { ...signedReceipt(), seq: 1 },
      { ...signedReceipt(), system_id: "other-system" },
      { ...signedReceipt(), ts_received: "2026-03-29T14:30:00.457Z" },
      { ...signedReceipt(), prev_hash: `${GENESIS_PREV_HASH.slice(0, 63)}1` },
      { ...signedReceipt(), key_id: "0000000000000000" },
      { ...signedReceipt(), actor: { agent: "someone-else" } },
    ];
    for (const receipt of mutations) {
      expect(verifyReceiptSignature(receipt, publicKey)).toBe(false);
    }
  });

  it("rejects a receipt signed by a different key", () => {
    const other = generateKeyPairSync("ed25519");
    expect(verifyReceiptSignature(signedReceipt(), other.publicKey)).toBe(false);
  });
});
