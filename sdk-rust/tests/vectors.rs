//! The crate's digests, held to the repository's shared vectors and to an
//! independent implementation.
//!
//! - every string vector of `salted_digests` in packages/core/test/vectors.json
//!   and every vector of packages/core/test/text-vectors.json, the same files
//!   the server, the verifier and the Python SDK are held to;
//! - fixed vectors for `nonce_for` and `pseudonym`, written from Python's
//!   `hmac` and `hashlib`;
//! - thousands of random strings, drawn from the characters where JSON
//!   escaping and Unicode are easiest to get wrong, digested here and by
//!   Python's standard library (`json.dumps(ensure_ascii=False)`, `hashlib`,
//!   `hmac`) one by one, when `python3` is on the PATH.
//!
//! No primitive is mocked: SHA-256 and HMAC are ring's here and hashlib's there.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use serde_json::Value;
use sigillo::digest::{canonical_string, plain_digest, salted_digest, sha256_hex};
use sigillo::text::{canonical_text, text_sha256};
use sigillo::{nonce_for, pseudonym, Role};

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn read_json(relative: &str) -> Value {
    let text = std::fs::read_to_string(repository().join(relative)).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap()).collect()
}

#[test]
fn salted_digests_match_the_shared_vectors() {
    let vectors = read_json("packages/core/test/vectors.json");
    let mut checked = 0;
    for vector in vectors["salted_digests"].as_array().unwrap() {
        // The crate digests strings, as the Python SDK does; the other values are the server's.
        let Some(value) = vector["value"].as_str() else { continue };
        let nonce: [u8; 32] = bytes(vector["nonce_hex"].as_str().unwrap()).try_into().unwrap();
        assert_eq!(salted_digest(value, &nonce), vector["digest"].as_str().unwrap(), "{}", vector["name"]);
        checked += 1;
    }
    assert!(checked >= 2, "the vectors file holds string values");
}

#[test]
fn the_documented_example_of_format_md() {
    // docs/FORMAT.md, 2.7: the bytes 0 to 31 and "score: 7".
    let nonce: [u8; 32] = std::array::from_fn(|index| index as u8);
    assert_eq!(salted_digest("score: 7", &nonce), "0de84395a90cb98f917231a13f03446f21af13e0c18d18f073f32417d119e0ac");
    assert_eq!(plain_digest("score: 7"), "ee57ba52c06d0f98e05f7685c4993b57a3290eacc5432af9c8fcf18924c12764");
}

#[test]
fn text_fingerprints_match_the_shared_vectors() {
    let vectors = read_json("packages/core/test/text-vectors.json");
    let list = vectors["vectors"].as_array().unwrap();
    assert!(list.len() >= 40);
    for vector in list {
        let input = bytes(vector["input_hex"].as_str().unwrap());
        let name = vector["name"].as_str().unwrap();
        assert_eq!(canonical_text(&input).as_deref(), vector["canonical"].as_str(), "{name}");
        assert_eq!(text_sha256(&input).as_deref(), vector["sha256"].as_str(), "{name}");
    }
}

#[test]
fn the_text_example_of_format_md() {
    assert_eq!(sha256_hex(b"Ciao,\r\nmondo.\r\n"), "fef8e3961a0d8b0aab3979406edacec21b767ac0e0c47fed7a0a6ad01f8ec615");
    assert_eq!(text_sha256(b"Ciao,\r\nmondo.\r\n").unwrap(), "54a58d6fbf86b8113c5183a32142c3069884460d0ec47b4ee7e435dfd5b23319");
    assert_eq!(text_sha256(b"Ciao,  mondo."), text_sha256(b"Ciao,\nmondo.\n"));
}

#[test]
fn the_customer_nonce_is_hmac_sha256_of_the_action_and_role() {
    let (trace, span) = ("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b8");
    let key = b"chiave-del-cliente";
    assert_eq!(nonce_for(key, trace, span, Role::Input).unwrap(), "a950a591a169a8d50c44e1c2cb777c8fb99f7f53e90e006f6c417dc5aed0758d");
    assert_eq!(nonce_for(key, trace, span, Role::Output).unwrap(), "f6a609fc3bdb58349e6cb54047c934003462d56d71e1dbc005fe3f23e5e1947e");
    assert!(nonce_for(b"", trace, span, Role::Input).is_err());
    assert!(nonce_for(key, "4BF92F3577B34DA6A3CE929D0E0E4736", span, Role::Input).is_err());
    assert!(nonce_for(key, trace, "00f067aa0ba902b", Role::Input).is_err());
}

#[test]
fn a_pseudonym_is_a_truncated_hmac() {
    assert_eq!(pseudonym("mario.rossi@example.com", b"chiave").unwrap(), "p:023ca55f92112c68b5df69dd4b4d343d");
    assert!(pseudonym("x", b"").is_err());
}

