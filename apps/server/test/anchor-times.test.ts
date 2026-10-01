import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readZip } from "@sigillo/core";
import { buildArchive } from "../src/export/archive.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createLocalTsa, type LocalTsa } from "./helpers/local-tsa.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * The time a token attests (genTime) is the proven time of its checkpoint, and
 * `sigillo-verify` holds the receipts and the other checkpoints to it.
 *
 * Every archive here is made the way the server makes one, with tokens from a
 * local authority dated whenever the test needs (LocalTsa.stampAt), and is
 * checked by the real command in a process of its own.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const VERIFY_CLI = join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts");
const SYSTEM = "acme-support-bot";

let directory: string;
let tsa: LocalTsa;
let counter = 0;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-anchor-times-"));
  tsa = createLocalTsa();
}, 60_000);

afterAll(() => {
  tsa.close();
  rmSync(directory, { recursive: true, force: true });
});

interface Plan {
  /** ts_received of seq 1, 2, ...; seq 0, the genesis, is received at 14:00. */
  received: string[];
  /** A checkpoint once `treeSize` receipts exist, stamped at genTime (none: never stamped). */
  checkpoints: { treeSize: number; ts: string; genTime?: string }[];
}

function event(index: number, tsReceived: string): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: tsReceived,
    ts_received: tsReceived,
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  };
}

