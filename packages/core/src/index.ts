export {
  canonicalBytes,
  canonicalJson,
  fromHex,
  hashCanonicalJson,
  sha256,
  sha256Hex,
  toHex,
} from "./canonical.js";

export { SIGILLO_VERSION } from "./version.js";

export { CANONICAL_BASE64_MESSAGE, isCanonicalBase64 } from "./base64.js";

export {
  checkpointEntrySchema,
  exportTimestampSchema,
  inclusionProofSchema,
  safeParseCheckpointEntry,
} from "./export.js";
export type {
  CheckpointEntry,
  CheckpointEntryParseResult,
  ExportTimestamp,
  InclusionProofEntry,
} from "./export.js";

export { createZip, crc32, readZip, ZipError } from "./zip.js";
export type { ZipEntry } from "./zip.js";

export {
  canonicalCheckpointBytes,
  checkpointHash,
  checkpointHashHex,
  CHECKPOINT_VERSION,
  checkpointSchema,
  parseCheckpoint,
  safeParseCheckpoint,
  signCheckpoint,
  unsignedCheckpointSchema,
  verifyCheckpointSignature,
} from "./checkpoint.js";
export type { Checkpoint, CheckpointParseResult, UnsignedCheckpoint } from "./checkpoint.js";

export {
  inclusionProof,
  merkleLeafHash,
  merkleNodeHash,
  merkleRoot,
  rootFromInclusionProof,
} from "./merkle.js";

export { keyIdFromRawPublicKey, publicKeyFromRaw, rawPublicKeyBytes } from "./keys.js";

export { manifestKeySchema, manifestSchema, safeParseManifest } from "./manifest.js";
export type { Manifest, ManifestKey, ManifestParseResult } from "./manifest.js";

export {
  signDigest,
  signReceipt,
  verifyDigestSignature,
  verifyReceiptSignature,
} from "./signing.js";

export {
  actionKindSchema,
  actionSchema,
  actorSchema,
  artifactRoleSchema,
  artifactSchema,
  canonicalReceiptBytes,
  GENESIS_PREV_HASH,
  modelSchema,
  outcomeSchema,
  parseReceipt,
  parseUnsignedReceipt,
  receiptHash,
  receiptHashHex,
  RECEIPT_VERSION_1,
  RECEIPT_VERSION_2,
  ReceiptFormatError,
  receiptSchema,
  receiptV1Schema,
  receiptV2Schema,
  safeParseReceipt,
  safeParseUnsignedReceipt,
  sourceSchema,
  sourceTypeSchema,
  unsignedReceiptSchema,
  unsignedReceiptV1Schema,
  unsignedReceiptV2Schema,
} from "./receipt.js";

export type {
  Action,
  ActionKind,
  ArtifactEntry,
  ArtifactRole,
  Actor,
  ModelInfo,
  Outcome,
  Receipt,
  ReceiptParseResult,
  ReceiptV1,
  ReceiptV2,
  Source,
  SourceType,
  UnsignedReceipt,
  UnsignedReceiptParseResult,
  UnsignedReceiptV1,
  UnsignedReceiptV2,
} from "./receipt.js";
