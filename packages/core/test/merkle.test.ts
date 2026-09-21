import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  fromHex,
  inclusionProof,
  merkleLeafHash,
  merkleNodeHash,
  merkleRoot,
  rootFromInclusionProof,
  sha256,
  toHex,
} from "@sigillo/core";

interface SizeVector {
  size: number;
  root: string;
  leaf_hashes: string[];
  proofs: string[][];
}

interface VectorFile {
  entries: string[];
  sizes: SizeVector[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./merkle-vectors.json", import.meta.url)), "utf8"),
) as VectorFile;

const entries = (size: number): Uint8Array[] =>
  vectors.entries.slice(0, size).map((hex) => fromHex(hex));

describe("the hashes a Merkle tree is built from", () => {
  it("prefixes a leaf with 0x00 and an internal node with 0x01", () => {
    const entry = fromHex(vectors.entries[0] ?? "");
    const expectedLeaf = sha256(new Uint8Array([0x00, ...entry]));
    expect(toHex(merkleLeafHash(entry))).toBe(toHex(expectedLeaf));

    const left = merkleLeafHash(entry);
    const right = merkleLeafHash(fromHex(vectors.entries[1] ?? ""));
    const expectedNode = sha256(new Uint8Array([0x01, ...left, ...right]));
    expect(toHex(merkleNodeHash(left, right))).toBe(toHex(expectedNode));
  });

  it("keeps a leaf from ever colliding with an internal node", () => {
    // Without the 0x00/0x01 prefixes, a leaf whose content is two concatenated
    // hashes would hash the same as the node above them. This is the whole
    // reason RFC 6962 separates the two domains.
    const left = merkleLeafHash(fromHex(vectors.entries[0] ?? ""));
    const right = merkleLeafHash(fromHex(vectors.entries[1] ?? ""));
    const forged = new Uint8Array([...left, ...right]);
    expect(toHex(merkleLeafHash(forged))).not.toBe(toHex(merkleNodeHash(left, right)));
  });

  it("refuses a node hash built from anything but two 32-byte hashes", () => {
    const good = merkleLeafHash(fromHex(vectors.entries[0] ?? ""));
    expect(() => merkleNodeHash(new Uint8Array(31), good)).toThrow(/32 bytes/);
    expect(() => merkleNodeHash(good, new Uint8Array(33))).toThrow(/32 bytes/);
  });
});

describe("Merkle roots", () => {
  for (const vector of vectors.sizes) {
    it(`matches the RFC 6962 root for ${vector.size} entries`, () => {
      expect(toHex(merkleRoot(entries(vector.size)))).toBe(vector.root);
    });
  }

  it("hashes the empty tree as the hash of the empty string", () => {
    expect(toHex(merkleRoot([]))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("gives a one-entry tree the leaf hash itself as its root", () => {
    const entry = fromHex(vectors.entries[0] ?? "");
    expect(toHex(merkleRoot([entry]))).toBe(toHex(merkleLeafHash(entry)));
  });

  it("gives every size a different root", () => {
    const roots = new Set(vectors.sizes.map((vector) => vector.root));
    expect(roots.size).toBe(vectors.sizes.length);
  });

  it("changes when any entry changes", () => {
    const original = entries(9);
    for (let index = 0; index < original.length; index += 1) {
      const altered = [...original];
      const entry = altered[index];
      if (entry === undefined) continue;
      const flipped = Uint8Array.from(entry);
      flipped[0] = (flipped[0] ?? 0) ^ 0x01;
      altered[index] = flipped;
      expect(toHex(merkleRoot(altered))).not.toBe(vectors.sizes[9]?.root);
    }
  });

  it("changes when two entries are swapped", () => {
    const swapped = entries(9);
    const first = swapped[3];
    const second = swapped[4];
    if (first === undefined || second === undefined) return;
    swapped[3] = second;
    swapped[4] = first;
    expect(toHex(merkleRoot(swapped))).not.toBe(vectors.sizes[9]?.root);
  });
});

describe("inclusion proofs", () => {
  for (const vector of vectors.sizes.filter((size) => size.size > 0)) {
    it(`proves every one of the ${vector.size} entries`, () => {
      const tree = entries(vector.size);
      for (let index = 0; index < vector.size; index += 1) {
        const proof = inclusionProof(tree, index);
        expect(proof.map(toHex)).toEqual(vector.proofs[index]);

        const entry = tree[index];
        if (entry === undefined) continue;
        expect(toHex(rootFromInclusionProof(entry, index, vector.size, proof))).toBe(vector.root);
      }
    });
  }

  it("rejects a proof with any step altered", () => {
    const size = 11;
    const tree = entries(size);
    const root = vectors.sizes[size]?.root;

    for (let index = 0; index < size; index += 1) {
      const proof = inclusionProof(tree, index);
      const entry = tree[index];
      if (entry === undefined) continue;

      for (let step = 0; step < proof.length; step += 1) {
        const tampered = proof.map((hash) => Uint8Array.from(hash));
        const target = tampered[step];
        if (target === undefined) continue;
        target[0] = (target[0] ?? 0) ^ 0x01;
        expect(toHex(rootFromInclusionProof(entry, index, size, tampered))).not.toBe(root);
      }
    }
  });

  it("rejects a proof presented for the wrong entry or the wrong position", () => {
    const size = 11;
    const tree = entries(size);
    const root = vectors.sizes[size]?.root;
    const proof = inclusionProof(tree, 4);

    const other = tree[5];
    const mine = tree[4];
    if (other === undefined || mine === undefined) return;

    expect(toHex(rootFromInclusionProof(other, 4, size, proof))).not.toBe(root);
    expect(toHex(rootFromInclusionProof(mine, 5, size, proof))).not.toBe(root);
  });

  it("rejects a proof that is too short or too long", () => {
    const tree = entries(11);
    const entry = tree[4];
    const proof = inclusionProof(tree, 4);
    if (entry === undefined) return;

    expect(() => rootFromInclusionProof(entry, 4, 11, proof.slice(1))).toThrow(/path/i);
    expect(() => rootFromInclusionProof(entry, 4, 11, [...proof, proof[0] ?? new Uint8Array(32)])).toThrow(
      /path/i,
    );
  });

  it("refuses an index that is not in the tree", () => {
    const tree = entries(5);
    expect(() => inclusionProof(tree, 5)).toThrow(/index/i);
    expect(() => inclusionProof(tree, -1)).toThrow(/index/i);
    expect(() => rootFromInclusionProof(tree[0] ?? new Uint8Array(32), 5, 5, [])).toThrow(/index/i);
  });

  it("gives a one-entry tree an empty proof", () => {
    const tree = entries(1);
    const entry = tree[0];
    if (entry === undefined) return;
    expect(inclusionProof(tree, 0)).toEqual([]);
    expect(toHex(rootFromInclusionProof(entry, 0, 1, []))).toBe(vectors.sizes[1]?.root);
  });
});
