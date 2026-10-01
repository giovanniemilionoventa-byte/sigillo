import Database from "better-sqlite3";
import {
  canonicalReceiptBytes,
  receiptHashHex,
  sha256,
  toHex,
  type Receipt,
  type UnsignedReceipt,
} from "@sigillo/core";
import type { ReceiptStore, SigningService } from "../../src/storage/store.js";

/**
 * A receipt of an older schema version, as the server wrote them before
 * version 4, put on a chain: the real signer signs it (it accepts every
 * version), and it is inserted the way the earlier server inserted it. The
 * store itself now writes only version 4, so this is how a test gets a chain
 * that began earlier.
 */
export async function appendLegacyReceipt(
  databasePath: string,
  store: ReceiptStore,
  signer: Pick<SigningService, "keyId" | "signReceipt">,
  /** Every member but the position, the chain link and the key: `v` decides which version it is. */
  fields: Record<string, unknown> & { system_id: string; ts_received: string },
): Promise<Receipt> {
  const tip = store.readChain(fields.system_id).at(-1) as Receipt;
  const unsigned = {
    ...fields,
    seq: tip.seq + 1,
    prev_hash: receiptHashHex(tip),
    key_id: signer.keyId,
  } as unknown as UnsignedReceipt;
  const sig = await signer.signReceipt(unsigned);
  const receipt = { ...unsigned, sig } as Receipt;
  const bytes = canonicalReceiptBytes(unsigned);
  const raw = new Database(databasePath);
  try {
    raw
      .prepare(
        `INSERT INTO receipts (system_id, seq, hash, prev_hash, canonical, sig, key_id, ts_event, ts_received, action_kind, action_name, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.system_id,
        receipt.seq,
        toHex(sha256(bytes)),
        receipt.prev_hash,
        new TextDecoder().decode(bytes),
        sig,
        receipt.key_id,
        receipt.ts_event,
        receipt.ts_received,
        receipt.action.kind,
        receipt.action.name,
        receipt.outcome,
      );
    if (receipt.v !== 1) {
      for (const artifact of receipt.artifacts ?? []) {
        const text = (artifact as { text?: { canon: string; sha256: string } }).text;
        raw
          .prepare(
            `INSERT INTO artifacts (system_id, seq, role, label, media_type, sha256, text_canon, text_sha256)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(receipt.system_id, receipt.seq, artifact.role, artifact.label, artifact.media_type, artifact.sha256, text?.canon ?? null, text?.sha256 ?? null);
      }
    }
  } finally {
    raw.close();
  }
  return receipt;
}
