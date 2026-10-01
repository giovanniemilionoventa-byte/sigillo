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
import base64
import hashlib
import json
import pathlib
import re
import sys
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent
VECTORS = ROOT / "packages" / "core" / "test" / "vectors.json"
TEXT_VECTORS = ROOT / "packages" / "core" / "test" / "text-vectors.json"
MERKLE_VECTORS = ROOT / "packages" / "core" / "test" / "merkle-vectors.json"
INVALID_VECTORS = ROOT / "packages" / "core" / "test" / "invalid-vectors.json"

GENESIS_PREV_HASH = "0" * 64
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX32 = re.compile(r"^[0-9a-f]{32}$")
HEX16 = re.compile(r"^[0-9a-f]{16}$")
TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SIGNATURE = re.compile(r"^[A-Za-z0-9+/]{86}==$")

ACTION_KINDS = {"tool_call", "llm_call", "agent_step", "decision", "genesis"}
OUTCOMES = {"ok", "error", "blocked", "unknown"}
SOURCE_TYPES = {"otlp", "sdk", "api"}
ARTIFACT_ROLES = {"input", "output"}
MANDATORY = {
    "v", "system_id", "seq", "ts_event", "ts_received", "actor", "action",
    "input_hash", "output_hash", "outcome", "source", "prev_hash", "key_id", "sig",
}
# Version 2 adds these two, both optional, and nothing else. Version 3 adds
# nothing at the receipt level: only `text` inside an artifact. Version 4 adds
# the two mandatory hash schemes, and requires on_behalf_of to be a token.
V2_OPTIONAL = {"artifacts", "model"}
V4_MANDATORY = {"input_hash_scheme", "output_hash_scheme"}
HASH_SCHEMES = {"plain", "salted"}
PSEUDONYM = re.compile(r"^psn_[0-9a-f]{32}$")
TEXT_CANON_1 = "sigillo-text/1"

