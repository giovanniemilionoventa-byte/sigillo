import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson,
  RECEIPT_VERSION,
  SIGILLO_VERSION,
  type Manifest,
  type ManifestKey,
  type Receipt,
} from "@sigillo/core";
import type { ReceiptStore } from "../storage/store.js";

/**
 * The minimal export: the receipts of one chain and the manifest that names the
 * keys they were signed with. The archive with checkpoints, timestamp tokens and
 * the report is built on top of this.
 */

export interface ExportBundle {
  manifestJson: string;
  receiptsJsonl: string;
}

export interface ExportOptions {
  systemId: string;
  keys: ManifestKey[];
  exportedAt: string;
}

export function buildExportBundle(receipts: Receipt[], options: ExportOptions): ExportBundle {
  const first = receipts[0];
  const last = receipts[receipts.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`system ${options.systemId} has no receipts to export`);
  }

  const manifest: Manifest = {
    sigillo_version: SIGILLO_VERSION,
    receipt_version: RECEIPT_VERSION,
    system_id: options.systemId,
    exported_at: options.exportedAt,
    range: {
      from_seq: first.seq,
      to_seq: last.seq,
      from_ts: first.ts_received,
      to_ts: last.ts_received,
    },
    counts: { receipts: receipts.length },
    keys: options.keys,
  };

  return {
    manifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    // Canonical form on the wire too, so the file is byte-for-byte reproducible.
    receiptsJsonl: receipts.map((receipt) => `${canonicalJson(receipt)}\n`).join(""),
  };
}

export function exportSystem(store: ReceiptStore, options: ExportOptions): ExportBundle {
  return buildExportBundle(store.readChain(options.systemId), options);
}

export function writeExportBundle(directory: string, bundle: ExportBundle): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.json"), bundle.manifestJson, "utf8");
  writeFileSync(join(directory, "receipts.jsonl"), bundle.receiptsJsonl, "utf8");
}
