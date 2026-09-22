import { z } from "zod";
import { CANONICAL_BASE64_MESSAGE, isCanonicalBase64 } from "./base64.js";
import { canonicalBytes, sha256, sha256Hex } from "./canonical.js";

/**
 * The two schema versions a receipt's `v` field may carry. `as const` keeps
 * their type the literal `1`/`2`, not `number`: `z.discriminatedUnion` needs a
 * genuine literal on the tag to route to the right branch and to give
 * `Receipt` a type that actually narrows on `v`.
 */
export const RECEIPT_VERSION_1 = 1 as const;
export const RECEIPT_VERSION_2 = 2 as const;

/** `prev_hash` of the first receipt in a chain. */
export const GENESIS_PREV_HASH = "0".repeat(64);

/**
 * Free-text fields are capped: a name is metadata, and a cap keeps a caller
 * from smuggling a prompt or a tool result into the chain in the clear.
 */
const MAX_SYSTEM_ID = 128;
const MAX_NAME = 256;
const MAX_MEDIA_TYPE = 128;
const MAX_MODEL_FIELD = 256;

const hexString = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-f]{${length}}$`), `must be ${length} lowercase hex characters`);

export const isoUtcTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "must be an ISO-8601 UTC timestamp with milliseconds, such as 2026-03-29T14:30:00.123Z",
  )
  .refine((value) => {
    const instant = new Date(value);
    return !Number.isNaN(instant.getTime()) && instant.toISOString() === value;
  }, "must be a real calendar instant in UTC");

/** Ed25519 signatures are 64 bytes, which is 88 characters of padded base64. */
const signature = z
  .string()
  .regex(/^[A-Za-z0-9+\/]{86}==$/, "must be a 64-byte Ed25519 signature in standard base64")
  .refine(isCanonicalBase64, CANONICAL_BASE64_MESSAGE);

export const actionKindSchema = z.enum([
  "tool_call",
  "llm_call",
  "agent_step",
  "decision",
  "genesis",
]);

export const outcomeSchema = z.enum(["ok", "error", "blocked", "unknown"]);

export const sourceTypeSchema = z.enum(["otlp", "sdk", "api"]);

export const actorSchema = z
  .object({
    agent: z.string().min(1).max(MAX_NAME),
    on_behalf_of: z.string().min(1).max(MAX_NAME).optional(),
  })
  .strict();

export const actionSchema = z
  .object({
    kind: actionKindSchema,
    name: z.string().min(1).max(MAX_NAME),
  })
  .strict();

export const sourceSchema = z
  .object({
    type: sourceTypeSchema,
    trace_id: hexString(32).optional(),
    span_id: hexString(16).optional(),
  })
  .strict();

/**
 * Version 2 additions. Both are optional at the receipt level: a receipt with
 * neither is exactly as informative as a version 1 receipt, just stamped `v: 2`.
 */

export const artifactRoleSchema = z.enum(["input", "output"]);

/**
 * A document's fingerprint, never its content. `sha256` is over the artifact's
 * exact raw bytes — no JSON canonicalisation, since a document is not JSON.
 * `label` is a developer-chosen category ("curriculum"), never a filename: a
 * filename can carry a person's name, which the receipt must never hold.
 */
export const artifactSchema = z
  .object({
    role: artifactRoleSchema,
    label: z.string().min(1).max(MAX_NAME),
    media_type: z.string().min(1).max(MAX_MEDIA_TYPE),
    sha256: hexString(64),
  })
  .strict();

/**
 * Model identity for an `llm_call`. `provider` and `digest` are nullable
 * rather than optional because, unlike `actor.on_behalf_of`, the field is
 * still meaningful when the caller has a model name but nothing more: `model`
 * itself stays optional at the receipt level for actions where no model
 * information is available at all.
 */
export const modelSchema = z
  .object({
    name: z.string().min(1).max(MAX_MODEL_FIELD),
    provider: z.string().min(1).max(MAX_MODEL_FIELD).nullable(),
    digest: z.string().min(1).max(MAX_MODEL_FIELD).nullable(),
  })
  .strict();

/**
 * Members common to every receipt version. Kept as a plain shape, not a
 * schema, so each version below is still one `z.object` a reader can see in
 * full, with the version-specific members alongside rather than behind an
 * `.extend()` a reader has to chase.
 */
const receiptCoreShape = {
  system_id: z.string().min(1).max(MAX_SYSTEM_ID),
  seq: z.number().int().nonnegative(),
  ts_event: isoUtcTimestampSchema,
  ts_received: isoUtcTimestampSchema,
  actor: actorSchema,
  action: actionSchema,
  input_hash: hexString(64).nullable(),
  output_hash: hexString(64).nullable(),
  outcome: outcomeSchema,
  source: sourceSchema,
  prev_hash: hexString(64),
  key_id: hexString(16),
};

/** A receipt as it exists between construction and signing. */
export const unsignedReceiptV1Schema = z
  .object({ v: z.literal(RECEIPT_VERSION_1), ...receiptCoreShape })
  .strict();

export const unsignedReceiptV2Schema = z
  .object({
    v: z.literal(RECEIPT_VERSION_2),
    ...receiptCoreShape,
    /** Never empty: a receipt with no documents omits the member entirely. */
    artifacts: z.array(artifactSchema).min(1).optional(),
    model: modelSchema.optional(),
  })
  .strict();

export const unsignedReceiptSchema = z.discriminatedUnion("v", [
  unsignedReceiptV1Schema,
  unsignedReceiptV2Schema,
]);

export const receiptV1Schema = unsignedReceiptV1Schema.extend({ sig: signature }).strict();
export const receiptV2Schema = unsignedReceiptV2Schema.extend({ sig: signature }).strict();

export const receiptSchema = z.discriminatedUnion("v", [receiptV1Schema, receiptV2Schema]);

export type ActionKind = z.infer<typeof actionKindSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type ArtifactRole = z.infer<typeof artifactRoleSchema>;
export type ArtifactEntry = z.infer<typeof artifactSchema>;
export type ModelInfo = z.infer<typeof modelSchema>;
export type UnsignedReceiptV1 = z.infer<typeof unsignedReceiptV1Schema>;
export type UnsignedReceiptV2 = z.infer<typeof unsignedReceiptV2Schema>;
export type UnsignedReceipt = z.infer<typeof unsignedReceiptSchema>;
export type ReceiptV1 = z.infer<typeof receiptV1Schema>;
export type ReceiptV2 = z.infer<typeof receiptV2Schema>;
export type Receipt = z.infer<typeof receiptSchema>;

export class ReceiptFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptFormatError";
  }
}

export type ReceiptParseResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; error: string };

export type UnsignedReceiptParseResult =
  | { ok: true; receipt: UnsignedReceipt }
  | { ok: false; error: string };

function describeIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<receipt>"}: ${issue.message}`)
    .join("; ");
}

