import { verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalReceiptBytes,
  fromHex,
  GENESIS_PREV_HASH,
  parseReceipt,
  receiptHash,
  receiptHashHex,
  type Receipt,
} from "@sigillo/core";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

const SYSTEM = "acme-support-bot";
const OTHER_SYSTEM = "acme-billing-bot";

let directory: string;
let databasePath: string;
let signer: TestSigner;
let store: ReceiptStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-store-"));
  databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function event(overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: "2026-03-29T14:30:01.005Z",
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: "search_orders" },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
    ...overrides,
  };
}

function signatureIsValid(receipt: Receipt, key = signer.publicKey): boolean {
  return verify(null, receiptHash(receipt), key, Buffer.from(receipt.sig, "base64"));
}

/** A second connection to the same file, to attack the data rather than the API. */
function openRawConnection(): Database.Database {
  return new Database(databasePath);
}

describe("opening the database", () => {
  it("uses write-ahead logging", () => {
    const raw = openRawConnection();
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    raw.close();
  });
});

describe("creating a chain", () => {
  it("writes a genesis receipt that matches the format", async () => {
    const genesis = await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
    expect(genesis.seq).toBe(0);
    expect(genesis.action).toEqual({ kind: "genesis", name: SYSTEM });
    expect(genesis.actor).toEqual({ agent: SYSTEM });
    expect(genesis.prev_hash).toBe(GENESIS_PREV_HASH);
    expect(genesis.input_hash).toBeNull();
    expect(genesis.output_hash).toBeNull();
    expect(genesis.key_id).toBe(signer.keyId);
    expect(parseReceipt(genesis)).toEqual(genesis);
    expect(signatureIsValid(genesis)).toBe(true);
  });

  it("refuses to create the same chain twice", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
    await expect(store.createSystem(SYSTEM, "2026-03-29T14:30:02.000Z")).rejects.toThrow(
      /already exists/i,
    );
    expect(store.readChain(SYSTEM)).toHaveLength(1);
  });
});

describe("appending to a chain", () => {
  beforeEach(async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
  });

  it("assigns the next sequence number and links to the previous receipt", async () => {
    const genesis = store.readChain(SYSTEM)[0];
    expect(genesis).toBeDefined();
    if (!genesis) return;

    const first = await store.append(event());
    expect(first.seq).toBe(1);
    expect(first.prev_hash).toBe(receiptHashHex(genesis));

    const second = await store.append(event());
    expect(second.seq).toBe(2);
    expect(second.prev_hash).toBe(receiptHashHex(first));
    expect(signatureIsValid(second)).toBe(true);
  });

  it("asks the signer for exactly one signature per receipt", async () => {
    const before = signer.calls();
    await store.append(event());
    await store.append(event());
    expect(signer.calls() - before).toBe(2);
  });

  it("refuses to append to a chain that was never created", async () => {
    await expect(store.append(event({ system_id: "never-created" }))).rejects.toThrow(/unknown/i);
    expect(store.readChain("never-created")).toHaveLength(0);
  });

  it("refuses to append a second genesis", async () => {
    await expect(
      store.append(event({ action: { kind: "genesis", name: SYSTEM } })),
    ).rejects.toThrow(/genesis/i);
  });

  it("refuses an event the format would reject, rather than storing it", async () => {
    await expect(store.append(event({ ts_event: "2026-03-29 14:30:01Z" }))).rejects.toThrow(
      /ts_event/,
    );
    expect(store.readChain(SYSTEM)).toHaveLength(1);
  });

  it("stores the canonical bytes that were hashed, not a re-serialisation", async () => {
    const receipt = await store.append(event({ actor: { agent: "café-agent ☕" } }));
    const raw = openRawConnection();
    const row = raw
      .prepare("SELECT canonical, hash, sig FROM receipts WHERE system_id = ? AND seq = ?")
      .get(SYSTEM, receipt.seq) as { canonical: string; hash: string; sig: string };
    raw.close();

    expect(row.canonical).toBe(new TextDecoder().decode(canonicalReceiptBytes(receipt)));
    expect(row.hash).toBe(receiptHashHex(receipt));
    expect(row.sig).toBe(receipt.sig);
  });
});