# sigillo-text/1 as docs/FORMAT.md section 2.5.1 writes it, with the character
# lists copied from there rather than from any sigillo code.
TEXT_REMOVED = re.compile("[\u00ad\u200b\u2060\ufeff]")
TEXT_WHITESPACE = re.compile("[\t\n\u000b\u000c\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+")

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def canonical_text(data):
    """sigillo-text/1 over bytes, or None when the document has no text."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    text = unicodedata.normalize("NFC", TEXT_REMOVED.sub("", text))
    return TEXT_WHITESPACE.sub(" ", text).strip(" ") or None


def check_text_vectors():
    document = json.loads(TEXT_VECTORS.read_text(encoding="utf-8"))
    check(document.get("canon") == TEXT_CANON_1, "text vector file must be for sigillo-text/1")
    for vector in document["vectors"]:
        text = canonical_text(bytes.fromhex(vector["input_hex"]))
        check(text == vector["canonical"], f"text vector {vector['name']!r}: canonical text differs")
        digest = None if text is None else hashlib.sha256(text.encode("utf-8")).hexdigest()
        check(digest == vector["sha256"], f"text vector {vector['name']!r}: digest differs")
    return len(document["vectors"])


def check_artifact(where, artifact, version):
    allowed = {"role", "label", "media_type", "sha256"} | ({"text"} if version >= 3 else set())
    check({"role", "label", "media_type", "sha256"} <= set(artifact) <= allowed, where + "artifact fields")
    if "text" in artifact:
        text = artifact["text"]
        check(isinstance(text, dict) and set(text) == {"canon", "sha256"}, where + "artifact.text fields")
        if isinstance(text, dict):
            check(text.get("canon") == TEXT_CANON_1, where + "artifact.text.canon must be sigillo-text/1")
            check(HEX64.match(text.get("sha256", "")) is not None, where + "artifact.text.sha256 format")
    check(artifact.get("role") in ARTIFACT_ROLES, where + "artifact.role value")
    check(1 <= len(artifact.get("label", "")) <= 256, where + "artifact.label length")
    check(1 <= len(artifact.get("media_type", "")) <= 128, where + "artifact.media_type length")
    check(HEX64.match(artifact.get("sha256", "")) is not None, where + "artifact.sha256 format")


def check_model(where, model):
    check(set(model) == {"name", "provider", "digest"}, where + "model fields")
    check(1 <= len(model.get("name", "")) <= 256, where + "model.name length")
    for field in ("provider", "digest"):
        value = model.get(field)
        check(
            value is None or (isinstance(value, str) and 1 <= len(value) <= 256),
            where + f"model.{field} must be null or a 1-256 character string",
        )


def check_shape(name, receipt):
    where = f"{name}: "
    version = receipt.get("v")
    check(version in (1, 2, 3, 4), where + "v must be 1, 2, 3 or 4")

    extra = set(receipt) - MANDATORY
    if version == 4:
        check(V4_MANDATORY <= extra, where + "a v4 receipt must carry input_hash_scheme and output_hash_scheme")
        extra = extra - V4_MANDATORY
        for role in ("input", "output"):
            scheme = receipt.get(f"{role}_hash_scheme")
            check(scheme is None or scheme in HASH_SCHEMES, where + f"{role}_hash_scheme value")
            check(
                (scheme is None) == (receipt.get(f"{role}_hash") is None),
                where + f"{role}_hash_scheme must be null exactly when {role}_hash is",
            )
        on_behalf_of = receipt.get("actor", {}).get("on_behalf_of")
        check(
            on_behalf_of is None or PSEUDONYM.match(on_behalf_of) is not None,
            where + "a v4 on_behalf_of must be a psn_ pseudonym token",
        )
    if version == 1:
        check(extra == set(), where + f"a v1 receipt must not carry {sorted(extra)}")
    else:
        check(extra <= V2_OPTIONAL, where + f"unexpected field set {sorted(extra - V2_OPTIONAL)}")
        if "artifacts" in receipt:
            artifacts = receipt["artifacts"]
            check(isinstance(artifacts, list) and len(artifacts) >= 1, where + "artifacts must be a non-empty array")
            if isinstance(artifacts, list):
                for index, artifact in enumerate(artifacts):
                    check_artifact(f"{where}artifacts[{index}]: ", artifact, version)
        if "model" in receipt:
            check_model(where + "model: ", receipt["model"])

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
    signature = receipt.get("sig", "")
    check(SIGNATURE.match(signature) is not None, where + "sig format")
    if SIGNATURE.match(signature):
        # Canonical base64: the bits the last character carries beyond the final
        # byte must be zero, so one signature has exactly one spelling.
        canonical = base64.b64encode(base64.b64decode(signature)).decode()
        check(canonical == signature, where + "sig must be canonical base64")
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


# RFC 6962 section 2.1, written again here rather than imported from
# gen_merkle_vectors.py, so that the file it wrote is checked by other code.
def merkle_root(leaves):
    if not leaves:
        return hashlib.sha256(b"").digest()
    if len(leaves) == 1:
        return hashlib.sha256(b"\x00" + leaves[0]).digest()
    k = 1
    while k * 2 < len(leaves):
        k *= 2
    return hashlib.sha256(b"\x01" + merkle_root(leaves[:k]) + merkle_root(leaves[k:])).digest()


def check_merkle_vectors():
    """Every root, and every frontier the signer would keep: one subtree root
    per set bit of the size, largest first, folding back into the root."""
    document = json.loads(MERKLE_VECTORS.read_text(encoding="utf-8"))
    entries = [bytes.fromhex(entry) for entry in document["entries"]]
    for item in document["sizes"]:
        size = item["size"]
        leaves = entries[:size]
        root = merkle_root(leaves)
        check(root.hex() == item["root"], f"merkle size {size}: root {root.hex()} differs from {item['root']}")
        nodes, start = [], 0
        for bit in reversed(range(size.bit_length())):
            if size & (1 << bit):
                nodes.append(merkle_root(leaves[start:start + (1 << bit)]))
                start += 1 << bit
        check(
            [node.hex() for node in nodes] == item.get("frontier"),
            f"merkle size {size}: frontier differs from the recorded one",
        )
        folded = nodes[-1] if nodes else hashlib.sha256(b"").digest()
        for node in reversed(nodes[:-1]):
            folded = hashlib.sha256(b"\x01" + node + folded).digest()
        check(folded == root, f"merkle size {size}: the frontier does not fold back into the root")
    return len(document["sizes"])


def check_invalid_vectors(vectors):
    """Each case must be refused by check_shape: the same rules, read from
    FORMAT.md, that accept every valid vector."""
    document = json.loads(INVALID_VECTORS.read_text(encoding="utf-8"))
    by_name = {vector["name"]: vector["receipt"] for vector in vectors}
    for case in document["cases"]:
        base = by_name.get(case["base"])
        check(base is not None, f"invalid {case['name']}: no vector named {case['base']}")
        if base is None:
            continue
        receipt = {**base, **case.get("set", {})}
        for key in case.get("remove", []):
            receipt.pop(key, None)
        before = len(failures)
        check_shape(case["name"], receipt)
        refused = len(failures) > before
        del failures[before:]
        check(refused, f"invalid {case['name']}: accepted, but every implementation must refuse it")
    return len(document["cases"])


def main():
    document = json.loads(VECTORS.read_text(encoding="utf-8"))
    vectors = document["vectors"]
    check(len(vectors) >= 10, f"expected at least 10 vectors, found {len(vectors)}")
    check(
        document.get("receipt_versions") == [1, 2, 3, 4],
        "vector file must declare receipt_versions [1, 2, 3, 4]",
    )

    # Salted digests (docs/FORMAT.md 2.7): SHA-256 of the nonce's 32 bytes
    # followed by the value's RFC 8785 form.
    salted = document.get("salted_digests", [])
    check(len(salted) >= 4, "expected at least 4 salted digest vectors")
    for entry in salted:
        nonce = bytes.fromhex(entry["nonce_hex"])
        check(len(nonce) == 32, f"salted digest {entry['name']}: the nonce must be 32 bytes")
        digest = hashlib.sha256(nonce + canonical_json(entry["value"]).encode("utf-8")).hexdigest()
        check(digest == entry["digest"], f"salted digest {entry['name']}: {digest} differs from {entry['digest']}")

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

    text_vectors = check_text_vectors()
    merkle_sizes = check_merkle_vectors()
    invalid = check_invalid_vectors(vectors)

    if failures:
        print(f"crosscheck: {len(failures)} problem(s)", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print(
        f"crosscheck: ok, {len(vectors)} receipt vectors, {len(salted)} salted digests, "
        f"{text_vectors} sigillo-text/1 vectors and {merkle_sizes} Merkle roots and frontiers "
        f"re-derived, and {invalid} invalid receipts refused, independently in Python"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
