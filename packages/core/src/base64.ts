/**
 * Base64 has slack: the characters that carry the final, unused padding bits of
 * a value can be written several ways and still decode to the same bytes. A
 * signature would then have more than one spelling, and an evidence file would
 * have more than one form for the same content.
 *
 * The format has always said "standard base64", so this is what that means: the
 * only accepted spelling is the one a canonical encoder produces.
 */
export function isCanonicalBase64(value: string): boolean {
  return Buffer.from(value, "base64").toString("base64") === value;
}

export const CANONICAL_BASE64_MESSAGE =
  "must be canonical base64: the unused bits of the final characters must be zero";
