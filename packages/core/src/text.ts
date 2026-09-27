import { sha256Hex } from "./canonical.js";

/**
 * The text canonicalization rule an artifact's `text` member names (FORMAT.md
 * section 2.5.1). A different rule would be a different name and a new receipt
 * version, never a change to this one.
 */
export const TEXT_CANON_1 = "sigillo-text/1" as const;

/**
 * The rule itself, as JavaScript source text. This is the only copy: Node
 * evaluates it once, below, and the "verifica un documento" page inlines the
 * same characters in its script, so the browser runs this code and not a
 * rewrite of it. It is kept as source text, rather than a function whose
 * `toString()` is sent, because tsc and the test runner print a function
 * differently: the page's CSP allows its script by SHA-256, and those bytes
 * must be the same in the tests and in the built server.
 *
 * Plain ES5, plain ASCII, no dependencies but TextDecoder and TextEncoder, which
 * both Node and every browser provide. core/test/text.test.ts runs it in an
 * empty context against every vector to hold it to that.
 *
 * The Python SDK cannot run this, so it carries a port
 * (sdk-python/src/sigillo/_text.py), bound to this one by the shared vectors
 * and by a test that runs this code in Node on random strings.
 */
export const DOCUMENT_TEXT_SOURCE = String.raw`function sigilloDecodeUtf8(bytes) {
  // Strict: bytes that are not UTF-8 are not a text. ignoreBOM keeps a
  // leading U+FEFF in the result instead of dropping it silently.
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    return null;
  }
}

function sigilloCanonicalText(bytes) {
  var text = sigilloDecodeUtf8(bytes);
  if (text === null) return null;
  var canonical = text
    // 1. soft hyphen, zero-width space, word joiner, byte order mark
    .replace(/[\u00AD\u200B\u2060\uFEFF]/g, "")
    // 2. NFC, never NFKC: m\u00B2 is not m2
    .normalize("NFC")
    // 3. every run of White_Space, listed in full, becomes one space
    .replace(/[\u0009-\u000D \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, " ")
    // 4. no space at either end
    .replace(/^ | $/g, "");
  return canonical.length === 0 ? null : canonical;
}

function sigilloLineEndingVariants(bytes) {
  // The same text with LF or CRLF, with or without one final newline, with
  // or without a leading byte order mark: what a record made from the raw
  // bytes of a text file may differ by and still be the same file. The input
  // itself is left out.
  var text = sigilloDecodeUtf8(bytes);
  if (text === null) return [];
  var body = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  var original = Array.prototype.join.call(bytes, ",");
  var seen = {};
  var variants = [];
  var tails = ["", "\n"];
  var boms = ["", "\uFEFF"];
  for (var t = 0; t < tails.length; t += 1) {
    for (var crlf = 0; crlf < 2; crlf += 1) {
      for (var b = 0; b < boms.length; b += 1) {
        var lines = body + tails[t];
        if (crlf === 1) lines = lines.replace(/\n/g, "\r\n");
        var encoded = new TextEncoder().encode(boms[b] + lines);
        var key = Array.prototype.join.call(encoded, ",");
        if (key === original || seen[key]) continue;
        seen[key] = true;
        variants.push(encoded);
      }
    }
  }
  return variants;
}

function sigilloFingerprintInputs(bytes) {
  // Every byte string whose SHA-256 a document lookup searches for, and what
  // a match on it means. The caller hashes; this only decides what.
  var inputs = [{ kind: "bytes", data: bytes }];
  var canonical = sigilloCanonicalText(bytes);
  if (canonical !== null) inputs.push({ kind: "text", data: new TextEncoder().encode(canonical) });
  var variants = sigilloLineEndingVariants(bytes);
  for (var i = 0; i < variants.length; i += 1) inputs.push({ kind: "lines", data: variants[i] });
  // input_hash and output_hash are SHA-256 of a value's RFC 8785 form; for
  // a string that is exactly JSON.stringify.
  var text = sigilloDecodeUtf8(bytes);
  if (text !== null && text.length > 0) {
    inputs.push({ kind: "json", data: new TextEncoder().encode(JSON.stringify(text)) });
    for (var j = 0; j < variants.length; j += 1) {
      inputs.push({ kind: "json-lines", data: new TextEncoder().encode(JSON.stringify(sigilloDecodeUtf8(variants[j]))) });
    }
  }
  return inputs;
}`;

export type FingerprintKind = "bytes" | "text" | "lines" | "json" | "json-lines";

interface DocumentTextFunctions {
  decodeUtf8: (bytes: Uint8Array) => string | null;
  canonicalText: (bytes: Uint8Array) => string | null;
  lineEndingVariants: (bytes: Uint8Array) => Uint8Array[];
  fingerprintInputs: (bytes: Uint8Array) => { kind: FingerprintKind; data: Uint8Array }[];
}

// Evaluated once, at import. The text is a constant of this module, never
// input: this is how one copy of the rule runs both here and in the browser.
const shared = new Function(
  `${DOCUMENT_TEXT_SOURCE}
return {
  decodeUtf8: sigilloDecodeUtf8,
  canonicalText: sigilloCanonicalText,
  lineEndingVariants: sigilloLineEndingVariants,
  fingerprintInputs: sigilloFingerprintInputs,
};`,
)() as DocumentTextFunctions;

/** A document's text under `sigillo-text/1`, or `null` when it has none (not UTF-8, or empty). */
export function canonicalText(bytes: Uint8Array): string | null {
  return shared.canonicalText(bytes);
}

/** SHA-256 of the canonical text's UTF-8 bytes, lowercase hex; `null` when there is no text. */
export function textSha256(bytes: Uint8Array): string | null {
  const canonical = shared.canonicalText(bytes);
  return canonical === null ? null : sha256Hex(new TextEncoder().encode(canonical));
}

/** See `sigilloLineEndingVariants` in DOCUMENT_TEXT_SOURCE. */
export function lineEndingVariants(bytes: Uint8Array): Uint8Array[] {
  return shared.lineEndingVariants(bytes);
}

export interface DocumentFingerprints {
  /** SHA-256 of the exact bytes: an artifact's `sha256`, in every receipt version. */
  bytes: string;
  /** `sigillo-text/1`: an artifact's `text.sha256` (version 3). */
  text: string | null;
  /** The exact-bytes digest of each line-ending variant, for records made before `text` existed. */
  lines: string[];
  /** The document's text as a JSON string: what `input_hash` or `output_hash` would be. */
  json: string | null;
  jsonLines: string[];
}

/** Every digest a document lookup searches for, computed from the one set of inputs the browser uses too. */
export function documentFingerprints(bytes: Uint8Array): DocumentFingerprints {
  const fingerprints: DocumentFingerprints = { bytes: "", text: null, lines: [], json: null, jsonLines: [] };
  for (const input of shared.fingerprintInputs(bytes)) {
    const digest = sha256Hex(input.data);
    if (input.kind === "bytes") fingerprints.bytes = digest;
    else if (input.kind === "text") fingerprints.text = digest;
    else if (input.kind === "lines") fingerprints.lines.push(digest);
    else if (input.kind === "json") fingerprints.json = digest;
    else fingerprints.jsonLines.push(digest);
  }
  return fingerprints;
}
