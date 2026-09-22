import { generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  canonicalJson,
  GENESIS_PREV_HASH,
  keyIdFromRawPublicKey,
  rawPublicKeyBytes,
  receiptHashHex,
  RECEIPT_VERSION_1,
  signReceipt,
  type ArtifactEntry,
  type Manifest,
  type ModelInfo,
  type Receipt,
  type UnsignedReceipt,
} from "@sigillo/core";
import type { Bundle } from "../../src/verify.js";

export interface SigningIdentity {
  privateKey: KeyObject;
  keyId: string;
  publicKeyBase64: string;
}

export function createIdentity(): SigningIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = rawPublicKeyBytes(publicKey);
  return {
    privateKey,
    keyId: keyIdFromRawPublicKey(raw),
    publicKeyBase64: Buffer.from(raw).toString("base64"),
  };
}

const SYSTEM = "acme-support-bot";

function timestamp(index: number): string {
  return new Date(Date.UTC(2026, 2, 29, 14, 30, 0, 0) + index * 1000).toISOString();
}

/** Per-seq departures from an all-v1 chain, for tests that need a v2 or mixed chain. */
export interface ReceiptOverride {
  v?: 1 | 2;
  artifacts?: ArtifactEntry[];
  model?: ModelInfo;
}

/**
 * Builds a chain the way the server would, so the verifier has something real
 * to check. Every receipt is v1 with no artifacts or model unless `overrides`
 * says otherwise for that seq, so existing callers that omit it are unaffected.
 */
export function buildReceipts(
  length: number,
  identity: SigningIdentity,
  systemId = SYSTEM,
  overrides: ReadonlyArray<ReceiptOverride | undefined> = [],
): Receipt[] {
  const receipts: Receipt[] = [];
  let prevHash = GENESIS_PREV_HASH;

  for (let seq = 0; seq < length; seq += 1) {
    const override = overrides[seq];
    const unsigned = {
      v: override?.v ?? RECEIPT_VERSION_1,
      system_id: systemId,
      seq,
      ts_event: timestamp(seq),
      ts_received: timestamp(seq),
      actor: { agent: seq === 0 ? systemId : "planner" },
      action:
        seq === 0
          ? { kind: "genesis" as const, name: systemId }
          : { kind: "tool_call" as const, name: `call-${seq}` },
      input_hash: null,
      output_hash: null,
      outcome: "ok" as const,
      source: { type: "api" as const },
      prev_hash: prevHash,
      key_id: identity.keyId,
      ...(override?.artifacts === undefined ? {} : { artifacts: override.artifacts }),
      ...(override?.model === undefined ? {} : { model: override.model }),
    } as UnsignedReceipt;
    const receipt = signReceipt(unsigned, identity.privateKey);
    receipts.push(receipt);
    prevHash = receiptHashHex(receipt);
  }

  return receipts;
}

export function buildManifest(receipts: Receipt[], identity: SigningIdentity): Manifest {
  const first = receipts[0];
  const last = receipts[receipts.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("a bundle needs at least one receipt");
  }
  const receiptVersion = receipts.reduce<number>((max, receipt) => Math.max(max, receipt.v), 0) as
    | 1
    | 2;
  return {
    sigillo_version: "0.1.0",
    receipt_version: receiptVersion,
    system_id: first.system_id,
    exported_at: timestamp(receipts.length),
    range: {
      from_seq: first.seq,
      to_seq: last.seq,
      from_ts: first.ts_received,
      to_ts: last.ts_received,
    },
    counts: { receipts: receipts.length, checkpoints: 0, timestamps: 0 },
    keys: [{ key_id: identity.keyId, public_key_base64: identity.publicKeyBase64 }],
  };
}

/** Mirrors apps/server/src/export/archive.ts: one index line per artifact occurrence. */
function artifactsIndexJsonl(receipts: Receipt[]): string {
  return receipts
    .flatMap((receipt) =>
      receipt.v === 2 && receipt.artifacts !== undefined
        ? receipt.artifacts.map(
            (artifact) =>
              `${JSON.stringify({
                sha256: artifact.sha256,
                seq: receipt.seq,
                role: artifact.role,
                label: artifact.label,
              })}\n`,
          )
        : [],
    )
    .join("");
}

export function toBundle(receipts: Receipt[], manifest: Manifest): Bundle {
  return {
    manifestJson: JSON.stringify(manifest, null, 2),
    receiptsJsonl: `${receipts.map((receipt) => canonicalJson(receipt)).join("\n")}\n`,
    artifactsIndexJsonl: artifactsIndexJsonl(receipts),
  };
}

export function buildBundle(length: number, identity = createIdentity()): Bundle {
  const receipts = buildReceipts(length, identity);
  return toBundle(receipts, buildManifest(receipts, identity));
}

export function lines(bundle: Bundle): string[] {
  return bundle.receiptsJsonl.split("\n").filter((line) => line.length > 0);
}

export function fromLines(bundle: Bundle, newLines: string[]): Bundle {
  return { manifestJson: bundle.manifestJson, receiptsJsonl: `${newLines.join("\n")}\n` };
}
