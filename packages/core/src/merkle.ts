import { sha256 } from "./canonical.js";

/**
 * The Merkle tree of RFC 6962, over the receipt hashes of one chain.
 *
 * Two details carry the weight. The 0x00 and 0x01 prefixes keep leaves and
 * internal nodes in separate domains, so nobody can present an internal node as
 * if it were a leaf. And an uneven tree splits at the largest power of two
 * below n rather than duplicating the last node, which is what makes the tree
 * append-only: growing it never rewrites a subtree that already existed.
 *
 * An audit path carries no left-or-right markers. The sides follow from the
 * leaf's index and the size of the tree, so there is nothing in the proof that
 * could disagree with itself.
 */

const HASH_BYTES = 32;

function assertHash(value: Uint8Array, what: string): void {
  if (value.length !== HASH_BYTES) {
    throw new Error(`${what} must be 32 bytes, received ${value.length}`);
  }
}

export function merkleLeafHash(entry: Uint8Array): Uint8Array {
  const prefixed = new Uint8Array(entry.length + 1);
  prefixed[0] = 0x00;
  prefixed.set(entry, 1);
  return sha256(prefixed);
}

export function merkleNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  assertHash(left, "the left child");
  assertHash(right, "the right child");
  const prefixed = new Uint8Array(1 + left.length + right.length);
  prefixed[0] = 0x01;
  prefixed.set(left, 1);
  prefixed.set(right, 1 + left.length);
  return sha256(prefixed);
}

/** The largest power of two strictly below n, where the tree splits. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) {
    k *= 2;
  }
  return k;
}

export function merkleRoot(entries: readonly Uint8Array[]): Uint8Array {
  if (entries.length === 0) {
    // RFC 6962: an empty tree hashes as the empty string does.
    return sha256(new Uint8Array(0));
  }
  const first = entries[0];
  if (entries.length === 1 && first !== undefined) {
    return merkleLeafHash(first);
  }
  const k = splitPoint(entries.length);
  return merkleNodeHash(merkleRoot(entries.slice(0, k)), merkleRoot(entries.slice(k)));
}

/** The audit path for one entry: sibling hashes from the leaf upwards. */
export function inclusionProof(entries: readonly Uint8Array[], index: number): Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    throw new Error(`index ${index} is not in a tree of ${entries.length} entries`);
  }
  if (entries.length === 1) {
    return [];
  }
  const k = splitPoint(entries.length);
  if (index < k) {
    return [...inclusionProof(entries.slice(0, k), index), merkleRoot(entries.slice(k))];
  }
  return [...inclusionProof(entries.slice(k), index - k), merkleRoot(entries.slice(0, k))];
}

/** How many steps an audit path for this position must have. */
function auditPathLength(index: number, treeSize: number): number {
  if (treeSize <= 1) {
    return 0;
  }
  const k = splitPoint(treeSize);
  return 1 + (index < k ? auditPathLength(index, k) : auditPathLength(index - k, treeSize - k));
}

/**
 * Rebuilds the root an audit path claims, so a verifier can compare it with a
 * signed checkpoint. Following RFC 6962 section 2.1.1, the side of each step is
 * derived from the index and the tree size, not read from the proof.
 *
 * The length is checked first. Once the walk reaches the root, further steps
 * would keep hashing happily and produce some other tree's root, so a path of
 * the wrong length is rejected outright rather than silently answered.
 */
export function rootFromInclusionProof(
  entry: Uint8Array,
  index: number,
  treeSize: number,
  proof: readonly Uint8Array[],
): Uint8Array {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize) || index < 0 || index >= treeSize) {
    throw new Error(`index ${index} is not in a tree of ${treeSize} entries`);
  }

  const expected = auditPathLength(index, treeSize);
  if (proof.length !== expected) {
    throw new Error(
      `an audit path for entry ${index} of ${treeSize} has ${expected} steps, received ${proof.length}`,
    );
  }

  let node = merkleLeafHash(entry);
  let leafIndex = index;
  let lastIndex = treeSize - 1;

  for (const sibling of proof) {
    assertHash(sibling, "an audit path step");
    if (leafIndex === lastIndex || leafIndex % 2 === 1) {
      node = merkleNodeHash(sibling, node);
      while (leafIndex !== 0 && leafIndex % 2 === 0) {
        leafIndex = Math.floor(leafIndex / 2);
        lastIndex = Math.floor(lastIndex / 2);
      }
    } else {
      node = merkleNodeHash(node, sibling);
    }
    leafIndex = Math.floor(leafIndex / 2);
    lastIndex = Math.floor(lastIndex / 2);
  }

  return node;
}
