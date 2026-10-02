import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/storage/schema.js";
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

  it("creates organizations, assigns systems to them and takes them back, and logs each step", async () => {
    expect((await cli("org", "create", "acme", "Acme S.p.A.")).code).toBe(0);
    expect((await cli("org", "create", "Acme", "wrong case")).code).toBe(1);
    expect((await cli("org", "create", "acme", "again")).code).toBe(1);
    expect((await cli("org", "list")).stdout).toMatch(/^acme\tapproved \S+\tAcme S\.p\.A\.\n$/);

    expect((await cli("system", "assign", "acme-support-bot", "acme")).code).toBe(0);
    expect((await cli("system", "assign", "prova", "nobody")).code).toBe(1);
    expect((await cli("system", "assign", "prova")).code).toBe(1);
    expect((await cli("system", "list", "--organization", "acme")).stdout).toBe(
      "acme-support-bot\t2 receipts\tactive\t\torganization acme\n",
    );
    const back = await cli("system", "assign", "acme-support-bot", "--none");
    expect(back.code).toBe(0);
    expect(back.stdout).toBe("acme-support-bot: acme -> the operator's alone\n");
    expect((await cli("system", "list", "--organization", "acme")).stdout).toBe("");

    const lines = (await cli("admin-log")).stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/\tsystem\.assign\tacme-support-bot\t.*\{"from":"acme","to":null\}$/);
    expect(lines[1]).toMatch(/\tsystem\.assign\tacme-support-bot\t.*\{"from":null,"to":"acme"\}$/);
    expect(lines[2]).toMatch(/\torganization\.create\t\t/);
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

describe("the commands that only read", () => {
  const fileHash = (): string => createHash("sha256").update(readFileSync(databasePath)).digest("hex");

  it("leave the database file byte for byte as it was", async () => {
    const before = fileHash();
    expect((await cli("system", "list", "--all")).code).toBe(0);
    expect((await cli("admin-log")).code).toBe(0);
    expect((await cli("key", "list")).code).toBe(0);
    expect((await cli("subject", "find", "nobody")).code).toBe(1);
    expect(fileHash()).toBe(before);
  });

  it("refuse a database at an older schema, without changing it, and migrate brings it up", async () => {
    const raw = new Database(databasePath);
    raw.pragma("user_version = 0");
    raw.close();
    const before = fileHash();

    const refused = await cli("system", "list");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("run `sigillo-server migrate` on it");
    expect((await cli("key", "list")).code).toBe(1);
    expect(fileHash()).toBe(before);

    const migrated = await cli("migrate");
    expect(migrated.code, migrated.stderr).toBe(0);
    expect(migrated.stdout).toContain(`schema ${SCHEMA_VERSION}`);
    expect((await cli("system", "list")).code).toBe(0);
  });
});
