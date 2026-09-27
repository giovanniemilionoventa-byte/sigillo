import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalText,
  DOCUMENT_TEXT_SOURCE,
  documentFingerprints,
  fromHex,
  hashCanonicalJson,
  lineEndingVariants,
  TEXT_CANON_1,
  textSha256,
} from "@sigillo/core";

interface TextVector {
  name: string;
  input_hex: string;
  canonical: string | null;
  sha256: string | null;
}

const vectorFile = JSON.parse(
  readFileSync(new URL("./text-vectors.json", import.meta.url), "utf8"),
) as { canon: string; vectors: TextVector[] };

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const rawSha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
// ignoreBOM: a leading U+FEFF is part of what is compared, not dropped.
const decode = (bytes: Uint8Array): string => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);

// Every code point the rule treats as whitespace, and the four it removes,
// written out here independently of the implementation's own lists.
const WHITESPACE = [
  "\t", "\n", "\u000b", "\f", "\r", " ", "\u0085", "\u00a0", "\u1680",
  "\u2000", "\u2001", "\u2002", "\u2003", "\u2004", "\u2005", "\u2006", "\u2007", "\u2008", "\u2009", "\u200a",
  "\u2028", "\u2029", "\u202f", "\u205f", "\u3000",
];
const REMOVED = ["\u00ad", "\u200b", "\u2060", "\ufeff"];

describe("sigillo-text/1 vectors", () => {
  it("names the rule they were written for", () => {
    expect(vectorFile.canon).toBe(TEXT_CANON_1);
    expect(TEXT_CANON_1).toBe("sigillo-text/1");
  });

  for (const vector of vectorFile.vectors) {
    it(vector.name, () => {
      const bytes = fromHex(vector.input_hex);
      expect(canonicalText(bytes)).toBe(vector.canonical);
      expect(textSha256(bytes)).toBe(vector.sha256);
    });
  }

  it("the digest is SHA-256 of the canonical text's UTF-8 bytes, with no JSON quoting", () => {
    expect(textSha256(utf8("  Ciao\r\nmondo "))).toBe(rawSha256(utf8("Ciao mondo")));
    expect(textSha256(utf8("Ciao mondo"))).not.toBe(hashCanonicalJson("Ciao mondo"));
  });
});

describe("sigillo-text/1: what matches and what does not", () => {
  it("two texts that differ only in spacing and line breaks have the same fingerprint", () => {
    const a = "Contratto n. 42\r\n\r\nIl fornitore consegna 1 000 pezzi\tentro il 3 marzo.\r\n";
    const b = "  Contratto n. 42 Il fornitore\nconsegna 1\u00a0000   pezzi entro\nil 3 marzo.";
    expect(textSha256(utf8(a))).not.toBeNull();
    expect(textSha256(utf8(a))).toBe(textSha256(utf8(b)));
    expect(rawSha256(utf8(a))).not.toBe(rawSha256(utf8(b)));
  });

  it("two texts that differ in one digit, one letter, one case or one mark do not", () => {
    const base = "Il fornitore consegna 1000 pezzi entro il 3 marzo.";
    const changed = [
      "Il fornitore consegna 1001 pezzi entro il 3 marzo.",
      "Il fornitore consegna 1000 pezzi entro il 4 marzo.",
      "Il fornitore consegna 1000 pezzi entro il 3 marzi.",
      "il fornitore consegna 1000 pezzi entro il 3 marzo.",
      "Il fornitore consegna 1000 pezzi entro il 3 marzo!",
      "Il fornitore consegna 1000 pezzi entro il 3 marzo",
      "Il fornitore consegna 1 000 pezzi entro il 3 marzo.",
    ];
    const digests = new Set([base, ...changed].map((text) => textSha256(utf8(text))));
    expect(digests.size).toBe(changed.length + 1);
  });

  it("a binary file has no text fingerprint: only its exact bytes identify it", () => {
    const pdf = new Uint8Array([
      ...utf8("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, ...utf8("\n1 0 obj\n<<>>\nendobj\n%%EOF\n"),
    ]);
    const png = fromHex("89504e470d0a1a0a0000000d494844520000000100000001");
    for (const binary of [pdf, png]) {
      expect(canonicalText(binary)).toBeNull();
      expect(textSha256(binary)).toBeNull();
      const fingerprints = documentFingerprints(binary);
      expect(fingerprints).toEqual({ bytes: rawSha256(binary), text: null, lines: [], json: null, jsonLines: [] });
    }
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme-composite" }), (text) => {
        const once = canonicalText(utf8(text));
        if (once === null) return;
        expect(canonicalText(utf8(once))).toBe(once);
      }),
    );
  });

  it("any run of listed whitespace between two words is the same as one space", () => {
    const word = fc.stringMatching(/^[a-zA-Z0-9àèéìòù.,;:!?'"-]{1,12}$/);
    const run = fc.array(fc.constantFrom(...WHITESPACE), { minLength: 1, maxLength: 6 }).map((a) => a.join(""));
    fc.assert(
      fc.property(word, run, word, (left, spaces, right) => {
        expect(textSha256(utf8(left + spaces + right))).toBe(textSha256(utf8(`${left} ${right}`)));
      }),
    );
  });

  it("the four removed characters never change the fingerprint, wherever they are", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.nat(), fc.constantFrom(...REMOVED), (text, at, invisible) => {
        const position = at % (text.length + 1);
        // Inserting inside a surrogate pair would make invalid UTF-16, not a text.
        fc.pre(!/[\ud800-\udbff]/.test(text.charAt(position - 1)));
        const withInvisible = text.slice(0, position) + invisible + text.slice(position);
        expect(textSha256(utf8(withInvisible))).toBe(textSha256(utf8(text)));
      }),
    );
  });

  it("replacing one visible ASCII character with another always changes the fingerprint", () => {
    const visible = fc.stringMatching(/^[!-~]$/);
    fc.assert(
      fc.property(fc.stringMatching(/^[!-~]{1,40}$/), fc.nat(), visible, (text, at, replacement) => {
        const position = at % text.length;
        fc.pre(text[position] !== replacement);
        const changed = text.slice(0, position) + replacement + text.slice(position + 1);
        expect(textSha256(utf8(changed))).not.toBe(textSha256(utf8(text)));
      }),
    );
  });
});

