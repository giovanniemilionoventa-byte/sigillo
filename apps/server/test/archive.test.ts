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
import { generateKeyPairSync } from "node:crypto";
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
function anchor(tokenBase64: string, tsaUrl = "https://freetsa.org/tsr"): void {
  const checkpoint = store.latestCheckpoint(SYSTEM);
  if (checkpoint === null) throw new Error("no checkpoint to anchor");
  store.recordTimestamp(checkpoint.id, tsaUrl, tokenBase64, "2026-03-29T15:00:05.000Z");
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
    anchor(FAKE_TOKEN);
    const files = filesOf((await build()).zip);
    expect([...files.keys()].sort()).toEqual([
      "VERIFY.md",
      "checkpoints.jsonl",
      "manifest.json",
      "receipts.jsonl",
      "report.pdf",
      "timestamps/checkpoint-12-1.tsr",
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
    anchor(FAKE_TOKEN);
    const archive = await build();
    expect(archive.manifest.counts).toEqual({ receipts: 12, checkpoints: 1, timestamps: 1 });
    expect(archive.manifest.range).toMatchObject({ from_seq: 0, to_seq: 11 });
  });

  it("carries the timestamp token byte for byte", async () => {
    anchor(FAKE_TOKEN);
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
  });

  it("writes instructions that stand on their own", async () => {
    anchor(FAKE_TOKEN);
    const files = filesOf((await build()).zip);
    const verify = decode(files.get("VERIFY.md"));
    expect(verify).toContain(SYSTEM);
    expect(verify).toContain("sigillo-verify");
    expect(verify).toContain("openssl dgst -sha256");
    expect(verify).toContain("openssl ts -verify");
    expect(verify).toContain(signer.keyId);
    expect(verify).toContain(signer.publicKeyBase64);
    // It must be honest about what a log cannot prove.
    expect(verify).toContain("does not prove that everything the system did was recorded");
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
    anchor(FAKE_TOKEN);
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
    anchor(FAKE_TOKEN);
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
    anchor(token);

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
