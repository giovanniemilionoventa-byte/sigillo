import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalReceiptBytes,
  GENESIS_PREV_HASH,
  keyIdFromRawPublicKey,
  rawPublicKeyBytes,
  RECEIPT_VERSION_1,
  sha256,
  signReceipt,
  toHex,
} from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Fase 9 / review point 6, the remaining half: a request that the server
 * completed but whose response was lost in transit. The OTLP exporter sends
 * the whole batch again — same trace_id and span_id — and this time the
 * server itself must recognise the spans it already wrote, rather than
 * relying on the atomic-batch fix alone (which only protects a batch that
 * failed mid-write). Real SQLite, a real Ed25519 signer: a duplicate must not
 * even ask for a signature, let alone consume a seq.
 */

const SYSTEM = "acme-support-bot";

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let token: string;
let app: FastifyInstance;

function event(traceId: string, spanId: string, name: string): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: "2026-03-29T14:30:01.005Z",
    actor: { agent: "planner" },
    action: { kind: "tool_call", name },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "otlp", trace_id: traceId, span_id: spanId },
  };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-dedup-"));
  signer = createTestSigner();
  const databasePath = join(directory, "sigillo.db");
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
  keys = ApiKeyStore.open(databasePath);
  token = keys.issue(SYSTEM, "2026-03-29T14:00:00.000Z").token;
  app = buildServer({ store, keys });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const TRACE = "0af7651916cd43dd8448eb211c80319c";

function span(spanId: string, name: string): Record<string, unknown> {
  return {
    traceId: TRACE,
    spanId,
    name,
    startTimeUnixNano: "1774795801000000000",
    endTimeUnixNano: "1774795802000000000",
    attributes: [
      { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
      { key: "tool.name", value: { stringValue: name } },
    ],
  };
}

function batch(...spans: Record<string, unknown>[]): Record<string, unknown> {
  return {
    resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }],
  };
}

const send = (payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> =>
  app
    .inject({
      method: "POST",
      url: "/v1/traces",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload,
    })
    .then((response) => ({ status: response.statusCode, body: response.json() as Record<string, unknown> }));

describe("the store, asked to append the same span twice", () => {
  it("writes it once, and does not ask the signer to sign it again", async () => {
    const first = await store.appendBatch([event(TRACE, "b7ad6b7169203331", "lookup")]);
    expect(store.readChain(SYSTEM)).toHaveLength(2); // genesis + the span
    const callsAfterFirst = signer.calls();

    const second = await store.appendBatch([event(TRACE, "b7ad6b7169203331", "lookup")]);
    expect(store.readChain(SYSTEM)).toHaveLength(2); // still: no new row
    expect(signer.calls()).toBe(callsAfterFirst); // no signature asked for the duplicate

    expect(second.receipts).toEqual(first.receipts);
    expect(second.duplicates).toBe(1);
    expect(first.duplicates).toBe(0);
  });

  it("does not confuse two different spans of the same trace, or the same span id in another system", async () => {
    await store.appendBatch([event(TRACE, "b7ad6b7169203331", "lookup")]);
    const other = await store.appendBatch([event(TRACE, "b7ad6b7169203332", "another")]);
    expect(other.duplicates).toBe(0);
    expect(store.readChain(SYSTEM)).toHaveLength(3);

    await store.createSystem("acme-billing-bot", "2026-03-29T14:00:00.000Z");
    const elsewhere = await store.appendBatch([
      { ...event(TRACE, "b7ad6b7169203331", "lookup"), system_id: "acme-billing-bot" },
    ]);
    expect(elsewhere.duplicates).toBe(0);
  });

  it("does not affect appends with no trace_id and span_id (the native API)", async () => {
    const withoutSource: ChainEvent = {
      system_id: SYSTEM,
      ts_event: "2026-03-29T14:30:01.000Z",
      ts_received: "2026-03-29T14:30:01.005Z",
      actor: { agent: "planner" },
      action: { kind: "tool_call", name: "search" },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "api" },
    };
    await store.append(withoutSource);
    await store.append(withoutSource);
    expect(store.readChain(SYSTEM)).toHaveLength(3); // genesis + two distinct receipts
  });
});

