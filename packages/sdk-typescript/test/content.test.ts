import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalText as coreCanonicalText, hashCanonicalJson, saltedDigest, textSha256 as coreTextSha256 } from "@sigillo/core";
import { hashContentValue, nonceFor, pseudonym, saltedHashContentValue } from "../src/content.js";
import { canonicalText, isPlainText, textSha256 } from "../src/text.js";

/**
 * The digests this package makes must be the ones the server and the verifier
 * expect, bit for bit, with the real node:crypto and the real core: nothing is
 * mocked. Each is held to packages/core (the reference) and, where core has no
 * counterpart, to an independent Python computation.
 */

const vectors = JSON.parse(readFileSync(new URL("../../core/test/text-vectors.json", import.meta.url), "utf8")) as {
  vectors: Array<{ name: string; input_hex: string; canonical: string | null; sha256: string | null }>;
};

describe("content digests", () => {
  it("hashes a string as core hashes its canonical JSON form", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }).map((s) => s.toWellFormed()), (value) => {
        expect(hashContentValue(value)).toBe(hashCanonicalJson(value));
      }),
      { numRuns: 2000 },
    );
  });

  it("salts a digest as core defines it", () => {
    const nonce = Buffer.alloc(32, 7);
    expect(saltedHashContentValue("score: 7", nonce)).toBe(saltedDigest(nonce, "score: 7"));
  });

  it("derives the customer nonce exactly as an independent implementation does", () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "00f067aa0ba902b7";
    const script =
      "import hmac,hashlib,sys;k,t,s,r=sys.argv[1:];print(hmac.new(k.encode(),f'sigillo-nonce-v1\\n{t}\\n{s}\\n{r}'.encode('ascii'),hashlib.sha256).hexdigest())";
    for (const role of ["input", "output"] as const) {
      const expected = execFileSync("python3", ["-I", "-c", script, "a secret", traceId, spanId, role], { encoding: "utf8" }).trim();
      expect(nonceFor("a secret", traceId, spanId, role)).toBe(expected);
    }
    expect(() => nonceFor("", traceId, spanId, "input")).toThrow();
    expect(() => nonceFor("k", "short", spanId, "input")).toThrow();
  });

  it("makes the same pseudonym as the Python SDK's rule, and a different key gives another", () => {
    const script = "import hmac,hashlib,sys;print('p:'+hmac.new(sys.argv[2].encode(),sys.argv[1].encode(),hashlib.sha256).hexdigest()[:32])";
    const expected = execFileSync("python3", ["-I", "-c", script, "elena.rizzo", "key one"], { encoding: "utf8" }).trim();
    expect(pseudonym("elena.rizzo", "key one")).toBe(expected);
    expect(pseudonym("elena.rizzo", "key two")).not.toBe(expected);
    expect(pseudonym("elena.rizzo", "key one")).toMatch(/^p:[0-9a-f]{32}$/);
  });
});

describe("sigillo-text/1", () => {
  it("agrees with every vector of the reference", () => {
    for (const vector of vectors.vectors) {
      const bytes = Buffer.from(vector.input_hex, "hex");
      expect(canonicalText(bytes), vector.name).toBe(vector.canonical);
      expect(textSha256(bytes), vector.name).toBe(vector.sha256);
    }
  });

  it("agrees with core on random text", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (value) => {
        const bytes = new TextEncoder().encode(value);
        expect(canonicalText(bytes)).toBe(coreCanonicalText(bytes));
        expect(textSha256(bytes)).toBe(coreTextSha256(bytes));
      }),
      { numRuns: 2000 },
    );
  });

  it("gives a fingerprint to text/plain only", () => {
    expect(isPlainText("text/plain; charset=utf-8")).toBe(true);
    expect(isPlainText("text/csv")).toBe(false);
  });
});
