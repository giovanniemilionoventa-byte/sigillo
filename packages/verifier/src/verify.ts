import {
  fromHex,
  GENESIS_PREV_HASH,
  hashCanonicalJson,
  HASH_SCHEME_SALTED,
  openSaltedDigest,
  keyIdFromRawPublicKey,
  merkleRoot,
  publicKeyFromRaw,
  receiptHashHex,
  rootFromInclusionProof,
  safeParseArtifactsIndexEntry,
  safeParseCheckpointEntry,
  safeParseManifest,
  safeParseOpeningEntry,
  safeParseReceipt,
  safeParseSubjectEntry,
  toHex,
  verifyCheckpointSignature,
  verifyReceiptSignature,
  type ArtifactsIndexEntry,
  type CheckpointEntry,
  type Manifest,
  type Receipt,
} from "@sigillo/core";

/**
 * Checks an export against docs/FORMAT.md. Everything is deliberately explicit:
 * an auditor should be able to read this file top to bottom and see that each
 * rule in the format is actually enforced, in the order the format states.
 *
 * It stops at the first failure and says which receipt and which check.
 */

export interface Bundle {
  manifestJson: string;
  receiptsJsonl: string;
  /** Present in a full export; absent in the minimal one. */
  checkpointsJsonl?: string;
  /** Present in a full export; absent in the minimal one, or where no v2 receipt names a document. */
  artifactsIndexJsonl?: string;
  /** Only when the export was asked to disclose the nonces of some salted digests. */
  openingsJsonl?: string;
  /** Only when the export was asked to name the people behind some pseudonym tokens. */
  subjectsJsonl?: string;
}

export type VerificationCheck =
  | "manifest"
  | "receipt-json"
  | "receipt-schema"
  | "system"
  | "sequence"
  | "genesis"
  | "chain-link"
  | "key"
  | "signature"
  | "range"
  | "checkpoint-json"
  | "checkpoint-schema"
  | "checkpoint-signature"
  | "merkle-root"
  | "inclusion-proof"
  | "artifacts-index"
  | "openings"
  | "subjects"
  | "previous-export";

export interface VerifyOptions {
  /**
   * The key identifiers the verifier was told to expect, from a source other
   * than the archive (--key-id). When given, a receipt or checkpoint signed by
   * any other key fails, even if the manifest publishes that key: a manifest
   * is part of the archive, and whoever forged the archive wrote it too.
   */
  trustedKeyIds?: ReadonlySet<string>;
}

export interface VerificationSummary {
  system_id: string;
  receipts: number;
  first_seq: number;
  last_seq: number;
  key_ids: string[];
  checkpoints: number;
  inclusion_proofs: number;
  /** Checkpoints whose root this verifier could rebuild from the receipts present. */
  roots_recomputed: number;
  /** Document fingerprints found in artifacts-index.jsonl, confirmed to match the receipts. */
  artifacts_indexed: number;
  /**
   * Checkpoints tied to none of these receipts: no root rebuilt from them and
   * no inclusion proof. They verify as signed statements, but prove nothing
   * about this export's receipts (review point 4).
   */
  unlinked_checkpoints: number;
  /**
   * Receipts in this export after the newest checkpoint that is tied to them:
   * nothing in the archive anchors them yet. Zero when no checkpoint is tied to
   * the receipts at all; the "no checkpoint" and "not linked" notes say that.
   */
  unanchored_receipts: number;
  /** Nonces disclosed in openings.jsonl, each confirmed to belong to a salted digest here. */
  openings_disclosed: number;
  /** Identifiers disclosed in subjects.jsonl, each for a token a receipt here uses. */
  subjects_disclosed: number;
}

export type Verification =
  | { ok: true; summary: VerificationSummary; receipts: Receipt[] }
  | { ok: false; check: VerificationCheck; location: string; detail: string };

function fail(check: VerificationCheck, location: string, detail: string): Verification {
  return { ok: false, check, location, detail };
}

