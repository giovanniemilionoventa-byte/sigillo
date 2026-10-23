import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createZip } from "@sigillo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import {
  inventoryMarkdown,
  liveColumns,
  newCanary,
  scanDatabase,
  scanFiles,
  STORAGE_INVENTORY,
  unclassifiedColumns,
} from "../src/assurance/privacy-check.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { loadOrCreateSealingKey, ProviderKeyStore } from "../src/gateway/provider-keys.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The privacy scan (docs/DATA-PROTECTION.md, last section), run the way a partner
 * runs it: a marker goes through a real agent's records and a real call to the
 * model gateway, in every place an agent puts content, and the scan of the
 * database's columns and raw bytes must not find it. Where the marker goes into
 * a field sigillo does record as sent (a person's id, a span's name), the scan
 * must find it, and say where: a check that cannot fail proves nothing.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const SERVER_CLI = join(REPOSITORY_ROOT, "apps", "server", "src", "cli.ts");
const SYSTEM = "partner-check";
const NOW = "2026-10-22T10:00:00.000Z";
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

let directory: string;
let databasePath: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let providerKeys: ProviderKeyStore;
let upstream: Server;
let app: FastifyInstance;
let token: string;
let marker: string;

const attribute = (key: string, value: string): unknown => ({ key, value: { stringValue: value } });

function span(id: number, name: string, attributes: unknown[], events: unknown[] = []): unknown {
  return {
    traceId: TRACE,
    spanId: id.toString(16).padStart(16, "0"),
    name,
    startTimeUnixNano: String(BigInt(Date.parse(NOW) + id) * 1_000_000n),
    endTimeUnixNano: String(BigInt(Date.parse(NOW) + id + 1) * 1_000_000n),
    attributes,
    events,
  };
}

async function ingest(spans: unknown[], as: string = token): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
    payload: { resourceSpans: [{ resource: { attributes: [attribute("service.name", SYSTEM)] }, scopeSpans: [{ spans }] }] },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** An agent's run with the marker in every place an agent puts content. */
async function runWithMarkerInContent(): Promise<void> {
  const secret = `Customer file of ACME: ${marker}`;
  await ingest([
    span(1, "lookup_customer", [
      attribute("openinference.span.kind", "TOOL"),
      attribute("tool.name", "lookup_customer"),
      attribute("input.value", JSON.stringify({ customer: marker })),
      attribute("output.value", secret),
      attribute("tool.parameters", JSON.stringify({ customer: marker })),
    ]),
    span(2, "ChatOpenAI", [
      attribute("openinference.span.kind", "LLM"),
      attribute("llm.model_name", "gpt-4o-mini"),
      attribute("input.value", secret),
      attribute("output.value", `Answer about ${marker}`),
      attribute("llm.input_messages.0.message.content", secret),
      attribute("llm.output_messages.0.message.content", `Answer about ${marker}`),
    ]),
    span(3, "chat gpt-4o-mini", [
      attribute("gen_ai.operation.name", "chat"),
      attribute("gen_ai.request.model", "gpt-4o-mini"),
      attribute("gen_ai.prompt", secret),
      attribute("gen_ai.completion", `Answer about ${marker}`),
      attribute("gen_ai.input.messages", JSON.stringify([{ role: "user", content: secret }])),
      attribute("gen_ai.output.messages", JSON.stringify([{ role: "assistant", content: marker }])),
    ], [{ name: "exception", timeUnixNano: String(BigInt(Date.parse(NOW)) * 1_000_000n), attributes: [attribute("exception.message", secret)] }]),
  ]);
  // And a call through the model gateway: the prompt and the answer both carry it.
  const call = await app.inject({
    method: "POST",
    url: "/llm/openai/v1/chat/completions",
    headers: { authorization: `Bearer ${token}` },
    payload: { model: "gpt-4o-mini", messages: [{ role: "user", content: secret }] },
  });
  expect(call.statusCode, call.body).toBe(200);
  expect(call.body).toContain(marker);
}

function serverCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      [SERVER_CLI, ...args, "--db", databasePath],
      { cwd: REPOSITORY_ROOT, env: { PATH: process.env["PATH"] ?? "" }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr }),
    );
  });
}

