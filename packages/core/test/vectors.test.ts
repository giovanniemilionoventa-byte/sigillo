import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalReceiptBytes, receiptHashHex, safeParseReceipt } from "@sigillo/core";

interface Vector {
  name: string;
  comment: string;
  receipt: unknown;
  canonical: string;
  hash: string;
}

interface VectorFile {
  format: string;
  receipt_versions: number[];
  vectors: Vector[];
}

const vectorFile = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors.json", import.meta.url)), "utf8"),
) as VectorFile;

describe("receipt test vectors", () => {
  it("covers at least ten receipts", () => {
    expect(vectorFile.vectors.length).toBeGreaterThanOrEqual(10);
  });

  it("declares exactly the versions the vectors actually contain, including both v1 and v2", () => {
    const actual = [
      ...new Set(vectorFile.vectors.map((vector) => (vector.receipt as { v: number }).v)),
    ].sort();
    expect(vectorFile.receipt_versions).toEqual(actual);
    expect(actual).toEqual([1, 2]);
  });

  it("gives every vector a unique name and a unique hash", () => {
    const names = new Set(vectorFile.vectors.map((vector) => vector.name));
    const hashes = new Set(vectorFile.vectors.map((vector) => vector.hash));
    expect(names.size).toBe(vectorFile.vectors.length);
    expect(hashes.size).toBe(vectorFile.vectors.length);
  });

  for (const vector of vectorFile.vectors) {
    describe(vector.name, () => {
      it("is a valid receipt", () => {
        const result = safeParseReceipt(vector.receipt);
        expect(result.ok ? "" : result.error).toBe("");
      });

      it("canonicalises to the recorded form", () => {
        const canonical = new TextDecoder().decode(
          canonicalReceiptBytes(vector.receipt as Parameters<typeof canonicalReceiptBytes>[0]),
        );
        expect(canonical).toBe(vector.canonical);
      });

      it("hashes to the recorded digest", () => {
        expect(receiptHashHex(vector.receipt as Parameters<typeof receiptHashHex>[0])).toBe(
          vector.hash,
        );
      });

      it("records a canonical form that is itself valid JSON for the same receipt", () => {
        const { sig: _sig, ...unsigned } = vector.receipt as Record<string, unknown>;
        expect(JSON.parse(vector.canonical)).toEqual(unsigned);
      });
    });
  }
});
