import { z } from "zod";
import { canonicalBytes, sha256, sha256Hex } from "./canonical.js";

/** Schema version carried in every receipt's `v` field. */
export const RECEIPT_VERSION = 1;

/** `prev_hash` of the first receipt in a chain. */
export const GENESIS_PREV_HASH = "0".repeat(64);

/**
 * Free-text fields are capped: a name is metadata, and a cap keeps a caller
 * from smuggling a prompt or a tool result into the chain in the clear.
 */
const MAX_SYSTEM_ID = 128;
const MAX_NAME = 256;

const hexString = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-f]{${length}}$`), `must be ${length} lowercase hex characters`);

const isoUtcTimestamp = z
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
  .regex(/^[A-Za-z0-9+\/]{86}==$/, "must be a 64-byte Ed25519 signature in standard base64");

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

/** A receipt as it exists between construction and signing. */
export const unsignedReceiptSchema = z
  .object({
    v: z.literal(RECEIPT_VERSION, {
      errorMap: () => ({
        message: `unsupported receipt schema version, this build implements version ${RECEIPT_VERSION}`,
      }),
    }),
    system_id: z.string().min(1).max(MAX_SYSTEM_ID),
    seq: z.number().int().nonnegative(),
    ts_event: isoUtcTimestamp,
    ts_received: isoUtcTimestamp,
    actor: actorSchema,
    action: actionSchema,
    input_hash: hexString(64).nullable(),
    output_hash: hexString(64).nullable(),
    outcome: outcomeSchema,
    source: sourceSchema,
    prev_hash: hexString(64),
    key_id: hexString(16),
  })
  .strict();

export const receiptSchema = unsignedReceiptSchema.extend({ sig: signature }).strict();

export type ActionKind = z.infer<typeof actionKindSchema>;
export type Outcome = z.infer<typeof outcomeSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type Actor = z.infer<typeof actorSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type UnsignedReceipt = z.infer<typeof unsignedReceiptSchema>;
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