describe("version 2 fields", () => {
  beforeEach(async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
  });

  it("stays v1, with neither member, when the event carries no artifacts or model", async () => {
    const receipt = await store.append(event());
    expect(receipt.v).toBe(1);
    expect(receipt).not.toHaveProperty("artifacts");
    expect(receipt).not.toHaveProperty("model");
  });

  it("becomes v2 when the event carries an artifact", async () => {
    const receipt = await store.append(
      event({
        artifacts: [
          { role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) },
        ],
      }),
    );
    expect(receipt.v).toBe(2);
    if (receipt.v !== 2) return;
    expect(receipt.artifacts).toEqual([
      { role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) },
    ]);
    expect(receipt).not.toHaveProperty("model");
  });

  it("becomes v2 when the event carries a model", async () => {
    const receipt = await store.append(
      event({ model: { name: "qwen2.5:3b", provider: "ollama", digest: "sha256:deadbeef" } }),
    );
    expect(receipt.v).toBe(2);
    if (receipt.v !== 2) return;
    expect(receipt.model).toEqual({ name: "qwen2.5:3b", provider: "ollama", digest: "sha256:deadbeef" });
  });

  it("chains a v2 receipt to a v1 predecessor exactly as it would another v1", async () => {
    const first = await store.append(event());
    const second = await store.append(
      event({ model: { name: "gpt-4o", provider: "openai", digest: null } }),
    );
    expect(second.prev_hash).toBe(receiptHashHex(first));
    expect(signatureIsValid(second)).toBe(true);
  });

  it("stores the exact canonical bytes for a v2 receipt too, artifacts included", async () => {
    const receipt = await store.append(
      event({
        artifacts: [
          { role: "output", label: "email di risposta", media_type: "text/plain", sha256: "b".repeat(64) },
        ],
      }),
    );
    const raw = openRawConnection();
    const row = raw
      .prepare("SELECT canonical FROM receipts WHERE system_id = ? AND seq = ?")
      .get(SYSTEM, receipt.seq) as { canonical: string };
    raw.close();
    expect(row.canonical).toBe(new TextDecoder().decode(canonicalReceiptBytes(receipt)));
    expect(parseReceipt({ ...JSON.parse(row.canonical), sig: receipt.sig })).toEqual(receipt);
  });

  it("finds a document by its fingerprint, across systems, oldest use first", async () => {
    const sha256 = "c".repeat(64);
    await store.append(
      event({
        ts_received: "2026-03-29T14:30:02.000Z",
        artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256 }],
      }),
    );

    await store.createSystem(OTHER_SYSTEM, "2026-03-29T14:29:00.000Z");
    await store.append(
      event({
        system_id: OTHER_SYSTEM,
        ts_received: "2026-03-29T14:29:01.000Z",
        action: { kind: "tool_call", name: "call-1" },
        artifacts: [{ role: "output", label: "allegato", media_type: "text/plain", sha256 }],
      }),
    );

    const matches = store.findArtifactsBySha256(sha256);
    expect(matches).toHaveLength(2);
    // Ordered by when the action was received, not by system or insertion order.
    expect(matches[0]).toMatchObject({ system_id: OTHER_SYSTEM, seq: 1, role: "output" });
    expect(matches[1]).toMatchObject({ system_id: SYSTEM, seq: 1, role: "input" });
  });

  it("finds nothing for a fingerprint no receipt ever declared", async () => {
    await store.append(event());
    expect(store.findArtifactsBySha256("d".repeat(64))).toEqual([]);
  });
});

