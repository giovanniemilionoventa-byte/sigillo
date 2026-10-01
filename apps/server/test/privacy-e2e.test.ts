import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalReceiptBytes,
  fromHex,
  hashCanonicalJson,
  isPseudonym,
  openSaltedDigest,
  readZip,
  RECEIPT_VERSION_2,
  sha256,
  toHex,
  type Receipt,
  type UnsignedReceiptV2,
} from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Receipt version 4 end to end, through the real ingest routes, the real web
 * view and the real command-line tools: an agent's spans name a person and
 * carry short content in the clear; the person can be searched for and
 * erased; the content cannot be guessed from an export, can be opened with
 * its nonce, and no longer once the nonce is erased; an older v2 chain stays
 * verifiable with v4 receipts after it.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const VERIFIER_CLI = join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts");
const SERVER_CLI = join(REPOSITORY_ROOT, "apps", "server", "src", "cli.ts");

const PASSWORD = "an administrator password";
const SYSTEM = "selezione-cv";
const PERSON = "elena.rizzo";
const CV = "Curriculum vitae di una candidata\nEsperienza: cinque anni\n";
const CV_SHA256 = createHash("sha256").update(CV).digest("hex");
const TRACE = "0af7651916cd43dd8448eb211c80319c";

let directory: string;
let databasePath: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;
let apiKey: string;
let cookie: string;
let clock = Date.parse("2026-10-01T09:00:00.000Z");

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const attribute = (key: string, value: string): unknown => ({ key, value: { stringValue: value } });

/** The candidate's run as the demo agent produces it, with the raw values an SDK without its filter sends. */
function candidateRun(): unknown {
  const span = (id: number, name: string, attributes: unknown[], events: unknown[] = []): unknown => ({
    traceId: TRACE,
    spanId: id.toString(16).padStart(16, "0"),
    name,
    startTimeUnixNano: String(BigInt(clock + id) * 1_000_000n),
    endTimeUnixNano: String(BigInt(clock + id + 1) * 1_000_000n),
    attributes: [attribute("openinference.span.kind", "TOOL"), attribute("tool.name", name), attribute("user.id", PERSON), ...attributes],
    events,
  });
  return {
    resourceSpans: [
      {
        resource: { attributes: [attribute("service.name", "agente-cv")] },
        scopeSpans: [
          {
            spans: [
              span(1, "leggi_curriculum", [attribute("output.value", CV)], [
                {
                  name: "sigillo.artifact",
                  timeUnixNano: String(BigInt(clock) * 1_000_000n),
                  attributes: [
                    attribute("sigillo.artifact.role", "input"),
                    attribute("sigillo.artifact.label", "input text/plain"),
                    attribute("sigillo.artifact.media_type", "text/plain"),
                    attribute("sigillo.artifact.sha256", CV_SHA256),
                  ],
                },
              ]),
              span(2, "valuta_candidato", [attribute("input.value", CV), attribute("output.value", "score: 7")]),
              span(3, "decidi", [attribute("input.value", "score: 7"), attribute("output.value", "idoneo")]),
            ],
          },
        ],
      },
    ],
  };
}

async function ingest(payload: unknown): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    payload: payload as Record<string, unknown>,
  });
  expect(response.statusCode, response.body).toBe(200);
  clock += 1_000;
}

async function post(url: string, fields: Record<string, string>): Promise<{ status: number; body: string; raw: Buffer }> {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: form(fields),
  });
  return { status: response.statusCode, body: response.body, raw: response.rawPayload };
}

/** An export from the web view, unpacked: file name to text. */
async function exportFromWeb(fields: Record<string, string> = {}): Promise<{ zip: Buffer; files: Map<string, string> }> {
  const response = await post(`/ui/systems/${SYSTEM}/export`, fields);
  expect(response.status, response.body).toBe(200);
  const files = new Map<string, string>();
  for (const entry of readZip(new Uint8Array(response.raw))) files.set(entry.name, new TextDecoder().decode(entry.data));
  return { zip: response.raw, files };
}

