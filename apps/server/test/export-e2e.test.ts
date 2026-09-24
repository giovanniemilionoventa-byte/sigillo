import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { publicKeyFromRaw, readZip } from "@sigillo/core";
import { generateKeyFile, startSignerDaemon, type SignerDaemon } from "../../signer/src/index.js";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { SignerClient } from "../src/signer/client.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createLocalTsa, type LocalTsa } from "./helpers/local-tsa.js";

/**
 * Phase 7: the whole path an evidence file takes, end to end, with nothing
 * stood in for. A signer daemon on a real socket with a key file; the server
 * as `serve` builds it; a system and its API key created from the web view;
 * actions sent over OTLP and the native API across three days; checkpoints
 * from the web view's button, anchored over HTTP by a real RFC 3161
 * authority (openssl, on this machine); exports of the whole chain and of
 * one day, from the web view and from the CLI; and every one of them checked
 * by the real `sigillo-verify` command, the authority's signature included.
 * Only the clock is ours, so that the three days pass in a second.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const VERIFY_CLI = join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts");
const SERVER_CLI = join(REPOSITORY_ROOT, "apps", "server", "src", "cli.ts");
const SYSTEM = "selezione-cv";
const PASSWORD = "an administrator password";
const CV = "Curriculum di Maria Bianchi, sviluppatrice backend junior.\n";
const CV_SHA256 = createHash("sha256").update(CV).digest("hex");

let directory: string;
let databasePath: string;
let socketPath: string;
let tsa: LocalTsa;
let daemon: SignerDaemon;
let signer: SignerClient;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;
let clock = Date.parse("2026-03-29T09:00:00.000Z");
let cookie = "";
let token = "";
let files = 0;

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function write(bytes: Uint8Array | Buffer): string {
  files += 1;
  const path = join(directory, `export-${files}.zip`);
  writeFileSync(path, bytes);
  return path;
}

function verify(...args: string[]): Run {
  const run = spawnSync(TSX, [VERIFY_CLI, ...args], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

/** Signs in to the web view, as the operator does at the start of each day's work. */
async function signIn(): Promise<void> {
  const login = await app.inject({
    method: "POST",
    url: "/ui/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({ password: PASSWORD }),
  });
  expect(login.statusCode).toBe(302);
  cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
}

async function post(url: string, payload: string): Promise<{ status: number; body: Buffer; text: string }> {
  await signIn();
  const response = await app.inject({
    method: "POST",
    url,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload,
  });
  return { status: response.statusCode, body: response.rawPayload, text: response.body };
}

function span(name: string, index: number, withCv = false): Record<string, unknown> {
  const start = BigInt(clock) * 1_000_000n;
  return {
    traceId: createHash("md5").update(`trace-${index}`).digest("hex"),
    spanId: createHash("md5").update(`span-${index}`).digest("hex").slice(0, 16),
    name,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 1_000_000n),
    attributes: [
      { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
      { key: "tool.name", value: { stringValue: name } },
      { key: "input.value", value: { stringValue: `{"candidate": ${index}}` } },
    ],
    ...(withCv
      ? {
          events: [
            {
              name: "sigillo.artifact",
              timeUnixNano: String(start),
              attributes: [
                { key: "sigillo.artifact.role", value: { stringValue: "input" } },
                { key: "sigillo.artifact.label", value: { stringValue: "curriculum" } },
                { key: "sigillo.artifact.media_type", value: { stringValue: "text/plain" } },
                { key: "sigillo.artifact.sha256", value: { stringValue: CV_SHA256 } },
              ],
            },
          ],
        }
      : {}),
  };
}

/** A day of work: some OTLP spans and some native receipts. */
async function work(day: string, first: number, withCv = false): Promise<void> {
  clock = Date.parse(`${day}T10:00:00.000Z`);
  const otlp = await app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: SYSTEM } }] },
          scopeSpans: [{ spans: [span("leggi_curriculum", first, withCv), span("valuta_candidato", first + 1)] }],
        },
      ],
    },
  });
  expect(otlp.statusCode, otlp.body).toBe(200);
  clock += 60_000;
  const native = await app.inject({
    method: "POST",
    url: "/api/v1/receipts",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      actor: { agent: SYSTEM },
      action: { kind: "decision", name: "esito" },
      outcome: "ok",
      output: { esito: "colloquio" },
    },
  });
  expect(native.statusCode, native.body).toBe(201);
}

