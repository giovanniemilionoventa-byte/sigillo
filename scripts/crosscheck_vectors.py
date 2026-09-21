#!/usr/bin/env python3
"""Re-derives the receipt test vectors without using the sigillo code.

This is the standing proof that docs/FORMAT.md is enough to reimplement a
verifier: everything below follows the written format, using only the Python
standard library.

Python's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)
is a valid RFC 8785 serialiser for this schema: the receipt contains only
strings, integers within the exact range, nulls and objects; all member names
are ASCII, so sorting by code point and sorting by UTF-16 code unit agree.

Usage: python3 scripts/crosscheck_vectors.py
"""
import hashlib
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
VECTORS = ROOT / "packages" / "core" / "test" / "vectors.json"

GENESIS_PREV_HASH = "0" * 64
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX32 = re.compile(r"^[0-9a-f]{32}$")
HEX16 = re.compile(r"^[0-9a-f]{16}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SIGNATURE = re.compile(r"^[A-Za-z0-9+/]{86}==$")

ACTION_KINDS = {"tool_call", "llm_call", "agent_step", "decision", "genesis"}
OUTCOMES = {"ok", "error", "blocked", "unknown"}
SOURCE_TYPES = {"otlp", "sdk", "api"}
MANDATORY = {
    "v", "system_id", "seq", "ts_event", "ts_received", "actor", "action",
    "input_hash", "output_hash", "outcome", "source", "prev_hash", "key_id", "sig",
}

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def check_shape(name, receipt):
    where = f"{name}: "
    check(set(receipt) == MANDATORY, where + f"unexpected field set {sorted(set(receipt) ^ MANDATORY)}")
    check(receipt.get("v") == 1, where + "v must be 1")
    seq = receipt.get("seq")
    check(isinstance(seq, int) and not isinstance(seq, bool) and seq >= 0, where + "seq must be a non-negative integer")
    check(1 <= len(receipt.get("system_id", "")) <= 128, where + "system_id length")
    for field in ("ts_event", "ts_received"):
        check(TIMESTAMP.match(receipt.get(field, "")) is not None, where + f"{field} format")
    for field in ("input_hash", "output_hash"):
        value = receipt.get(field)
        check(value is None or HEX64.match(value) is not None, where + f"{field} must be null or 64 hex characters")
    check(HEX64.match(receipt.get("prev_hash", "")) is not None, where + "prev_hash format")
    check(HEX16.match(receipt.get("key_id", "")) is not None, where + "key_id format")
    check(SIGNATURE.match(receipt.get("sig", "")) is not None, where + "sig format")
    check(receipt.get("outcome") in OUTCOMES, where + "outcome value")

    actor = receipt.get("actor", {})
    check(set(actor) <= {"agent", "on_behalf_of"}, where + "actor fields")
    check(1 <= len(actor.get("agent", "")) <= 256, where + "actor.agent length")

    action = receipt.get("action", {})
    check(set(action) == {"kind", "name"}, where + "action fields")
    check(action.get("kind") in ACTION_KINDS, where + "action.kind value")
    check(1 <= len(action.get("name", "")) <= 256, where + "action.name length")

    source = receipt.get("source", {})
    check(set(source) <= {"type", "trace_id", "span_id"}, where + "source fields")
    check(source.get("type") in SOURCE_TYPES, where + "source.type value")
    if "trace_id" in source:
        check(HEX32.match(source["trace_id"]) is not None, where + "source.trace_id format")
    if "span_id" in source:
        check(HEX16.match(source["span_id"]) is not None, where + "source.span_id format")

    if action.get("kind") == "genesis":
        check(seq == 0, where + "a genesis receipt must have seq 0")
        check(receipt.get("prev_hash") == GENESIS_PREV_HASH, where + "a genesis receipt must have 64 zeros as prev_hash")
        check(action.get("name") == receipt.get("system_id"), where + "a genesis receipt names its system in action.name")
    if seq == 0:
        check(receipt.get("prev_hash") == GENESIS_PREV_HASH, where + "seq 0 must carry 64 zeros as prev_hash")


def main():
    document = json.loads(VECTORS.read_text(encoding="utf-8"))
    vectors = document["vectors"]
    check(len(vectors) >= 10, f"expected at least 10 vectors, found {len(vectors)}")
    check(document["receipt_version"] == 1, "vector file declares an unexpected receipt version")

    seen_hashes = {}
    for vector in vectors:
        name = vector["name"]
        receipt = vector["receipt"]
        check_shape(name, receipt)

        signed_fields = {key: value for key, value in receipt.items() if key != "sig"}
        canonical = canonical_json(signed_fields)
        check(canonical == vector["canonical"], f"{name}: canonical form differs from the recorded one")

        digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
        check(digest == vector["hash"], f"{name}: digest {digest} differs from the recorded {vector['hash']}")

        check(name not in seen_hashes.values(), f"{name}: duplicate vector name")
        check(digest not in seen_hashes, f"{name}: shares a digest with {seen_hashes.get(digest)}")
        seen_hashes[digest] = name

    if failures:
        print(f"crosscheck: {len(failures)} problem(s)", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print(f"crosscheck: ok, {len(vectors)} vectors re-derived independently in Python")
    return 0


if __name__ == "__main__":
    sys.exit(main())
