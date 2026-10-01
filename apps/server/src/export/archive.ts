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
  type OpeningEntry,
  type Receipt,
  type SubjectEntry,
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
 *   openings.jsonl     only if asked: nonces of chosen salted digests
 *   subjects.jsonl     only if asked: who chosen pseudonym tokens stand for
 *   report.pdf         the same facts, for a person
 *   VERIFY.md          how to check all of it without this software
 *
 * The archive is verified with the open-source verifier before the report is
 * written, so the report states a result that was actually computed.
 */

export interface ArchiveInput {
  systemId: string;
  /**
   * The label the web view shows for the system at the time of export, if it
   * has one. It goes into the two files written for a person (report.pdf,
   * VERIFY.md), marked as a label, and never into manifest.json: it is not
   * signed, it can change at any time, and older verifiers refuse a manifest
   * with a field they do not know. The archive keeps the name as it was when
   * it was made, like any document; a later rename does not reach it.
   */
  displayName?: string | null;
  receipts: Receipt[];
  checkpoints: { stored: StoredCheckpoint; timestamps: StoredTimestamp[] }[];
  keys: ManifestKey[];
  exportedAt: string;
  /**
   * The hash of every receipt of the chain, from seq 0, in order: the leaves
   * of its Merkle trees. With them, an export of a window that does not start
   * at seq 0 still carries inclusion proofs tying its receipts to the
   * checkpoints. Without them, only an export from seq 0 can.
   */
  chainLeaves?: readonly string[];
  /**
   * What the archive discloses beyond the receipts, only when the operator
   * chose it, for the receipts and tokens chosen: by default an export names
   * nobody and opens no salted digest. A nonce lets whoever holds the archive
   * test guesses of short content, and an identifier names a person, so
   * neither goes out unless asked for. Entries for receipts or tokens outside
   * the exported window are left out.
   */
  disclose?: { openings?: readonly OpeningEntry[]; subjects?: readonly SubjectEntry[] };
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
  const leaves =
    input.chainLeaves === undefined
      ? first.seq === 0
        ? receipts.map((receipt) => fromHex(receiptHashHex(receipt)))
        : []
      : input.chainLeaves.map((hash) => fromHex(hash));

  // One line per artifact occurrence, so "has this document been used"
  // never requires opening every receipt to find out.
  const artifactsIndexJsonl = receipts
    .flatMap((receipt) =>
      receipt.v !== 1 && receipt.artifacts !== undefined
        ? receipt.artifacts.map(
            (artifact) =>
              `${JSON.stringify({
                sha256: artifact.sha256,
                seq: receipt.seq,
                role: artifact.role,
                label: artifact.label,
                ...("text" in artifact && artifact.text !== undefined ? { text: artifact.text } : {}),
              })}\n`,
          )
        : [],
    )
    .join("");

  const tokens: ZipEntry[] = [];
  const entries: CheckpointEntry[] = [];

  // The checkpoints that say something about these receipts: every one whose
  // tree holds at least one of them, up to and including the first whose tree
  // holds them all. A checkpoint entirely before the window proves nothing
  // about it, and one after the first that covers it all adds nothing.
  const relevant: typeof input.checkpoints = [];
  for (const candidate of [...input.checkpoints].sort(
    (a, b) => a.stored.checkpoint.tree_size - b.stored.checkpoint.tree_size,
  )) {
    const size = candidate.stored.checkpoint.tree_size;
    if (size <= first.seq) continue;
    relevant.push(candidate);
    if (size > last.seq) break;
  }

  for (const { stored, timestamps } of relevant) {
    const { checkpoint } = stored;

    // A proof needs every leaf of the tree. Without the chain's hashes (see
    // chainLeaves), a window that starts after seq 0 carries the checkpoint
    // without proofs rather than a proof it cannot support, and the verifier
    // reports that checkpoint as unlinked.
    const canProve = leaves.length >= checkpoint.tree_size;
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

  const exported = new Set(receipts.map((receipt) => receipt.seq));
  const tokensUsed = new Set(receipts.flatMap((receipt) => receipt.actor.on_behalf_of ?? []));
  const openingsJsonl = (input.disclose?.openings ?? [])
    .filter((entry) => exported.has(entry.seq))
    .map((entry) => `${JSON.stringify({ seq: entry.seq, role: entry.role, nonce: entry.nonce })}\n`)
    .join("");
  const subjectsJsonl = (input.disclose?.subjects ?? [])
    .filter((entry) => tokensUsed.has(entry.token))
    .map((entry) => `${JSON.stringify({ token: entry.token, identifier: entry.identifier })}\n`)
    .join("");

  // The manifest declares the highest receipt version actually present, so an
  // export that mixes receipt versions (a chain upgraded mid-flight) still
  // makes a claim the verifier can check against the receipts themselves.
  const receiptVersion = receipts.reduce<number>((max, receipt) => Math.max(max, receipt.v), 0) as
    | 1
    | 2
    | 3
    | 4;

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
    ...(openingsJsonl === "" ? {} : { openingsJsonl }),
    ...(subjectsJsonl === "" ? {} : { subjectsJsonl }),
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

  const displayName = input.displayName ?? undefined;
  const report = await buildReportPdf({
    manifest,
    checkpoints: entries,
    verification,
    actionCounts,
    genTimes,
    ...(displayName === undefined ? {} : { displayName }),
  });

  const archiveEntries: ZipEntry[] = [
    { name: "manifest.json", data: encode(manifestJson) },
    { name: "receipts.jsonl", data: encode(receiptsJsonl) },
    { name: "checkpoints.jsonl", data: encode(checkpointsJsonl) },
    { name: "artifacts-index.jsonl", data: encode(artifactsIndexJsonl) },
    ...(openingsJsonl === "" ? [] : [{ name: "openings.jsonl", data: encode(openingsJsonl) }]),
    ...(subjectsJsonl === "" ? [] : [{ name: "subjects.jsonl", data: encode(subjectsJsonl) }]),
    ...tokens,
    { name: "report.pdf", data: report },
    {
      name: "VERIFY.md",
      data: encode(
        verifyInstructions(manifest, entries, genTimes, displayName, {
          openings: openingsJsonl !== "",
          subjects: subjectsJsonl !== "",
        }),
      ),
    },
  ];

  return { zip: createZip(archiveEntries), entries: archiveEntries, manifest, verification };
}