describe("an OTLP batch resent because its response was lost", () => {
  it("is accepted again with the same status, but writes nothing new, and reports the duplicates", async () => {
    const payload = batch(span("b7ad6b7169203331", "leggi_curriculum"), span("b7ad6b7169203332", "valuta"));
    const first = await send(payload);
    expect(first.status).toBe(200);
    expect(first.body["sigillo"]).toMatchObject({ accepted: 2, duplicates: 0 });

    const second = await send(payload);
    expect(second.status).toBe(200);
    expect(second.body["sigillo"]).toMatchObject({ accepted: 2, duplicates: 2 });

    expect(store.readChain(SYSTEM)).toHaveLength(3); // genesis + 2, never 5
  });

  it("still writes a batch that mixes an already-seen span with a genuinely new one", async () => {
    await send(batch(span("b7ad6b7169203331", "leggi_curriculum")));
    const mixed = await send(batch(span("b7ad6b7169203331", "leggi_curriculum"), span("b7ad6b7169203399", "nuovo")));
    expect(mixed.body["sigillo"]).toMatchObject({ accepted: 2, duplicates: 1 });
    expect(store.readChain(SYSTEM)).toHaveLength(3);
  });
});

describe("a database created before fase 9", () => {
  it("gains the columns dedup needs, without disturbing the row already there", async () => {
    // A genuine genesis receipt, signed for real, inserted directly with the
    // columns the schema had before this change — no source_trace_id, no
    // source_span_id, and so no way yet to tell one span from another.
    const databasePath = join(directory, "old-schema.db");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const raw = rawPublicKeyBytes(publicKey);
    const keyId = keyIdFromRawPublicKey(raw);
    const unsigned = {
      v: RECEIPT_VERSION_1,
      system_id: SYSTEM,
      seq: 0,
      ts_event: "2020-01-01T00:00:00.000Z",
      ts_received: "2020-01-01T00:00:00.000Z",
      actor: { agent: SYSTEM },
      action: { kind: "genesis", name: SYSTEM },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "api" },
      prev_hash: GENESIS_PREV_HASH,
      key_id: keyId,
    } as const;
    const receipt = signReceipt(unsigned, privateKey);
    const canonicalBytes = canonicalReceiptBytes(unsigned);

    const old = new Database(databasePath);
    old.exec(`
      CREATE TABLE systems (system_id TEXT PRIMARY KEY, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE receipts (
        id INTEGER PRIMARY KEY, system_id TEXT NOT NULL, seq INTEGER NOT NULL,
        hash TEXT NOT NULL, prev_hash TEXT NOT NULL, canonical TEXT NOT NULL,
        sig TEXT NOT NULL, key_id TEXT NOT NULL, ts_event TEXT NOT NULL,
        ts_received TEXT NOT NULL, action_kind TEXT NOT NULL, action_name TEXT NOT NULL,
        outcome TEXT NOT NULL, UNIQUE (system_id, seq), UNIQUE (hash)
      ) STRICT;
    `);
    old.prepare("INSERT INTO systems (system_id, created_at) VALUES (?, ?)").run(SYSTEM, unsigned.ts_received);
    old
      .prepare(
        `INSERT INTO receipts (system_id, seq, hash, prev_hash, canonical, sig, key_id,
                               ts_event, ts_received, action_kind, action_name, outcome)
         VALUES (@system_id, @seq, @hash, @prev_hash, @canonical, @sig, @key_id,
                 @ts_event, @ts_received, @action_kind, @action_name, @outcome)`,
      )
      .run({
        system_id: SYSTEM,
        seq: 0,
        hash: toHex(sha256(canonicalBytes)),
        prev_hash: unsigned.prev_hash,
        canonical: new TextDecoder().decode(canonicalBytes),
        sig: receipt.sig,
        key_id: keyId,
        ts_event: unsigned.ts_event,
        ts_received: unsigned.ts_received,
        action_kind: "genesis",
        action_name: SYSTEM,
        outcome: "ok",
      });
    expect(old.prepare("PRAGMA table_info(receipts)").all().map((c) => (c as { name: string }).name)).not.toContain(
      "source_trace_id",
    );
    old.close();

    const migrated = ReceiptStore.open(databasePath, createTestSigner());
    try {
      // Opened without throwing, and the row from before the migration is
      // exactly as it was.
      expect(migrated.readChain(SYSTEM)).toHaveLength(1);

      // Dedup works on rows written after the migration, even though the row
      // from before it has no source_trace_id/source_span_id to match against.
      const first = await migrated.appendBatch([event(TRACE, "b7ad6b7169203331", "lookup")]);
      expect(first.duplicates).toBe(0);
      const second = await migrated.appendBatch([event(TRACE, "b7ad6b7169203331", "lookup")]);
      expect(second.duplicates).toBe(1);
      expect(migrated.readChain(SYSTEM)).toHaveLength(2);
    } finally {
      migrated.close();
    }
  });
});
