import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalCheckpointBytes,
  checkpointHashHex,
  fromHex,
  inclusionProof,
  merkleRoot,
  rootFromInclusionProof,
  safeParseCheckpoint,
  signCheckpoint,
  toHex,
  verifyCheckpointSignature,
  type Checkpoint,
  type UnsignedCheckpoint,
} from "@sigillo/core";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const ROOT = "84b39fd0350001ad0ef1d6886db35abfa3241db8139941892b8341c5d6c6207a";

function unsigned(overrides: Partial<UnsignedCheckpoint> = {}): UnsignedCheckpoint {
  return {
    v: 1,
    system_id: "acme-support-bot",
    tree_size: 17,
    root_hash: ROOT,
    ts: "2026-03-29T15:00:00.000Z",
    key_id: "3f2a1c9d8e7b6a5f",
    ...overrides,
  };
}

describe("the canonical form of a checkpoint", () => {
  it("is the same RFC 8785 rule a receipt uses, with sig removed", () => {
    const checkpoint = signCheckpoint(unsigned(), privateKey);
    const canonical = new TextDecoder().decode(canonicalCheckpointBytes(checkpoint));
    // Sorted by UTF-16 code unit, which puts tree_size before ts: they share
    // "t", and then "r" comes before "s".
    expect(canonical).toBe(
      `{"key_id":"3f2a1c9d8e7b6a5f","root_hash":"${ROOT}","system_id":"acme-support-bot","tree_size":17,"ts":"2026-03-29T15:00:00.000Z","v":1}`,
    );
    expect(canonical).not.toContain("sig");
  });

  it("does not depend on the order the fields were written in", () => {
    const forwards = unsigned();
    const backwards: UnsignedCheckpoint = {
      key_id: forwards.key_id,
      ts: forwards.ts,
      root_hash: forwards.root_hash,
      tree_size: forwards.tree_size,
      system_id: forwards.system_id,
      v: forwards.v,
    };
    expect(checkpointHashHex(backwards)).toBe(checkpointHashHex(forwards));
  });

  it("changes when any field changes", () => {
    const base = checkpointHashHex(unsigned());
    const mutations: UnsignedCheckpoint[] = [
      unsigned({ system_id: "other-system" }),
      unsigned({ tree_size: 18 }),
      unsigned({ root_hash: `${ROOT.slice(0, 63)}0` }),
      unsigned({ ts: "2026-03-29T15:00:00.001Z" }),
      unsigned({ key_id: "0000000000000000" }),
    ];
    for (const mutated of mutations) {
      expect(checkpointHashHex(mutated)).not.toBe(base);
    }
  });
});

describe("signing a checkpoint", () => {
  it("produces a signature that verifies under the signing key", () => {
    const checkpoint = signCheckpoint(unsigned(), privateKey);
    expect(verifyCheckpointSignature(checkpoint, publicKey)).toBe(true);
    expect(checkpoint.sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
  });

  it("does not verify once any field has been changed", () => {
    const checkpoint = signCheckpoint(unsigned(), privateKey);
    const mutations: Checkpoint[] = [
      { ...checkpoint, tree_size: 18 },
      { ...checkpoint, root_hash: `${ROOT.slice(0, 63)}0` },
      { ...checkpoint, ts: "2026-03-29T15:00:00.001Z" },
      { ...checkpoint, system_id: "other-system" },
    ];
    for (const mutated of mutations) {
      expect(verifyCheckpointSignature(mutated, publicKey)).toBe(false);
    }
  });

  it("does not verify under another key", () => {
    const other = generateKeyPairSync("ed25519");
    expect(verifyCheckpointSignature(signCheckpoint(unsigned(), privateKey), other.publicKey)).toBe(
      false,
    );
  });
});

describe("the checkpoint schema", () => {
  it("accepts a well-formed checkpoint", () => {
    expect(safeParseCheckpoint(signCheckpoint(unsigned(), privateKey)).ok).toBe(true);
  });

  it("rejects a tree of no receipts: a chain always has its genesis", () => {
    const result = safeParseCheckpoint({ ...signCheckpoint(unsigned(), privateKey), tree_size: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("tree_size");
  });

  it("rejects unknown fields and malformed values", () => {
    const signed = signCheckpoint(unsigned(), privateKey);
    const cases: [unknown, RegExp][] = [
      [{ ...signed, note: "extra" }, /note/],
      [{ ...signed, root_hash: "short" }, /root_hash/],
      [{ ...signed, root_hash: ROOT.toUpperCase() }, /root_hash/],
      [{ ...signed, ts: "2026-03-29T15:00:00Z" }, /ts/],
      [{ ...signed, tree_size: 1.5 }, /tree_size/],
      [{ ...signed, key_id: "nope" }, /key_id/],
      [{ ...signed, sig: "nope" }, /sig/],
      [{ ...signed, v: 2 }, /version/i],
    ];
    for (const [value, pattern] of cases) {
      const result = safeParseCheckpoint(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(pattern);
    }
  });
});

describe("what a checkpoint is for", () => {
  it("commits to a set of receipts that inclusion proofs can be checked against", () => {
    // Nine receipt hashes standing in for a chain of nine.
    const receipts = Array.from({ length: 9 }, (_unused, index) =>
      fromHex(checkpointHashHex(unsigned({ tree_size: index + 1 }))),
    );
    const root = toHex(merkleRoot(receipts));
    const checkpoint = signCheckpoint(
      unsigned({ tree_size: receipts.length, root_hash: root }),
      privateKey,
    );

    expect(verifyCheckpointSignature(checkpoint, publicKey)).toBe(true);

    for (let index = 0; index < receipts.length; index += 1) {
      const entry = receipts[index];
      if (entry === undefined) continue;
      const proof = inclusionProof(receipts, index);
      expect(toHex(rootFromInclusionProof(entry, index, checkpoint.tree_size, proof))).toBe(
        checkpoint.root_hash,
      );
    }
  });
});