describe("append-only storage", () => {
  beforeEach(async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
    await store.append(event());
  });

  it("refuses an UPDATE on receipts, from any connection", () => {
    const raw = openRawConnection();
    expect(() => raw.exec("UPDATE receipts SET outcome = 'error'")).toThrow(/append-only/);
    expect(() => raw.exec("UPDATE receipts SET hash = 'x' WHERE seq = 0")).toThrow(/append-only/);
    raw.close();
  });

  it("refuses a DELETE on receipts, from any connection", () => {
    const raw = openRawConnection();
    expect(() => raw.exec("DELETE FROM receipts")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM receipts WHERE seq = 1")).toThrow(/append-only/);
    raw.close();
  });

  it("leaves the chain intact after a rejected attempt", () => {
    const raw = openRawConnection();
    expect(() => raw.exec("DELETE FROM receipts")).toThrow(/append-only/);
    raw.close();
    const chain = store.readChain(SYSTEM);
    expect(chain.map((receipt) => receipt.seq)).toEqual([0, 1]);
  });

  it("refuses an UPDATE or a DELETE on checkpoints and timestamps", () => {
    const raw = openRawConnection();
    raw.exec(
      `INSERT INTO checkpoints (system_id, tree_size, root_hash, ts, key_id, sig)
       VALUES ('${SYSTEM}', 2, '${"a".repeat(64)}', '2026-03-29T15:00:00.000Z', '${signer.keyId}', 'sig')`,
    );
    raw.exec(
      `INSERT INTO timestamps (checkpoint_id, tsa_url, token_base64, obtained_at)
       VALUES (1, 'https://freetsa.org/tsr', 'dG9rZW4=', '2026-03-29T15:00:01.000Z')`,
    );
    expect(() => raw.exec("UPDATE checkpoints SET tree_size = 3")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM checkpoints")).toThrow(/append-only/);
    expect(() => raw.exec("UPDATE timestamps SET tsa_url = 'x'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM timestamps")).toThrow(/append-only/);
    raw.close();
  });

  it("refuses a second receipt at an existing position", () => {
    const raw = openRawConnection();
    expect(() =>
      raw.exec(
        `INSERT INTO receipts (system_id, seq, hash, prev_hash, canonical, sig, key_id,
                               ts_event, ts_received, action_kind, action_name, outcome)
         VALUES ('${SYSTEM}', 1, '${"b".repeat(64)}', '${"c".repeat(64)}', '{}', 'sig',
                 '${signer.keyId}', '2026-03-29T14:30:01.000Z', '2026-03-29T14:30:01.005Z',
                 'tool_call', 'forged', 'ok')`,
      ),
    ).toThrow(/UNIQUE/i);
    raw.close();
  });
});

describe("concurrent writers on one chain", () => {
  it(
    "produces a contiguous chain with no gaps and no fork",
    async () => {
      await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");

      const total = 1000;
      const pending = Array.from({ length: total - 1 }, (_unused, index) =>
        store.append(
          event({
            action: { kind: "tool_call", name: `call-${index}` },
            ts_event: "2026-03-29T14:30:01.000Z",
          }),
        ),
      );
      await Promise.all(pending);

      const chain = store.readChain(SYSTEM);
      expect(chain).toHaveLength(total);
      expect(chain.map((receipt) => receipt.seq)).toEqual(
        Array.from({ length: total }, (_unused, index) => index),
      );

      const hashes = new Set<string>();
      let previous = GENESIS_PREV_HASH;
      for (const receipt of chain) {
        expect(receipt.prev_hash).toBe(previous);
        expect(parseReceipt(receipt)).toEqual(receipt);
        previous = receiptHashHex(receipt);
        hashes.add(previous);
      }
      expect(hashes.size).toBe(total);

      // Spot-check signatures rather than all 1000: signing is covered above.
      for (const index of [0, 1, 499, total - 1]) {
        const receipt = chain[index];
        expect(receipt).toBeDefined();
        if (receipt) expect(signatureIsValid(receipt)).toBe(true);
      }

      // Every action name was used exactly once: nothing was dropped or duplicated.
      const names = chain.slice(1).map((receipt) => receipt.action.name).sort();
      const expected = Array.from({ length: total - 1 }, (_unused, index) => `call-${index}`).sort();
      expect(names).toEqual(expected);
    },
    120_000,
  );
});

describe("a new process taking over the database", () => {
  it("continues the chain from the stored tip instead of forking it", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
    const first = await store.append(event());
    store.close();

    const reopened = ReceiptStore.open(databasePath, signer);
    try {
      expect(reopened.tip(SYSTEM)).toEqual({ seq: 1, hash: receiptHashHex(first) });
      const second = await reopened.append(event());
      expect(second.seq).toBe(2);
      expect(second.prev_hash).toBe(receiptHashHex(first));
      expect(reopened.readChain(SYSTEM).map((receipt) => receipt.seq)).toEqual([0, 1, 2]);
    } finally {
      reopened.close();
    }

    // afterEach closes `store` again, which must stay harmless.
    store = ReceiptStore.open(databasePath, signer);
  });
});

