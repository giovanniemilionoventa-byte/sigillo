import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { it } from "./helpers/italian.js";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { hashCanonicalJson, textSha256 } from "@sigillo/core";
import { VERIFY_DOCUMENT_SCRIPT } from "../src/http/ui.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The "verifica un documento" page, end to end, as it was used when a pilot
 * reported a document the agent had really used as "no match": a system
 * created from the web view under a name with a space in it, its API key,
 * the agent's spans over OTLP carrying `sigillo.artifact` events, and then
 * the page itself — its browser script hashing the file and navigating, and
 * the route answering that navigation. Nothing cryptographic is stood in for.
 */

const PASSWORD = "an administrator password";
const ONE_DAY_MS = 24 * 60 * 60_000;

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;
let clock = Date.parse("2026-09-24T09:00:00.000Z");
let spanCounter = 0;

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function signIn(): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/ui/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: form({ password: PASSWORD }),
  });
  expect(login.statusCode).toBe(302);
  return String(login.headers["set-cookie"]).split(";")[0] ?? "";
}

/** Creates a system from the web view, as the operator does, and returns its API key. */
async function createSystem(cookie: string, systemId: string): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/ui/sistemi",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload: form({ system_id: systemId }),
  });
  expect(created.statusCode, created.body).toBe(200);
  const token = /sigillo_[0-9a-f]{16}_[0-9a-f]{64}/.exec(created.body)?.[0];
  expect(token).toBeDefined();
  return token ?? "";
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A tool span the way the demo agent's `leggi_curriculum` produces one: with
 * only the exact fingerprint, as every SDK before sigillo-text/1 sent it, or
 * with the text fingerprint too, as the current SDK does for a text file.
 */
function cvSpan(fileSha256: string, textSha256?: string): Record<string, unknown> {
  spanCounter += 1;
  const start = BigInt(clock) * 1_000_000n;
  return {
    traceId: createHash("md5").update(`trace-${spanCounter}`).digest("hex"),
    spanId: createHash("md5").update(`span-${spanCounter}`).digest("hex").slice(0, 16),
    name: "leggi_curriculum",
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + 1_000_000n),
    attributes: [
      { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
      { key: "tool.name", value: { stringValue: "leggi_curriculum" } },
    ],
    events: [
      {
        name: "sigillo.artifact",
        timeUnixNano: String(start),
        attributes: [
          { key: "sigillo.artifact.role", value: { stringValue: "input" } },
          { key: "sigillo.artifact.label", value: { stringValue: "curriculum" } },
          { key: "sigillo.artifact.media_type", value: { stringValue: "text/plain" } },
          { key: "sigillo.artifact.sha256", value: { stringValue: fileSha256 } },
          ...(textSha256 === undefined
            ? []
            : [
                { key: "sigillo.artifact.text_canon", value: { stringValue: "sigillo-text/1" } },
                { key: "sigillo.artifact.text_sha256", value: { stringValue: textSha256 } },
              ]),
        ],
      },
    ],
  };
}

async function sendSpans(token: string, serviceName: string, spans: Record<string, unknown>[]): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/traces",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
          scopeSpans: [{ spans }],
        },
      ],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  clock += 1_000;
}

/**
 * Runs the page's own inline script against `fileBytes` (or `text`, typed in
 * the box), with just enough of a DOM for it to find its inputs, and returns
 * where it sends the browser. The hashing is Node's real Web Crypto, and the
 * text decoding Node's real TextDecoder, which is what a browser offers.
 */
async function urlTheBrowserWouldOpen(fileBytes: Uint8Array | null, text = ""): Promise<string> {
  let onClick: (() => Promise<void>) | undefined;
  const location = { href: "" };
  const elements: Record<string, unknown> = {
    "sigillo-doc-file": {
      files:
        fileBytes === null
          ? []
          : [{ arrayBuffer: async () => fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength) }],
    },
    "sigillo-doc-text": { value: text },
    "sigillo-doc-button": {
      disabled: true,
      addEventListener: (_type: string, handler: () => Promise<void>) => {
        onClick = handler;
      },
    },
    "sigillo-doc-inactive": { hidden: false },
    "sigillo-doc-failed": { hidden: true },
    "sigillo-doc-error": { textContent: "" },
  };
  runInNewContext(VERIFY_DOCUMENT_SCRIPT, {
    document: { getElementById: (id: string) => elements[id] ?? null },
    window: { location },
    history: { replaceState: () => undefined },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Array,
  });
  expect(onClick).toBeDefined();
  await onClick?.();
  return location.href;
}