function at(lineNumber: number): string {
  return `receipts.jsonl:${lineNumber}`;
}

function atCheckpoint(lineNumber: number): string {
  return `checkpoints.jsonl:${lineNumber}`;
}

function jsonLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

export function verifyBundle(bundle: Bundle, options: VerifyOptions = {}): Verification {
  const trusted = options.trustedKeyIds;
  // 1. The manifest, which carries the keys everything else is checked against.
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(bundle.manifestJson);
  } catch (error) {
    return fail("manifest", "manifest.json", `is not valid JSON: ${String(error)}`);
  }

  const manifestResult = safeParseManifest(manifestValue);
  if (!manifestResult.ok) {
    return fail("manifest", "manifest.json", manifestResult.error);
  }
  const manifest: Manifest = manifestResult.manifest;

  const keysById = new Map<string, ReturnType<typeof publicKeyFromRaw>>();
  for (const entry of manifest.keys) {
    const raw = new Uint8Array(Buffer.from(entry.public_key_base64, "base64"));
    if (raw.length !== 32) {
      return fail("key", "manifest.json", `key ${entry.key_id} is not a 32-byte public key`);
    }
    // key_id is derived from the key, so the manifest cannot label a key freely:
    // a key published under someone else's identifier is caught here rather than
    // surfacing later as an unexplained signature failure.
    const derived = keyIdFromRawPublicKey(raw);
    if (derived !== entry.key_id) {
      return fail(
        "key",
        "manifest.json",
        `the manifest publishes a key under key_id ${entry.key_id}, but that key's identifier is ${derived}`,
      );
    }
    keysById.set(entry.key_id, publicKeyFromRaw(raw));
  }

  // 2. Every line is a receipt of the version this verifier implements.
  const rawLines = bundle.receiptsJsonl.split("\n").filter((line) => line.trim().length > 0);
  if (rawLines.length === 0) {
    return fail("range", "receipts.jsonl", "the export contains no receipts");
  }

  const receipts: Receipt[] = [];
  for (const [index, line] of rawLines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return fail("receipt-json", at(index + 1), `is not valid JSON: ${String(error)}`);
    }
    const parsed = safeParseReceipt(value);
    if (!parsed.ok) {
      return fail("receipt-schema", at(index + 1), parsed.error);
    }
    receipts.push(parsed.receipt);
  }

  // 3. Every receipt belongs to the chain the manifest names.
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.system_id !== manifest.system_id) {
      return fail(
        "system",
        at(index + 1),
        `receipt seq ${receipt.seq} belongs to system ${receipt.system_id}, but the manifest declares ${manifest.system_id}`,
      );
    }
  }

  // 4. The sequence runs from the declared start, one at a time, with no gap,
  //    no repeat and no reordering.
  const first = receipts[0];
  if (first === undefined) {
    return fail("range", "receipts.jsonl", "the export contains no receipts");
  }
  if (first.seq !== manifest.range.from_seq) {
    return fail(
      "range",
      at(1),
      `the manifest declares the export starts at seq ${manifest.range.from_seq}, but the first receipt is seq ${first.seq}`,
    );
  }
  for (const [index, receipt] of receipts.entries()) {
    const expected = first.seq + index;
    if (receipt.seq !== expected) {
      const previous = receipts[index - 1];
      const because =
        previous !== undefined && receipt.seq === previous.seq
          ? `seq ${receipt.seq} appears twice`
          : `expected seq ${expected}, found seq ${receipt.seq}`;
      return fail("sequence", at(index + 1), because);
    }
  }

  // 5. A chain that starts at the beginning starts with a genesis receipt.
  if (first.seq === 0) {
    if (first.action.kind !== "genesis") {
      return fail("genesis", at(1), `seq 0 must be a genesis receipt, found ${first.action.kind}`);
    }
    if (first.action.name !== first.system_id) {
      return fail(
        "genesis",
        at(1),
        `a genesis receipt names its system in action.name, found ${first.action.name}`,
      );
    }
    if (first.prev_hash !== GENESIS_PREV_HASH) {
      return fail("genesis", at(1), "a genesis receipt must carry 64 zeros as prev_hash");
    }
  }

  // 6. Each receipt commits to the one before it.
  for (let index = 1; index < receipts.length; index += 1) {
    const previous = receipts[index - 1];
    const receipt = receipts[index];
    if (previous === undefined || receipt === undefined) continue;
    const expected = receiptHashHex(previous);
    if (receipt.prev_hash !== expected) {
      return fail(
        "chain-link",
        at(index + 1),
        `receipt seq ${receipt.seq} carries prev_hash ${receipt.prev_hash}, but receipt seq ${previous.seq} hashes to ${expected}: one of the two has been altered`,
      );
    }
  }

  // 7. Every receipt names a key the manifest publishes (and, if the verifier
  //    was told which keys to expect, one of those), and 8. is signed by it.
  for (const [index, receipt] of receipts.entries()) {
    const key = keysById.get(receipt.key_id);
    if (key === undefined) {
      return fail(
        "key",
        at(index + 1),
        `receipt seq ${receipt.seq} is signed by key ${receipt.key_id}, which the manifest does not publish`,
      );
    }
    if (trusted !== undefined && !trusted.has(receipt.key_id)) {
      return fail(
        "key",
        at(index + 1),
        `receipt seq ${receipt.seq} is signed by key ${receipt.key_id}, which is not a key you said to expect (--key-id)`,
      );
    }
    if (!verifyReceiptSignature(receipt, key)) {
      return fail(
        "signature",
        at(index + 1),
        `receipt seq ${receipt.seq} is not signed by key ${receipt.key_id}`,
      );
    }
  }

  // 9. Every artifact a v2 or v3 receipt declares is indexed exactly once,
  //    text fingerprint included, and the index claims nothing the receipts do
  //    not. This is what makes a document lookup trustworthy: it is checked
  //    against the receipts, not taken as given.
  const artifactKey = (
    seq: number,
    artifact: { role: string; label: string; sha256: string; text?: { canon: string; sha256: string } | undefined },
  ): string =>
    [seq, artifact.role, artifact.label, artifact.sha256, artifact.text?.canon ?? "", artifact.text?.sha256 ?? ""].join("\u0000");
  const declaredArtifacts: string[] = [];
  for (const receipt of receipts) {
    if (receipt.v === 1 || receipt.artifacts === undefined) continue;
    for (const artifact of receipt.artifacts) {
      declaredArtifacts.push(artifactKey(receipt.seq, artifact));
    }
  }

  const artifactsIndex: ArtifactsIndexEntry[] = [];
  const indexedArtifacts: string[] = [];
  for (const [index, line] of jsonLines(bundle.artifactsIndexJsonl ?? "").entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return fail(
        "artifacts-index",
        `artifacts-index.jsonl:${index + 1}`,
        `is not valid JSON: ${String(error)}`,
      );
    }
    const parsed = safeParseArtifactsIndexEntry(value);
    if (!parsed.ok) {
      return fail("artifacts-index", `artifacts-index.jsonl:${index + 1}`, parsed.error);
    }
    artifactsIndex.push(parsed.entry);
    indexedArtifacts.push(artifactKey(parsed.entry.seq, parsed.entry));
  }

  if ([...declaredArtifacts].sort().join("\n") !== [...indexedArtifacts].sort().join("\n")) {
    return fail(
      "artifacts-index",
      "artifacts-index.jsonl",
      `the index does not match the artifacts the receipts declare: ${declaredArtifacts.length} declared by the receipts, ${indexedArtifacts.length} indexed`,
    );
  }

  // 9b. A disclosed nonce belongs to a salted digest this export holds, once.
  //     Whether it opens that digest depends on content this file does not
  //     have: `sigillo-verify open` checks that, given the content.
  const openingKeys = new Set<string>();
  for (const [index, line] of jsonLines(bundle.openingsJsonl ?? "").entries()) {
    const where = `openings.jsonl:${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return fail("openings", where, `is not valid JSON: ${String(error)}`);
    }
    const parsed = safeParseOpeningEntry(value);
    if (!parsed.ok) return fail("openings", where, parsed.error);
    const { seq, role } = parsed.entry;
    const receipt = receipts.find((candidate) => candidate.seq === seq);
    if (receipt === undefined) {
      return fail("openings", where, `the nonce is for seq ${seq}, which this export does not contain`);
    }
    if (receipt.v !== 4 || receipt[`${role}_hash_scheme`] !== HASH_SCHEME_SALTED) {
      return fail("openings", where, `the ${role} of seq ${seq} is not a salted digest, so it has no nonce`);
    }
    const key = `${seq}:${role}`;
    if (openingKeys.has(key)) return fail("openings", where, `the nonce for the ${role} of seq ${seq} appears twice`);
    openingKeys.add(key);
  }

  // 9c. A disclosed identifier is for a token these receipts use, once.
  const tokensUsed = new Set(
    receipts.flatMap((receipt) => (receipt.actor.on_behalf_of === undefined ? [] : [receipt.actor.on_behalf_of])),
  );
  const subjectTokens = new Set<string>();
  for (const [index, line] of jsonLines(bundle.subjectsJsonl ?? "").entries()) {
    const where = `subjects.jsonl:${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return fail("subjects", where, `is not valid JSON: ${String(error)}`);
    }
    const parsed = safeParseSubjectEntry(value);
    if (!parsed.ok) return fail("subjects", where, parsed.error);
    const { token } = parsed.entry;
    if (!tokensUsed.has(token)) return fail("subjects", where, `${token} is the on_behalf_of of no receipt in this export`);
    if (subjectTokens.has(token)) return fail("subjects", where, `${token} appears twice`);
    subjectTokens.add(token);
  }

  // 10. Every checkpoint is a signed statement about a tree these receipts build.
  const checkpoints: CheckpointEntry[] = [];
  let rootsRecomputed = 0;
  let proofsChecked = 0;
  let unlinked = 0;
  // A checkpoint over N receipts covers seq 0..N-1; this is the highest N among
  // the checkpoints tied to these receipts.
  let anchoredThrough: number | null = null;

  for (const [index, line] of jsonLines(bundle.checkpointsJsonl ?? "").entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return fail("checkpoint-json", atCheckpoint(index + 1), `is not valid JSON: ${String(error)}`);
    }

    const parsed = safeParseCheckpointEntry(value);
    if (!parsed.ok) {
      return fail("checkpoint-schema", atCheckpoint(index + 1), parsed.error);
    }
    const { checkpoint, proofs } = parsed.entry;

    if (checkpoint.system_id !== manifest.system_id) {
      return fail(
        "system",
        atCheckpoint(index + 1),
        `the checkpoint covers system ${checkpoint.system_id}, but the manifest declares ${manifest.system_id}`,
      );
    }

    const key = keysById.get(checkpoint.key_id);
    if (key === undefined) {
      return fail(
        "key",
        atCheckpoint(index + 1),
        `the checkpoint is signed by key ${checkpoint.key_id}, which the manifest does not publish`,
      );
    }
    if (trusted !== undefined && !trusted.has(checkpoint.key_id)) {
      return fail(
        "key",
        atCheckpoint(index + 1),
        `the checkpoint is signed by key ${checkpoint.key_id}, which is not a key you said to expect (--key-id)`,
      );
    }
    if (!verifyCheckpointSignature(checkpoint, key)) {
      return fail(
        "checkpoint-signature",
        atCheckpoint(index + 1),
        `the checkpoint over ${checkpoint.tree_size} receipts is not signed by key ${checkpoint.key_id}`,
      );
    }

    // 11. Where the export holds the receipts the tree was built from, the root
    //     is rebuilt from them rather than taken on the checkpoint's word.
    const rebuildable = first.seq === 0 && receipts.length >= checkpoint.tree_size;
    if (!rebuildable && proofs.length === 0) unlinked += 1;
    else anchoredThrough = Math.max(anchoredThrough ?? 0, checkpoint.tree_size);
    if (rebuildable) {
      const leaves = receipts
        .slice(0, checkpoint.tree_size)
        .map((receipt) => fromHex(receiptHashHex(receipt)));
      const recomputed = toHex(merkleRoot(leaves));
      if (recomputed !== checkpoint.root_hash) {
        return fail(
          "merkle-root",
          atCheckpoint(index + 1),
          `the checkpoint claims root ${checkpoint.root_hash} over ${checkpoint.tree_size} receipts, but those receipts build ${recomputed}`,
        );
      }
      rootsRecomputed += 1;
    }

    // 12. Each inclusion proof ties a receipt in this export to that root.
    for (const proof of proofs) {
      const receipt = receipts.find((candidate) => candidate.seq === proof.seq);
      if (receipt === undefined) {
        return fail(
          "inclusion-proof",
          atCheckpoint(index + 1),
          `the proof is for seq ${proof.seq}, which this export does not contain`,
        );
      }
      const hash = receiptHashHex(receipt);
      if (hash !== proof.receipt_hash) {
        return fail(
          "inclusion-proof",
          atCheckpoint(index + 1),
          `the proof for seq ${proof.seq} is over ${proof.receipt_hash}, but that receipt hashes to ${hash}`,
        );
      }

      let rebuilt: string;
      try {
        rebuilt = toHex(
          rootFromInclusionProof(
            fromHex(hash),
            proof.seq,
            checkpoint.tree_size,
            proof.path.map((step) => fromHex(step)),
          ),
        );
      } catch (error) {
        return fail(
          "inclusion-proof",
          atCheckpoint(index + 1),
          `the proof for seq ${proof.seq} is malformed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (rebuilt !== checkpoint.root_hash) {
        return fail(
          "inclusion-proof",
          atCheckpoint(index + 1),
          `the proof for seq ${proof.seq} rebuilds ${rebuilt}, not the checkpoint's root ${checkpoint.root_hash}`,
        );
      }
      proofsChecked += 1;
    }

    checkpoints.push(parsed.entry);
  }

  // 13. The manifest describes the receipts and checkpoints that are actually here.
  const last = receipts[receipts.length - 1];
  if (last === undefined) {
    return fail("range", "receipts.jsonl", "the export contains no receipts");
  }
  if (last.seq !== manifest.range.to_seq) {
    return fail(
      "range",
      "manifest.json",
      `the manifest declares the export ends at seq ${manifest.range.to_seq}, but the last receipt is seq ${last.seq}`,
    );
  }
  // The period the manifest states (and the report prints) is the time the
  // server received the first and the last receipt: checked, not taken.
  if (manifest.range.from_ts !== first.ts_received || manifest.range.to_ts !== last.ts_received) {
    const member = manifest.range.from_ts !== first.ts_received ? "from_ts" : "to_ts";
    return fail(
      "range",
      "manifest.json",
      `the manifest's range.${member} is ${manifest.range[member]}, but the receipts run from ${first.ts_received} to ${last.ts_received}`,
    );
  }
  if (manifest.counts.receipts !== receipts.length) {
    return fail(
      "range",
      "manifest.json",
      `the manifest declares ${manifest.counts.receipts} receipts, but the export holds ${receipts.length}`,
    );
  }
  if (manifest.counts.checkpoints !== checkpoints.length) {
    return fail(
      "range",
      "manifest.json",
      `the manifest declares ${manifest.counts.checkpoints} checkpoints, but the export holds ${checkpoints.length}`,
    );
  }
  const tokens = checkpoints.reduce((total, entry) => total + entry.timestamps.length, 0);
  if (manifest.counts.timestamps !== tokens) {
    return fail(
      "range",
      "manifest.json",
      `the manifest declares ${manifest.counts.timestamps} timestamp tokens, but the checkpoints reference ${tokens}`,
    );
  }

  // A chain may upgrade from v1 to v2 or v3 mid-flight, so this is not "the export's
  // version": it is a claim, like the counts above, checked against what the
  // receipts actually declare rather than trusted.
  const highestReceiptVersion = receipts.reduce<number>(
    (max, receipt) => Math.max(max, receipt.v),
    0,
  );
  if (manifest.receipt_version !== highestReceiptVersion) {
    return fail(
      "range",
      "manifest.json",
      `the manifest declares receipt_version ${manifest.receipt_version}, but the highest version among the receipts is ${highestReceiptVersion}`,
    );
  }

  return {
    ok: true,
    summary: {
      system_id: manifest.system_id,
      receipts: receipts.length,
      first_seq: first.seq,
      last_seq: last.seq,
      key_ids: [...keysById.keys()],
      checkpoints: checkpoints.length,
      inclusion_proofs: proofsChecked,
      roots_recomputed: rootsRecomputed,
      artifacts_indexed: artifactsIndex.length,
      unlinked_checkpoints: unlinked,
      unanchored_receipts:
        anchoredThrough === null
          ? 0
          : receipts.filter((receipt) => receipt.seq >= (anchoredThrough as number)).length,
      openings_disclosed: openingKeys.size,
      subjects_disclosed: subjectTokens.size,
    },
    receipts,
  };
}