describe("chains of different systems", () => {
  it("keeps sequence numbers and links independent", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
    await store.createSystem(OTHER_SYSTEM, "2026-03-29T14:30:00.100Z");

    await Promise.all([
      store.append(event({ system_id: SYSTEM, action: { kind: "tool_call", name: "a1" } })),
      store.append(event({ system_id: OTHER_SYSTEM, action: { kind: "tool_call", name: "b1" } })),
      store.append(event({ system_id: SYSTEM, action: { kind: "tool_call", name: "a2" } })),
      store.append(event({ system_id: OTHER_SYSTEM, action: { kind: "tool_call", name: "b2" } })),
    ]);

    const first = store.readChain(SYSTEM);
    const second = store.readChain(OTHER_SYSTEM);
    expect(first.map((receipt) => receipt.seq)).toEqual([0, 1, 2]);
    expect(second.map((receipt) => receipt.seq)).toEqual([0, 1, 2]);
    expect(first.every((receipt) => receipt.system_id === SYSTEM)).toBe(true);
    expect(second.every((receipt) => receipt.system_id === OTHER_SYSTEM)).toBe(true);

    for (const chain of [first, second]) {
      let previous = GENESIS_PREV_HASH;
      for (const receipt of chain) {
        expect(receipt.prev_hash).toBe(previous);
        previous = receiptHashHex(receipt);
      }
    }

    expect(store.listSystems().sort()).toEqual([OTHER_SYSTEM, SYSTEM].sort());
  });
});

describe("reading back", () => {
  it("returns receipts that a verifier would accept", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
    await store.append(event({ input_hash: "a".repeat(64), output_hash: "b".repeat(64) }));
    await store.append(
      event({
        actor: { agent: "executor", on_behalf_of: "urn:operator:night-shift" },
        source: { type: "otlp", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" },
        outcome: "blocked",
      }),
    );

    for (const receipt of store.readChain(SYSTEM)) {
      expect(parseReceipt(receipt)).toEqual(receipt);
      expect(signatureIsValid(receipt)).toBe(true);
      expect(receipt.sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
      expect(fromHex(receipt.prev_hash)).toHaveLength(32);
    }

    const tip = store.tip(SYSTEM);
    expect(tip).not.toBeNull();
    expect(tip?.seq).toBe(2);
  });

  it("reports an empty chain for a system that does not exist", () => {
    expect(store.readChain("nothing-here")).toEqual([]);
    expect(store.tip("nothing-here")).toBeNull();
  });
});

describe("verifying every signature before it is stored", () => {
  // The signer is a separate process, and what it hands back is checked, not
  // trusted: a signature that does not verify over exactly the bytes about to
  // be stored, under the signer's own public key, never reaches the table.

  /** The same key, the same key_id, but a genuine signature over some other digest. */
  function signerSigningTheWrongDigest(): TestSigner {
    const honest = createTestSigner();
    return { ...honest, sign: async () => honest.sign(new Uint8Array(32).fill(7)) };
  }

  async function reopenWith(liar: TestSigner): Promise<ReceiptStore> {
    store.close();
    store = ReceiptStore.open(databasePath, liar);
    return store;
  }

  function tableCount(table: string): number {
    const raw = openRawConnection();
    try {
      return (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } finally {
      raw.close();
    }
  }

  it("refuses a well-formed signature that does not verify at all", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
    const liar = { ...signer, sign: async () => "A".repeat(86) + "==" };
    await reopenWith(liar);

    await expect(store.append(event())).rejects.toThrow(/does not verify/);
    expect(store.readChain(SYSTEM).map((receipt) => receipt.seq)).toEqual([0]);
    expect(tableCount("receipts")).toBe(1);
  });

  it("refuses a valid signature over a different digest, made with the very same key", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
    const other = await signer.sign(receiptHash(store.readChain(SYSTEM)[0] as Receipt));
    // A genuine signature by this signer's key — just not over this receipt.
    const liar = { ...signer, sign: async () => other };
    await reopenWith(liar);

    await expect(store.append(event())).rejects.toThrow(/does not verify/);
    expect(tableCount("receipts")).toBe(1);
  });

  it("refuses a signature made with a different key under this signer's key_id", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
    const impostor = createTestSigner();
    const liar = { ...signer, sign: (digest: Uint8Array) => impostor.sign(digest) };
    await reopenWith(liar);

    await expect(store.append(event())).rejects.toThrow(/does not verify/);
    expect(tableCount("receipts")).toBe(1);
  });

  it("keeps the chain writable afterwards: the refused position is taken by the next good receipt", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
    const honest = signer;
    await reopenWith({ ...honest, sign: async () => "A".repeat(86) + "==" });
    await expect(store.append(event())).rejects.toThrow(/does not verify/);

    await reopenWith(honest);
    const next = await store.append(event({ action: { kind: "tool_call", name: "after" } }));
    expect(next.seq).toBe(1);
    expect(signatureIsValid(next)).toBe(true);
    expect(next.prev_hash).toBe(receiptHashHex(store.readChain(SYSTEM)[0] as Receipt));
  });

  it("refuses a genesis receipt whose signature does not verify, and registers no system", async () => {
    await reopenWith(signerSigningTheWrongDigest());

    await expect(store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z")).rejects.toThrow(
      /does not verify/,
    );
    expect(store.hasSystem(SYSTEM)).toBe(false);
    expect(tableCount("receipts")).toBe(0);
  });

  it("refuses a checkpoint whose signature does not verify", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
    await store.append(event());
    await reopenWith({ ...signer, sign: async () => "A".repeat(86) + "==" });

    await expect(store.createCheckpoint(SYSTEM, "2026-03-29T15:00:00.000Z")).rejects.toThrow(
      /does not verify/,
    );
    expect(tableCount("checkpoints")).toBe(0);
  });

  it("refuses to open for writing with a signer whose key_id is not its public key's", () => {
    const stranger = createTestSigner();
    const mismatched = { ...signer, publicKeyBase64: stranger.publicKeyBase64 };
    expect(() => ReceiptStore.open(join(directory, "other.db"), mismatched)).toThrow(/key_id/);
  });
});

