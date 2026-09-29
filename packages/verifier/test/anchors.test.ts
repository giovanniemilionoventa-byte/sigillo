import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  fromHex,
  inclusionProof,
  merkleRoot,
  receiptHashHex,
  signCheckpoint,
  toHex,
  type CheckpointEntry,
  type Receipt,
} from "@sigillo/core";
import { compareAnchorsWithPrevious, verifyBundle, type AnchorSet, type Bundle } from "../src/verify.js";
import { buildManifest, buildReceipts, createIdentity, toBundle } from "./helpers/chain.js";

const identity = createIdentity();
const receipts = buildReceipts(13, identity);

/** A checkpoint over the first `treeSize` receipts, signed by the real key. */
function checkpointOver(treeSize: number, proofsFor: number[] = []): CheckpointEntry {
  const leaves = receipts.slice(0, treeSize).map((receipt) => fromHex(receiptHashHex(receipt)));
  const checkpoint = signCheckpoint(
    {
      v: 1,
      system_id: "acme-support-bot",
      tree_size: treeSize,
      root_hash: toHex(merkleRoot(leaves)),
      ts: "2026-03-29T15:00:00.000Z",
      key_id: identity.keyId,
    },
    identity.privateKey,
  );
  return {
    checkpoint,
    proofs: proofsFor.map((seq) => ({
      seq,
      receipt_hash: receiptHashHex(receipts[seq] as Receipt),
      path: inclusionProof(leaves, seq).map(toHex),
    })),
    timestamps: [],
  };
}

function bundleOf(window: Receipt[], entries: CheckpointEntry[]): Bundle {
  const manifest = buildManifest(window, identity);
  manifest.counts.checkpoints = entries.length;
  return {
    ...toBundle(window, manifest),
    checkpointsJsonl: entries.map((entry) => `${canonicalJson(entry)}\n`).join(""),
  };
}

function unanchored(bundle: Bundle): number {
  const result = verifyBundle(bundle);
  if (!result.ok) throw new Error(`${result.check} at ${result.location}: ${result.detail}`);
  return result.summary.unanchored_receipts;
}

describe("receipts after the newest checkpoint", () => {
  it("counts none when the newest checkpoint covers every receipt", () => {
    expect(unanchored(bundleOf(receipts, [checkpointOver(13)]))).toBe(0);
  });

  it("counts the receipts the newest checkpoint does not cover", () => {
    // A checkpoint over 9 receipts covers seq 0..8: seq 9..12 are four receipts.
    expect(unanchored(bundleOf(receipts, [checkpointOver(9)]))).toBe(4);
  });

  it("goes by the newest checkpoint, not by how many there are", () => {
    expect(unanchored(bundleOf(receipts, [checkpointOver(5), checkpointOver(9)]))).toBe(4);
    expect(unanchored(bundleOf(receipts, [checkpointOver(9), checkpointOver(13)]))).toBe(0);
  });

  it("counts the receipts of a window that starts after seq 0, when a checkpoint is tied to it by proofs", () => {
    const window = receipts.slice(4);
    expect(unanchored(bundleOf(window, [checkpointOver(9, [4, 8])]))).toBe(4);
  });

  it("does not count a checkpoint that is tied to none of the receipts", () => {
    // Without proofs, a window after seq 0 is not linked to the checkpoint:
    // the existing "not linked" note says so, and the checkpoint anchors nothing.
    const window = receipts.slice(4);
    expect(unanchored(bundleOf(window, [checkpointOver(9)]))).toBe(0);
  });

  it("leaves an export with no checkpoint to the existing 'no checkpoint' note", () => {
    expect(unanchored(bundleOf(receipts, []))).toBe(0);
  });
});

/** The anchors of an export: checkpoints, each with two tokens' worth of bytes on file. */
function anchors(entries: CheckpointEntry[], tokenBytes: Record<string, number[]> = {}): AnchorSet {
  const tokens = new Map<string, Uint8Array>();
  const withTimestamps = entries.map((entry) => {
    const file = `timestamps/checkpoint-${entry.checkpoint.tree_size}-1.tsr`;
    tokens.set(file, new Uint8Array(tokenBytes[file] ?? [0x30, 0x03, entry.checkpoint.tree_size]));
    return {
      ...entry,
      timestamps: [{ tsa_url: "https://freetsa.org/tsr", obtained_at: "2026-03-29T15:00:05.000Z", file }],
    };
  });
  return { checkpoints: withTimestamps, tokens };
}

function refusal(current: AnchorSet, previous: AnchorSet, firstSeq = 0): string {
  const result = compareAnchorsWithPrevious(current, previous, firstSeq);
  expect(result?.ok, "expected the comparison to refuse").toBe(false);
  if (result === null || result.ok) return "";
  expect(result.check).toBe("previous-export");
  return result.detail;
}

describe("the checkpoints and tokens of an earlier export (--previous)", () => {
  const nine = checkpointOver(9);
  const thirteen = checkpointOver(13);

  it("accepts an export that keeps them all, and one that adds more", () => {
    const before = anchors([nine]);
    expect(compareAnchorsWithPrevious(anchors([nine]), before, 0)).toBeNull();
    expect(compareAnchorsWithPrevious(anchors([nine, thirteen]), before, 0)).toBeNull();
  });

  it("refuses an export from which a checkpoint has been removed", () => {
    const detail = refusal(anchors([nine]), anchors([nine, thirteen]));
    expect(detail).toContain("13");
    expect(detail).toContain("checkpoint");
  });

  it("refuses an export from which every checkpoint has been removed", () => {
    expect(refusal(anchors([]), anchors([nine]))).toContain("9");
  });

  it("refuses a checkpoint that is there but is no longer the same statement", () => {
    const other = checkpointOver(9);
    other.checkpoint = { ...other.checkpoint, ts: "2026-03-30T00:00:00.000Z", sig: "AAAA" };
    expect(refusal(anchors([other]), anchors([nine]))).toContain("9");
  });

  it("refuses an export from which a token has been removed, the checkpoint staying", () => {
    const current = anchors([nine, thirteen]);
    current.checkpoints[1] = { ...thirteen, timestamps: [] };
    const detail = refusal(current, anchors([nine, thirteen]));
    expect(detail).toContain("13");
    expect(detail).toContain("token");
  });

  it("refuses a token that has been replaced by other bytes", () => {
    const before = anchors([nine, thirteen]);
    const current = anchors([nine, thirteen], { "timestamps/checkpoint-13-1.tsr": [0x30, 0x03, 0xff] });
    expect(refusal(current, before)).toContain("13");
  });

  it("does not ask for a checkpoint that lies wholly before the receipts this export starts at", () => {
    // The exporter leaves out a checkpoint over seq 0..8 from a window that
    // starts at seq 10: it says nothing about those receipts.
    const before = anchors([nine, thirteen]);
    expect(compareAnchorsWithPrevious(anchors([thirteen]), before, 10)).toBeNull();
    expect(refusal(anchors([thirteen]), before, 8)).toContain("9");
  });
});