export type Opening =
  | { ok: true; scheme: "plain" | "salted" }
  | { ok: false; reason: string };

/**
 * Whether `value` is what the `role` digest of receipt `seq` was computed
 * over (FORMAT.md 2.7): under the nonce for a salted digest, without one for
 * a plain digest, which every version before 4 carries. `receipts` must come
 * from a bundle that verified.
 */
export function openDigest(
  receipts: readonly Receipt[],
  seq: number,
  role: "input" | "output",
  nonce: Uint8Array | null,
  value: unknown,
): Opening {
  const receipt = receipts.find((candidate) => candidate.seq === seq);
  if (receipt === undefined) return { ok: false, reason: `this export does not contain seq ${seq}` };
  const digest = receipt[`${role}_hash`];
  if (digest === null) return { ok: false, reason: `seq ${seq} recorded no ${role}` };

  if (receipt.v === 4 && receipt[`${role}_hash_scheme`] === HASH_SCHEME_SALTED) {
    if (nonce === null) {
      return { ok: false, reason: `the ${role} of seq ${seq} is a salted digest: it opens only with its nonce` };
    }
    return openSaltedDigest(digest, nonce, value)
      ? { ok: true, scheme: "salted" }
      : { ok: false, reason: `the ${role} of seq ${seq} is not this content under this nonce` };
  }
  return hashCanonicalJson(value) === digest
    ? { ok: true, scheme: "plain" }
    : { ok: false, reason: `the ${role} of seq ${seq} is not the digest of this content` };
}

