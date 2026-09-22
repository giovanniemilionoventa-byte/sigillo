import { z } from "zod";
import { CANONICAL_BASE64_MESSAGE, isCanonicalBase64 } from "./base64.js";
import { isoUtcTimestampSchema, RECEIPT_VERSION_1, RECEIPT_VERSION_2 } from "./receipt.js";

/**
 * The manifest of an export: what the archive claims to contain, and the public
 * keys needed to check it. A verifier trusts the manifest for nothing except
 * the keys it must try — and those are checked against each receipt's key_id.
 */

/** 32 raw bytes of an Ed25519 public key are 44 characters of padded base64. */
const rawPublicKeyBase64 = z
  .string()
  .regex(/^[A-Za-z0-9+\/]{43}=$/, "must be the raw 32-byte public key in standard base64")
  .refine(isCanonicalBase64, CANONICAL_BASE64_MESSAGE);

export const manifestKeySchema = z
  .object({
    key_id: z.string().regex(/^[0-9a-f]{16}$/, "must be 16 lowercase hex characters"),
    public_key_base64: rawPublicKeyBase64,
  })
  .strict();

export const manifestSchema = z
  .object({
    sigillo_version: z.string().min(1),
    /**
     * The highest receipt schema version among the receipts this export
     * holds. An export can freely mix v1 and v2 receipts — each is checked
     * under the rules its own `v` declares — so this is not "the version of
     * this export" but a declared fact a verifier checks like any other:
     * against the receipts actually present.
     */
    receipt_version: z.union([z.literal(RECEIPT_VERSION_1), z.literal(RECEIPT_VERSION_2)]),
    system_id: z.string().min(1).max(128),
    exported_at: isoUtcTimestampSchema,
    range: z
      .object({
        from_seq: z.number().int().nonnegative(),
        to_seq: z.number().int().nonnegative(),
        from_ts: isoUtcTimestampSchema,
        to_ts: isoUtcTimestampSchema,
      })
      .strict(),
    counts: z
      .object({
        receipts: z.number().int().nonnegative(),
        checkpoints: z.number().int().nonnegative().default(0),
        timestamps: z.number().int().nonnegative().default(0),
      })
      .strict(),
    keys: z.array(manifestKeySchema).min(1),
  })
  .strict();

export type ManifestKey = z.infer<typeof manifestKeySchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export type ManifestParseResult = { ok: true; manifest: Manifest } | { ok: false; error: string };

export function safeParseManifest(value: unknown): ManifestParseResult {
  const parsed = manifestSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data };
  }
  const error = parsed.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<manifest>"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error };
}
