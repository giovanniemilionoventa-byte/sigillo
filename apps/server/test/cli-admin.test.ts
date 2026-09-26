import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * `sigillo-server system rename | archive | unarchive | delete | list` and
 * `admin-log`, run as the real CLI in a process of its own. None of them
 * signs anything, so none needs the signer.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const SERVER_CLI = join(REPOSITORY_ROOT, "apps", "server", "src", "cli.ts");

let directory: string;
let databasePath: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(...args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      [SERVER_CLI, ...args, "--db", databasePath],
      { cwd: REPOSITORY_ROOT, env: { PATH: process.env["PATH"] ?? "" }, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-cli-admin-"));
  databasePath = join(directory, "sigillo.db");
  const store = ReceiptStore.open(databasePath, createTestSigner());
  await store.createSystem("acme-support-bot", "2026-09-26T08:00:00.000Z");
  await store.append({
    system_id: "acme-support-bot",
    ts_event: "2026-09-26T08:01:00.000Z",
    ts_received: "2026-09-26T08:01:00.000Z",
    actor: { agent: "planner" },
    action: { kind: "tool_call", name: "search" },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
  });
  await store.createSystem("prova", "2026-09-26T08:30:00.000Z");
  store.close();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("the administration commands", () => {
  it("renames, archives and lists, and logs each change with the operating system's user", async () => {
    const renamed = await cli("system", "rename", "acme-support-bot", "Assistente clienti");
    expect(renamed.code).toBe(0);
    expect(renamed.stdout).toContain('acme-support-bot is now shown as "Assistente clienti"');

    expect((await cli("system", "archive", "prova")).code).toBe(0);
    const active = await cli("system", "list");
    expect(active.stdout).toBe("acme-support-bot\t2 receipts\tactive\tAssistente clienti\n");
    const all = await cli("system", "list", "--all");
    expect(all.stdout).toMatch(/^prova\t1 receipts\tarchived \S+\t$/m);

    const log = await cli("admin-log");
    const lines = log.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\tsystem\.archive\tprova\tcli \S+@\S+\t/);
    expect(lines[1]).toMatch(/\tsystem\.rename\tacme-support-bot\tcli \S+@\S+\t\{"from":null,"to":"Assistente clienti"\}$/);
  }, 60_000);

  it("refuses to delete a system with a recorded action, with or without confirmation, and changes nothing", async () => {
    const refused = await cli("system", "delete", "acme-support-bot", "--confirm", "acme-support-bot");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("cannot be deleted");
    expect(refused.stderr).toContain("sigillo-server system archive acme-support-bot");

    const mismatch = await cli("system", "delete", "prova", "--confirm", "Prova");
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("nothing was deleted");

    const store = ReceiptStore.open(databasePath);
    try {
      expect(store.readChain("acme-support-bot")).toHaveLength(2);
      expect(store.hasSystem("prova")).toBe(true);
      expect(store.adminLog()).toEqual([]);
    } finally {
      store.close();
    }
  }, 60_000);

  it("deletes a system whose chain holds only its genesis, and logs it", async () => {
    const deleted = await cli("system", "delete", "prova", "--confirm", "prova");
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain("deleted prova");
    expect((await cli("system", "list", "--all")).stdout).not.toContain("prova");
    expect((await cli("admin-log")).stdout).toMatch(/\tsystem\.delete\tprova\tcli \S+@\S+\t/);
  }, 60_000);
});