/** Validates a value as a receipt, naming the offending field on failure. */
export function safeParseReceipt(value: unknown): ReceiptParseResult {
  const parsed = receiptSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, receipt: parsed.data };
  }
  return { ok: false, error: describeIssues(parsed.error.issues) };
}

export function parseReceipt(value: unknown): Receipt {
  const result = safeParseReceipt(value);
  if (!result.ok) {
    throw new ReceiptFormatError(result.error);
  }
  return result.receipt;
}

/**
 * Validates a receipt that has not been signed yet, so that a malformed one is
 * rejected before a signer is ever asked to put its key behind it.
 */
export function safeParseUnsignedReceipt(value: unknown): UnsignedReceiptParseResult {
  const parsed = unsignedReceiptSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, receipt: parsed.data };
  }
  return { ok: false, error: describeIssues(parsed.error.issues) };
}

export function parseUnsignedReceipt(value: unknown): UnsignedReceipt {
  const result = safeParseUnsignedReceipt(value);
  if (!result.ok) {
    throw new ReceiptFormatError(result.error);
  }
  return result.receipt;
}

/**
 * The exact bytes a receipt's hash is taken over: its canonical JSON form with
 * the `sig` field removed, so the same bytes exist before and after signing.
 */
export function canonicalReceiptBytes(receipt: UnsignedReceipt | Receipt): Uint8Array {
  const signedFields: Record<string, unknown> = { ...receipt };
  delete signedFields["sig"];
  return canonicalBytes(signedFields);
}

/** The 32 bytes that Ed25519 signs and that the next receipt carries as `prev_hash`. */
export function receiptHash(receipt: UnsignedReceipt | Receipt): Uint8Array {
  return sha256(canonicalReceiptBytes(receipt));
}

export function receiptHashHex(receipt: UnsignedReceipt | Receipt): string {
  return sha256Hex(canonicalReceiptBytes(receipt));
}
