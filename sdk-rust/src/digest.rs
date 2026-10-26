//! The digests an input or an output becomes before it leaves the process.
//!
//! The same functions as the Python SDK's, byte for byte, held to the same
//! vectors (`tests/vectors.rs`):
//!
//! - `plain`: SHA-256 of the RFC 8785 canonical JSON of the value;
//! - `salted`: SHA-256 of a 32-byte nonce followed by those same bytes
//!   (docs/FORMAT.md, section 2.7), the nonce drawn afresh every time or made
//!   from the customer's own key (`nonce_for`).
//!
//! Values are strings, as in the Python SDK, where an input or an output is
//! the text an instrumentation attached. The canonical JSON of a string is the
//! string in quotes with only `"`, `\` and the control characters escaped
//! (RFC 8785, section 3.2.2.2), and every other character as its UTF-8 bytes.

use ring::{digest, hmac, rand::SecureRandom};

use crate::Error;

/// The two roles a digest can have on a receipt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Input,
    Output,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Input => "input",
            Role::Output => "output",
        }
    }
}

/// The RFC 8785 canonical JSON of a string: exactly what `json.dumps(value,
/// ensure_ascii=False)` writes in Python and `JSON.stringify(value)` in
/// JavaScript. Also used to write every JSON string this crate sends.
pub fn canonical_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{09}' => out.push_str("\\t"),
            '\u{0a}' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\u{0d}' => out.push_str("\\r"),
            control if (control as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", control as u32)),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// SHA-256 of `bytes`, as 64 lowercase hex characters.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, bytes).as_ref())
}

/// The `plain` digest of a string value.
pub fn plain_digest(value: &str) -> String {
    sha256_hex(canonical_string(value).as_bytes())
}

/// The `salted` digest of a string value under a 32-byte nonce.
pub fn salted_digest(value: &str, nonce: &[u8; 32]) -> String {
    let mut context = digest::Context::new(&digest::SHA256);
    context.update(nonce);
    context.update(canonical_string(value).as_bytes());
    hex(context.finish().as_ref())
}

/// The nonce a digest was salted under, when `init` had a customer key: 64
/// hex characters, to give the verifier as `--nonce` together with the
/// content. HMAC-SHA256(`customer_key`, "sigillo-nonce-v1\n" + trace_id +
/// "\n" + span_id + "\n" + role), exactly as the Python SDK's `nonce_for`.
///
/// The key never leaves the customer's process, and neither does the nonce:
/// sigillo receives the digest only.
pub fn nonce_for(customer_key: &[u8], trace_id: &str, span_id: &str, role: Role) -> Result<String, Error> {
    if customer_key.is_empty() {
        return Err(Error::Config("customer_key must not be empty".into()));
    }
    if !is_lower_hex(trace_id, 32) || !is_lower_hex(span_id, 16) {
        return Err(Error::Config(
            "trace_id and span_id are 32 and 16 lowercase hex characters, as in the receipt's source".into(),
        ));
    }
    let message = format!("sigillo-nonce-v1\n{trace_id}\n{span_id}\n{}", role.as_str());
    let key = hmac::Key::new(hmac::HMAC_SHA256, customer_key);
    Ok(hex(hmac::sign(&key, message.as_bytes()).as_ref()))
}

/// An opaque stand-in for `value`, to pass as the person an action is for in
/// place of the identifier itself: HMAC-SHA256(`key`, `value`), truncated to
/// 32 hex characters and prefixed `p:`, as the Python SDK's `pseudonym`. The
/// key never leaves this process.
pub fn pseudonym(value: &str, key: &[u8]) -> Result<String, Error> {
    if key.is_empty() {
        return Err(Error::Config("key must not be empty".into()));
    }
    let key = hmac::Key::new(hmac::HMAC_SHA256, key);
    let tag = hex(hmac::sign(&key, value.as_bytes()).as_ref());
    Ok(format!("p:{}", &tag[..32]))
}

/// `N` bytes from the operating system's secure random source.
pub(crate) fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .expect("the operating system's random source failed");
    bytes
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

pub(crate) fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
        .collect()
}

pub(crate) fn is_lower_hex(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
