#!/usr/bin/env python3
"""Derives the Merkle test vectors from RFC 6962, without using sigillo's code.

Everything here is written from the text of RFC 6962 section 2.1, in Python,
with only the standard library. The roots are computed twice, by two different
algorithms that the RFC's definition implies:

  * the recursive split at the largest power of two below n, which is what the
    RFC actually defines;
  * the level-by-level construction that promotes an odd node unchanged, which
    is how most implementations build the same tree.

If those two ever disagree, one of them is wrong and the vectors are not
written. That check is the reason this file computes the root twice.

Usage: python3 scripts/gen_merkle_vectors.py
"""
import hashlib
import json
import pathlib

TARGET = pathlib.Path(__file__).resolve().parent.parent / "packages" / "core" / "test" / "merkle-vectors.json"
MAX_SIZE = 17


def sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def leaf_hash(entry: bytes) -> bytes:
    """RFC 6962: MTH({d(0)}) = SHA-256(0x00 || d(0))."""
    return sha256(b"\x00" + entry)


def node_hash(left: bytes, right: bytes) -> bytes:
    """RFC 6962: MTH(D[n]) = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))."""
    return sha256(b"\x01" + left + right)


def split_point(n: int) -> int:
    """The largest power of two strictly smaller than n."""
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def merkle_root(entries: list[bytes]) -> bytes:
    if not entries:
        # RFC 6962: the hash of an empty list is the hash of the empty string.
        return sha256(b"")
    if len(entries) == 1:
        return leaf_hash(entries[0])
    k = split_point(len(entries))
    return node_hash(merkle_root(entries[:k]), merkle_root(entries[k:]))


def merkle_root_by_levels(entries: list[bytes]) -> bytes:
    if not entries:
        return sha256(b"")
    level = [leaf_hash(entry) for entry in entries]
    while len(level) > 1:
        nxt = [node_hash(level[i], level[i + 1]) for i in range(0, len(level) - 1, 2)]
        if len(level) % 2 == 1:
            nxt.append(level[-1])
        level = nxt
    return level[0]


def inclusion_path(index: int, entries: list[bytes]) -> list[bytes]:
    """RFC 6962 PATH(m, D[n]): the audit path, closest sibling first."""
    n = len(entries)
    if n <= 1:
        return []
    k = split_point(n)
    if index < k:
        return inclusion_path(index, entries[:k]) + [merkle_root(entries[k:])]
    return inclusion_path(index - k, entries[k:]) + [merkle_root(entries[:k])]


def root_from_path(leaf: bytes, index: int, size: int, path: list[bytes]) -> bytes:
    """RFC 6962 section 2.1.1: the sides come from the index and the tree size."""
    if index >= size:
        raise ValueError("index outside the tree")
    node = leaf
    fn, sn = index, size - 1
    for sibling in path:
        if fn == sn or fn % 2 == 1:
            node = node_hash(sibling, node)
            while fn != 0 and fn % 2 == 0:
                fn >>= 1
                sn >>= 1
        else:
            node = node_hash(node, sibling)
        fn >>= 1
        sn >>= 1
    if fn != 0:
        raise ValueError("audit path too short")
    return node


def entry(index: int) -> bytes:
    """A stand-in for a receipt hash: 32 bytes, reproducible from the index."""
    return sha256(f"entry-{index}".encode("utf-8"))


def main() -> None:
    sizes = []
    for size in range(0, MAX_SIZE + 1):
        entries = [entry(index) for index in range(size)]

        recursive = merkle_root(entries)
        by_levels = merkle_root_by_levels(entries)
        if recursive != by_levels:
            raise SystemExit(
                f"size {size}: the recursive split and the level construction disagree"
            )

        proofs = []
        for index in range(size):
            path = inclusion_path(index, entries)
            recomputed = root_from_path(leaf_hash(entries[index]), index, size, path)
            if recomputed != recursive:
                raise SystemExit(f"size {size}, index {index}: the audit path does not rebuild the root")
            proofs.append([step.hex() for step in path])

        sizes.append(
            {
                "size": size,
                "root": recursive.hex(),
                "leaf_hashes": [leaf_hash(e).hex() for e in entries],
                "proofs": proofs,
            }
        )

    document = {
        "format": "sigillo Merkle test vectors, RFC 6962",
        "note": (
            "entry(i) = SHA-256('entry-<i>'), standing in for a receipt hash. "
            "leaf = SHA-256(0x00 || entry), internal node = SHA-256(0x01 || left || right), "
            "and a tree of n entries splits at the largest power of two below n. "
            "proofs[i] is the RFC 6962 audit path for entry i: sibling hashes from the leaf "
            "upwards, with no side markers, because the sides follow from the index and the size."
        ),
        "entries": [entry(index).hex() for index in range(MAX_SIZE)],
        "sizes": sizes,
    }

    TARGET.write_text(json.dumps(document, indent=2) + "\n")
    print(f"wrote roots and audit paths for sizes 0..{MAX_SIZE} to {TARGET}")
    print(f"empty tree root: {sizes[0]['root']}")
    print(f"one entry root : {sizes[1]['root']}")


if __name__ == "__main__":
    main()
