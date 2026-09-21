import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fromHex,
  inclusionProof,
  merkleRoot,
  rootFromInclusionProof,
  toHex,
  verifyCheckpointSignature,
} from "@sigillo/core";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { buildTimestampRequest, requestTimestampWithRetry, TimestampError } from "../src/timestamp/rfc3161.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

const SYSTEM = "acme-support-bot";
const OTHER = "acme-billing-bot";
const TSA_URL = "https://tsa.example/tsr";

let directory: string;
let databasePath: string;
let signer: TestSigner;
let store: ReceiptStore;
let clock: Date;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-checkpoint-"));
  databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  clock = new Date("2026-03-29T15:00:00.000Z");
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const now = (): Date => clock;

function event(index: number): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: "2026-03-29T14:30:01.005Z",
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  };
}

async function writeChain(length: number, systemId = SYSTEM): Promise<void> {
  await store.createSystem(systemId, "2026-03-29T14:30:00.000Z");
  for (let index = 1; index < length; index += 1) {
    await store.append({ ...event(index), system_id: systemId });
  }
}

/** A DER SEQUENCE, enough to stand in for a token where the bytes do not matter. */
const FAKE_TOKEN = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]);

function fakeTsa(behaviour: () => Response | Promise<Response>): typeof fetch {
  return (async () => behaviour()) as unknown as typeof fetch;
}

const tokenResponse = (): Response =>
  new Response(FAKE_TOKEN, {
    status: 200,
    headers: { "content-type": "application/timestamp-reply" },
  });

