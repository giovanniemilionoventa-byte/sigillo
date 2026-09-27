"""sigillo-text/1: a text document's fingerprint, whatever its spacing.

This is a port. The rule's one reference implementation is
packages/core/src/text.ts, which the server, `sigillo-verify` and the
browser page all run as it is; the SDK cannot run JavaScript, so it carries
this copy, and sdk-python/tests/test_text.py holds it to the original: every
vector of packages/core/test/text-vectors.json, and thousands of random
strings hashed here and by the built core in Node. docs/FORMAT.md, section
2.5.1, is the definition both follow.

The character lists are written out, never taken from `str.isspace()` or
`\\s`: Python counts U+001C..U+001F as whitespace and JavaScript does not,
and JavaScript counts U+FEFF and Python does not. With the library's own
notion of whitespace, the SDK and the browser would give the same text two
fingerprints.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

TEXT_CANON_1 = "sigillo-text/1"

# 1. Removed: soft hyphen, zero-width space, word joiner, byte order mark.
_REMOVED = re.compile("[\u00ad\u200b\u2060\ufeff]")
# 3. Every run of these (Unicode White_Space, listed in full) becomes one space.
_WHITESPACE = re.compile(
    "[\u0009-\u000d \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+"
)


def canonical_text(data: bytes) -> str | None:
    """The document's text under sigillo-text/1, or None when it has none:
    bytes that are not UTF-8, or nothing left but whitespace."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    # 2. NFC, never NFKC: m² is not m2.
    text = unicodedata.normalize("NFC", _REMOVED.sub("", text))
    # 4. No space at either end.
    text = _WHITESPACE.sub(" ", text).strip(" ")
    return text or None


def text_sha256(data: bytes) -> str | None:
    """SHA-256 of the canonical text's UTF-8 bytes, lowercase hex, or None."""
    text = canonical_text(data)
    return None if text is None else hashlib.sha256(text.encode("utf-8")).hexdigest()


def is_plain_text(media_type: str) -> bool:
    """Whether a document of this media type gets a text fingerprint. Only
    text/plain: in CSV, Markdown, HTML or source code, spacing and line
    breaks are content, and the exact fingerprint is the only honest one."""
    return media_type.split(";", 1)[0].strip().lower() == "text/plain"