function verifier(...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: execFileSync(TSX, [VERIFIER_CLI, ...args], { encoding: "utf8" }), stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
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

function databaseBytes(): Buffer {
  return Buffer.concat(
    [databasePath, `${databasePath}-wal`].filter((path) => existsSync(path)).map((path) => readFileSync(path)),
  );
}

function chain(): Receipt[] {
  return store.readChain(SYSTEM);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-privacy-e2e-"));
  databasePath = join(directory, "sigillo.db");
  signer = createTestSigner();
  store = ReceiptStore.open(databasePath, signer);
  keys = ApiKeyStore.open(databasePath);
  const now = (): Date => new Date(clock);
  app = buildServer({
    store,
    keys,
    now,
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000),
      checkpointer: new Checkpointer({ store, now }),
    },
  });
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/ui/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({ password: PASSWORD }),
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
  const created = await post("/ui/sistemi", { system_id: SYSTEM });
  apiKey = /sigillo_[0-9a-f]{16}_[0-9a-f]{64}/.exec(created.body)?.[0] ?? "";
  expect(apiKey).not.toBe("");
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("a person named in a span", () => {
  it("is recorded as a token, and the identifier never reaches the receipts table or an export", async () => {
    await ingest(candidateRun());
    const tokens = new Set(chain().slice(1).map((receipt) => receipt.actor.on_behalf_of));
    expect(tokens.size).toBe(1);
    const [token] = tokens;
    expect(isPseudonym(token ?? "")).toBe(true);

    const raw = (await import("better-sqlite3")).default;
    const connection = new raw(databasePath, { readonly: true });
    const rows = JSON.stringify(connection.prepare("SELECT * FROM receipts").all());
    connection.close();
    expect(rows).not.toContain(PERSON);

    const { files } = await exportFromWeb();
    expect(files.has("subjects.jsonl")).toBe(false);
    for (const [name, text] of files) expect(text.includes(PERSON), name).toBe(false);
  });

  it("is found from the web view by identifier, through the table", async () => {
    await ingest(candidateRun());
    const found = await post("/ui/persone", { identifier: " Elena.Rizzo " });
    expect(found.status).toBe(200);
    expect(found.body).toContain(chain()[1]?.actor.on_behalf_of ?? "missing");
    expect(found.body).toContain("valuta_candidato");
    expect((found.body.match(/class="person-receipt"/g) ?? []).length).toBe(3);
  });

  it("is erased from the web view: the receipts stay valid, the identifier leaves the file, the log keeps the token", async () => {
    await ingest(candidateRun());
    const token = chain()[1]?.actor.on_behalf_of ?? "";
    expect(databaseBytes().includes(PERSON)).toBe(true);

    const refused = await post("/ui/persone/cancella", { token, confirm: "sì" });
    expect(refused.status).toBe(400);
    const erased = await post("/ui/persone/cancella", { token, confirm: token });
    expect(erased.status).toBe(303);

    expect(databaseBytes().includes(PERSON)).toBe(false);
    expect((await post("/ui/persone", { identifier: PERSON })).body).not.toContain(token);
    const [entry] = store.adminLog(1);
    expect(entry).toMatchObject({ action: "subject.erase", detail: { token } });
    expect(JSON.stringify(entry)).not.toContain(PERSON);

    const { zip } = await exportFromWeb();
    const archivePath = join(directory, "fascicolo.zip");
    writeFileSync(archivePath, zip);
    expect(verifier(archivePath, "--quiet").status).toBe(0);
  }, 30_000);

  it("is named in an export only for the tokens chosen", async () => {
    await ingest(candidateRun());
    const token = chain()[1]?.actor.on_behalf_of ?? "";
    const { zip, files } = await exportFromWeb({ subjects: `${token} psn_${"f".repeat(32)}` });
    expect(files.get("subjects.jsonl")).toBe(`${JSON.stringify({ token, identifier: PERSON })}\n`);
    const archivePath = join(directory, "fascicolo.zip");
    writeFileSync(archivePath, zip);
    const result = verifier(archivePath);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("names the person behind 1 pseudonym token");
  }, 30_000);
});

