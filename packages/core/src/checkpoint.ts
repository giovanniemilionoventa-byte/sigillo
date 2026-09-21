import { type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalBytes, sha256, sha256Hex } from "./canonical.js";
import { isoUtcTimestampSchema, RECEIPT_VERSION } from "./receipt.js";
import { signDigest, verifyDigestSignature } from "./signing.js";

/**
 * A checkpoint is a signed statement that, at a given moment, one chain held
 * exactly `tree_size` receipts whose Merkle root was `root_hash`.
 *
 * It is what a timestamp token is taken over, and what an inclusion proof is
 * checked against. Its canonical form and signature follow the same rules as a
 * receipt's, so a verifier has one procedure to implement, not two.
 */

const hexString = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-f]{${length}}$`), `must be ${length} lowercase hex characters`);

export const unsignedCheckpointSchema = z
  .object({
    v: z.literal(RECEIPT_VERSION, {
      errorMap: () => ({
        message: `unsupported checkpoint version, this build implements version ${RECEIPT_VERSION}`,
      }),
    }),
    system_id: z.string().min(1).max(128),
    tree_size: z.number().int().positive(),
    root_hash: hexString(64),
    ts: isoUtcTimestampSchema,
    key_id: hexString(16),
  })
  .strict();

export const checkpointSchema = unsignedCheckpointSchema
  .extend({
    sig: z
      .string()
      .regex(/^[A-Za-z0-9+\/]{86}==$/, "must be a 64-byte Ed25519 signature in standard base64"),
  })
  .strict();

export type UnsignedCheckpoint = z.infer<typeof unsignedCheckpointSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;

export type CheckpointParseResult =
  | { ok: true; checkpoint: Checkpoint }
  | { ok: false; error: string };

export function safeParseCheckpoint(value: unknown): CheckpointParseResult {
  const parsed = checkpointSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, checkpoint: parsed.data };
  }
  const error = parsed.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<checkpoint>"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error };
}

export function parseCheckpoint(value: unknown): Checkpoint {
  const result = safeParseCheckpoint(value);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.checkpoint;
}

/** The canonical form, with `sig` removed, exactly as for a receipt. */
export function canonicalCheckpointBytes(checkpoint: UnsignedCheckpoint | Checkpoint): Uint8Array {
  const signedFields: Record<string, unknown> = { ...checkpoint };
  delete signedFields["sig"];
  return canonicalBytes(signedFields);
}

export function checkpointHash(checkpoint: UnsignedCheckpoint | Checkpoint): Uint8Array {
  return sha256(canonicalCheckpointBytes(checkpoint));
}

export function checkpointHashHex(checkpoint: UnsignedCheckpoint | Checkpoint): string {
  return sha256Hex(canonicalCheckpointBytes(checkpoint));
}

export function signCheckpoint(checkpoint: UnsignedCheckpoint, privateKey: KeyObject): Checkpoint {
  return { ...checkpoint, sig: signDigest(checkpointHash(checkpoint), privateKey) };
}

export function verifyCheckpointSignature(checkpoint: Checkpoint, publicKey: KeyObject): boolean {
  return verifyDigestSignature(checkpointHash(checkpoint), checkpoint.sig, publicKey);
}
