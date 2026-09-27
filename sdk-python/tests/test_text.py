"""sigillo-text/1 in the SDK: the port, held to packages/core.

The rule has one reference implementation, in packages/core/src/text.ts,
which the server, `sigillo-verify` and the browser page all run. Python
cannot run it, so the SDK carries a port; these tests are what bind the two:

- every hand-written vector in packages/core/test/text-vectors.json;
- thousands of random strings, drawn from the characters where the rule is
  easiest to get wrong, hashed here and by the real built core in Node, one
  by one.

    python -m unittest discover -s sdk-python/tests -t sdk-python
"""

from __future__ import annotations

import hashlib
import json
import random
import shutil
import subprocess
import unittest
from pathlib import Path

from sigillo import _text

_ROOT = Path(__file__).resolve().parent.parent.parent
_VECTORS = _ROOT / "packages" / "core" / "test" / "text-vectors.json"
_CORE_INDEX = _ROOT / "packages" / "core" / "dist" / "index.js"

# Where implementations disagree: every whitespace the rule lists and some it
# does not (U+001C..U+001F are whitespace to Python's str.isspace(); U+FEFF
# is whitespace to JavaScript's \s), the removed invisibles, the kept ones
# (ZWJ, ZWNJ, bidi controls, a variation selector), combining marks and what
# they compose with, compatibility characters NFC must leave alone, emoji,
# and plain letters, digits and punctuation.
_ALPHABET = (
    list("\t\n\u000b\u000c\r \u0085\u00a0\u1680\u2028\u2029\u202f\u205f\u3000")
    + [chr(code) for code in range(0x2000, 0x200B)]
    + list("\u001c\u001d\u001e\u001f\u180e")
    + list("\u00ad\u200b\u2060\ufeff")
    + list("\u200c\u200d\u202e\u2066\u2069\ufe0f")
    + list("\u0301\u0300\u0308\u0327eéaAoOcç한ΩÅ")
    + list("²ﬁ１①")
    + ["\U0001f468", "\U0001f469", "❤"]
    + list("abcXYZ0123456789.,;:!?'\"-“”–")
)


def _node_text_sha256(inputs: list[bytes]) -> list[str | None]:
    """The real `textSha256` from the built packages/core, run in Node."""
    script = (
        f"import {{ textSha256 }} from {json.dumps(str(_CORE_INDEX))};\n"
        "const chunks = [];\n"
        "process.stdin.on('data', (chunk) => chunks.push(chunk));\n"
        "process.stdin.on('end', () => {\n"
        "  const inputs = JSON.parse(Buffer.concat(chunks).toString('utf8'));\n"
        "  const out = inputs.map((hex) => textSha256(new Uint8Array(Buffer.from(hex, 'hex'))));\n"
        "  process.stdout.write(JSON.stringify(out));\n"
        "});\n"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=json.dumps([data.hex() for data in inputs]).encode("utf-8"),
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


class TextVectorsTest(unittest.TestCase):
    def test_every_shared_vector(self) -> None:
        document = json.loads(_VECTORS.read_text(encoding="utf-8"))
        self.assertEqual(document["canon"], _text.TEXT_CANON_1)
        self.assertGreaterEqual(len(document["vectors"]), 40)
        for vector in document["vectors"]:
            with self.subTest(vector["name"]):
                data = bytes.fromhex(vector["input_hex"])
                self.assertEqual(_text.canonical_text(data), vector["canonical"])
                self.assertEqual(_text.text_sha256(data), vector["sha256"])

    def test_same_text_different_spacing_same_fingerprint(self) -> None:
        a = "Contratto n. 42\r\n\r\nIl fornitore consegna 1 000 pezzi\tentro il 3 marzo.\r\n".encode()
        b = "  Contratto n. 42 Il fornitore\nconsegna 1\u00a0000   pezzi entro\nil 3 marzo.".encode()
        self.assertIsNotNone(_text.text_sha256(a))
        self.assertEqual(_text.text_sha256(a), _text.text_sha256(b))

    def test_one_changed_digit_or_letter_different_fingerprint(self) -> None:
        base = "Il fornitore consegna 1000 pezzi entro il 3 marzo."
        changed = [base.replace("1000", "1001"), base.replace("marzo", "marzi"), base.replace("Il", "il")]
        digests = {_text.text_sha256(text.encode()) for text in [base, *changed]}
        self.assertEqual(len(digests), 4)

    def test_binary_has_no_text_fingerprint(self) -> None:
        pdf = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n"
        png = bytes.fromhex("89504e470d0a1a0a0000000d49484452")
        for data in (pdf, png):
            self.assertIsNone(_text.canonical_text(data))
            self.assertIsNone(_text.text_sha256(data))


@unittest.skipIf(shutil.which("node") is None or not _CORE_INDEX.exists(), "needs node and a built packages/core (pnpm build)")
class AgreesWithCoreTest(unittest.TestCase):
    def test_random_strings_hash_the_same_here_and_in_core(self) -> None:
        generator = random.Random(20260927)
        inputs = [
            "".join(generator.choice(_ALPHABET) for _ in range(generator.randint(0, 24))).encode("utf-8")
            for _ in range(3000)
        ]
        # A few that are not UTF-8 at all.
        inputs += [b"\xff", b"a\xed\xa0\x80b", b"\xc0\xaf", bytes(range(256))]
        expected = _node_text_sha256(inputs)
        for data, digest in zip(inputs, expected):
            self.assertEqual(_text.text_sha256(data), digest, data.hex())


class MediaTypeTest(unittest.TestCase):
    def test_only_text_plain_gets_a_text_fingerprint(self) -> None:
        for media_type in ("text/plain", "text/plain; charset=utf-8", "TEXT/PLAIN"):
            self.assertTrue(_text.is_plain_text(media_type), media_type)
        for media_type in ("text/csv", "text/markdown", "text/html", "application/pdf", "application/octet-stream", ""):
            self.assertFalse(_text.is_plain_text(media_type), media_type)


if __name__ == "__main__":
    unittest.main()
