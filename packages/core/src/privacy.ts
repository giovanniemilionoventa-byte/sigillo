import { createHash } from "node:crypto";
import { canonicalBytes, toHex } from "./canonical.js";

/**
 * The two constructions receipt version 4 adds so that a receipt holds no
 * personal data in the clear (FORMAT.md sections 2.2 and 2.7). Both take their
 * randomness from the caller: core never draws any itself.
 */

/**
 * A pseudonym token: what `actor.on_behalf_of` holds in a version 4 receipt
 * instead of an identifier. 128 random bits, so it says nothing about the
 * person; the server keeps which identifier it stands for in a separate,
 * erasable table, and once that row is gone nothing links the two.
 */
export const PSEUDONYM_PREFIX = "psn_";
export const PSEUDONYM_RANDOM_BYTES = 16;
const PSEUDONYM_PATTERN = /^psn_[0-9a-f]{32}$/;

export function isPseudonym(value: string): boolean {
  return PSEUDONYM_PATTERN.test(value);
}

export function pseudonymFromRandom(random: Uint8Array): string {
  if (random.length !== PSEUDONYM_RANDOM_BYTES) {
    throw new Error(`a pseudonym is made from exactly ${PSEUDONYM_RANDOM_BYTES} bytes of randomness`);
  }
  return `${PSEUDONYM_PREFIX}${toHex(random)}`;
}

/**
 * How an `input_hash` or `output_hash` was computed, named in the receipt
 * beside it. `plain`: SHA-256 of the value's RFC 8785 form, the only scheme of
 * versions 1 to 3, and what a client that hashes for itself sends. `salted`:
 * SHA-256 of a 32-byte random nonce followed by those same bytes. Short
 * content (a score, a yes or no) cannot be found from a salted digest by
 * trying candidates, and the same content gives a different digest in every
 * receipt; whoever holds the nonce and the content can still show the two
 * match. A different construction would be a new name, never a change to
 * either of these.
 */
export const HASH_SCHEME_PLAIN = "plain" as const;
export const HASH_SCHEME_SALTED = "salted" as const;
export const SALT_NONCE_BYTES = 32;

export function saltedDigest(nonce: Uint8Array, value: unknown): string {
  if (nonce.length !== SALT_NONCE_BYTES) {
    throw new Error(`a salted digest takes a nonce of exactly ${SALT_NONCE_BYTES} bytes`);
  }
  return createHash("sha256").update(nonce).update(canonicalBytes(value)).digest("hex");
}

/** Whether `digest` is the salted digest of `value` under `nonce`. False for a nonce of the wrong length. */
export function openSaltedDigest(digest: string, nonce: Uint8Array, value: unknown): boolean {
  if (nonce.length !== SALT_NONCE_BYTES) return false;
  return saltedDigest(nonce, value) === digest;
}