/**
 * Compares an export with one of the same chain received earlier (--previous).
 *
 * An archive on its own cannot show that receipts were cut from its end: a
 * shorter chain with a matching manifest is still a valid chain. An earlier
 * export can. Every receipt the two have in common must be the same receipt,
 * byte for byte, and the new export must reach at least as far as the old one
 * did. When the new one starts right after the old one ends, its first receipt
 * must link to the old one's last.
 *
 * Both exports must already have verified on their own.
 */
export function compareWithPrevious(current: Receipt[], previous: Receipt[]): Verification | null {
  const firstNow = current[0];
  const lastNow = current[current.length - 1];
  const lastBefore = previous[previous.length - 1];
  if (firstNow === undefined || lastNow === undefined || lastBefore === undefined) {
    return fail("previous-export", "receipts.jsonl", "one of the two exports holds no receipts");
  }
  if (firstNow.system_id !== lastBefore.system_id) {
    return fail(
      "previous-export",
      "manifest.json",
      `this export is of system ${firstNow.system_id}, the previous one of ${lastBefore.system_id}`,
    );
  }

  const before = new Map(previous.map((receipt) => [receipt.seq, receiptHashHex(receipt)]));
  for (const [index, receipt] of current.entries()) {
    const earlier = before.get(receipt.seq);
    if (earlier !== undefined && earlier !== receiptHashHex(receipt)) {
      return fail(
        "previous-export",
        at(index + 1),
        `receipt seq ${receipt.seq} is not the receipt seq ${receipt.seq} of the previous export: the history has been rewritten`,
      );
    }
  }

  if (lastNow.seq < lastBefore.seq) {
    return fail(
      "previous-export",
      "manifest.json",
      `this export ends at seq ${lastNow.seq}, but the previous one already reached seq ${lastBefore.seq}: receipts are missing from the end`,
    );
  }
  if (firstNow.seq > lastBefore.seq + 1) {
    return fail(
      "previous-export",
      at(1),
      `this export starts at seq ${firstNow.seq} and the previous one ends at seq ${lastBefore.seq}: they neither overlap nor follow each other`,
    );
  }
  if (firstNow.seq === lastBefore.seq + 1 && firstNow.prev_hash !== before.get(lastBefore.seq)) {
    return fail(
      "previous-export",
      at(1),
      `receipt seq ${firstNow.seq} does not link to the last receipt of the previous export`,
    );
  }
  return null;
}

