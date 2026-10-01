import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { safeParseReceipt } from "@sigillo/core";

/**
 * Receipts that must be refused, shared with scripts/crosscheck_vectors.py so
 * that the Python reading of docs/FORMAT.md and packages/core agree on what is
 * not a receipt as well as on what is.
 */

interface Case {
  name: string;
  base: string;
  set?: Record<string, unknown>;
  remove?: string[];
}

const read = (name: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8"));
const { vectors } = read("./vectors.json") as { vectors: { name: string; receipt: Record<string, unknown> }[] };
const { cases } = read("./invalid-vectors.json") as { cases: Case[] };

function build(entry: Case): Record<string, unknown> {
  const base = vectors.find((vector) => vector.name === entry.base);
  if (base === undefined) throw new Error(`${entry.name}: no vector named ${entry.base}`);
  const receipt: Record<string, unknown> = { ...base.receipt, ...(entry.set ?? {}) };
  for (const key of entry.remove ?? []) delete receipt[key];
  return receipt;
}

describe("invalid receipt vectors", () => {
  it("cover every rule version 4 adds", () => {
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });

  for (const entry of cases) {
    it(`refuses ${entry.name}`, () => {
      expect(safeParseReceipt(build(entry)).ok).toBe(false);
    });
  }

  it("start from receipts that are valid, so each refusal is the case's own", () => {
    for (const entry of cases) {
      const base = vectors.find((vector) => vector.name === entry.base);
      expect(safeParseReceipt(base?.receipt).ok, entry.base).toBe(true);
    }
  });
});
