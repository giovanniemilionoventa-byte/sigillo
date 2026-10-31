import { createHash } from "node:crypto";

/**
 * sigillo-text/1: a text document's fingerprint, whatever its spacing. A port
 * of packages/core/src/text.ts (the reference), written with the same
 * character lists; test/content.test.ts runs every vector of
 * packages/core/test/text-vectors.json through it.
 */
export const TEXT_CANON_1 = "sigillo-text/1";

/** The document's text under sigillo-text/1, or null: bytes that are not UTF-8, or nothing left but whitespace. */
export function canonicalText(data: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return null;
  }
  const canonical = text
    .replace(/[\u00AD\u200B\u2060\uFEFF]/g, "")
    .normalize("NFC")
    .replace(/[\u0009-\u000D \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g, " ")
    .replace(/^ | $/g, "");
  return canonical.length === 0 ? null : canonical;
}

export function textSha256(data: Uint8Array): string | null {
  const text = canonicalText(data);
  return text === null ? null : createHash("sha256").update(text, "utf8").digest("hex");
}

/** Only text/plain gets a text fingerprint: in CSV, Markdown or source code, spacing is content. */
export function isPlainText(mediaType: string): boolean {
  return (mediaType.split(";", 1)[0] ?? "").trim().toLowerCase() === "text/plain";
}