describe("short content received in the clear", () => {
  it("is digested with a salt: the same content differs between receipts and is not found by guessing", async () => {
    await ingest(candidateRun());
    const [, read, assess, decide] = chain();
    // "score: 7" is the output of one action and the input of the next.
    expect(assess?.output_hash).not.toBe(decide?.input_hash);
    expect(read?.v === 4 && read.output_hash_scheme).toBe("salted");

    const { files } = await exportFromWeb();
    expect(files.has("openings.jsonl")).toBe(false);
    const recorded = new Set(chain().flatMap((receipt) => [receipt.input_hash, receipt.output_hash]));
    const guesses = Array.from({ length: 101 }, (_, score) => `score: ${score}`).concat("idoneo", "non idoneo", CV);
    for (const guess of guesses) expect(recorded.has(hashCanonicalJson(guess)), guess).toBe(false);
    // Nor is any of the content in the database, in any form.
    for (const content of ["score: 7", "idoneo", "cinque anni"]) expect(databaseBytes().includes(content), content).toBe(false);
  });

  it("opens with its nonce from an export that discloses it, and no longer once the nonce is erased", async () => {
    await ingest(candidateRun());
    const seq = 3; // decidi, whose input was "score: 7"
    const nonce = store.opening(SYSTEM, seq, "input") ?? "";
    expect(openSaltedDigest(chain()[seq]?.input_hash ?? "", fromHex(nonce), "score: 7")).toBe(true);

    const disclosed = await exportFromWeb({ openings: String(seq) });
    expect(disclosed.files.get("openings.jsonl")).toContain(nonce);
    const archivePath = join(directory, "aperto.zip");
    writeFileSync(archivePath, disclosed.zip);
    const opened = verifier("open", archivePath, String(seq), "input", "--text", "score: 7");
    expect(opened.status, opened.stdout + opened.stderr).toBe(0);
    expect(opened.stdout).toContain("MATCH");
    expect(verifier("open", archivePath, String(seq), "input", "--text", "score: 8").status).toBe(1);

    const erased = await serverCli("openings", "erase", SYSTEM, "--seq", String(seq), "--confirm", SYSTEM);
    expect(erased.code, erased.stderr).toBe(0);
    expect(store.opening(SYSTEM, seq, "input")).toBeNull();
    expect(databaseBytes().includes(nonce)).toBe(false);

    const after = await exportFromWeb({ openings: String(seq) });
    expect(after.files.has("openings.jsonl")).toBe(false);
    const afterPath = join(directory, "dopo.zip");
    writeFileSync(afterPath, after.zip);
    const closed = verifier("open", afterPath, String(seq), "input", "--text", "score: 7");
    expect(closed.status).toBe(1);
    expect(closed.stdout).toContain("nonce");
  }, 60_000);

  it("is digested plain when the client already hashed it, and says so", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts",
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        actor: { agent: "agente-cv", on_behalf_of: PERSON },
        action: { kind: "decision", name: "decidi" },
        outcome: "ok",
        input_hash: hashCanonicalJson("score: 7"),
        output: { esito: "idoneo" },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const receipt = chain()[1];
    expect(receipt?.v === 4 && [receipt.input_hash_scheme, receipt.output_hash_scheme]).toEqual(["plain", "salted"]);
    expect(receipt?.input_hash).toBe(hashCanonicalJson("score: 7"));
    expect(openSaltedDigest(receipt?.output_hash ?? "", fromHex(store.opening(SYSTEM, 1, "output") ?? ""), { esito: "idoneo" })).toBe(true);
  });
});

