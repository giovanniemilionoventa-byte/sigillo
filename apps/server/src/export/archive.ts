import {
  canonicalJson,
  createZip,
  fromHex,
  inclusionProof,
  receiptHashHex,
  SIGILLO_VERSION,
  toHex,
  type CheckpointEntry,
  type Manifest,
  type ManifestKey,
  type Receipt,
  type ZipEntry,
} from "@sigillo/core";
import { verifyBundle, type Verification } from "@sigillo/verifier";
import type { StoredCheckpoint, StoredTimestamp } from "../storage/store.js";
import { buildReportPdf } from "./report.js";
import { genTimeOfToken } from "../timestamp/gentime.js";
import { verifyInstructions } from "./verify-instructions.js";

/**
 * The evidence file: everything an auditor needs, and nothing they have to
 * take on trust.
 *
 *   receipts.jsonl     one receipt per line, in canonical form
 *   checkpoints.jsonl  each checkpoint with its inclusion proofs and tokens
 *   timestamps/*.tsr   the RFC 3161 tokens, exactly as the authority returned
 *   manifest.json      the public keys, the range, the counts
 *   report.pdf         the same facts, for a person
 *   VERIFY.md          how to check all of it without this software
 *
 * The archive is verified with the open-source verifier before the report is
 * written, so the report states a result that was actually computed.
 */

export interface ArchiveInput {
  systemId: string;
  receipts: Receipt[];
  checkpoints: { stored: StoredCheckpoint; timestamps: StoredTimestamp[] }[];
  keys: ManifestKey[];
  exportedAt: string;
}

export interface BuiltArchive {
  zip: Uint8Array;
  entries: ZipEntry[];
  manifest: Manifest;
  verification: Verification;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function tokenPath(treeSize: number, index: number): string {
  return `timestamps/checkpoint-${treeSize}-${index + 1}.tsr`;
}

/**
 * The proofs an export carries for a checkpoint: the first and the last receipt
 * it holds. Those two tie the whole range to the checkpoint's root, and the
 * receipts between them are tied to each other by the chain.
 */
function proofPositions(receipts: Receipt[], treeSize: number): number[] {
  const inTree = receipts.filter((receipt) => receipt.seq < treeSize);
  const first = inTree[0];
  const last = inTree[inTree.length - 1];
  if (first === undefined || last === undefined) return [];
  return first.seq === last.seq ? [first.seq] : [first.seq, last.seq];
}

export async function buildArchive(input: ArchiveInput): Promise<BuiltArchive> {
  const { receipts, systemId } = input;
  const first = receipts[0];
  const last = receipts[receipts.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`system ${systemId} has no receipts to export`);
  }

  const receiptsJsonl = receipts.map((receipt) => `${canonicalJson(receipt)}\n`).join("");
  const leaves = receipts.map((receipt) => fromHex(receiptHashHex(receipt)));

  // One line per artifact occurrence, so "has this document been used"
  // never requires opening every receipt to find out.
  const artifactsIndexJsonl = receipts
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

  const tokens: ZipEntry[] = [];
  const entries: CheckpointEntry[] = [];

  for (const { stored, timestamps } of input.checkpoints) {
    const { checkpoint } = stored;

    // A proof can only be built where the export holds the receipts the tree was
    // made of. A window that starts after seq 0 carries the checkpoint without
    // proofs rather than carrying a proof it cannot support.
    const canProve = first.seq === 0 && receipts.length >= checkpoint.tree_size;
    const proofs = canProve
      ? proofPositions(receipts, checkpoint.tree_size).map((seq) => {
          const receipt = receipts.find((candidate) => candidate.seq === seq);
          if (receipt === undefined) {
            throw new Error(`receipt seq ${seq} is missing from the export`);
          }
          return {
            seq,
            receipt_hash: receiptHashHex(receipt),
            path: inclusionProof(leaves.slice(0, checkpoint.tree_size), seq).map(toHex),
          };
        })
      : [];

    const anchors = timestamps.map((timestamp, index) => {
      const file = tokenPath(checkpoint.tree_size, index);
      tokens.push({
        name: file,
        data: new Uint8Array(Buffer.from(timestamp.tokenBase64, "base64")),
      });
      return { tsa_url: timestamp.tsaUrl, obtained_at: timestamp.obtainedAt, file };
    });

    entries.push({ checkpoint, proofs, timestamps: anchors });
  }

  const checkpointsJsonl = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

  // The manifest declares the highest receipt version actually present, so an
  // export that mixes v1 and v2 receipts (a chain upgraded mid-flight) still
  // makes a claim the verifier can check against the receipts themselves.
  const receiptVersion = receipts.reduce<number>((max, receipt) => Math.max(max, receipt.v), 0) as
    | 1
    | 2;

  const manifest: Manifest = {
    sigillo_version: SIGILLO_VERSION,
    receipt_version: receiptVersion,
    system_id: systemId,
    exported_at: input.exportedAt,
    range: {
      from_seq: first.seq,
      to_seq: last.seq,
      from_ts: first.ts_received,
      to_ts: last.ts_received,
    },
    counts: {
      receipts: receipts.length,
      checkpoints: entries.length,
      timestamps: entries.reduce((total, entry) => total + entry.timestamps.length, 0),
    },
    keys: input.keys,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  const verification = verifyBundle({
    manifestJson,
    receiptsJsonl,
    checkpointsJsonl,
    artifactsIndexJsonl,
  });

  const actionCounts = new Map<string, number>();
  for (const receipt of receipts) {
    actionCounts.set(receipt.action.kind, (actionCounts.get(receipt.action.kind) ?? 0) + 1);
  }

  // The time each token attests, read from the token itself: the evidence of
  // when, rather than the server's clock (review point 8).
  const genTimes = new Map<string, string>();
  for (const token of tokens) {
    const attested = genTimeOfToken(token.data);
    if (attested !== undefined) genTimes.set(token.name, attested);
  }

  const report = await buildReportPdf({ manifest, checkpoints: entries, verification, actionCounts, genTimes });

  const archiveEntries: ZipEntry[] = [
    { name: "manifest.json", data: encode(manifestJson) },
    { name: "receipts.jsonl", data: encode(receiptsJsonl) },
    { name: "checkpoints.jsonl", data: encode(checkpointsJsonl) },
    { name: "artifacts-index.jsonl", data: encode(artifactsIndexJsonl) },
    ...tokens,
    { name: "report.pdf", data: report },
    { name: "VERIFY.md", data: encode(verifyInstructions(manifest, entries, genTimes)) },
  ];

  return { zip: createZip(archiveEntries), entries: archiveEntries, manifest, verification };
}