describe("refusing text that is not well-formed Unicode", () => {
  // RFC 8785 is defined over well-formed Unicode. A receipt holding half of a
  // surrogate pair would be signed here, but an independent implementation
  // could not even compute its hash, so the store refuses it before it asks
  // for a signature, whichever route the event took to get here.

  const LONE = "\ud83d";

  const cases: [string, Partial<ChainEvent>][] = [
    ["action.name", { action: { kind: "tool_call", name: `cerca${LONE}` } }],
    ["actor.agent", { actor: { agent: `agente${LONE}` } }],
    ["actor.on_behalf_of", { actor: { agent: "planner", on_behalf_of: `${LONE}utente` } }],
    [
      "an artifact label",
      { artifacts: [{ role: "input", label: `cv${LONE}`, media_type: "text/plain", sha256: "a".repeat(64) }] },
    ],
    ["a model name", { model: { name: `modello${LONE}`, provider: null, digest: null } }],
  ];

  for (const [where, overrides] of cases) {
    it(`refuses a lone surrogate in ${where}, before any signature is asked for`, async () => {
      await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
      const signaturesBefore = signer.calls();

      await expect(store.append(event(overrides))).rejects.toThrow(/well-formed Unicode/);
      expect(signer.calls()).toBe(signaturesBefore);
      expect(store.readChain(SYSTEM).map((receipt) => receipt.seq)).toEqual([0]);
    });
  }

  it("refuses a system name that is not well-formed Unicode", async () => {
    await expect(store.createSystem(`sistema${LONE}`, "2026-03-29T14:00:00.000Z")).rejects.toThrow(
      /well-formed Unicode/,
    );
    expect(store.listSystems()).toEqual([]);
  });

  it("still accepts any well-formed text, astral characters included", async () => {
    await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
    const receipt = await store.append(
      event({ action: { kind: "tool_call", name: "invia_email_\u{1F600}_àèìòù_日本" } }),
    );
    expect(receipt.action.name).toBe("invia_email_\u{1F600}_àèìòù_日本");
    expect(signatureIsValid(receipt)).toBe(true);
  });
});