#[test]
fn json_strings_are_written_as_rfc_8785_writes_them() {
    assert_eq!(canonical_string("a\"b\\c"), r#""a\"b\\c""#);
    assert_eq!(canonical_string("\u{8}\t\n\u{c}\r"), r#""\b\t\n\f\r""#);
    assert_eq!(canonical_string("\u{1}\u{1f}\u{7f}"), "\"\\u0001\\u001f\u{7f}\"");
    assert_eq!(canonical_string("è ✓ \u{2028} 😀"), "\"è ✓ \u{2028} 😀\"");
}

/// A small deterministic generator: the test is the same on every run.
struct Draw(u64);

impl Draw {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn random_strings(count: usize) -> Vec<String> {
    let mut alphabet: Vec<char> = "\t\n\u{b}\u{c}\r \u{85}\u{a0}\u{1680}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{1c}\u{1d}\u{1e}\u{1f}\u{180e}\u{ad}\u{200b}\u{2060}\u{feff}\u{200c}\u{200d}\u{202a}\u{202e}\u{2066}\u{fe0f}\u{301}\u{308}\u{327}eEaAoOuUcC\u{e9}\u{c5}\u{212b}\u{1e9b}\u{b2}\u{bd}\u{fb01}\u{ff11}😀👍🏽\"\\/\u{0}\u{1}\u{8}\u{7f}xyz019.,;:-_'"
        .chars()
        .collect();
    alphabet.extend((0x2000..0x200b).filter_map(char::from_u32));
    let mut draw = Draw(0x5eed_1234_abcd_0001);
    (0..count)
        .map(|_| {
            let length = (draw.next() % 24) as usize;
            (0..length).map(|_| alphabet[(draw.next() % alphabet.len() as u64) as usize]).collect()
        })
        .collect()
}

#[test]
fn digests_agree_with_python_on_random_strings() {
    if Command::new("python3").arg("--version").output().is_err() {
        eprintln!("python3 is not on the PATH: the independent cross-check is skipped");
        return;
    }
    let strings = random_strings(3000);
    let nonce: [u8; 32] = std::array::from_fn(|index| (index * 7 + 3) as u8);
    let key = b"chiave del cliente";
    let script = r#"
import hashlib, hmac, json, sys, unicodedata
nonce = bytes((i * 7 + 3) % 256 for i in range(32))
key = b"chiave del cliente"
for line in sys.stdin:
    value = bytes.fromhex(line.strip()).decode("utf-8")
    canonical = json.dumps(value, ensure_ascii=False).encode("utf-8")
    plain = hashlib.sha256(canonical).hexdigest()
    salted = hashlib.sha256(nonce + canonical).hexdigest()
    alias = "p:" + hmac.new(key, value.encode("utf-8"), hashlib.sha256).hexdigest()[:32]
    print(canonical.hex(), plain, salted, alias)
"#;
    let mut child = Command::new("python3")
        .args(["-I", "-c", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let input: String = strings.iter().map(|value| format!("{}\n", hex(value.as_bytes()))).collect();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()).unwrap());
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();
    assert!(output.status.success());
    let lines: Vec<String> = String::from_utf8(output.stdout).unwrap().lines().map(str::to_string).collect();
    assert_eq!(lines.len(), strings.len());
    for (value, line) in strings.iter().zip(&lines) {
        let expected: Vec<&str> = line.split(' ').collect();
        assert_eq!(hex(canonical_string(value).as_bytes()), expected[0], "canonical form of {value:?}");
        assert_eq!(plain_digest(value), expected[1], "plain digest of {value:?}");
        assert_eq!(salted_digest(value, &nonce), expected[2], "salted digest of {value:?}");
        assert_eq!(pseudonym(value, key).unwrap(), expected[3], "pseudonym of {value:?}");
    }
}

#[test]
fn text_fingerprints_agree_with_python_on_random_strings() {
    if Command::new("python3").arg("--version").output().is_err() {
        eprintln!("python3 is not on the PATH: the independent cross-check is skipped");
        return;
    }
    // The rule written out again here, from docs/FORMAT.md 2.5.1, with the
    // Unicode tables of Python's unicodedata: a second port, not the SDK's.
    let script = r#"
import hashlib, re, sys, unicodedata
removed = re.compile("[­​⁠﻿]")
white = re.compile("[\u0009-\u000d \u0085   -     　]+")
for line in sys.stdin:
    data = bytes.fromhex(line.strip())
    text = unicodedata.normalize("NFC", removed.sub("", data.decode("utf-8")))
    text = white.sub(" ", text).strip(" ")
    print(hashlib.sha256(text.encode("utf-8")).hexdigest() if text else "-")
"#;
    let strings = random_strings(3000);
    let mut child = Command::new("python3").args(["-I", "-c", script]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let input: String = strings.iter().map(|value| format!("{}\n", hex(value.as_bytes()))).collect();
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()).unwrap());
    let output = child.wait_with_output().unwrap();
    writer.join().unwrap();
    assert!(output.status.success());
    let lines: Vec<String> = String::from_utf8(output.stdout).unwrap().lines().map(str::to_string).collect();
    assert_eq!(lines.len(), strings.len());
    for (value, line) in strings.iter().zip(&lines) {
        let expected = if line == "-" { None } else { Some(line.as_str()) };
        assert_eq!(text_sha256(value.as_bytes()).as_deref(), expected, "text fingerprint of {value:?}");
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
