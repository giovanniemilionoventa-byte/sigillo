import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentFingerprints, readZip, TEXT_CANON_1, textSha256, type Receipt } from "@sigillo/core";
import { generateKeyFile, startSignerDaemon, type SignerDaemon } from "../../signer/src/index.js";
import { buildArchive } from "../src/export/archive.js";
import { SignerClient } from "../src/signer/client.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createLocalTsa, type LocalTsa } from "./helpers/local-tsa.js";

/**
 * Two features built in parallel, made to work together: the signer that
 * keeps its own record of every chain (protocol 2, over its real socket, with
 * its clock check on) and the proven times of the anchors (genTime).
 *
 * One chain moves from receipt version 1 to 2 (an artifact and a model) and
 * to 3 (an artifact with a text fingerprint). Every receipt is signed by the
 * signer process's daemon over its Unix socket, which builds the checkpoints
 * itself and dates them by its own clock; the local authority dates the
 * tokens. The export is then checked by the real `sigillo-verify`, and its
 * report.pdf read back.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const VERIFY_CLI = join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts");
const SYSTEM = "selezione-cv";
const DOCUMENT = new TextEncoder().encode("Curriculum di prova\nEsperienza: 5 anni\n");

let directory: string;
let tsa: LocalTsa;
let counter = 0;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-crossing-"));
  tsa = createLocalTsa();
}, 60_000);

afterAll(() => {
  tsa.close();
  rmSync(directory, { recursive: true, force: true });
});

const plainArtifact = { role: "input" as const, label: "cv.pdf", media_type: "application/pdf", sha256: "ab".repeat(32) };
const textArtifact = {
  role: "input" as const,
  label: "cv.txt",
  media_type: "text/plain",
  sha256: documentFingerprints(DOCUMENT).bytes,
  text: { canon: TEXT_CANON_1, sha256: textSha256(DOCUMENT) ?? "" },
};

/** seq 1..5: v1, v2 (artifact and model), v3 (text fingerprint), v2, v3. */
const EVENTS: Partial<ChainEvent>[] = [
  {},
  { artifacts: [plainArtifact], model: { name: "qwen2.5:3b", provider: "ollama", digest: null } },
  { artifacts: [textArtifact] },
  { model: { name: "qwen2.5:3b", provider: "ollama", digest: null } },
  { artifacts: [textArtifact] },
];

interface Plan {
  /** ts_received of seq 1..5. */
  received: string[];
  /** Checkpoints after seq 2 (tree 3) and after seq 5 (tree 6): the signer's time and the authority's. */
  checkpoints: [{ at: string; genTime: string }, { at: string; genTime: string }];
}

/** The chain of `plan`, through a real signer daemon over its socket, exported. */
async function archiveOf(plan: Plan): Promise<{ path: string; receipts: Receipt[]; files: Map<string, Uint8Array> }> {
  counter += 1;
  const base = join(directory, `run-${counter}`);
  // The signer's clock moves with the receipts, and its clock check is on
  // (the default five minutes): every ts_received is close to its own time.
  let signerClock = new Date("2026-03-29T14:00:00.000Z");
  let daemon: SignerDaemon | undefined;
  let client: SignerClient | undefined;
  let store: ReceiptStore | undefined;
  try {
    daemon = await startSignerDaemon({
      socketPath: `${base}.sock`,
      stateDir: `${base}-signer-state`,
      now: () => signerClock,
      key: generateKeyFile(`${base}.key`),
    });
    client = await SignerClient.connect(`${base}.sock`);
    store = ReceiptStore.open(`${base}.db`, client);
    await store.createSystem(SYSTEM, "2026-03-29T14:00:00.000Z");

    for (const [index, extra] of EVENTS.entries()) {
      const tsReceived = plan.received[index] as string;
      signerClock = new Date(tsReceived);
      await store.append({
        system_id: SYSTEM,
        ts_event: tsReceived,
        ts_received: tsReceived,
        actor: { agent: "screener" },
        action: { kind: "llm_call", name: `valuta-${index + 1}` },
        input_hash: null,
        output_hash: null,
        outcome: "ok",
        source: { type: "sdk" },
        ...extra,
      });
      const checkpoint = index === 1 ? plan.checkpoints[0] : index === 4 ? plan.checkpoints[1] : undefined;
      if (checkpoint !== undefined) {
        signerClock = new Date(checkpoint.at);
        const written = await store.createCheckpoint(SYSTEM);
        if (written === null) throw new Error("no checkpoint");
        expect(written.checkpoint.ts).toBe(checkpoint.at); // the signer's time, not the server's
        const token = tsa.stampAt(written.checkpoint.root_hash, checkpoint.genTime);
        await store.recordTimestamp(written.id, "http://tsa.test/", token.toString("base64"), checkpoint.genTime);
      }
    }

    const archive = await buildArchive({
      systemId: SYSTEM,
      receipts: store.readChain(SYSTEM),
      checkpoints: store.readCheckpoints(SYSTEM).map((stored) => ({ stored, timestamps: store?.readTimestamps(stored.id) ?? [] })),
      keys: [{ key_id: client.keyId, public_key_base64: client.publicKeyBase64 }],
      exportedAt: "2026-03-29T18:00:00.000Z",
    });
    const path = `${base}.zip`;
    writeFileSync(path, archive.zip);
    return {
      path,
      receipts: store.readChain(SYSTEM),
      files: new Map(readZip(archive.zip).map((entry) => [entry.name, entry.data])),
    };
  } finally {
    store?.close();
    client?.close();
    await daemon?.close();
  }
}

