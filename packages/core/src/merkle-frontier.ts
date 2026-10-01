import { fromHex, sha256, toHex } from "./canonical.js";
import { merkleLeafHash, merkleNodeHash } from "./merkle.js";

/**
 * The frontier of an RFC 6962 Merkle tree (a "compact range" from 0 to n):
 * the roots of the perfect subtrees that a tree of n leaves splits into, one
 * per set bit of n, the largest first. It is all the signer needs to keep to
 * know a chain's root without keeping the chain, and it grows by one append
 * per receipt.
 *
 * Leaves follow merkle.ts exactly: an entry is a receipt hash, and its leaf is
 * merkleLeafHash(entry). The root is the one merkleRoot computes from every
 * entry, because RFC 6962 splits a tree at the largest power of two below n:
 * the left part is the largest perfect subtree, and the right part is the tree
 * of what remains, so folding the nodes from the right rebuilds the root.
 */

export interface MerkleFrontier {
  readonly size: number;
  /** Subtree roots, largest (leftmost) first. */
  readonly nodes: readonly Uint8Array[];
}

/** A frontier as JSON holds it. */
export interface SerializedFrontier {
  size: number;
  nodes: string[];
}

const NODE_HEX = /^[0-9a-f]{64}$/;

function setBits(n: number): number {
  let count = 0;
  for (let rest = n; rest > 0; rest = Math.floor(rest / 2)) count += rest % 2;
  return count;
}

export function emptyFrontier(): MerkleFrontier {
  return { size: 0, nodes: [] };
}

/**
 * Adds one entry. The new leaf is merged with the smallest subtrees for as
 * long as they are the same size as what it has become, which is once for
 * every trailing 1 bit of the old size: the way a binary counter carries.
 */
export function frontierAppend(frontier: MerkleFrontier, entry: Uint8Array): MerkleFrontier {
  const nodes = [...frontier.nodes];
  let node = merkleLeafHash(entry);
  for (let carry = frontier.size; carry % 2 === 1; carry = Math.floor(carry / 2)) {
    const left = nodes.pop();
    if (left === undefined) throw new Error("a frontier holds fewer nodes than its size requires");
    node = merkleNodeHash(left, node);
  }
  nodes.push(node);
  return { size: frontier.size + 1, nodes };
}

/** The root merkleRoot would compute from all the entries appended so far. */
export function frontierRoot(frontier: MerkleFrontier): Uint8Array {
  const last = frontier.nodes[frontier.nodes.length - 1];
  if (last === undefined) {
    // RFC 6962: an empty tree hashes as the empty string does.
    return sha256(new Uint8Array(0));
  }
  let root = last;
  for (let index = frontier.nodes.length - 2; index >= 0; index -= 1) {
    root = merkleNodeHash(frontier.nodes[index] as Uint8Array, root);
  }
  return root;
}

export function serializeFrontier(frontier: MerkleFrontier): SerializedFrontier {
  return { size: frontier.size, nodes: frontier.nodes.map((node) => toHex(node)) };
}

/**
 * Reads a serialized frontier back, refusing anything that is not the
 * frontier of some tree: exactly the two members, a whole size, and as many
 * 32-byte nodes as the size has set bits.
 */
export function parseFrontier(value: unknown): MerkleFrontier {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("a frontier must be an object");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "nodes" || keys[1] !== "size") {
    throw new Error("a frontier has exactly two members, size and nodes");
  }
  const { size, nodes } = value as { size: unknown; nodes: unknown };
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("a frontier's size must be a whole number, 0 or more");
  }
  if (!Array.isArray(nodes) || nodes.length !== setBits(size)) {
    throw new Error(`a frontier of size ${size} holds exactly ${setBits(size)} nodes`);
  }
  return {
    size,
    nodes: nodes.map((node) => {
      if (typeof node !== "string" || !NODE_HEX.test(node)) {
        throw new Error("a frontier's nodes are 64 lowercase hex characters each");
      }
      return fromHex(node);
    }),
  };
}