async function checkpointNow(day: string): Promise<void> {
  clock = Date.parse(`${day}T18:00:00.000Z`);
  const response = await post("/ui/checkpoint", "");
  expect(response.status).toBe(303);
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-export-e2e-"));
  databasePath = join(directory, "sigillo.db");
  socketPath = join(directory, "signer.sock");
  tsa = createLocalTsa();
  const tsaUrl = await tsa.listen();
  daemon = await startSignerDaemon({ socketPath, key: generateKeyFile(join(directory, "signer.key")) });
  signer = await SignerClient.connect(socketPath);
  store = ReceiptStore.open(databasePath, signer);
  keys = ApiKeyStore.open(databasePath);
  const now = (): Date => new Date(clock);
  app = buildServer({
    store,
    keys,
    now,
    signerHealthy: () => signer.healthy(),
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(
        store,
        publicKeyFromRaw(new Uint8Array(Buffer.from(signer.publicKeyBase64, "base64"))),
        24 * 60 * 60_000,
      ),
      checkpointer: new Checkpointer({ store, now, tsa: { url: tsaUrl }, retry: { attempts: 1 } }),
    },
  });
  await app.ready();

  // The system and its key, from the web view, as an operator would.
  const created = await post("/ui/sistemi", form({ system_id: SYSTEM }));
  expect(created.status).toBe(200);
  token = /sigillo_[0-9a-f]{16}_[0-9a-f]{64}/.exec(created.text)?.[0] ?? "";
  expect(token).not.toBe("");

  await work("2026-03-29", 1);
  await checkpointNow("2026-03-29");
  await work("2026-03-30", 10, true);
  await checkpointNow("2026-03-30");
  await work("2026-03-31", 20);
  // Day three is not checkpointed: its receipts are the unanchored tail.
}, 120_000);

afterAll(async () => {
  await app.close();
  keys.close();
  store.close();
  signer.close();
  await daemon.close();
  tsa.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("the whole chain, exported from the web view", () => {
  let archive = "";

  beforeAll(async () => {
    clock = Date.parse("2026-04-01T08:00:00.000Z");
    const response = await post(`/ui/systems/${SYSTEM}/export`, "");
    expect(response.status).toBe(200);
    archive = write(response.body);
  });

  it("verifies with the authority's certificate and the operator's key", () => {
    const run = verify(archive, "--tsa-ca", tsa.caFile, "--key-id", signer.keyId);
    expect(run.code, run.stderr).toBe(0);
    // genesis + three days of four receipts each
    expect(run.stdout).toContain(`OK  ${SYSTEM}: 10 receipts, seq 0..9, signed by ${signer.keyId}`);
    expect(run.stdout).toContain("2 checkpoint(s), 2 root(s) rebuilt");
    expect(run.stdout.match(/: verified \(http:\/\/127\.0\.0\.1:\d+\/tsr\), attested time 20\d\d-/g)).toHaveLength(2);
    expect(run.stdout).toContain(`every signature is by a key you said to expect: ${signer.keyId}`);
    expect(run.stdout).not.toContain("not linked");
  }, 30_000);

  it("finds the curriculum used on the second day, offline", () => {
    const cv = join(directory, "cv.txt");
    writeFileSync(cv, CV);
    const run = verify("doc", archive, cv);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('as "curriculum" (input), in action leggi_curriculum');
    writeFileSync(cv, CV.replace("Maria", "Mario"));
    expect(verify("doc", archive, cv).code).toBe(1);
  }, 30_000);

  it("holds no plaintext of what the agent handled", () => {
    const bytes = Buffer.concat(readZip(new Uint8Array(readFileSync(archive))).map((e) => Buffer.from(e.data)));
    for (const secret of ["Maria Bianchi", '"candidate"', "colloquio"]) {
      expect(bytes.includes(secret), secret).toBe(false);
    }
  });
});

describe("one day, exported from the web view by date", () => {
  let dayTwo = "";

  beforeAll(async () => {
    const response = await post("/ui/export", form({ system_id: SYSTEM, from: "2026-03-30", to: "2026-03-30" }));
    expect(response.status).toBe(200);
    dayTwo = write(response.body);
  });

  it("verifies, and ties the day's receipts to the checkpoint by inclusion proofs (review point 4)", () => {
    const run = verify(dayTwo, "--tsa-ca", tsa.caFile, "--key-id", signer.keyId);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`OK  ${SYSTEM}: 3 receipts, seq 4..6`);
    // The checkpoint of day two covers the whole day: one checkpoint, two proofs.
    expect(run.stdout).toContain("1 checkpoint(s), 0 root(s) rebuilt, 2 inclusion proof(s) verified");
    expect(run.stdout).toContain(": verified (");
    expect(run.stdout).not.toContain("not linked");
  }, 30_000);

  it("is contained, unchanged, in the later export of the whole chain", async () => {
    clock = Date.parse("2026-04-02T08:00:00.000Z");
    const later = write((await post(`/ui/systems/${SYSTEM}/export`, "")).body);
    const run = verify(later, "--previous", dayTwo);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`contains ${dayTwo} unchanged`);
  }, 30_000);

  it("is not a substitute for the whole chain: the whole chain cannot be shorter than it", () => {
    const run = verify(dayTwo, "--previous", join(directory, "export-1.zip"));
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FAILED  previous-export");
  }, 30_000);
});

describe("the same chain, exported from the command line", () => {
  it("writes an archive that verifies, while the server keeps running", async () => {
    const out = join(directory, "cli-export.zip");
    // Asynchronously: the signer daemon lives in this test's own process, and
    // must stay free to answer the CLI's requests.
    const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        TSX,
        [SERVER_CLI, "export", SYSTEM, "--db", databasePath, "--signer-socket", socketPath, "--out", out],
        { cwd: REPOSITORY_ROOT },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("exit", (status) => resolve({ status, stdout, stderr }));
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("the archive verifies");
    const verified = verify(out, "--tsa-ca", tsa.caFile, "--key-id", signer.keyId);
    expect(verified.code, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("10 receipts, seq 0..9");
  }, 60_000);
});
