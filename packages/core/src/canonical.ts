import { createHash } from "node:crypto";
// canonicalize sets `module.exports` to the function but declares it as an ES
// default export, so its published types describe a namespace that TypeScript
// will not call. Node's interop hands us the function itself; the cast states
// what actually arrives. canonical.test.ts pins the output byte for byte, so a
// change in the package cannot pass unnoticed.
import canonicalizeExport from "canonicalize";

const canonicalize = canonicalizeExport as unknown as (input: unknown) => string | undefined;

/**
 * RFC 8785 (JCS) serialisation. Object keys are sorted by UTF-16 code unit at
 * every depth, there is no insignificant whitespace, and a key whose value is
 * `undefined` is omitted exactly as `JSON.stringify` omits it.
 */
export function canonicalJson(value: unknown): string {
  const json = canonicalize(value);
  if (typeof json !== "string") {
    throw new Error("value has no canonical JSON form (RFC 8785)");
  }
  return json;
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Digest of a payload in canonical form. This is how `input_hash` and
 * `output_hash` are produced: sigillo stores the digest of an argument list or
 * a result, never the value itself.
 */
export function hashCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalBytes(value));
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error("expected an even number of lowercase hex characters");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