/** Builds the chain, checkpoints and tokens of `plan`, exports it, and returns the zip's path. */
async function archiveOf(plan: Plan): Promise<string> {
  counter += 1;
  // The signer dates each checkpoint by its own clock, so the test sets that
  // clock to the time the plan wants the checkpoint to declare.
  let signerClock = "2026-03-29T14:00:00.000Z";
  const signer = createTestSigner({ now: () => new Date(signerClock) });
  const store = ReceiptStore.open(join(directory, `chain-${counter}.db`), signer);
  try {
    await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");
    const pending = [...plan.checkpoints].sort((a, b) => a.treeSize - b.treeSize);
    for (let seq = 1; seq <= plan.received.length; seq += 1) {
      await store.append(event(seq, plan.received[seq - 1] as string));
      while (pending[0] !== undefined && pending[0].treeSize === seq + 1) {
        const wanted = pending.shift() as Plan["checkpoints"][number];
        signerClock = wanted.ts;
        const checkpoint = await store.createCheckpoint(SYSTEM);
        if (checkpoint === null) throw new Error("no checkpoint");
        if (wanted.genTime !== undefined) {
          const token = tsa.stampAt(checkpoint.checkpoint.root_hash, wanted.genTime);
          await store.recordTimestamp(checkpoint.id, "http://tsa.test/", token.toString("base64"), wanted.genTime);
        }
      }
    }
    const archive = await buildArchive({
      systemId: SYSTEM,
      receipts: store.readChain(SYSTEM),
      checkpoints: store.readCheckpoints(SYSTEM).map((stored) => ({ stored, timestamps: store.readTimestamps(stored.id) })),
      keys: [{ key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 }],
      exportedAt: "2026-03-29T20:00:00.000Z",
    });
    const path = join(directory, `archive-${counter}.zip`);
    writeFileSync(path, archive.zip);
    return path;
  } finally {
    store.close();
  }
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function verify(path: string, ...extra: string[]): Run {
  const run = spawnSync(TSX, [VERIFY_CLI, path, "--tsa-ca", tsa.caFile, ...extra], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** Receipts seq 1..n, one minute apart from 14:01. */
function minutes(n: number): string[] {
  return Array.from({ length: n }, (_, index) => `2026-03-29T14:${String(index + 1).padStart(2, "0")}:00.000Z`);
}

describe("an archive anchored on time", () => {
  let path: string;
  beforeAll(async () => {
    // Receipts 0..11; checkpoints over 4, 8 and 10 receipts stamped seconds
    // after their own time, the gap between the last two three hours.
    path = await archiveOf({
      received: minutes(11),
      checkpoints: [
        { treeSize: 4, ts: "2026-03-29T15:00:00.000Z", genTime: "2026-03-29T15:00:04.000Z" },
        { treeSize: 8, ts: "2026-03-29T16:00:00.000Z", genTime: "2026-03-29T16:00:03.000Z" },
        { treeSize: 10, ts: "2026-03-29T19:00:00.000Z", genTime: "2026-03-29T19:00:05.000Z" },
      ],
    });
  }, 60_000);

  it("verifies, and opens the report with what the timestamps prove", () => {
    const run = verify(path);
    expect(run.code, run.stderr).toBe(0);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toMatch(/^OK, with a warning {2}acme-support-bot: 12 receipts/);
    expect(lines[1]).toBe("    timestamps: 3 checkpoint(s) proven by a timestamp, 0 timestamped late (more than 60 min after their own time)");
    expect(lines[2]).toBe(
      "    longest gap between two timestamps: 3 h (2026-03-29T16:00:03.000Z to 2026-03-29T19:00:05.000Z)",
    );
    expect(lines[3]).toBe("    receipts at the end not yet timestamped: 2 (seq 10..11)");
  }, 30_000);

  it("gives each checkpoint its proven time, and each receipt the time it existed by", () => {
    const run = verify(path);
    expect(run.stdout).toContain("    checkpoint over 4 receipts: proven 2026-03-29T15:00:04.000Z (declared 2026-03-29T15:00:00.000Z)\n");
    expect(run.stdout).toContain("    checkpoint over 10 receipts: proven 2026-03-29T19:00:05.000Z (declared 2026-03-29T19:00:00.000Z)\n");
    expect(run.stdout).toContain("    seq 0..3: existed no later than 2026-03-29T15:00:04.000Z\n");
    expect(run.stdout).toContain("    seq 4..7: existed no later than 2026-03-29T16:00:03.000Z\n");
    expect(run.stdout).toContain("    seq 8..9: existed no later than 2026-03-29T19:00:05.000Z\n");
    expect(run.stdout).toContain("    seq 10..11: not yet timestamped\n");
  }, 30_000);

  it("says a time is only attested, not proven, when the token's signature was not checked", () => {
    const run = spawnSync(TSX, [VERIFY_CLI, path], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain(
      "    checkpoint over 4 receipts: attested 2026-03-29T15:00:04.000Z, signature not checked (declared 2026-03-29T15:00:00.000Z)\n",
    );
  }, 30_000);
});

describe("a receipt received after a timestamp that includes it", () => {
  let path: string;
  beforeAll(async () => {
    // The checkpoint over seq 0..4 is dated 14:02 by the authority, yet the
    // server says it received seq 3 at 14:12 and seq 4 at 14:13.
    path = await archiveOf({
      received: ["2026-03-29T14:01:00.000Z", "2026-03-29T14:01:30.000Z", "2026-03-29T14:12:00.000Z", "2026-03-29T14:13:00.000Z", "2026-03-29T14:20:00.000Z"],
      checkpoints: [{ treeSize: 5, ts: "2026-03-29T14:02:00.000Z", genTime: "2026-03-29T14:02:00.000Z" }],
    });
  }, 60_000);

  it("fails, naming the first such receipt", () => {
    const run = verify(path);
    expect(run.code, run.stdout).toBe(1);
    expect(run.stderr).toContain("FAILED  anchor-time at receipts.jsonl:4\n");
    expect(run.stderr).toContain("receipt seq 3 was received at 2026-03-29T14:12:00.000Z");
  }, 30_000);

  it("passes with a clock tolerance wide enough", () => {
    expect(verify(path, "--clock-tolerance", "11").code).toBe(0);
    expect(verify(path, "--clock-tolerance", "10").code).toBe(1);
  }, 30_000);
});

describe("timestamps that go backwards", () => {
  it("fail at the checkpoint whose time is older than a smaller tree's", async () => {
    const path = await archiveOf({
      received: minutes(7),
      checkpoints: [
        { treeSize: 4, ts: "2026-03-29T15:00:00.000Z", genTime: "2026-03-29T15:00:04.000Z" },
        { treeSize: 8, ts: "2026-03-29T16:00:00.000Z", genTime: "2026-03-29T14:59:00.000Z" },
      ],
    });
    const run = verify(path);
    expect(run.code, run.stdout).toBe(1);
    expect(run.stderr).toContain("FAILED  anchor-order at checkpoints.jsonl:2\n");
  }, 60_000);
});

describe("a checkpoint timestamped long after its own time", () => {
  let path: string;
  beforeAll(async () => {
    path = await archiveOf({
      received: minutes(7),
      checkpoints: [
        { treeSize: 4, ts: "2026-03-29T15:00:00.000Z", genTime: "2026-03-29T15:00:04.000Z" },
        { treeSize: 8, ts: "2026-03-29T16:00:00.000Z", genTime: "2026-03-29T18:30:00.000Z" },
      ],
    });
  }, 60_000);

  it("is a warning, and the exit code stays 0", () => {
    const run = verify(path);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^OK, with a warning {2}/);
    expect(run.stdout).toContain("timestamps: 2 checkpoint(s) proven by a timestamp, 1 timestamped late");
    expect(run.stdout).toContain(
      "    warning: anchor-delay at checkpoints.jsonl:2: the checkpoint over 8 receipts declares 2026-03-29T16:00:00.000Z, " +
        "but the authority dates it 2026-03-29T18:30:00.000Z, 2 h 30 min later (more than 60 min)",
    );
  }, 30_000);

  it("is an error with --strict", () => {
    const run = verify(path, "--strict");
    expect(run.code, run.stdout).toBe(1);
    expect(run.stderr).toContain("FAILED  anchor-delay at checkpoints.jsonl:2 (--strict)\n");
  }, 30_000);

  it("follows --max-anchor-delay", () => {
    const run = verify(path, "--max-anchor-delay", "150", "--strict");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^OK {2}/);
    expect(verify(path, "--max-anchor-delay", "149", "--strict").code).toBe(1);
  }, 30_000);
});

describe("the options", () => {
  it("refuse a value that is not a whole number of minutes", async () => {
    const path = await archiveOf({ received: minutes(2), checkpoints: [] });
    for (const [option, value] of [["--max-anchor-delay", "abc"], ["--clock-tolerance", "-1"], ["--max-anchor-delay", "1.5"]]) {
      const run = verify(path, option as string, value as string);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(`${option as string} takes a whole number of minutes`);
    }
  }, 60_000);
});

describe("the evidence file's own report", () => {
  it("gives the same proven times as the verifier, in the PDF and in VERIFY.md", async (context) => {
    const path = await archiveOf({
      received: minutes(7),
      checkpoints: [
        { treeSize: 4, ts: "2026-03-29T15:00:00.000Z", genTime: "2026-03-29T15:00:04.000Z" },
        { treeSize: 8, ts: "2026-03-29T16:00:00.000Z", genTime: "2026-03-29T18:30:00.000Z" },
      ],
    });
    const files = new Map(readZip(new Uint8Array(readFileSync(path))).map((entry) => [entry.name, entry.data]));

    const verifyMd = new TextDecoder().decode(files.get("VERIFY.md"));
    expect(verifyMd).toContain("1 checkpoint(s) timestamped late");
    expect(verifyMd).toContain("seq 0..3: existed no later than 2026-03-29T15:00:04.000Z");
    expect(verifyMd).toContain("seq 4..7: existed no later than 2026-03-29T18:30:00.000Z");

    const pdfPath = join(directory, "report.pdf");
    writeFileSync(pdfPath, files.get("report.pdf") ?? new Uint8Array());
    let text: string;
    try {
      text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
    } catch {
      context.skip(); // no pdftotext here; VERIFY.md above says the same
      return;
    }
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("2 checkpoint(s) proven by a timestamp, 1 timestamped late");
    expect(flat).toContain("Longest gap between two timestamps 3 h 29 min");
    expect(flat).toContain("Receipts at the end not yet timestamped none");
    expect(flat).toContain("proven 2026-03-29T15:00:04.000Z");
    expect(flat).toContain("seq 0..3 existed no later than 2026-03-29T15:00:04.000Z");
    expect(flat).toContain("seq 4..7 existed no later than 2026-03-29T18:30:00.000Z");
  }, 60_000);
});