function verify(path: string, ...extra: string[]): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync(TSX, [VERIFY_CLI, path, "--tsa-ca", tsa.caFile, ...extra], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

const ON_TIME: Plan = {
  received: ["2026-03-29T14:01:00.000Z", "2026-03-29T14:02:00.000Z", "2026-03-29T14:20:00.000Z", "2026-03-29T14:21:00.000Z", "2026-03-29T14:22:00.000Z"],
  checkpoints: [
    { at: "2026-03-29T14:05:00.000Z", genTime: "2026-03-29T14:05:03.000Z" },
    { at: "2026-03-29T14:30:00.000Z", genTime: "2026-03-29T14:30:04.000Z" },
  ],
};

describe("receipts v1, v2 and v3, signed by the signer over its socket, with proven times", () => {
  let run: Awaited<ReturnType<typeof archiveOf>>;
  beforeAll(async () => {
    run = await archiveOf(ON_TIME);
  }, 60_000);

  it("are all accepted and signed by the signer, v3 text fingerprints included", () => {
    expect(run.receipts.map((receipt) => receipt.v)).toEqual([1, 1, 2, 3, 2, 3]);
    const v3 = run.receipts[3];
    expect(v3?.v === 3 ? v3.artifacts?.[0]?.text?.sha256 : undefined).toBe(textSha256(DOCUMENT));
  });

  it("verify in full under --strict, each version given the time it existed by", () => {
    const result = verify(run.path, "--strict");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^OK {2}selezione-cv: 6 receipts/);
    expect(result.stdout).toContain("3 document fingerprint(s) indexed");
    expect(result.stdout).toContain("timestamps: 2 checkpoint(s) proven by a timestamp, 0 timestamped late");
    // seq 2 is v2; seq 3 and 5 are v3, seq 4 v2.
    expect(result.stdout).toContain("seq 0..2: existed no later than 2026-03-29T14:05:03.000Z\n");
    expect(result.stdout).toContain("seq 3..5: existed no later than 2026-03-29T14:30:04.000Z\n");
    // The checkpoints' own times are the signer's.
    expect(result.stdout).toContain("checkpoint over 3 receipts: proven 2026-03-29T14:05:03.000Z (declared 2026-03-29T14:05:00.000Z)");
  }, 30_000);

  it("carry the proven times into report.pdf and VERIFY.md, next to the document fingerprints", (context) => {
    const verifyMd = new TextDecoder().decode(run.files.get("VERIFY.md"));
    expect(verifyMd).toContain("seq 3..5: existed no later than 2026-03-29T14:30:04.000Z");
    expect(verifyMd).toContain("sigillo-verify doc <this archive> <the file>");

    const pdfPath = join(directory, "crossing.pdf");
    writeFileSync(pdfPath, run.files.get("report.pdf") ?? new Uint8Array());
    let text: string;
    try {
      text = execFileSync("pdftotext", [pdfPath, "-"], { encoding: "utf8" });
    } catch {
      context.skip();
      return;
    }
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("2 checkpoint(s) proven by a timestamp, 0 timestamped late");
    expect(flat).toContain("Receipts seq 0..2 existed no later than 2026-03-29T14:05:03.000Z");
    expect(flat).toContain("Receipts seq 3..5 existed no later than 2026-03-29T14:30:04.000Z");
    expect(flat).toContain("3 document fingerprint(s) are recorded");
  }, 30_000);
});

describe("the time checks, on v2 and v3 receipts alike", () => {
  it("fail a v2 receipt received after the timestamp that includes it", async () => {
    // seq 2 (v2) received 14:20, in a tree the authority dated 14:05.
    const run = await archiveOf({
      received: ["2026-03-29T14:01:00.000Z", "2026-03-29T14:20:00.000Z", "2026-03-29T14:21:00.000Z", "2026-03-29T14:22:00.000Z", "2026-03-29T14:23:00.000Z"],
      checkpoints: [
        { at: "2026-03-29T14:20:30.000Z", genTime: "2026-03-29T14:05:00.000Z" },
        { at: "2026-03-29T14:30:00.000Z", genTime: "2026-03-29T14:30:04.000Z" },
      ],
    });
    expect(run.receipts[2]?.v).toBe(2);
    const result = verify(run.path);
    expect(result.code, result.stdout).toBe(1);
    expect(result.stderr).toContain("FAILED  anchor-time at receipts.jsonl:3\n");
    expect(result.stderr).toContain("receipt seq 2 was received at 2026-03-29T14:20:00.000Z");
  }, 60_000);

  it("fail a v3 receipt received after the timestamp that includes it", async () => {
    // seq 5 (v3) received 14:50, in a tree the authority dated 14:30.
    const run = await archiveOf({
      received: ["2026-03-29T14:01:00.000Z", "2026-03-29T14:02:00.000Z", "2026-03-29T14:20:00.000Z", "2026-03-29T14:21:00.000Z", "2026-03-29T14:50:00.000Z"],
      checkpoints: [
        { at: "2026-03-29T14:05:00.000Z", genTime: "2026-03-29T14:05:03.000Z" },
        { at: "2026-03-29T14:50:30.000Z", genTime: "2026-03-29T14:30:00.000Z" },
      ],
    });
    expect(run.receipts[5]?.v).toBe(3);
    const result = verify(run.path);
    expect(result.code, result.stdout).toBe(1);
    expect(result.stderr).toContain("FAILED  anchor-time at receipts.jsonl:6\n");
  }, 60_000);

  it("warn about a late anchor over v3 receipts, and fail it under --strict", async () => {
    const run = await archiveOf({
      ...ON_TIME,
      checkpoints: [ON_TIME.checkpoints[0], { at: "2026-03-29T14:30:00.000Z", genTime: "2026-03-29T16:00:00.000Z" }],
    });
    const result = verify(run.path);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("warning: anchor-delay at checkpoints.jsonl:2");
    expect(verify(run.path, "--strict").code).toBe(1);
  }, 60_000);
});