describe("lineEndingVariants (legacy lookup, decision D5)", () => {
  it("offers the same text with LF and CRLF, with and without a final newline and a BOM", () => {
    const variants = lineEndingVariants(utf8("a\r\nb\r\n")).map(decode);
    expect(variants).toContain("a\nb\n");
    expect(variants).toContain("a\nb");
    expect(variants).toContain("a\r\nb");
    expect(variants).toContain("\ufeffa\nb\n");
    expect(variants).toContain("\ufeffa\r\nb\r\n");
    expect(variants).not.toContain("a\r\nb\r\n");
    expect(variants.length).toBe(7);
  });

  it("never changes anything but line endings, the final newline and a leading BOM", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (generated) => {
        // A lone surrogate has no UTF-8 form: compare with what was encoded.
        const text = decode(utf8(generated));
        for (const variant of lineEndingVariants(utf8(text))) {
          const strip = (value: string): string => value.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
          expect(strip(new TextDecoder("utf-8", { ignoreBOM: true }).decode(variant))).toBe(strip(text));
        }
      }),
    );
  });

  it("has no variants for bytes that are not UTF-8", () => {
    expect(lineEndingVariants(new Uint8Array([0xff, 0x0a, 0x0d]))).toEqual([]);
  });
});

describe("documentFingerprints", () => {
  it("computes every digest a lookup needs, from the same bytes", () => {
    const bytes = utf8("Ciao,\r\nmondo.\r\n");
    const fingerprints = documentFingerprints(bytes);
    expect(fingerprints.bytes).toBe(rawSha256(bytes));
    expect(fingerprints.text).toBe(rawSha256(utf8("Ciao, mondo.")));
    expect(fingerprints.lines).toContain(rawSha256(utf8("Ciao,\nmondo.\n")));
    expect(fingerprints.json).toBe(hashCanonicalJson("Ciao,\r\nmondo.\r\n"));
    expect(fingerprints.jsonLines).toContain(hashCanonicalJson("Ciao,\nmondo.\n"));
    expect(fingerprints.jsonLines).toContain(hashCanonicalJson("Ciao,\nmondo."));
  });

  it("has no JSON digest for an empty document", () => {
    expect(documentFingerprints(new Uint8Array()).json).toBeNull();
  });
});

describe("DOCUMENT_TEXT_SOURCE: the one copy the browser also runs", () => {
  it("is self-contained: evaluated with nothing but TextDecoder and TextEncoder, it gives every vector", () => {
    const sandbox: Record<string, unknown> = { TextDecoder, TextEncoder };
    runInNewContext(`${DOCUMENT_TEXT_SOURCE}\nthis.found = sigilloCanonicalText;`, sandbox);
    const inSandbox = sandbox["found"] as (bytes: Uint8Array) => string | null;
    for (const vector of vectorFile.vectors) {
      expect(inSandbox(fromHex(vector.input_hex)), vector.name).toBe(vector.canonical);
    }
  });

  it("can be inlined in an HTML <script> and in a template literal unchanged", () => {
    expect(DOCUMENT_TEXT_SOURCE).not.toMatch(/<\/script|<!--|`|\$\{/i);
    // Plain ASCII: its bytes, and therefore the CSP hash of any script that
    // embeds it, cannot depend on how a file or a build tool encodes it.
    expect(DOCUMENT_TEXT_SOURCE).toMatch(/^[\x09\x0a\x20-\x7e]*$/);
  });
});