describe("writing a checkpoint", () => {
  it("commits to every receipt in the chain", async () => {
    await writeChain(9);
    const stored = await store.createCheckpoint(SYSTEM, clock.toISOString());

    expect(stored).not.toBeNull();
    if (stored === null) return;

    const { checkpoint } = stored;
    expect(checkpoint.system_id).toBe(SYSTEM);
    expect(checkpoint.tree_size).toBe(9);
    expect(checkpoint.ts).toBe("2026-03-29T15:00:00.000Z");
    expect(checkpoint.key_id).toBe(signer.keyId);

    const hashes = store.readReceiptHashes(SYSTEM).map((hash) => fromHex(hash));
    expect(checkpoint.root_hash).toBe(toHex(merkleRoot(hashes)));
    expect(verifyCheckpointSignature(checkpoint, signer.publicKey)).toBe(true);
  });

  it("proves the inclusion of every receipt it covers", async () => {
    await writeChain(11);
    const stored = await store.createCheckpoint(SYSTEM, clock.toISOString());
    if (stored === null) throw new Error("no checkpoint");

    const hashes = store.readReceiptHashes(SYSTEM).map((hash) => fromHex(hash));
    for (let index = 0; index < hashes.length; index += 1) {
      const entry = hashes[index];
      if (entry === undefined) continue;
      const proof = inclusionProof(hashes, index);
      expect(
        toHex(rootFromInclusionProof(entry, index, stored.checkpoint.tree_size, proof)),
      ).toBe(stored.checkpoint.root_hash);
    }
  });

  it("writes nothing when the chain has not grown", async () => {
    await writeChain(4);
    expect(await store.createCheckpoint(SYSTEM, clock.toISOString())).not.toBeNull();
    expect(await store.createCheckpoint(SYSTEM, "2026-03-29T16:00:00.000Z")).toBeNull();
    expect(store.readCheckpoints(SYSTEM)).toHaveLength(1);
  });

  it("writes another once the chain has grown", async () => {
    await writeChain(4);
    await store.createCheckpoint(SYSTEM, clock.toISOString());
    await store.append(event(99));

    const second = await store.createCheckpoint(SYSTEM, "2026-03-29T16:00:00.000Z");
    expect(second?.checkpoint.tree_size).toBe(5);
    expect(second?.checkpoint.root_hash).not.toBe(
      store.readCheckpoints(SYSTEM)[0]?.checkpoint.root_hash,
    );
    expect(store.readCheckpoints(SYSTEM).map((c) => c.checkpoint.tree_size)).toEqual([4, 5]);
  });

  it("refuses to check point a system that has no receipts", async () => {
    await expect(store.createCheckpoint("never-created", clock.toISOString())).rejects.toThrow(
      /unknown system/,
    );
  });

  it("keeps each chain's checkpoints to itself", async () => {
    await writeChain(4);
    await writeChain(6, OTHER);
    await store.createCheckpoint(SYSTEM, clock.toISOString());
    await store.createCheckpoint(OTHER, clock.toISOString());

    expect(store.readCheckpoints(SYSTEM).map((c) => c.checkpoint.tree_size)).toEqual([4]);
    expect(store.readCheckpoints(OTHER).map((c) => c.checkpoint.tree_size)).toEqual([6]);
    expect(store.latestCheckpoint(OTHER)?.checkpoint.system_id).toBe(OTHER);
  });

  it("cannot be modified once written", async () => {
    await writeChain(3);
    await store.createCheckpoint(SYSTEM, clock.toISOString());
    const raw = new Database(databasePath);
    expect(() => raw.exec("UPDATE checkpoints SET tree_size = 99")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM checkpoints")).toThrow(/append-only/);
    raw.close();
  });
});

describe("the timestamp request", () => {
  it("is the DER that openssl ts -query produces", async () => {
    const digest = "74a67e081df5c321729640090e63ca95991f9657bfaab0af51e4504cc2056241";
    const built = await buildTimestampRequest(digest);

    const expected = execFileSync(
      "openssl",
      ["ts", "-query", "-sha256", "-digest", digest, "-cert", "-no_nonce"],
      { maxBuffer: 64 * 1024 },
    );
    expect(Buffer.from(built)).toEqual(expected);
    expect(built[0]).toBe(0x30);
  });

  it("refuses anything that is not a 32-byte digest in lowercase hex", async () => {
    for (const bad of ["", "abc", "A".repeat(64), "z".repeat(64), "0".repeat(63)]) {
      await expect(buildTimestampRequest(bad)).rejects.toThrow(TimestampError);
    }
  });
});

describe("anchoring a checkpoint", () => {
  it("stores the token exactly as the authority returned it", async () => {
    await writeChain(5);
    const checkpointer = new Checkpointer({
      store,
      now,
      tsa: { url: TSA_URL, fetchImpl: fakeTsa(tokenResponse) },
    });

    const run = await checkpointer.runOnce();
    expect(run.checkpoints).toHaveLength(1);
    expect(run.timestamped).toBe(1);
    expect(run.pending).toBe(0);

    const stored = store.latestCheckpoint(SYSTEM);
    if (stored === null) throw new Error("no checkpoint");
    const tokens = store.readTimestamps(stored.id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.tsaUrl).toBe(TSA_URL);
    expect(Buffer.from(tokens[0]?.tokenBase64 ?? "", "base64")).toEqual(Buffer.from(FAKE_TOKEN));
  });

  it("keeps the checkpoint when the authority never answers", async () => {
    await writeChain(5);
    const checkpointer = new Checkpointer({
      store,
      now,
      tsa: {
        url: TSA_URL,
        fetchImpl: fakeTsa(() => {
          throw new Error("connection refused");
        }),
      },
      retry: { attempts: 2, sleep: async () => undefined },
    });

    const run = await checkpointer.runOnce();
    expect(run.checkpoints).toHaveLength(1);
    expect(run.timestamped).toBe(0);
    expect(run.pending).toBe(1);

    // The signed checkpoint is there; only the anchor is missing.
    const stored = store.latestCheckpoint(SYSTEM);
    expect(stored).not.toBeNull();
    expect(verifyCheckpointSignature(stored?.checkpoint ?? ({} as never), signer.publicKey)).toBe(
      true,
    );
    expect(store.readTimestamps(stored?.id ?? 0)).toHaveLength(0);
  });

  it("picks up a checkpoint left unanchored by an earlier run", async () => {
    await writeChain(5);
    let answering = false;
    const checkpointer = new Checkpointer({
      store,
      now,
      tsa: {
        url: TSA_URL,
        fetchImpl: fakeTsa(() => {
          if (!answering) throw new Error("the authority is down");
          return tokenResponse();
        }),
      },
      retry: { attempts: 1, sleep: async () => undefined },
    });

    expect((await checkpointer.runOnce()).pending).toBe(1);

    answering = true;
    const second = await checkpointer.runOnce();
    // No new receipts, so no new checkpoint, but the old one gets its token.
    expect(second.checkpoints).toHaveLength(0);
    expect(second.timestamped).toBe(1);
    expect(store.readTimestamps(store.latestCheckpoint(SYSTEM)?.id ?? 0)).toHaveLength(1);
  });

  it("retries with a doubling delay before giving up", async () => {
    const delays: number[] = [];
    let calls = 0;

    const token = await requestTimestampWithRetry(
      "a".repeat(64),
      {
        url: TSA_URL,
        fetchImpl: fakeTsa(() => {
          calls += 1;
          if (calls < 3) throw new Error("temporarily unavailable");
          return tokenResponse();
        }),
      },
      {
        attempts: 4,
        baseDelayMs: 100,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(Buffer.from(token, "base64")).toEqual(Buffer.from(FAKE_TOKEN));
  });

  it("rejects an answer that is not a timestamp token", async () => {
    const attempts: [string, () => Response][] = [
      ["a 500", () => new Response("boom", { status: 500 })],
      [
        "an empty body",
        () =>
          new Response(new Uint8Array(0), {
            status: 200,
            headers: { "content-type": "application/timestamp-reply" },
          }),
      ],
      [
        "an HTML error page",
        () =>
          new Response("<html>nope</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ],
      [
        "something that is not DER",
        () =>
          new Response(new Uint8Array([0x7b, 0x7d]), {
            status: 200,
            headers: { "content-type": "application/timestamp-reply" },
          }),
      ],
    ];

    for (const [name, response] of attempts) {
      await expect(
        requestTimestampWithRetry(
          "a".repeat(64),
          { url: TSA_URL, fetchImpl: fakeTsa(response) },
          { attempts: 1, sleep: async () => undefined },
        ),
        name,
      ).rejects.toThrow(TimestampError);
    }
  });

  it("sends basic credentials when the authority needs them", async () => {
    let seen: Headers | undefined;
    await requestTimestampWithRetry(
      "a".repeat(64),
      {
        url: TSA_URL,
        username: "acme",
        password: "hunter2",
        fetchImpl: (async (_url: string, init: RequestInit) => {
          seen = new Headers(init.headers);
          return tokenResponse();
        }) as unknown as typeof fetch,
      },
      { attempts: 1 },
    );

    expect(seen?.get("content-type")).toBe("application/timestamp-query");
    expect(seen?.get("authorization")).toBe(
      `Basic ${Buffer.from("acme:hunter2").toString("base64")}`,
    );
  });
});

describe("checkpointing every chain", () => {
  it("covers each system that has something new", async () => {
    await writeChain(3);
    await writeChain(4, OTHER);
    const checkpointer = new Checkpointer({ store, now });

    const first = await checkpointer.checkpointAll();
    expect(first.map((c) => c.checkpoint.system_id).sort()).toEqual([OTHER, SYSTEM].sort());

    const second = await checkpointer.checkpointAll();
    expect(second).toHaveLength(0);

    await store.append(event(42));
    const third = await checkpointer.checkpointAll();
    expect(third.map((c) => c.checkpoint.system_id)).toEqual([SYSTEM]);
  });

  it("does nothing at all when no authority is configured", async () => {
    await writeChain(3);
    const checkpointer = new Checkpointer({ store, now });
    const run = await checkpointer.runOnce();
    expect(run.checkpoints).toHaveLength(1);
    expect(run.timestamped).toBe(0);
    expect(run.pending).toBe(0);
  });
});

describe("a real timestamp authority", () => {
  const FREETSA = "https://freetsa.org/tsr";
  let reachable = false;

  beforeEach(async () => {
    try {
      const probe = await fetch(FREETSA, {
        method: "POST",
        headers: { "Content-Type": "application/timestamp-query" },
        body: await buildTimestampRequest("a".repeat(64)),
        signal: AbortSignal.timeout(15_000),
      });
      reachable = probe.ok;
    } catch {
      reachable = false;
    }
  }, 30_000);

  it(
    "issues a token that openssl verifies against the checkpoint root",
    async (context) => {
      if (!reachable) {
        context.skip();
        return;
      }

      await writeChain(6);
      const checkpointer = new Checkpointer({
        store,
        now,
        tsa: { url: FREETSA, timeoutMs: 25_000 },
        retry: { attempts: 2, baseDelayMs: 500 },
      });

      const run = await checkpointer.runOnce();
      expect(run.timestamped).toBe(1);

      const stored = store.latestCheckpoint(SYSTEM);
      if (stored === null) throw new Error("no checkpoint");
      const token = store.readTimestamps(stored.id)[0];
      if (token === undefined) throw new Error("no token");

      const tokenPath = join(directory, "token.tsr");
      writeFileSync(tokenPath, Buffer.from(token.tokenBase64, "base64"));

      const reply = execFileSync("openssl", ["ts", "-reply", "-in", tokenPath, "-text"], {
        encoding: "utf8",
      });
      expect(reply).toContain("Status: Granted.");

      // The token is over this checkpoint's root and no other.
      const digestInToken = reply
        .split("\n")
        .filter((line) => /^\s+\d{4} - /.test(line))
        .map((line) => line.replace(/^\s+\d{4} - /, "").split("   ")[0] ?? "")
        .join("")
        .replace(/[^0-9a-f]/g, "");
      expect(digestInToken).toBe(stored.checkpoint.root_hash);
    },
    90_000,
  );
});
