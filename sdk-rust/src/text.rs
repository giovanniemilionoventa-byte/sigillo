//! sigillo-text/1: a text document's fingerprint, whatever its spacing.
//!
//! A port, like the Python SDK's `_text.py`. The rule's one reference
//! implementation is packages/core/src/text.ts; docs/FORMAT.md, section
//! 2.5.1, is the definition both follow, and `tests/vectors.rs` holds this
//! copy to every vector of packages/core/test/text-vectors.json.
//!
//! The character lists are written out, never taken from
//! `char::is_whitespace`, which is Unicode's White_Space but not the rule's
//! own list written down: the rule says which characters, so this says them.

use unicode_normalization::UnicodeNormalization;

use crate::digest::sha256_hex;

pub const TEXT_CANON_1: &str = "sigillo-text/1";

/// Step 2: removed. Soft hyphen, zero-width space, word joiner, byte order mark.
fn removed(character: char) -> bool {
    matches!(character, '\u{00ad}' | '\u{200b}' | '\u{2060}' | '\u{feff}')
}

/// Step 4: every run of these (Unicode White_Space, listed in full) becomes one space.
fn white(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | ' '
            | '\u{0085}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

/// The document's text under sigillo-text/1, or `None` when it has none:
/// bytes that are not UTF-8, or nothing left but whitespace.
pub fn canonical_text(data: &[u8]) -> Option<String> {
    // 1. Strict UTF-8; a leading byte order mark stays a character, removed below.
    let text = std::str::from_utf8(data).ok()?;
    // 2 and 3. Remove the invisibles, then NFC (never NFKC: m² is not m2).
    let normalized: String = text.chars().filter(|&c| !removed(c)).nfc().collect();
    // 4 and 5. Collapse every run of whitespace into one space, none at either end.
    let mut out = String::with_capacity(normalized.len());
    let mut in_run = false;
    for character in normalized.chars() {
        if white(character) {
            in_run = true;
            continue;
        }
        if in_run && !out.is_empty() {
            out.push(' ');
        }
        in_run = false;
        out.push(character);
    }
    // 6. Nothing left: no text fingerprint.
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 7. SHA-256 of the canonical text's UTF-8 bytes, lowercase hex, or `None`.
pub fn text_sha256(data: &[u8]) -> Option<String> {
    canonical_text(data).map(|text| sha256_hex(text.as_bytes()))
}

/// Whether a document of this media type gets a text fingerprint. Only
/// text/plain: in CSV, Markdown, HTML or source code, spacing and line
/// breaks are content, and the exact fingerprint is the only honest one.
pub fn is_plain_text(media_type: &str) -> bool {
    media_type.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("text/plain")
}
