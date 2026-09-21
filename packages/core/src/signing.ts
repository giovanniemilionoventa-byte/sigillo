import { type KeyObject, sign, verify } from "node:crypto";
import { receiptHash } from "./receipt.js";
import type { Receipt, UnsignedReceipt } from "./receipt.js";

const DIGEST_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const STANDARD_BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/**
 * Signs the 32 bytes of a receipt hash. Ed25519 takes the message itself, so
 * the algorithm argument is null: the digest is the message, and it is not
 * hashed again.
 */
export function signDigest(digest: Uint8Array, privateKey: KeyObject): string {
  if (digest.length !== DIGEST_LENGTH) {
    throw new Error(`a receipt hash is 32 bytes, received ${digest.length}`);
  }
  return Buffer.from(sign(null, digest, privateKey)).toString("base64");
}

/**
 * Returns whether the signature is valid. A malformed signature is a failed
 * check, not an exception: a verifier walking a log must be able to report it
 * and keep going.
 */
export function verifyDigestSignature(
  digest: Uint8Array,
  signatureBase64: string,
  publicKey: KeyObject,
): boolean {
  if (!STANDARD_BASE64_SIGNATURE.test(signatureBase64)) {
    return false;
  }
  const signature = Buffer.from(signatureBase64, "base64");
  if (signature.length !== SIGNATURE_LENGTH) {
    return false;
  }
  try {
    return verify(null, digest, publicKey, signature);
  } catch {
    return false;
  }
}

export function verifyReceiptSignature(receipt: Receipt, publicKey: KeyObject): boolean {
  return verifyDigestSignature(receiptHash(receipt), receipt.sig, publicKey);
}

/** Signs an unsigned receipt, returning the receipt a verifier will check. */
export function signReceipt(receipt: UnsignedReceipt, privateKey: KeyObject): Receipt {
  return { ...receipt, sig: signDigest(receiptHash(receipt), privateKey) };
}
