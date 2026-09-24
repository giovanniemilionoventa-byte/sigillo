import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalJson,
  createZip,
  readZip,
  signCheckpoint,
  type Receipt,
  type ZipEntry,
} from "@sigillo/core";
import { verifyBundle, type Bundle, type VerificationCheck } from "@sigillo/verifier";
import { createHash, generateKeyPairSync } from "node:crypto";
import { buildArchive } from "../src/export/archive.js";
import { requestTimestampWithRetry } from "../src/timestamp/rfc3161.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SYSTEM = "acme-support-bot";
const EXPORTED_AT = "2026-03-29T16:00:00.000Z";
/** A DER SEQUENCE standing in for a token: these tests are about the archive. */
const FAKE_TOKEN = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]).toString("base64");

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-archive-"));
  signer = createTestSigner();
  store = ReceiptStore.open(join(directory, "sigillo.db"), signer);
  await store.createSystem(SYSTEM, "2026-03-29T14:30:00.000Z");
  for (let index = 1; index < 12; index += 1) {
    await store.append(event(index));
  }
  await store.createCheckpoint(SYSTEM, "2026-03-29T15:00:00.000Z");
});

/** Anchors the checkpoint with whatever token the test wants to study. */
async function anchor(tokenBase64: string, tsaUrl = "https://freetsa.org/tsr"): Promise<void> {
  const checkpoint = store.latestCheckpoint(SYSTEM);
  if (checkpoint === null) throw new Error("no checkpoint to anchor");
  await store.recordTimestamp(checkpoint.id, tsaUrl, tokenBase64, "2026-03-29T15:00:05.000Z");
}

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function event(index: number): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: "2026-03-29T14:30:01.005Z",
    actor: { agent: "planner" },
    action: { kind: index % 3 === 0 ? "llm_call" : "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  };
}

async function build(): Promise<Awaited<ReturnType<typeof buildArchive>>> {
  return buildArchive({
    systemId: SYSTEM,
    receipts: store.readChain(SYSTEM),
    checkpoints: store.readCheckpoints(SYSTEM).map((stored) => ({
      stored,
      timestamps: store.readTimestamps(stored.id),
    })),
    keys: [{ key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 }],
    exportedAt: EXPORTED_AT,
  });
}

function filesOf(archive: Uint8Array): Map<string, Uint8Array> {
  return new Map(readZip(archive).map((entry) => [entry.name, entry.data]));
}

const decode = (bytes: Uint8Array | undefined): string =>
  new TextDecoder().decode(bytes ?? new Uint8Array());

function bundleFrom(files: Map<string, Uint8Array>): Bundle {
  return {
    manifestJson: decode(files.get("manifest.json")),
    receiptsJsonl: decode(files.get("receipts.jsonl")),
    checkpointsJsonl: decode(files.get("checkpoints.jsonl")),
  };
}

/** Rebuilds the archive after changing one file, preserving the rest. */
function rebuild(files: Map<string, Uint8Array>, changes: Record<string, Uint8Array | null>): Bundle {
  const copy = new Map(files);
  for (const [name, data] of Object.entries(changes)) {
    if (data === null) copy.delete(name);
    else copy.set(name, data);
  }
  return bundleFrom(copy);
}

