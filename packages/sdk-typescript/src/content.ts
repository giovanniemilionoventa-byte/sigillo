import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Digests of content, made here before anything leaves the process. These are
 * the same rules sdk-python/src/sigillo/__init__.py applies (and the server
 * applies to a raw value): the test file holds this module to packages/core.
 */

/**
 * SHA-256 of the RFC 8785 canonical JSON form of a string. For a string that
 * is its JSON encoding, which JavaScript's JSON.stringify already produces in
 * the canonical form (no escaping beyond what the RFC requires).
 */
export function hashContentValue(value: string): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** SHA-256 of a 32-byte nonce followed by the canonical form (FORMAT.md 2.7). */
export function saltedHashContentValue(value: string, nonce: Buffer): string {
  return createHash("sha256").update(nonce).update(JSON.stringify(value), "utf8").digest("hex");
}

export function freshNonce(): Buffer {
  return randomBytes(32);
}

/** What `sigillo.<role>.nonce` says when the customer's own key made the nonce. */
export const NONCE_KEPT_BY_CUSTOMER = "customer";

const TRACE_ID_HEX = /^[0-9a-f]{32}$/;
const SPAN_ID_HEX = /^[0-9a-f]{16}$/;

/**
 * The nonce a digest was salted under when `customerKey` is set: HMAC-SHA256
 * of "sigillo-nonce-v1\n<trace>\n<span>\n<role>". It never leaves the process;
 * whoever holds the key can rebuild it. Same function as Python's `nonce_for`.
 */
export function nonceFor(customerKey: Uint8Array | string, traceId: string, spanId: string, role: "input" | "output"): string {
  const key = typeof customerKey === "string" ? Buffer.from(customerKey, "utf8") : Buffer.from(customerKey);
  if (key.length === 0) throw new Error("customerKey must not be empty");
  if (!TRACE_ID_HEX.test(traceId) || !SPAN_ID_HEX.test(spanId)) {
    throw new Error("traceId and spanId are 32 and 16 lowercase hex characters, as in the receipt's source");
  }
  if (role !== "input" && role !== "output") throw new Error('role is "input" or "output"');
  return createHmac("sha256", key).update(`sigillo-nonce-v1\n${traceId}\n${spanId}\n${role}`, "ascii").digest("hex");
}

/**
 * An opaque stand-in for an identifier, to pass as the user an action was for:
 * "p:" and the first 32 hex characters of HMAC-SHA256(key, value). The key
 * never leaves this process.
 */
export function pseudonym(value: string, key: Uint8Array | string): string {
  const keyBytes = typeof key === "string" ? Buffer.from(key, "utf8") : Buffer.from(key);
  if (keyBytes.length === 0) throw new Error("key must not be empty");
  return `p:${createHmac("sha256", keyBytes).update(value, "utf8").digest("hex").slice(0, 32)}`;
}
