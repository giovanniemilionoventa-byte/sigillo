import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJson, parseReceipt, type Receipt } from "@sigillo/core";
import { verifyBundle } from "@sigillo/verifier";
import { exportSystem, writeExportBundle } from "../src/export/bundle.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SYSTEM = "acme-support-bot";
const EXPORTED_AT = "2026-03-29T15:00:00.000Z";

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-export-"));
  signer = createTestSigner();
  store = ReceiptStore.open(join(directory, "sigillo.db"), signer);
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function event(index: number): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: "2026-03-29T14:30:01.000Z",
    ts_received: "2026-03-29T14:30:01.005Z",
    actor: { agent: "planner", on_behalf_of: "urn:operator:night-shift" },
    action: { kind: "tool_call", name: `call-${index}` },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  };
}

async function writeChain(length: number): Promise<void> {
  await store.createChain(SYSTEM, "2026-03-29T14:30:00.000Z");
  for (let index = 1; index < length; index += 1) {
    await store.append(event(index));
  }
}

function bundleFromStore(): ReturnType<typeof exportSystem> {
  return exportSystem(store, {
    systemId: SYSTEM,
    keys: [{ key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 }],
    exportedAt: EXPORTED_AT,
  });
}

describe("exporting a chain", () => {
  it("produces a bundle the independent verifier accepts", async () => {
    await writeChain(25);
    const result = verifyBundle(bundleFromStore());
    expect(result.ok ? "" : `${result.check} at ${result.location}: ${result.detail}`).toBe("");
    if (!result.ok) return;
    expect(result.summary).toMatchObject({ system_id: SYSTEM, receipts: 25, first_seq: 0, last_seq: 24 });
  });

  it("writes one receipt per line, in canonical form", async () => {
    await writeChain(4);
    const bundle = bundleFromStore();
    const lines = bundle.receiptsJsonl.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const receipt: Receipt = parseReceipt(JSON.parse(line));
      expect(line).toBe(canonicalJson(receipt));
    }
  });

  it("is reproducible: exporting the same chain twice gives the same bytes", async () => {
    await writeChain(6);
    expect(bundleFromStore()).toEqual(bundleFromStore());
  });

  it("refuses to export a system with no receipts", () => {
    expect(() =>
      exportSystem(store, { systemId: "nothing-here", keys: [], exportedAt: EXPORTED_AT }),
    ).toThrow(/no receipts/);
  });
});

describe("the exported files on disk", () => {
  it("are accepted by the sigillo-verify command", async () => {
    await writeChain(10);
    const exportDirectory = join(directory, "fascicolo");
    writeExportBundle(exportDirectory, bundleFromStore());

    const output = execFileSync(
      join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx"),
      [join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts"), exportDirectory],
      { encoding: "utf8" },
    );

    expect(output).toContain("OK");
    expect(output).toContain(SYSTEM);
    expect(output).toContain("10 receipts");
    expect(output).toContain("seq 0..9");
    expect(output).toContain(signer.keyId);
  }, 30_000);

  it("make the command exit non-zero and name the failing check when tampered with", async () => {
    await writeChain(10);
    const exportDirectory = join(directory, "tampered");
    writeExportBundle(exportDirectory, bundleFromStore());

    const receiptsPath = join(exportDirectory, "receipts.jsonl");
    const lines = readFileSync(receiptsPath, "utf8").split("\n").filter((line) => line.length > 0);
    const target = JSON.parse(lines[4] ?? "{}") as Receipt;
    lines[4] = canonicalJson({ ...target, outcome: "error" });
    writeFileSync(receiptsPath, `${lines.join("\n")}\n`, "utf8");

    let status = 0;
    let stderr = "";
    try {
      execFileSync(
        join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx"),
        [join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts"), exportDirectory],
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
    expect(stderr).toContain("receipts.jsonl:6");
  }, 30_000);
});
