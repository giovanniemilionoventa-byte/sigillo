import { z } from "zod";
import { checkpointSchema } from "./checkpoint.js";
import { isoUtcTimestampSchema } from "./receipt.js";

/**
 * A line of `checkpoints.jsonl`: one signed checkpoint, the inclusion proofs
 * that tie the export's own receipts to it, and the timestamp tokens that
 * anchor it.
 *
 * The proofs are what make a partial export meaningful. A window of a chain
 * cannot be walked back to its genesis, but each of its receipts can still be
 * proved to sit at a known position in a tree that a trusted timestamp covers.
 */

const hexDigest = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

export const inclusionProofSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    receipt_hash: hexDigest,
    /** RFC 6962 audit path, closest sibling first. Empty for a tree of one. */
    path: z.array(hexDigest),
  })
  .strict();

export const exportTimestampSchema = z
  .object({
    tsa_url: z.string().min(1),
    obtained_at: isoUtcTimestampSchema,
    /** Where the DER token sits in the archive. */
    file: z.string().min(1),
  })
  .strict();

export const checkpointEntrySchema = z
  .object({
    checkpoint: checkpointSchema,
    proofs: z.array(inclusionProofSchema),
    timestamps: z.array(exportTimestampSchema),
  })
  .strict();

export type InclusionProofEntry = z.infer<typeof inclusionProofSchema>;
export type ExportTimestamp = z.infer<typeof exportTimestampSchema>;
export type CheckpointEntry = z.infer<typeof checkpointEntrySchema>;

export type CheckpointEntryParseResult =
  | { ok: true; entry: CheckpointEntry }
  | { ok: false; error: string };

export function safeParseCheckpointEntry(value: unknown): CheckpointEntryParseResult {
  const parsed = checkpointEntrySchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, entry: parsed.data };
  }
  const error = parsed.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<checkpoint entry>"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error };
}