beforeEach(async () => {
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // The stand-in provider repeats the prompt back, so the answer carries the marker too.
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: { content: string }[] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `You said: ${body.messages[0]?.content}` } }] }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  directory = mkdtempSync(join(tmpdir(), "sigillo-privacy-check-"));
  databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  await store.createSystem(SYSTEM, NOW);
  keys = ApiKeyStore.open(databasePath);
  token = keys.issue(SYSTEM, NOW).token;
  providerKeys = ProviderKeyStore.open(databasePath, loadOrCreateSealingKey(join(directory, "llm-gateway.key")));
  providerKeys.set(SYSTEM, "openai", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", NOW);
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    gateway: { keys: providerKeys, access: "all", toolRequests: "all", upstream: { openai: upstreamUrl } },
  });
  await app.ready();
  marker = newCanary();
});

afterEach(async () => {
  await app.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  providerKeys.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the storage inventory", () => {
  it("classifies every column the schema creates", () => {
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(liveColumns(db).length).toBeGreaterThan(50);
      expect(unclassifiedColumns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("names a class for every column it lists, and nothing it calls content is kept in clear", () => {
    for (const entry of Object.values(STORAGE_INVENTORY)) {
      for (const [kind] of Object.values(entry.columns)) expect(kind).toMatch(/^[a-z-]+$/);
    }
    expect(STORAGE_INVENTORY["receipts"]?.columns["canonical"]?.[0]).toBe("recorded-as-sent");
    expect(STORAGE_INVENTORY["subjects"]?.columns["identifier"]?.[0]).toBe("personal-erasable");
  });

  it("is what docs/STORAGE-INVENTORY.md says (regenerate with `sigillo-server privacy inventory --markdown`)", () => {
    expect(readFileSync(join(REPOSITORY_ROOT, "docs", "STORAGE-INVENTORY.md"), "utf8")).toBe(inventoryMarkdown());
  });
});

describe("the canary scan", () => {
  it("does not find content an agent sent, through its spans or through the model gateway", async () => {
    await runWithMarkerInContent();
    expect(store.readChain(SYSTEM).length).toBeGreaterThan(4);

    const db = new Database(databasePath, { readonly: true });
    try {
      expect(scanDatabase(db, marker)).toEqual([]);
    } finally {
      db.close();
    }
    const scan = await serverCli("privacy", "scan", marker);
    expect(scan.stderr).toBe("");
    expect(scan.code).toBe(0);
    expect(scan.stdout).toMatch(/^not found: every column of the database, and \d+ file\(s\)\n$/);
  }, 60_000);

  it("finds a marker put in a field sigillo records as sent, and says where", async () => {
    await ingest([
      span(1, `reply to ${marker}`, [attribute("openinference.span.kind", "CHAIN")]),
    ]);
    const scan = await serverCli("privacy", "scan", marker);
    expect(scan.code).toBe(2);
    expect(scan.stdout).toContain("FOUND in receipts.action_name: 1 row(s)");
    expect(scan.stdout).toContain("FOUND in receipts.canonical: 1 row(s)");
    expect(scan.stdout).toContain(`FOUND in file ${databasePath}`);
  }, 60_000);

  it("finds a person's identifier where it is kept, and no longer once the person is erased", async () => {
    await ingest([
      span(1, "lookup_customer", [attribute("openinference.span.kind", "TOOL"), attribute("tool.name", "lookup_customer"), attribute("user.id", marker)]),
    ]);
    const before = await serverCli("privacy", "scan", marker);
    expect(before.code).toBe(2);
    expect(before.stdout).toContain("FOUND in subjects.identifier: 1 row(s)");
    expect(before.stdout).not.toContain("receipts.");

    const erased = await serverCli("subject", "erase", "--identifier", marker);
    expect(erased.code, erased.stderr).toBe(0);
    const after = await serverCli("privacy", "scan", marker);
    expect(after.stdout).toMatch(/^not found/);
    expect(after.code).toBe(0);
  }, 60_000);

  it("searches the folders it is given, inside zips too", () => {
    const logs = mkdtempSync(join(directory, "logs-"));
    writeFileSync(join(logs, "server.log"), `GET /ui?q=${marker}\n`);
    writeFileSync(join(logs, "utf16.txt"), Buffer.from(marker, "utf16le"));
    writeFileSync(join(logs, "clean.log"), "GET /ui\n");
    writeFileSync(join(logs, "export.zip"), createZip([{ name: "receipts.jsonl", data: new TextEncoder().encode(marker) }]));
    const result = scanFiles([logs], marker);
    expect(result.scanned).toBe(4);
    expect(result.hits.map((hit) => hit.path)).toEqual(["export.zip", "server.log", "utf16.txt"].map((name) => join(logs, name)));
  });

  it("refuses a marker too short to mean anything", async () => {
    const scan = await serverCli("privacy", "scan", "short");
    expect(scan.code).toBe(1);
    expect(scan.stderr).toContain("at least 16 characters");
  }, 60_000);
});

describe("erasing a customer at the end of its contract", () => {
  const ADMIN = { actor: "test", ts: NOW };

  it("leaves nothing of what its agents sent, and touches no other customer", async () => {
    await store.createOrganization("acme", "Acme", ADMIN, { approved: true });
    await store.createOrganization("other", "Other", ADMIN, { approved: true });
    await store.createSystem("acme.bot", NOW, "acme");
    await store.createSystem("other.bot", NOW, "other");
    const acme = keys.issue("acme.bot", NOW).token;
    const other = keys.issue("other.bot", NOW).token;
    const tool = (id: number, name: string, person: string): unknown =>
      span(id, name, [attribute("openinference.span.kind", "TOOL"), attribute("tool.name", name), attribute("user.id", person)]);
    await ingest([tool(1, `lookup ${marker}`, marker), tool(2, "lookup", "shared.person")], acme);
    await ingest([tool(3, "lookup", "shared.person")], other);
    expect((await new Checkpointer({ store, now: () => new Date(NOW) }).checkpointAll()).length).toBeGreaterThan(0);
    const otherChain = store.readChain("other.bot");

    expect((await serverCli("privacy", "scan", marker)).code).toBe(2);
    expect((await serverCli("org", "erase", "acme", "--confirm", "acm")).code).toBe(1);
    const erased = await serverCli("org", "erase", "acme", "--confirm", "acme");
    expect(erased.stderr).toBe("");
    expect(erased.stdout).toContain("erased acme: 1 system(s), 2 receipt(s), 0 person(s) who signed in, 1 pseudonym link(s)");

    const scan = await serverCli("privacy", "scan", marker);
    expect(scan.stdout).toMatch(/^not found/);
    expect(scan.code).toBe(0);
    expect(store.hasSystem("acme.bot")).toBe(false);
    expect(store.organization("acme")).toBeNull();
    // The other customer keeps its chain, its person and its guards.
    expect(store.readChain("other.bot")).toEqual(otherChain);
    expect(store.subjectToken("shared.person")).not.toBeNull();
    const db = new Database(databasePath);
    try {
      expect(() => db.prepare("DELETE FROM receipts WHERE system_id = 'other.bot'").run()).toThrow(/append-only/);
      const log = db.prepare("SELECT action, detail FROM admin_log WHERE action IN ('organization.erase', 'system.delete')").all();
      expect(JSON.stringify(log)).not.toContain(marker);
      expect(log.map((entry) => (entry as { action: string }).action)).toEqual(["organization.erase", "system.delete"]);
    } finally {
      db.close();
    }
  }, 60_000);

  it("is refused by the database for a customer whose erasure is not logged", async () => {
    await store.createOrganization("acme", "Acme", ADMIN, { approved: true });
    await store.createSystem("acme.bot", NOW, "acme");
    await ingest([span(1, "lookup", [attribute("openinference.span.kind", "TOOL"), attribute("tool.name", "lookup")])], keys.issue("acme.bot", NOW).token);
    await expect(store.eraseOperatorSystem("acme.bot", ADMIN)).rejects.toThrow(/belongs to a customer/);
    const db = new Database(databasePath);
    try {
      db.prepare("INSERT INTO admin_log (ts, action, system_id, actor, detail) VALUES (?, 'system.delete', 'acme.bot', 'x', ?)").run(
        NOW,
        JSON.stringify({ receipts_erased: 1 }),
      );
      expect(() => db.prepare("DELETE FROM receipts WHERE system_id = 'acme.bot'").run()).toThrow(/append-only/);
    } finally {
      db.close();
    }
  });

  it("is possible on a database made before it existed, once opened by this release", () => {
    store.close();
    const db = new Database(databasePath);
    db.exec(`DROP VIEW operator_erasable_chains;
      CREATE VIEW operator_erasable_chains AS
      SELECT system.system_id FROM systems system
      JOIN admin_log entry ON entry.action = 'system.delete' AND entry.system_id = system.system_id
       AND json_extract(entry.detail, '$.receipts_erased') IS NOT NULL
      WHERE system.organization_id IS NULL;`);
    db.close();
    store = ReceiptStore.open(databasePath, signer);
    const reopened = new Database(databasePath, { readonly: true });
    try {
      const view = reopened.prepare("SELECT sql FROM sqlite_master WHERE name = 'operator_erasable_chains'").get() as { sql: string };
      expect(view.sql).toContain("organization.erase");
    } finally {
      reopened.close();
    }
  });
});
