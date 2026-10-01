export {
  canonicalBytes,
  canonicalJson,
  fromHex,
  hashCanonicalJson,
  sha256,
  sha256Hex,
  toHex,
} from "./canonical.js";

export {
  canonicalText,
  DOCUMENT_TEXT_SOURCE,
  documentFingerprints,
  lineEndingVariants,
  TEXT_CANON_1,
  textSha256,
} from "./text.js";
export type { DocumentFingerprints, FingerprintKind } from "./text.js";

export { SIGILLO_VERSION } from "./version.js";

export {
  HASH_SCHEME_PLAIN,
  HASH_SCHEME_SALTED,
  isPseudonym,
  openSaltedDigest,
  PSEUDONYM_PREFIX,
  PSEUDONYM_RANDOM_BYTES,
  pseudonymFromRandom,
  SALT_NONCE_BYTES,
  saltedDigest,
} from "./privacy.js";

export { CANONICAL_BASE64_MESSAGE, isCanonicalBase64 } from "./base64.js";

export {
  artifactsIndexEntrySchema,
  checkpointEntrySchema,
  exportTimestampSchema,
  inclusionProofSchema,
  openingEntrySchema,
  safeParseArtifactsIndexEntry,
  safeParseCheckpointEntry,
  safeParseOpeningEntry,
  safeParseSubjectEntry,
  subjectEntrySchema,
} from "./export.js";
export type {
  ArtifactsIndexEntry,
  ArtifactsIndexEntryParseResult,
  CheckpointEntry,
  CheckpointEntryParseResult,
  ExportTimestamp,
  InclusionProofEntry,
  OpeningEntry,
  SubjectEntry,
} from "./export.js";

export { createZip, crc32, readZip, ZipError } from "./zip.js";
export type { ReadZipOptions, ZipEntry } from "./zip.js";

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

export {
  emptyFrontier,
  frontierAppend,
  frontierRoot,
  parseFrontier,
  serializeFrontier,
} from "./merkle-frontier.js";
export type { MerkleFrontier, SerializedFrontier } from "./merkle-frontier.js";

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
  actorV4Schema,
  artifactRoleSchema,
  artifactSchema,
  artifactTextSchema,
  artifactV3Schema,
  canonicalReceiptBytes,
  GENESIS_PREV_HASH,
  hashSchemeSchema,
  modelSchema,
  outcomeSchema,
  parseReceipt,
  parseUnsignedReceipt,
  receiptHash,
  receiptHashHex,
  RECEIPT_VERSION_1,
  RECEIPT_VERSION_2,
  RECEIPT_VERSION_3,
  RECEIPT_VERSION_4,
  ReceiptFormatError,
  receiptSchema,
  receiptV1Schema,
  receiptV2Schema,
  receiptV3Schema,
  receiptV4Schema,
  safeParseReceipt,
  safeParseUnsignedReceipt,
  sourceSchema,
  sourceTypeSchema,
  unsignedReceiptSchema,
  unsignedReceiptV1Schema,
  unsignedReceiptV2Schema,
  unsignedReceiptV3Schema,
  unsignedReceiptV4Schema,
} from "./receipt.js";

export type {
  Action,
  ActionKind,
  ArtifactEntry,
  ArtifactEntryV3,
  ArtifactRole,
  ArtifactText,
  Actor,
  ActorV4,
  HashScheme,
  ModelInfo,
  Outcome,
  Receipt,
  ReceiptParseResult,
  ReceiptV1,
  ReceiptV2,
  ReceiptV3,
  ReceiptV4,
  Source,
  SourceType,
  UnsignedReceipt,
  UnsignedReceiptParseResult,
  UnsignedReceiptV1,
  UnsignedReceiptV2,
  UnsignedReceiptV3,
  UnsignedReceiptV4,
} from "./receipt.js";
