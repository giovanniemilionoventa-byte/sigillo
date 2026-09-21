import {
  GENESIS_PREV_HASH,
  keyIdFromRawPublicKey,
  publicKeyFromRaw,
  receiptHashHex,
  safeParseManifest,
  safeParseReceipt,
  verifyReceiptSignature,
  type Manifest,
  type Receipt,
} from "@sigillo/core";

/**
 * Checks an export against docs/FORMAT.md. Everything is deliberately explicit:
 * an auditor should be able to read this file top to bottom and see that each
 * rule in the format is actually enforced, in the order the format states.
 *
 * It stops at the first failure and says which receipt and which check.
 */

export interface Bundle {
  manifestJson: string;
  receiptsJsonl: string;
}

export type VerificationCheck =
  | "manifest"
  | "receipt-json"
  | "receipt-schema"
  | "system"
  | "sequence"
  | "genesis"
  | "chain-link"
  | "key"
  | "signature"
  | "range";

export interface VerificationSummary {
  system_id: string;
  receipts: number;
  first_seq: number;
  last_seq: number;
  key_ids: string[];
}

export type Verification =
  | { ok: true; summary: VerificationSummary }
  | { ok: false; check: VerificationCheck; location: string; detail: string };

function fail(check: VerificationCheck, location: string, detail: string): Verification {
  return { ok: false, check, location, detail };
}

function at(lineNumber: number): string {
  return `receipts.jsonl:${lineNumber}`;
}

export function verifyBundle(bundle: Bundle): Verification {
  // 1. The manifest, which carries the keys everything else is checked against.
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(bundle.manifestJson);
  } catch (error) {
    return fail("manifest", "manifest.json", `is not valid JSON: ${String(error)}`);
  }

  const manifestResult = safeParseManifest(manifestValue);
  if (!manifestResult.ok) {
    return fail("manifest", "manifest.json", manifestResult.error);
  }
  const manifest: Manifest = manifestResult.manifest;

  const keysById = new Map<string, ReturnType<typeof publicKeyFromRaw>>();
  for (const entry of manifest.keys) {
    const raw = new Uint8Array(Buffer.from(entry.public_key_base64, "base64"));
    if (raw.length !== 32) {
      return fail("key", "manifest.json", `key ${entry.key_id} is not a 32-byte public key`);
    }
    // key_id is derived from the key, so the manifest cannot label a key freely:
    // a key published under someone else's identifier is caught here rather than
    // surfacing later as an unexplained signature failure.
    const derived = keyIdFromRawPublicKey(raw);
    if (derived !== entry.key_id) {
      return fail(
        "key",
        "manifest.json",
        `the manifest publishes a key under key_id ${entry.key_id}, but that key's identifier is ${derived}`,
      );
    }
    keysById.set(entry.key_id, publicKeyFromRaw(raw));
  }

  // 2. Every line is a receipt of the version this verifier implements.
  const rawLines = bundle.receiptsJsonl.split("\n").filter((line) => line.trim().length > 0);
  if (rawLines.length === 0) {
    return fail("range", "receipts.jsonl", "the export contains no receipts");
  }

  const receipts: Receipt[] = [];
  for (const [index, line] of rawLines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      return fail("receipt-json", at(index + 1), `is not valid JSON: ${String(error)}`);
    }
    const parsed = safeParseReceipt(value);
    if (!parsed.ok) {
      return fail("receipt-schema", at(index + 1), parsed.error);
    }
    receipts.push(parsed.receipt);
  }

  // 3. Every receipt belongs to the chain the manifest names.
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.system_id !== manifest.system_id) {
      return fail(
        "system",
        at(index + 1),
        `receipt seq ${receipt.seq} belongs to system ${receipt.system_id}, but the manifest declares ${manifest.system_id}`,
      );
    }
  }

  // 4. The sequence runs from the declared start, one at a time, with no gap,
  //    no repeat and no reordering.
  const first = receipts[0];
  if (first === undefined) {
    return fail("range", "receipts.jsonl", "the export contains no receipts");
  }
  if (first.seq !== manifest.range.from_seq) {
    return fail(
      "range",
      at(1),
      `the manifest declares the export starts at seq ${manifest.range.from_seq}, but the first receipt is seq ${first.seq}`,
    );
  }
  for (const [index, receipt] of receipts.entries()) {
    const expected = first.seq + index;
    if (receipt.seq !== expected) {
      const previous = receipts[index - 1];
      const because =
        previous !== undefined && receipt.seq === previous.seq
          ? `seq ${receipt.seq} appears twice`
          : `expected seq ${expected}, found seq ${receipt.seq}`;
      return fail("sequence", at(index + 1), because);
    }
  }

  // 5. A chain that starts at the beginning starts with a genesis receipt.
  if (first.seq === 0) {
    if (first.action.kind !== "genesis") {
      return fail("genesis", at(1), `seq 0 must be a genesis receipt, found ${first.action.kind}`);
    }
    if (first.action.name !== first.system_id) {
      return fail(
        "genesis",
        at(1),
        `a genesis receipt names its system in action.name, found ${first.action.name}`,
      );
    }
    if (first.prev_hash !== GENESIS_PREV_HASH) {
      return fail("genesis", at(1), "a genesis receipt must carry 64 zeros as prev_hash");
    }
  }

  // 6. Each receipt commits to the one before it.
  for (let index = 1; index < receipts.length; index += 1) {
    const previous = receipts[index - 1];
    const receipt = receipts[index];
    if (previous === undefined || receipt === undefined) continue;
    const expected = receiptHashHex(previous);
    if (receipt.prev_hash !== expected) {
      return fail(
        "chain-link",
        at(index + 1),
        `receipt seq ${receipt.seq} carries prev_hash ${receipt.prev_hash}, but receipt seq ${previous.seq} hashes to ${expected}: one of the two has been altered`,
      );
    }
  }

  // 7. Every receipt names a key the manifest publishes, and 8. is signed by it.
  for (const [index, receipt] of receipts.entries()) {
    const key = keysById.get(receipt.key_id);
    if (key === undefined) {
      return fail(
        "key",
        at(index + 1),
        `receipt seq ${receipt.seq} is signed by key ${receipt.key_id}, which the manifest does not publish`,
      );
    }
    if (!verifyReceiptSignature(receipt, key)) {
      return fail(
        "signature",
        at(index + 1),
        `receipt seq ${receipt.seq} is not signed by key ${receipt.key_id}`,
      );
    }
  }

  // 9. The manifest describes the receipts that are actually here.
  const last = receipts[receipts.length - 1];
  if (last === undefined) {
    return fail("range", "receipts.jsonl", "the export contains no receipts");
  }
  if (last.seq !== manifest.range.to_seq) {
    return fail(
      "range",
      "manifest.json",
      `the manifest declares the export ends at seq ${manifest.range.to_seq}, but the last receipt is seq ${last.seq}`,
    );
  }
  if (manifest.counts.receipts !== receipts.length) {
    return fail(
      "range",
      "manifest.json",
      `the manifest declares ${manifest.counts.receipts} receipts, but the export holds ${receipts.length}`,
    );
  }

  return {
    ok: true,
    summary: {
      system_id: manifest.system_id,
      receipts: receipts.length,
      first_seq: first.seq,
      last_seq: last.seq,
      key_ids: [...keysById.keys()],
    },
  };
}
