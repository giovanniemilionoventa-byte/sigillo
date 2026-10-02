import { isPseudonym, type OpeningEntry, type SubjectEntry } from "@sigillo/core";
import type { ReceiptStore } from "../storage/store.js";
import { buildArchive, type BuiltArchive } from "./archive.js";

/** What the operator asked an export for: a window, and what to disclose beyond the receipts. */
export interface ExportRequest {
  range?: { from?: string; to?: string };
  /** Pseudonym tokens whose identifier the export should carry (subjects.jsonl). */
  subjects?: readonly string[];
  /** Positions whose salted digests' nonces the export should carry (openings.jsonl). */
  openings?: readonly number[];
  exportedAt: string;
}

/**
 * The archive of a system's chain, as the web view and the command line both
 * build it. Only what was asked for is disclosed, and only what the database
 * still holds: an erased subject or nonce is simply not there to disclose.
 */
export async function archiveFromStore(store: ReceiptStore, systemId: string, request: ExportRequest): Promise<BuiltArchive> {
  const range = request.range ?? {};
  const receipts =
    range.from === undefined && range.to === undefined
      ? store.readChain(systemId)
      : store.readChainInRange(systemId, range.from, range.to);

  const subjects: SubjectEntry[] = [];
  for (const token of new Set(request.subjects ?? [])) {
    // Only a person this system's chain acted on behalf of: a token from
    // another chain is not this export's to name.
    const identifier = isPseudonym(token) ? store.subjectIdentifierIn(systemId, token) : null;
    if (identifier !== null) subjects.push({ token, identifier });
  }
  const openings: OpeningEntry[] = store.openingsOf(systemId, request.openings ?? []);

  return buildArchive({
    systemId,
    // The name as it is now: the archive keeps it, whatever it becomes later.
    displayName: store.systemRecord(systemId)?.display_name ?? null,
    receipts,
    checkpoints: store.readCheckpoints(systemId).map((stored) => ({
      stored,
      timestamps: store.readTimestamps(stored.id),
    })),
    chainLeaves: store.readReceiptHashes(systemId),
    // Every key the chain has been signed with, not only today's.
    keys: store.signingKeys(),
    exportedAt: request.exportedAt,
    disclose: { subjects, openings },
  });
}

/** Tokens out of free text (spaces, commas, new lines between them); anything else is ignored. */
export function tokensIn(text: unknown): string[] {
  return typeof text === "string" ? text.split(/[\s,;]+/).filter(isPseudonym) : [];
}

/** Positions out of free text: whole numbers, and ranges such as 4-9. */
export function positionsIn(text: unknown): number[] {
  if (typeof text !== "string") return [];
  const positions: number[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    const range = /^(\d{1,9})(?:-(\d{1,9}))?$/.exec(part);
    if (range === null) continue;
    const first = Number(range[1]);
    const last = range[2] === undefined ? first : Number(range[2]);
    for (let seq = first; seq <= last && positions.length < 100_000; seq += 1) positions.push(seq);
  }
  return positions;
}