async function verifyDocumentPage(cookie: string, url: string): Promise<string> {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.body;
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-verify-doc-"));
  const databasePath = join(directory, "sigillo.db");
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
      healthMonitor: new ChainHealthMonitor(store, signer.publicKey, ONE_DAY_MS),
      checkpointer: new Checkpointer({ store, now }),
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("verifica un documento, for a system whose name has a space in it", () => {
  it("finds a curriculum the agent used, from the file's own bytes", async () => {
    const cookie = await signIn();
    const token = await createSystem(cookie, "sistema cv");
    const cv = new TextEncoder().encode("Curriculum di Maria Bianchi, sviluppatrice backend junior.\n");
    await sendSpans(token, "sistema cv", [cvSpan(sha256Hex(cv))]);

    const url = await urlTheBrowserWouldOpen(cv);
    const query = new URL(url, "http://sigillo").searchParams;
    expect(url.startsWith(`/ui/verify-document?sha256=${sha256Hex(cv)}&`)).toBe(true);
    expect(query.get("text")).toBe(textSha256(cv));
    expect(query.get("json")).toBe(hashCanonicalJson(new TextDecoder().decode(cv)));
    expect(query.get("from")).toBe("file");
    const body = await verifyDocumentPage(cookie, url);
    expect(body).toContain("Risultato");
    expect(body).toContain("Questo documento è esattamente quello usato da sistema cv");
    expect(body).not.toContain("Nessuna azione registrata");
  });

  it("finds it among twenty candidates, next to another system that read the same files", async () => {
    const cookie = await signIn();
    const pilot = await createSystem(cookie, "sistema cv");
    const other = await createSystem(cookie, "selezione-cv");
    const cvs = Array.from({ length: 20 }, (_, index) =>
      new TextEncoder().encode(`Curriculum del candidato ${index + 1}.\r\nEsperienza: python, sql.\r\n`),
    );
    for (const cv of cvs) {
      await sendSpans(other, "selezione-cv", [cvSpan(sha256Hex(cv))]);
    }
    for (const cv of cvs) {
      await sendSpans(pilot, "sistema cv", [cvSpan(sha256Hex(cv))]);
    }
    const seventh = cvs[6] ?? new Uint8Array();

    const body = await verifyDocumentPage(cookie, await urlTheBrowserWouldOpen(seventh));
    expect(body).toContain("esattamente quello usato da selezione-cv");
    expect(body).toContain("esattamente quello usato da sistema cv");
    expect(body.match(/esattamente quello usato da/g)).toHaveLength(2);
  });

  it("links each match to its system's page, whatever characters the name holds", async () => {
    const cookie = await signIn();
    const names = ["sistema cv", "a/b", "a?b", "a&b", "perché", "a%20b", "a#b", "a+b"];
    const cv = new TextEncoder().encode("Curriculum condiviso.\n");
    for (const name of names) {
      await sendSpans(await createSystem(cookie, name), name, [cvSpan(sha256Hex(cv))]);
    }

    const body = await verifyDocumentPage(cookie, `/ui/verify-document?sha256=${sha256Hex(cv)}`);
    const links = [...body.matchAll(/<a href="(\/ui\/systems\/[^"]+)">/g)].map((match) => match[1] ?? "");
    expect(links).toHaveLength(names.length);
    for (const link of links) {
      const page = await app.inject({ method: "GET", url: link, headers: { cookie } });
      expect(page.statusCode, link).toBe(200);
    }
  });
});

/**
 * What the pilot actually hit. The receipt holds the fingerprint of
 * candidato-07.txt as a Windows checkout wrote it, with CRLF line endings;
 * the same text with LF line endings — a copy from any other checkout, or the
 * text pasted into the page's box, which a browser always reads back with LF
 * (HTML's textarea value normalisation) — has other bytes. Since the redesign
 * the page finds it anyway, and says exactly how it differs.
 */
describe("verifica un documento, when the same text has different line endings (a record made before sigillo-text/1)", () => {
  const textWithLf = "Curriculum di Andrea Bianchi\nEsperienza: python, sql.\n";
  const windowsBytes = new TextEncoder().encode(textWithLf.replace(/\n/g, "\r\n"));
  const unixBytes = new TextEncoder().encode(textWithLf);

  it("finds the LF copy of a CRLF document, and says that only the line endings differ", async () => {
    const cookie = await signIn();
    const token = await createSystem(cookie, "sistema cv");
    await sendSpans(token, "sistema cv", [cvSpan(sha256Hex(windowsBytes))]);

    const body = await verifyDocumentPage(cookie, await urlTheBrowserWouldOpen(unixBytes));
    expect(body).toContain('data-match="lines"');
    expect(body).toContain("a meno del modo di andare a capo");
    expect(body).not.toContain("esattamente quello usato");
  });

  it("finds it from the text pasted in the box too", async () => {
    const cookie = await signIn();
    const token = await createSystem(cookie, "sistema cv");
    await sendSpans(token, "sistema cv", [cvSpan(sha256Hex(windowsBytes))]);

    const body = await verifyDocumentPage(cookie, await urlTheBrowserWouldOpen(null, textWithLf.trimEnd()));
    expect(body).toContain('data-match="lines"');
  });

  it("does not stretch an old record to other spacing: it has no text fingerprint", async () => {
    const cookie = await signIn();
    const token = await createSystem(cookie, "sistema cv");
    await sendSpans(token, "sistema cv", [cvSpan(sha256Hex(windowsBytes))]);

    const body = await verifyDocumentPage(cookie, await urlTheBrowserWouldOpen(null, "Curriculum di Andrea Bianchi  Esperienza: python, sql."));
    expect(body).toContain("Nessuna azione registrata ha usato questo documento");
  });

  it("shows the exact fingerprint it searched for, found or not, so it can be compared by hand", async () => {
    const cookie = await signIn();
    const token = await createSystem(cookie, "sistema cv");
    await sendSpans(token, "sistema cv", [cvSpan(sha256Hex(windowsBytes))]);

    const found = await verifyDocumentPage(cookie, await urlTheBrowserWouldOpen(windowsBytes));
    expect(found).toContain(`Impronta esatta (SHA-256): <span class="hash">${sha256Hex(windowsBytes)}</span>`);
    const missed = await verifyDocumentPage(cookie, `/ui/verify-document?sha256=${"ab".repeat(32)}`);
    expect(missed).toContain(`Impronta esatta (SHA-256): <span class="hash">${"ab".repeat(32)}</span>`);
    expect(missed).toContain("Get-FileHash");
  });
});

describe("verifica un documento, for a text recorded with its sigillo-text/1 fingerprint", () => {
  const recorded = new TextEncoder().encode("Curriculum di Maria Bianchi\r\n\r\nEsperienza:   python,\tsql.\r\n");

  it("finds a copy that differs only in spacing and line breaks, and one with a changed letter not at all", async () => {
    const cookie = await signIn();
    const token = await createSystem(cookie, "sistema cv");
    await sendSpans(token, "sistema cv", [cvSpan(sha256Hex(recorded), textSha256(recorded) ?? undefined)]);

    const same = await verifyDocumentPage(cookie, await urlTheBrowserWouldOpen(null, "Curriculum di Maria Bianchi Esperienza: python, sql."));
    expect(same).toContain('data-match="text"');
    expect(same).toContain("ha lo stesso testo di quello usato da sistema cv");

    const exact = await verifyDocumentPage(cookie, await urlTheBrowserWouldOpen(recorded));
    expect(exact).toContain('data-match="bytes"');
    expect(exact.match(/data-match=/g)).toHaveLength(1);

    const other = await verifyDocumentPage(cookie, await urlTheBrowserWouldOpen(null, "Curriculum di Mario Bianchi Esperienza: python, sql."));
    expect(other).toContain("Nessuna azione registrata ha usato questo documento");
  });

  it("still finds a binary file by its exact bytes only", async () => {
    const cookie = await signIn();
    const token = await createSystem(cookie, "sistema cv");
    const pdf = new Uint8Array([...new TextEncoder().encode("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
    await sendSpans(token, "sistema cv", [cvSpan(sha256Hex(pdf))]);

    const url = await urlTheBrowserWouldOpen(pdf);
    expect(url).toBe(`/ui/verify-document?sha256=${sha256Hex(pdf)}&from=file`);
    expect(await verifyDocumentPage(cookie, url)).toContain('data-match="bytes"');
  });
});
