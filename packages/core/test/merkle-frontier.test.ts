import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  emptyFrontier,
  frontierAppend,
  frontierRoot,
  fromHex,
  merkleRoot,
  parseFrontier,
  serializeFrontier,
  sha256,
  toHex,
  type MerkleFrontier,
} from "@sigillo/core";

/**
 * The frontier is how the signer keeps a chain's Merkle root without keeping
 * the chain: the roots of the perfect subtrees a tree of n leaves splits
 * into, one per set bit of n. Every test compares it with merkleRoot, the
 * full recomputation the verifier uses, over real SHA-256.
 */

interface VectorFile {
  entries: string[];
  sizes: { size: number; root: string; frontier: string[] }[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./merkle-vectors.json", import.meta.url)), "utf8"),
) as VectorFile;

function frontierOf(entries: readonly Uint8Array[]): MerkleFrontier {
  return entries.reduce((frontier, entry) => frontierAppend(frontier, entry), emptyFrontier());
}

function popcount(n: number): number {
  let count = 0;
  for (let rest = n; rest > 0; rest = Math.floor(rest / 2)) count += rest % 2;
  return count;
}

const receiptHash = fc.uint8Array({ minLength: 32, maxLength: 32 });

describe("a Merkle frontier", () => {
  it("of no entries has the root of the empty tree", () => {
    const frontier = emptyFrontier();
    expect(frontier.size).toBe(0);
    expect(frontier.nodes).toEqual([]);
    expect(toHex(frontierRoot(frontier))).toBe(toHex(merkleRoot([])));
    expect(toHex(frontierRoot(frontier))).toBe(toHex(sha256(new Uint8Array(0))));
  });

  it("gives the root of every RFC 6962 test vector, sizes 0 to 17", () => {
    for (const { size, root } of vectors.sizes) {
      const entries = vectors.entries.slice(0, size).map((hex) => fromHex(hex));
      expect(toHex(frontierRoot(frontierOf(entries))), `size ${size}`).toBe(root);
    }
  });

  it("holds the subtree roots derived independently in Python, sizes 0 to 17", () => {
    // scripts/gen_merkle_vectors.py slices the entries at each set bit of the
    // size and hashes each slice whole; this builds the same nodes by
    // appending one entry at a time.
    for (const { size, frontier } of vectors.sizes) {
      const entries = vectors.entries.slice(0, size).map((hex) => fromHex(hex));
      expect(serializeFrontier(frontierOf(entries)), `size ${size}`).toEqual({ size, nodes: frontier });
    }
  });

  it("gives the same root as the full computation, at every size along the way", () => {
    fc.assert(
      fc.property(fc.array(receiptHash, { maxLength: 300 }), (entries) => {
        let frontier = emptyFrontier();
        expect(toHex(frontierRoot(frontier))).toBe(toHex(merkleRoot([])));
        entries.forEach((entry, index) => {
          frontier = frontierAppend(frontier, entry);
          expect(frontier.size).toBe(index + 1);
          expect(toHex(frontierRoot(frontier))).toBe(toHex(merkleRoot(entries.slice(0, index + 1))));
        });
      }),
      { numRuns: 60 },
    );
  });

  it("holds one node per set bit of its size, never more", () => {
    fc.assert(
      fc.property(fc.array(receiptHash, { maxLength: 200 }), (entries) => {
        const frontier = frontierOf(entries);
        expect(frontier.nodes.length).toBe(popcount(entries.length));
        for (const node of frontier.nodes) expect(node.length).toBe(32);
      }),
      { numRuns: 100 },
    );
  });

  it("does not change the frontier it was appended to", () => {
    const first = frontierAppend(emptyFrontier(), fromHex(vectors.entries[0] ?? ""));
    const before = serializeFrontier(first);
    frontierAppend(first, fromHex(vectors.entries[1] ?? ""));
    expect(serializeFrontier(first)).toEqual(before);
  });
});

describe("a serialized frontier", () => {
  it("survives a round trip through JSON, and keeps growing to the right root", () => {
    fc.assert(
      fc.property(
        fc.array(receiptHash, { maxLength: 150 }),
        fc.array(receiptHash, { maxLength: 40 }),
        (before, after) => {
          const stored = JSON.parse(JSON.stringify(serializeFrontier(frontierOf(before)))) as unknown;
          const restored = after.reduce(
            (frontier, entry) => frontierAppend(frontier, entry),
            parseFrontier(stored),
          );
          expect(toHex(frontierRoot(restored))).toBe(toHex(merkleRoot([...before, ...after])));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("is the size and the nodes as lowercase hex, largest subtree first", () => {
    const entries = vectors.entries.slice(0, 3).map((hex) => fromHex(hex));
    const serialized = serializeFrontier(frontierOf(entries));
    expect(Object.keys(serialized).sort()).toEqual(["nodes", "size"]);
    expect(serialized.size).toBe(3);
    expect(serialized.nodes).toHaveLength(2);
    expect(serialized.nodes[0]).toBe(toHex(merkleRoot(entries.slice(0, 2))));
    expect(serialized.nodes[1]).toBe(toHex(merkleRoot(entries.slice(2, 3))));
  });

  it("is refused when it cannot be the frontier of any tree", () => {
    const node = "ab".repeat(32);
    const bad: unknown[] = [
      null,
      [],
      "frontier",
      { size: 1 },
      { nodes: [node] },
      { size: -1, nodes: [] },
      { size: 1.5, nodes: [node] },
      { size: 2 ** 53, nodes: [] },
      { size: 0, nodes: [node] },
      { size: 1, nodes: [] },
      { size: 3, nodes: [node] },
      { size: 2, nodes: [node, node] },
      { size: 1, nodes: [node.toUpperCase()] },
      { size: 1, nodes: [node.slice(2)] },
      { size: 1, nodes: [7] },
      { size: 1, nodes: [node], extra: true },
    ];
    for (const value of bad) {
      expect(() => parseFrontier(value), JSON.stringify(value)).toThrow();
    }
  });
});