describe("a candidate who asks to be forgotten", () => {
  it("is found by their CV's fingerprint and trace, cut off from every input and output, and then their CV is deleted", async () => {
    await ingest(candidateRun());
    // Another candidate's run, which must not be touched.
    const other = JSON.parse(JSON.stringify(candidateRun()).replaceAll(TRACE, "1af7651916cd43dd8448eb211c80319c").replaceAll(CV_SHA256, "d".repeat(64))) as unknown;
    await ingest(other);
    const cvPath = join(directory, "cv-candidata.txt");
    writeFileSync(cvPath, CV);

    const result = await serverCli("openings", "erase", "--document", cvPath, "--confirm", SYSTEM);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${SYSTEM}: seq 1, 2, 3`);
    for (const seq of [1, 2, 3]) {
      expect(store.opening(SYSTEM, seq, "input")).toBeNull();
      expect(store.opening(SYSTEM, seq, "output")).toBeNull();
    }
    expect(store.opening(SYSTEM, 5, "input")).not.toBeNull();
    // The last step is the operator's, outside sigillo: the CV itself.
    rmSync(cvPath);

    // What is left: valid receipts, an artifact digest nobody can reverse
    // without the CV, and digests nobody can open.
    const { zip } = await exportFromWeb({ openings: "1 2 3" });
    const archivePath = join(directory, "fascicolo.zip");
    writeFileSync(archivePath, zip);
    expect(verifier(archivePath, "--quiet").status).toBe(0);
    expect(verifier("open", archivePath, "3", "input", "--text", "score: 7").status).toBe(1);
  }, 60_000);

  it("can have their pseudonym erased from the command line by identifier, with only the token logged", async () => {
    await ingest(candidateRun());
    const token = chain()[1]?.actor.on_behalf_of ?? "";
    const found = await serverCli("subject", "find", "Elena.Rizzo");
    expect(found.stdout.trim()).toBe(token);
    const erased = await serverCli("subject", "erase", "--identifier", PERSON);
    expect(erased.code, erased.stderr).toBe(0);
    expect(erased.stdout).toContain(token);
    expect(erased.stdout).not.toContain(PERSON);
    expect((await serverCli("admin-log")).stdout).toContain(`subject.erase`);
    expect((await serverCli("admin-log")).stdout).not.toContain(PERSON);
    expect((await serverCli("subject", "find", PERSON)).code).toBe(1);
  }, 60_000);
});

describe("a chain started before version 4", () => {
  it("keeps its v2 receipts valid, with v4 receipts after them, in the same export", async () => {
    // A v2 receipt as the previous server wrote it, with an identifier in the
    // clear and a plain digest: signed by the signer itself (which accepts
    // every receipt version and now remembers it as the chain's head), and put
    // in the table directly, as the earlier server version would have.
    const genesis = chain()[0] as Receipt;
    const unsigned: UnsignedReceiptV2 = {
      v: RECEIPT_VERSION_2,
      system_id: SYSTEM,
      seq: 1,
      // After the genesis: the signer refuses a ts_received earlier than its head's.
      ts_event: new Date(clock).toISOString(),
      ts_received: new Date(clock).toISOString(),
      actor: { agent: "agente-cv", on_behalf_of: "mario.bianchi" },
      action: { kind: "tool_call", name: "leggi_curriculum" },
      input_hash: hashCanonicalJson("score: 5"),
      output_hash: null,
      outcome: "ok",
      source: { type: "sdk" },
      prev_hash: toHex(sha256(canonicalReceiptBytes(genesis))),
      key_id: signer.keyId,
      artifacts: [{ role: "input", label: "curriculum", media_type: "text/plain", sha256: "e".repeat(64) }],
    };
    const bytes = canonicalReceiptBytes(unsigned);
    const sig = await signer.signReceipt(unsigned);
    const raw = new (await import("better-sqlite3")).default(databasePath);
    raw
      .prepare(
        `INSERT INTO receipts (system_id, seq, hash, prev_hash, canonical, sig, key_id, ts_event, ts_received, action_kind, action_name, outcome)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'tool_call', 'leggi_curriculum', 'ok')`,
      )
      .run(SYSTEM, toHex(sha256(bytes)), unsigned.prev_hash, new TextDecoder().decode(bytes), sig, signer.keyId, unsigned.ts_event, unsigned.ts_received);
    raw.close();

    await ingest(candidateRun());
    expect(chain().map((receipt) => receipt.v)).toEqual([4, 2, 4, 4, 4]);

    const { zip, files } = await exportFromWeb();
    expect(JSON.parse(files.get("manifest.json") ?? "{}").receipt_version).toBe(4);
    const archivePath = join(directory, "misto.zip");
    writeFileSync(archivePath, zip);
    const result = verifier(archivePath, "--quiet");
    expect(result.status, result.stderr).toBe(0);
    // A plain v2 digest opens without a nonce, as it always could.
    expect(verifier("open", archivePath, "1", "input", "--text", "score: 5").stdout).toContain("MATCH");
  }, 30_000);
});
