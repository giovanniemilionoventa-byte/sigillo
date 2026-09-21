import { createPublicKey, type KeyObject } from "node:crypto";
import { sha256Hex } from "./canonical.js";

const ED25519_PUBLIC_KEY_LENGTH = 32;

function assertRawLength(raw: Uint8Array): void {
  if (raw.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(`an Ed25519 public key is 32 bytes, received ${raw.length}`);
  }
}

/** Rebuilds a usable key from the 32 raw bytes an export or a manifest carries. */
export function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  assertRawLength(raw);
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") },
    format: "jwk",
  });
}

/** The 32 raw bytes of a public key, without DER or PEM framing. */
export function rawPublicKeyBytes(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: "jwk" });
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    throw new Error("expected an Ed25519 public key");
  }
  const raw = new Uint8Array(Buffer.from(jwk.x, "base64url"));
  assertRawLength(raw);
  return raw;
}

/**
 * The `key_id` carried by every receipt: the first 16 hex characters of the
 * SHA-256 digest of the raw public key. It names a key, it does not stand in
 * for one — a verifier still has to hold the key itself.
 */
export function keyIdFromRawPublicKey(raw: Uint8Array): string {
  assertRawLength(raw);
  return sha256Hex(raw).slice(0, 16);
}
