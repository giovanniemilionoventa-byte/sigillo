import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { archiveFromStore } from "../src/export/from-store.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createLocalTsa, type LocalTsa } from "./helpers/local-tsa.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * A second, independent timestamp authority over the same checkpoint roots
 * (security audit 2026-11-07), and what the verifier makes of an export that
 * carries tokens from two authorities when it is given the certificate of one.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const VERIFY_CLI = join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts");
const SYSTEM = "two-authorities";

let directory: string;
let first: LocalTsa;
let second: LocalTsa;
let store: ReceiptStore;
let archive: string;
let clock = Date.parse("2026-11-07T09:00:00.000Z");

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-second-tsa-"));
  first = createLocalTsa();
  second = createLocalTsa();
  const firstUrl = await first.listen(() => new Date(clock));
  const secondUrl = await second.listen(() => new Date(clock));
  const signer = createTestSigner({ now: () => new Date(clock) });
  store = ReceiptStore.open(join(directory, "sigillo.db"), signer);
  await store.createSystem(SYSTEM, new Date(clock).toISOString());
  for (let i = 0; i < 3; i++) {
    clock += 1000;
    await store.append({
      system_id: SYSTEM,
      ts_event: new Date(clock).toISOString(),
      ts_received: new Date(clock).toISOString(),
      actor: { agent: "a" },
      action: { kind: "tool_call", name: `step${i}` },
      input_hash: null,
      output_hash: null,
      outcome: "ok",
      source: { type: "api" },
    });
  }
  const checkpointer = new Checkpointer({
    store,
    now: () => new Date(clock),
    tsa: { url: firstUrl },
    extraTsas: [{ url: secondUrl }],
    retry: { attempts: 1 },
  });
  const run = await checkpointer.runOnce();
  expect(run.pending).toBe(0);
  const [checkpoint] = store.readCheckpoints(SYSTEM);
  expect(store.readTimestamps(checkpoint!.id).map((t) => t.tsaUrl).sort()).toEqual([firstUrl, secondUrl].sort());
  clock += 60_000;
  const built = await archiveFromStore(store, SYSTEM, { exportedAt: new Date(clock).toISOString() });
  archive = join(directory, "export.zip");
  writeFileSync(archive, built.zip);
}, 60_000);

afterAll(() => {
  store?.close();
  first?.close();
  second?.close();
  rmSync(directory, { recursive: true, force: true });
});

const verify = (...args: string[]) => spawnSync(TSX, [VERIFY_CLI, ...args], { cwd: REPOSITORY_ROOT, encoding: "utf8" });

describe("an export with tokens from two authorities", () => {
  it("verifies with the first authority's certificate alone, the other token read as from an authority not supplied", () => {
    const run = verify(archive, "--tsa-ca", first.caFile);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/: verified \(/);
    expect(run.stdout).toMatch(/: imprint-only \(/);
  });

  it("verifies with the second's alone just as well", () => {
    const run = verify(archive, "--tsa-ca", second.caFile);
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  it("still fails with a certificate that covers neither", () => {
    const stranger = createLocalTsa();
    try {
      const run = verify(archive, "--tsa-ca", stranger.caFile);
      expect(run.status).not.toBe(0);
    } finally {
      stranger.close();
    }
  });
});