/** Changes the last character of a digest to one that is certainly different. */
function flipLastHex(hex: string): string {
  return `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
}

function expectFailure(bundle: Bundle, check: VerificationCheck): string {
  const result = verifyBundle(bundle);
  expect(result.ok, `expected the ${check} check to fail`).toBe(false);
  if (result.ok) return "";
  expect(result.check).toBe(check);
  return result.detail;
}

describe("the archive a full export produces", () => {
  it("contains every part an auditor needs", async () => {
    await anchor(FAKE_TOKEN);
    const files = filesOf((await build()).zip);
    expect([...files.keys()].sort()).toEqual([
      "VERIFY.md",
      "artifacts-index.jsonl",
      "checkpoints.jsonl",
      "manifest.json",
      "receipts.jsonl",
      "report.pdf",
      "timestamps/checkpoint-12-1.tsr",
    ]);
  });

  it("indexes every artifact a receipt declares, one line each", async () => {
    await store.append({
      ...event(12),
      artifacts: [
        { role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) },
        { role: "output", label: "email di risposta", media_type: "text/plain", sha256: "b".repeat(64) },
      ],
    });
    const files = filesOf((await build()).zip);
    const lines = decode(files.get("artifacts-index.jsonl"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([
      { sha256: "a".repeat(64), seq: 12, role: "input", label: "curriculum" },
      { sha256: "b".repeat(64), seq: 12, role: "output", label: "email di risposta" },
    ]);
  });

  it("verifies, and says what it verified", async () => {
    const archive = await build();
    expect(archive.verification.ok).toBe(true);
    if (!archive.verification.ok) return;

    expect(archive.verification.summary).toMatchObject({
      system_id: SYSTEM,
      receipts: 12,
      checkpoints: 1,
      roots_recomputed: 1,
      inclusion_proofs: 2,
    });
  });

  it("declares in the manifest exactly what it holds", async () => {
    await anchor(FAKE_TOKEN);
    const archive = await build();
    expect(archive.manifest.counts).toEqual({ receipts: 12, checkpoints: 1, timestamps: 1 });
    expect(archive.manifest.range).toMatchObject({ from_seq: 0, to_seq: 11 });
  });

  it("carries the timestamp token byte for byte", async () => {
    await anchor(FAKE_TOKEN);
    const files = filesOf((await build()).zip);
    expect(Buffer.from(files.get("timestamps/checkpoint-12-1.tsr") ?? new Uint8Array())).toEqual(
      Buffer.from(FAKE_TOKEN, "base64"),
    );
  });

  it("writes a report that is a real PDF and names the system", async () => {
    const files = filesOf((await build()).zip);
    const report = files.get("report.pdf");
    expect(report?.length).toBeGreaterThan(1000);
    expect(Buffer.from(report ?? new Uint8Array()).subarray(0, 5).toString()).toBe("%PDF-");

    const path = join(directory, "report.pdf");
    writeFileSync(path, report ?? new Uint8Array());
    let text = "";
    try {
      text = execFileSync("pdftotext", [path, "-"], { encoding: "utf8" });
    } catch {
      return; // no pdftotext here; the header check above still holds
    }
    expect(text).toContain(SYSTEM);
    expect(text).toContain("Article 12(2)");
    expect(text).toContain("post-market monitoring");
    expect(text).toContain("sigillo-verify");
    // This chain has no artifacts, so the report says there is nothing to look up.
    expect(text).toContain("nothing to look up");
  });

  it("points to sigillo-verify doc in the report once a receipt names a document", async () => {
    await store.append({
      ...event(12),
      artifacts: [
        { role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) },
      ],
    });
    const files = filesOf((await build()).zip);
    const report = files.get("report.pdf");
    const path = join(directory, "report-with-artifact.pdf");
    writeFileSync(path, report ?? new Uint8Array());
    let text = "";
    try {
      text = execFileSync("pdftotext", [path, "-"], { encoding: "utf8" });
    } catch {
      return; // no pdftotext here; the zip-level test above already covers this file
    }
    expect(text).toContain("sigillo-verify doc");
    expect(text).toContain("1 document fingerprint");
  });

  it("writes instructions that stand on their own", async () => {
    await anchor(FAKE_TOKEN);
    const files = filesOf((await build()).zip);
    const verify = decode(files.get("VERIFY.md"));
    expect(verify).toContain(SYSTEM);
    expect(verify).toContain("sigillo-verify");
    expect(verify).toContain("openssl dgst -sha256");
    expect(verify).toContain("openssl ts -verify");
    expect(verify).toContain(signer.keyId);
    expect(verify).toContain(signer.publicKeyBase64);
    // It must be honest about what a log cannot prove (review point 3).
    expect(verify).toContain("that everything the system did was recorded");
    expect(verify).toContain("that the key is the operator's");
    expect(verify).toContain("that nothing was cut from the end");
    expect(verify).toContain(`--key-id ${signer.keyId}`);
    expect(verify).toContain("--previous");
    expect(verify).not.toContain("Nothing here asks you to trust");
    expect(verify).not.toContain("any\nremoval");
  });

  it("says plainly when nothing anchors the archive in time", async () => {
    const files = filesOf((await build()).zip);
    const verify = decode(files.get("VERIFY.md"));
    expect(verify).toContain("carries no timestamp tokens");
    expect(verify).not.toContain("openssl ts -verify -digest");
  });

  it("carries no plaintext of anything the agent handled", async () => {
    await store.append({
      ...event(99),
      action: { kind: "tool_call", name: "search_orders" },
      input_hash: "a".repeat(64),
    });
    const files = filesOf((await build()).zip);
    const everything = decode(files.get("receipts.jsonl"));
    expect(everything).toContain("search_orders");
    expect(everything).not.toContain("prompt");
  });
});

describe("an export of a window of the chain", () => {
  // Review point 4. A window that does not start at seq 0 used to carry its
  // checkpoints with no inclusion proof at all: nothing tied the timestamps in
  // the archive to the receipts in it, and the verifier did not say so.

  /** Appends up to `count` receipts in all, then checkpoints. */
  async function growTo(count: number, at: string): Promise<void> {
    for (let index = store.readChain(SYSTEM).length; index < count; index += 1) {
      await store.append(event(index));
    }
    await store.createCheckpoint(SYSTEM, at);
  }

  async function buildWindow(fromSeq: number, toSeq: number): Promise<Awaited<ReturnType<typeof buildArchive>>> {
    return buildArchive({
      systemId: SYSTEM,
      receipts: store.readChain(SYSTEM).filter((receipt) => receipt.seq >= fromSeq && receipt.seq <= toSeq),
      checkpoints: store.readCheckpoints(SYSTEM).map((stored) => ({
        stored,
        timestamps: store.readTimestamps(stored.id),
      })),
      chainLeaves: store.readReceiptHashes(SYSTEM),
      keys: [{ key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 }],
      exportedAt: EXPORTED_AT,
    });
  }

  function entriesOf(archive: Awaited<ReturnType<typeof buildArchive>>): { tree: number; proved: number[] }[] {
    return decode(filesOf(archive.zip).get("checkpoints.jsonl"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { checkpoint: { tree_size: number }; proofs: { seq: number }[] })
      .map((entry) => ({ tree: entry.checkpoint.tree_size, proved: entry.proofs.map((proof) => proof.seq) }));
  }

  it("proves the window's first and last receipt against the checkpoint that covers them", async () => {
    // beforeEach: 12 receipts and a checkpoint over all 12.
    const archive = await buildWindow(4, 7);
    expect(entriesOf(archive)).toEqual([{ tree: 12, proved: [4, 7] }]);
    expect(archive.verification.ok).toBe(true);
    if (archive.verification.ok) {
      expect(archive.verification.summary.inclusion_proofs).toBe(2);
      expect(archive.verification.summary.unlinked_checkpoints).toBe(0);
    }
  });

  it("carries only the checkpoints that cover a receipt of the window, up to the first that covers it all", async () => {
    await growTo(20, "2026-03-29T15:30:00.000Z");
    await growTo(25, "2026-03-29T15:45:00.000Z");
    // Checkpoints over 12, 20 and 25 receipts. The window 10..15 is covered
    // in part by the first and wholly by the second; the third adds nothing.
    expect(entriesOf(await buildWindow(10, 15))).toEqual([
      { tree: 12, proved: [10, 11] },
      { tree: 20, proved: [10, 15] },
    ]);
    // A window after the first checkpoint leaves it out.
    expect(entriesOf(await buildWindow(13, 18))).toEqual([{ tree: 20, proved: [13, 18] }]);
  });

  it("is caught when one of those proofs is altered", async () => {
    const files = filesOf((await buildWindow(4, 7)).zip);
    const entry = JSON.parse(decode(files.get("checkpoints.jsonl")).trim()) as {
      proofs: { path: string[] }[];
    };
    const proof = entry.proofs[0];
    if (proof === undefined || proof.path[0] === undefined) throw new Error("no proof to alter");
    proof.path[0] = flipLastHex(proof.path[0]);
    expectFailure(
      { ...bundleFrom(files), checkpointsJsonl: `${JSON.stringify(entry)}\n` },
      "inclusion-proof",
    );
  });

  it("is verified with the checkpoint reported as unlinked when no proof ties it to the window", async () => {
    // An archive produced before this change: accepted, because it was
    // honestly produced, but the verifier says the checkpoint proves nothing
    // about these receipts (the committente's open decision: a warning).
    const archive = await buildArchive({
      systemId: SYSTEM,
      receipts: store.readChain(SYSTEM).filter((receipt) => receipt.seq >= 4 && receipt.seq <= 7),
      checkpoints: store.readCheckpoints(SYSTEM).map((stored) => ({ stored, timestamps: [] })),
      keys: [{ key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 }],
      exportedAt: EXPORTED_AT,
    });
    expect(archive.verification.ok).toBe(true);
    if (archive.verification.ok) {
      expect(archive.verification.summary.inclusion_proofs).toBe(0);
      expect(archive.verification.summary.unlinked_checkpoints).toBe(1);
    }
  });
});

describe("tampering with the archive", () => {
  it("is caught when a receipt changes", async () => {
    const files = filesOf((await build()).zip);
    const lines = decode(files.get("receipts.jsonl")).split("\n").filter(Boolean);
    const target = JSON.parse(lines[4] ?? "{}") as Receipt;
    lines[4] = canonicalJson({ ...target, outcome: "error" });

    const detail = expectFailure(
      rebuild(files, { "receipts.jsonl": new TextEncoder().encode(`${lines.join("\n")}\n`) }),
      "chain-link",
    );
    expect(detail).toContain("seq 5");
  });

  it("is caught when the last receipt changes, where the Merkle root covers it", async () => {
    const files = filesOf((await build()).zip);
    const lines = decode(files.get("receipts.jsonl")).split("\n").filter(Boolean);
    const target = JSON.parse(lines[11] ?? "{}") as Receipt;
    lines[11] = canonicalJson({ ...target, outcome: "error" });

    // The signature is checked before the Merkle root, so that is what reports.
    expectFailure(
      rebuild(files, { "receipts.jsonl": new TextEncoder().encode(`${lines.join("\n")}\n`) }),
      "signature",
    );
  });

  it("is caught when a checkpoint's root is changed", async () => {
    const files = filesOf((await build()).zip);
    const entry = JSON.parse(decode(files.get("checkpoints.jsonl")).trim()) as {
      checkpoint: { root_hash: string };
    };
    entry.checkpoint.root_hash = flipLastHex(entry.checkpoint.root_hash);

    expectFailure(
      rebuild(files, {
        "checkpoints.jsonl": new TextEncoder().encode(`${JSON.stringify(entry)}\n`),
      }),
      "checkpoint-signature",
    );
  });

  it("is caught when a checkpoint is re-signed by another key", async () => {
    const files = filesOf((await build()).zip);
    const entry = JSON.parse(decode(files.get("checkpoints.jsonl")).trim()) as {
      checkpoint: Record<string, unknown>;
    };
    const stranger = generateKeyPairSync("ed25519");
    const { sig: _sig, ...unsigned } = entry.checkpoint;
    // Same content, same announced key_id, signed by a key that is not it.
    entry.checkpoint = signCheckpoint(
      unsigned as Parameters<typeof signCheckpoint>[0],
      stranger.privateKey,
    ) as unknown as Record<string, unknown>;

    expectFailure(
      rebuild(files, {
        "checkpoints.jsonl": new TextEncoder().encode(`${JSON.stringify(entry)}\n`),
      }),
      "checkpoint-signature",
    );
  });

  it("is caught when an inclusion proof is altered", async () => {
    const files = filesOf((await build()).zip);
    const entry = JSON.parse(decode(files.get("checkpoints.jsonl")).trim()) as {
      proofs: { path: string[] }[];
    };
    const step = entry.proofs[0]?.path[0];
    expect(step).toBeDefined();
    if (step === undefined) return;
    if (entry.proofs[0] !== undefined) entry.proofs[0].path[0] = flipLastHex(step);

    const detail = expectFailure(
      rebuild(files, {
        "checkpoints.jsonl": new TextEncoder().encode(`${JSON.stringify(entry)}\n`),
      }),
      "inclusion-proof",
    );
    expect(detail).toContain("rebuilds");
  });

  it("is caught when a proof is claimed for a receipt that is not there", async () => {
    const files = filesOf((await build()).zip);
    const entry = JSON.parse(decode(files.get("checkpoints.jsonl")).trim()) as {
      proofs: { seq: number }[];
    };
    if (entry.proofs[0] !== undefined) entry.proofs[0].seq = 99;

    expectFailure(
      rebuild(files, {
        "checkpoints.jsonl": new TextEncoder().encode(`${JSON.stringify(entry)}\n`),
      }),
      "inclusion-proof",
    );
  });

  it("is caught when the manifest's counts are changed", async () => {
    await anchor(FAKE_TOKEN);
    const files = filesOf((await build()).zip);
    for (const [field, value] of [
      ["receipts", 11],
      ["checkpoints", 2],
      ["timestamps", 5],
    ] as const) {
      const manifest = JSON.parse(decode(files.get("manifest.json"))) as {
        counts: Record<string, number>;
      };
      manifest.counts[field] = value;
      expectFailure(
        rebuild(files, { "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)) }),
        "range",
      );
    }
  });

  it("is caught when a checkpoint is removed to hide a period", async () => {
    const files = filesOf((await build()).zip);
    expectFailure(rebuild(files, { "checkpoints.jsonl": new TextEncoder().encode("") }), "range");
  });

  it("is caught when the zip itself is edited", async () => {
    const archive = await build();
    const tampered = Uint8Array.from(archive.zip);
    // Flip a byte in the middle of the compressed data.
    const position = Math.floor(tampered.length / 2);
    tampered[position] = (tampered[position] ?? 0) ^ 0xff;
    expect(() => readZip(tampered)).toThrow();
  });

  it("is caught when a file is removed from the zip", async () => {
    const archive = await build();
    const kept: ZipEntry[] = readZip(archive.zip).filter((entry) => entry.name !== "receipts.jsonl");
    const files = new Map(kept.map((entry) => [entry.name, entry.data]));
    expect(files.has("receipts.jsonl")).toBe(false);
    expectFailure(bundleFrom(files), "range");
  });
});

describe("the sigillo-verify command on a real archive", () => {
  it("accepts the archive and reports the timestamps it checked", async () => {
    const archive = await build();
    const path = join(directory, "fascicolo.zip");
    writeFileSync(path, archive.zip);

    const output = execFileSync(
      join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx"),
      [join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts"), path, "--quiet"],
      { encoding: "utf8" },
    );

    expect(output).toContain("OK");
    expect(output).toContain(SYSTEM);
    expect(output).toContain("12 receipts");
    expect(output).toContain("1 checkpoint(s)");
    expect(output).toContain("2 inclusion proof(s)");
    // Nothing anchors this one, and the tool says so rather than staying quiet.
    expect(output).toContain("no timestamp tokens");
  }, 30_000);

  it("refuses an archive whose timestamp token is not a timestamp token", async () => {
    await anchor(FAKE_TOKEN);
    const path = join(directory, "bad-token.zip");
    writeFileSync(path, (await build()).zip);

    let status = 0;
    let stderr = "";
    try {
      execFileSync(
        join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx"),
        [join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts"), path],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status ?? 0;
      stderr = failure.stderr ?? "";
    }

    // The chain is sound; the anchor is not. That is still a failed verification.
    expect(status).toBe(1);
    expect(stderr).toContain("FAILED  timestamp");
    expect(stderr).toContain("checkpoint-12-1.tsr");
  }, 30_000);

  it("accepts an archive anchored by a real authority", async (context) => {
    const checkpoint = store.latestCheckpoint(SYSTEM);
    if (checkpoint === null) throw new Error("no checkpoint");

    let token: string;
    try {
      token = await requestTimestampWithRetry(
        checkpoint.checkpoint.root_hash,
        { url: "https://freetsa.org/tsr", timeoutMs: 20_000 },
        { attempts: 1 },
      );
    } catch {
      context.skip();
      return;
    }
    await anchor(token);

    const path = join(directory, "anchored.zip");
    writeFileSync(path, (await build()).zip);

    const output = execFileSync(
      join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx"),
      [join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts"), path, "--quiet"],
      { encoding: "utf8" },
    );

    expect(output).toContain("OK");
    // Without the authority's certificate, the tool checks the digest only and
    // must not pass that off as a verified signature.
    expect(output).toContain("imprint-only");
    expect(output).toContain("no timestamp authority certificate was supplied");
  }, 90_000);

  it("exits non-zero when the archive has been tampered with", async () => {
    const archive = await build();
    const files = filesOf(archive.zip);
    const lines = decode(files.get("receipts.jsonl")).split("\n").filter(Boolean);
    const target = JSON.parse(lines[3] ?? "{}") as Receipt;
    lines[3] = canonicalJson({ ...target, outcome: "blocked" });

    const rebuilt = createZip(
      [...files].map(([name, data]) =>
        name === "receipts.jsonl"
          ? { name, data: new TextEncoder().encode(`${lines.join("\n")}\n`) }
          : { name, data },
      ),
    );
    const path = join(directory, "tampered.zip");
    writeFileSync(path, rebuilt);

    let status = 0;
    let stderr = "";
    try {
      execFileSync(
        join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx"),
        [join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts"), path],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      const failure = error as { status?: number; stderr?: string };
      status = failure.status ?? 0;
      stderr = failure.stderr ?? "";
    }

    expect(status).toBe(1);
    expect(stderr).toContain("FAILED");
    expect(stderr).toContain("chain-link");
  }, 30_000);
});

describe("the sigillo-verify doc command", () => {
  const VERIFIER_CLI = join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts");
  const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");

  function run(args: string[]): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(TSX, [VERIFIER_CLI, ...args], { encoding: "utf8" });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
  }

  it("finds a document that was used, with the right label and action", async () => {
    const content = "il curriculum esatto usato in questo test";
    const sha256 = createHash("sha256").update(content).digest("hex");
    await store.append({
      ...event(12),
      action: { kind: "tool_call", name: "leggi_curriculum" },
      artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256 }],
    });

    const archivePath = join(directory, "fascicolo.zip");
    writeFileSync(archivePath, (await build()).zip);
    const filePath = join(directory, "curriculum.txt");
    writeFileSync(filePath, content);

    const result = run(["doc", archivePath, filePath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(SYSTEM);
    expect(result.stdout).toContain("curriculum");
    expect(result.stdout).toContain("leggi_curriculum");
    expect(result.stdout).toContain("not been modified");
  }, 30_000);

  it("reports no match for a document changed by one character", async () => {
    const content = "il curriculum esatto usato in questo test";
    const sha256 = createHash("sha256").update(content).digest("hex");
    await store.append({
      ...event(12),
      artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256 }],
    });

    const archivePath = join(directory, "fascicolo.zip");
    writeFileSync(archivePath, (await build()).zip);
    const filePath = join(directory, "curriculum.txt");
    writeFileSync(filePath, `${content}!`);

    const result = run(["doc", archivePath, filePath]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("No registered action used this document");
  }, 30_000);

  it("lists every use of a document that was recorded more than once", async () => {
    const content = "documento riutilizzato due volte";
    const sha256 = createHash("sha256").update(content).digest("hex");
    await store.append({
      ...event(12),
      action: { kind: "tool_call", name: "prima-azione" },
      artifacts: [{ role: "input", label: "allegato", media_type: "text/plain", sha256 }],
    });
    await store.append({
      ...event(13),
      action: { kind: "tool_call", name: "seconda-azione" },
      artifacts: [{ role: "input", label: "allegato", media_type: "text/plain", sha256 }],
    });

    const archivePath = join(directory, "fascicolo.zip");
    writeFileSync(archivePath, (await build()).zip);
    const filePath = join(directory, "allegato.txt");
    writeFileSync(filePath, content);

    const result = run(["doc", archivePath, filePath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("prima-azione");
    expect(result.stdout).toContain("seconda-azione");
  }, 30_000);

  it("fails the whole archive, not just the lookup, when the index has been tampered with", async () => {
    const content = "documento di prova";
    const sha256 = createHash("sha256").update(content).digest("hex");
    await store.append({
      ...event(12),
      artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256 }],
    });

    const files = filesOf((await build()).zip);
    const tampered = JSON.stringify({ sha256, seq: 999, role: "input", label: "curriculum" });
    const rebuilt = createZip(
      [...files].map(([name, data]) =>
        name === "artifacts-index.jsonl"
          ? { name, data: new TextEncoder().encode(`${tampered}\n`) }
          : { name, data },
      ),
    );
    const archivePath = join(directory, "tampered.zip");
    writeFileSync(archivePath, rebuilt);
    const filePath = join(directory, "curriculum.txt");
    writeFileSync(filePath, content);

    const result = run(["doc", archivePath, filePath]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FAILED");
    expect(result.stderr).toContain("artifacts-index");
  }, 30_000);

  it("exits 2 when the file to look up cannot be read", async () => {
    await store.append(event(12));
    const archivePath = join(directory, "fascicolo.zip");
    writeFileSync(archivePath, (await build()).zip);

    const result = run(["doc", archivePath, join(directory, "does-not-exist.txt")]);
    expect(result.status).toBe(2);
  }, 30_000);
});