/** The checkpoints of an export and the timestamp tokens it holds, by file name. */
export interface AnchorSet {
  checkpoints: CheckpointEntry[];
  tokens: ReadonlyMap<string, Uint8Array>;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * The other half of --previous. compareWithPrevious shows that receipts were not
 * cut or rewritten; this shows that the anchors were not either. Every
 * checkpoint the earlier export held, and every timestamp token on it, must
 * still be here, unchanged. Without this, taking the newest checkpoint and its
 * token out of an archive (and correcting the manifest's counts) leaves a valid
 * chain whose latest receipts have silently lost their anchor.
 *
 * The exporter leaves out a checkpoint that lies wholly before the first
 * receipt of a window (tree_size <= first seq), so one of those is not asked for.
 *
 * Both exports must already have verified on their own.
 */
export function compareAnchorsWithPrevious(
  current: AnchorSet,
  previous: AnchorSet,
  firstSeq: number,
): Verification | null {
  for (const before of previous.checkpoints) {
    const size = before.checkpoint.tree_size;
    if (size <= firstSeq) continue;

    const now = current.checkpoints.find((entry) => entry.checkpoint.tree_size === size);
    if (now === undefined) {
      return fail(
        "previous-export",
        "checkpoints.jsonl",
        `the previous export holds the checkpoint over ${size} receipts, and this one does not: a checkpoint has been removed`,
      );
    }
    if (now.checkpoint.root_hash !== before.checkpoint.root_hash || now.checkpoint.sig !== before.checkpoint.sig) {
      return fail(
        "previous-export",
        "checkpoints.jsonl",
        `the checkpoint over ${size} receipts is not the one in the previous export: it has been replaced`,
      );
    }

    for (const stamp of before.timestamps) {
      const wanted = previous.tokens.get(stamp.file);
      if (wanted === undefined) continue;
      const kept = now.timestamps.some((candidate) => {
        const bytes = current.tokens.get(candidate.file);
        return candidate.tsa_url === stamp.tsa_url && bytes !== undefined && sameBytes(bytes, wanted);
      });
      if (!kept) {
        return fail(
          "previous-export",
          "checkpoints.jsonl",
          `the previous export holds a timestamp token from ${stamp.tsa_url} over the checkpoint of ${size} receipts, and this one does not: a token has been removed or replaced`,
        );
      }
    }
  }
  return null;
}
