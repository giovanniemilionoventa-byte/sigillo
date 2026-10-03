import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readZip, receiptHashHex } from "@sigillo/core";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { UI } from "../src/http/strings.js";
import { STATE_ICONS, STYLE } from "../src/http/style.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The history of one system in direction B (PROGRESS.md, Interfaccia B, B2):
 * the filter by kind with its counts, the search, `?ricevuta=` and the
 * inspector, the evidence sheet, the tabs, and every link keeping the
 * filters it was drawn under. The data is the screenshots' fixture
 * (scripts/screenshots.ts), the same the mockups were drawn from.
 */

const SYSTEM = "acme-support-bot";
const EMPTY = "prova-per-errore";
const PASSWORD = "an administrator password";
const NOW = "2026-09-29T13:00:00.000Z";
const DAY_MS = 24 * 60 * 60_000;

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let healthMonitor: ChainHealthMonitor;
let app: FastifyInstance;
let cookie: string;

function event(minute: string, overrides: Partial<ChainEvent>): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: `2026-09-29T12:${minute}:13.000Z`,
    ts_received: `2026-09-29T12:${minute}:13.000Z`,
    actor: { agent: "support-agent" },
    action: { kind: "tool_call", name: "x" },
    input_hash: "a".repeat(64),
    output_hash: "b".repeat(64),
    outcome: "ok",
    source: { type: "sdk" },
    ...overrides,
  };
}

async function start(monitor: ChainHealthMonitor): Promise<FastifyInstance> {
  const server = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor: monitor,
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
    },
  });
  await server.ready();
  return server;
}

async function signIn(server: FastifyInstance): Promise<string> {
  const response = await server.inject({
    method: "POST",
    url: "/ui/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `password=${encodeURIComponent(PASSWORD)}`,
  });
  return String(response.headers["set-cookie"]).split(";")[0] ?? "";
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-history-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner({ now: () => new Date(NOW) });
  store = ReceiptStore.open(databasePath, signer);
  keys = ApiKeyStore.open(databasePath);
  await store.createSystem(SYSTEM, "2026-09-29T12:16:13.000Z");
  await store.append(
    event("36", { actor: { agent: "support-agent", on_behalf_of: "cliente-4821" }, action: { kind: "tool_call", name: "cerca_ordine" } }),
  );
  await store.append(
    event("37", { action: { kind: "llm_call", name: "chat" }, model: { name: "llama3.1:8b", provider: "ollama", digest: null } }),
  );
  await store.append(event("39", { action: { kind: "tool_call", name: "rimborsa_pagamento" }, outcome: "blocked" }));
  await store.append(event("40", { action: { kind: "decision", name: "escalation_operatore" } }));
  await store.createSystem(EMPTY, "2026-09-29T12:50:00.000Z");
  // Five minutes for a first checkpoint, so that SYSTEM, opened 44 minutes
  // before NOW and never sealed, is yellow.
  healthMonitor = new ChainHealthMonitor(store, signer.publicKey, DAY_MS, 5 * 60_000);
  healthMonitor.check();
  app = await start(healthMonitor);
  cookie = await signIn(app);
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const get = async (url: string, server = app, session = cookie): Promise<string> => {
  const response = await server.inject({ method: "GET", url, headers: { cookie: session } });
  expect(response.statusCode, url).toBe(200);
  return response.body;
};

const inspectorOf = (body: string): string => /<aside class="inspector"[^>]*>([^]*?)<\/aside>/.exec(body)?.[1] ?? "";
const listOf = (body: string): string => /<div class="rows-scroll" id="elenco">([^]*?)<\/section>/.exec(body)?.[1] ?? "";
const segmentsOf = (body: string): string => /<nav class="segmented"[^>]*>([^]*?)<\/nav>/.exec(body)?.[1] ?? "";
const amp = (url: string): string => url.replaceAll("&", "&amp;");

describe("?ricevuta= and the inspector", () => {
  it("opens the most recent receipt shown when the address names none, without marking a selection", async () => {
    const body = await get(`/ui/systems/${SYSTEM}`);
    expect(inspectorOf(body)).toContain('<h2 class="insp-title" id="dettaglio-titolo">Decisione: escalation_operatore</h2>');
    expect(body).toContain('<a class="row" id="r-4" href="/ui/systems/acme-support-bot?ricevuta=4#r-4" aria-current="true">');
    expect(body).toContain('<main id="main" class="studio">');
  });

  it("fills the inspector from ?ricevuta=, marks the row, and says so in the title", async () => {
    const body = await get(`/ui/systems/${SYSTEM}?ricevuta=1`);
    expect(inspectorOf(body)).toContain(UI.inspector.receiptNo(1));
    expect(listOf(body).match(/aria-current="true"/g)).toHaveLength(1);
    expect(body).toContain('<a class="row" id="r-1" href="/ui/systems/acme-support-bot?ricevuta=1#r-1" aria-current="true">');
    expect(body).toContain(`<title>${UI.inspector.receiptNo(1)} — ${SYSTEM} — sigillo</title>`);
    // On a phone the receipt is then a page of its own: the list steps aside.
    expect(body).toContain('<main id="main" class="studio has-selection">');
    expect(STYLE).toContain(".studio.has-selection .studio-list { display: none; }");
  });

  it("defaults to the most recent receipt of the kind shown", async () => {
    const body = await get(`/ui/systems/${SYSTEM}?kind=tool_call`);
    expect(inspectorOf(body)).toContain(UI.inspector.receiptNo(3));
  });

  it("shows the receipt asked for even when the filters leave it out of the list", async () => {
    const body = await get(`/ui/systems/${SYSTEM}?kind=decision&ricevuta=2`);
    expect(listOf(body)).not.toContain('id="r-2"');
    expect(inspectorOf(body)).toContain(UI.inspector.receiptNo(2));
  });

  it("falls back to the most recent receipt shown for a position that is not one, and never echoes it", async () => {
    for (const value of ["99", "-1", "1.5", "abc", "%3Cb%3E", "1e3"]) {
      const body = await get(`/ui/systems/${SYSTEM}?ricevuta=${value}`);
      expect(inspectorOf(body), value).toContain(UI.inspector.receiptNo(4));
      expect(body, value).toContain('<main id="main" class="studio">');
      expect(body, value).not.toContain("<b>");
    }
  });

  it("shows a blocked outcome as a triangle and a word, under a title that names the tool", async () => {
    const body = inspectorOf(await get(`/ui/systems/${SYSTEM}?kind=tool_call&ricevuta=3`));
    expect(body).toContain(`<span class="pill yellow" data-outcome="blocked">${STATE_ICONS.warn}Bloccato</span>`);
    expect(body).toContain('<h2 class="insp-title" id="dettaglio-titolo">Strumento: rimborsa_pagamento</h2>');
    expect(body).toContain("<dt>Agente</dt><dd>support-agent</dd>");
    expect(body).toContain("<dt>Arrivata da</dt><dd>SDK Python</dd>");
    // In Italian time, and said as people say it; the exact instant is in the technical details.
    expect(body).toContain("<dt>Quando</dt><dd>Oggi, 14:39</dd>");
    expect(body).toContain("<code>2026-09-29T12:39:13.000Z</code>");
  });

  it("names a model receipt's model and where it runs, and its prompt and reply fingerprints", async () => {
    const body = inspectorOf(await get(`/ui/systems/${SYSTEM}?kind=llm_call&ricevuta=2`));
    expect(body).toContain('<h2 class="insp-title" id="dettaglio-titolo">Modello: llama3.1:8b</h2>');
    expect(body).toContain('<dt>Modello</dt><dd>llama3.1:8b<span class="sub">in locale, con ollama</span></dd>');
    expect(body).toContain(`<dt>${UI.inspector.promptHash}</dt>`);
    expect(body).toContain(`<dt>${UI.inspector.replyHash}</dt>`);
    expect(body).toContain('<span class="pill green" data-outcome="ok">');
  });

  it("explains the opening of the register, with no agent, no previous receipt, and its anchoring still pending", async () => {
    const body = await get(`/ui/systems/${EMPTY}?kind=genesis`);
    const inspector = inspectorOf(body);
    expect(inspector).toContain(UI.inspector.receiptNo(0));
    expect(inspector).toContain('<h2 class="insp-title" id="dettaglio-titolo">Registro aperto</h2>');
    expect(inspector).toContain(UI.inspector.genesisNote.replaceAll("'", "&#39;"));
    expect(inspector).not.toContain("<dt>Agente</dt>");
    expect(inspector).toContain(`<dt>Arrivata da</dt><dd>${UI.inspector.sources.genesis}</dd>`);
    expect(inspector).toContain(`${UI.inspector.first}<code class="hash-full">${"0".repeat(64)}</code>`);
    expect(inspector).toContain(`<dt>${UI.inspector.seal}</dt><dd><span class="wait">${UI.inspector.sealWaiting}</span></dd>`);
    expect(inspector).toContain(UI.anchoring.notCovered);
    expect(listOf(body)).toContain('<span class="row-title">Registro aperto</span>');
  });

  it("names whom an action was for, and links each receipt to the one before it", async () => {
    const inspector = inspectorOf(await get(`/ui/systems/${SYSTEM}?ricevuta=1`));
    expect(inspector).toContain('<dt>Per conto di</dt><dd><a href="/ui/persone">');
    const previous = store.readChain(SYSTEM)[0];
    expect(inspector).toContain(
      `<a href="/ui/systems/acme-support-bot?ricevuta=0#r-0">${UI.inspector.linkedTo(0)}</a><code class="hash-full">${receiptHashHex(previous!)}</code>`,
    );
    expect(inspector).toContain(receiptHashHex(store.readChain(SYSTEM)[1]!));
  });

  it("says a receipt is anchored, and links the checkpoints, once a timestamped checkpoint covers it", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM);
    await store.recordTimestamp(checkpoint!.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), NOW);
    const inspector = inspectorOf(await get(`/ui/systems/${SYSTEM}?ricevuta=3`));
    expect(inspector).toContain(`<dt>${UI.inspector.seal}</dt><dd><span class="ok">${UI.inspector.sealedAt("oggi alle 15:00")}</span></dd>`);
    expect(inspector).toContain(`<a href="/ui/systems/${SYSTEM}/checkpoints">${UI.checkpoints.title}</a>`);
  });

  it("keeps signature, key and full fingerprints in a <details>, opened without a script", async () => {
    const inspector = inspectorOf(await get(`/ui/systems/${SYSTEM}?ricevuta=4`));
    const details = inspector.slice(inspector.indexOf('<details class="tech">'));
    expect(details).toContain(`<span>${UI.inspector.technical}</span>`);
    expect(details).toContain(store.readChain(SYSTEM)[4]!.sig);
    expect(details).toContain(`Ed25519 · ${signer.keyId}`);
    expect(details).toContain("a".repeat(64));
  });
});

describe("the filter by kind, with its counts", () => {
  it("offers every kind it holds as a link, each with how many receipts, and leaves out the empty ones", async () => {
    const segments = segmentsOf(await get(`/ui/systems/${SYSTEM}`));
    const counted = [...segments.matchAll(/>([^<>]+)<span class="count">(\d+)<\/span><\/a>/g)].map((match) => [match[1], Number(match[2])]);
    expect(counted).toEqual([
      ["Tutte", 5],
      ["Strumenti", 2],
      ["Modelli", 1],
      ["Decisioni", 1],
      ["Apertura", 1],
    ]);
    expect(segments).toContain('<a href="/ui/systems/acme-support-bot" aria-current="page">Tutte');
    expect(segments).toContain('<a href="/ui/systems/acme-support-bot?kind=tool_call">Strumenti');
  });

  it("counts under the other filters, and marks the kind chosen", async () => {
    const body = await get(`/ui/systems/${SYSTEM}?kind=tool_call&name=r`);
    const segments = segmentsOf(body);
    expect(segments).toContain(`<a href="${amp("/ui/systems/acme-support-bot?kind=tool_call&name=r")}" aria-current="page">Strumenti<span class="count">2</span>`);
    expect(segments).not.toContain("Modelli");
    expect(segments).toContain('Decisioni<span class="count">1</span>');
    expect(segments).toContain('Tutte<span class="count">4</span>');
    expect(segments).toContain('Apertura<span class="count">1</span>');
    expect(listOf(body).match(/class="row"/g)).toHaveLength(2);
  });

  it("says plainly when nothing matches", async () => {
    const body = await get(`/ui/systems/${SYSTEM}?kind=agent_step`);
    expect(body).toContain(UI.history.noMatches);
    expect(listOf(body)).not.toContain('class="row"');
  });
});

describe("every link keeps the filters it was drawn under", () => {
  const FILTERED = "/ui/systems/acme-support-bot?kind=tool_call&name=r&from=2026-09-29&to=2026-09-29";

  it("in the rows, the segments, the previous receipt, the way back, the search form and its reset", async () => {
    const body = await get(`${FILTERED}&ricevuta=3`);
    // A row: every filter, and the receipt.
    expect(body).toContain(`<a class="row" id="r-1" href="${amp(`${FILTERED}&ricevuta=1`)}#r-1">`);
    // A segment: the other filters, another kind, no receipt.
    expect(segmentsOf(body)).toContain(
      `<a href="${amp("/ui/systems/acme-support-bot?kind=decision&name=r&from=2026-09-29&to=2026-09-29")}">Decisioni`,
    );
    expect(segmentsOf(body)).toContain(`<a href="${amp("/ui/systems/acme-support-bot?name=r&from=2026-09-29&to=2026-09-29")}">Tutte`);
    // The receipt before, and the way back to the list on a phone.
    expect(inspectorOf(body)).toContain(`<a href="${amp(`${FILTERED}&ricevuta=2`)}#r-2">`);
    expect(inspectorOf(body)).toContain(`<a class="back" href="${amp(FILTERED)}#r-3">`);
    // The search keeps the kind, and shows the current values.
    expect(body).toContain('<input type="hidden" name="kind" value="tool_call">');
    expect(body).toContain('<input type="text" name="name" value="r"');
    expect(body).toContain('<input type="date" name="from" value="2026-09-29">');
    expect(body).toMatch(/<details class="search" open>/);
    // Clearing the search keeps the kind.
    expect(body).toContain(`<a href="/ui/systems/acme-support-bot?kind=tool_call">${UI.history.clearFilters}</a>`);
  });

  it("escapes what it carries, so a filter cannot become markup", async () => {
    const body = await get(`/ui/systems/${SYSTEM}?name=${encodeURIComponent('"><script>alert(1)</script>')}`);
    expect(body).not.toContain("<script>alert(1)");
    expect(body).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("reads a date alone as the whole day, and still accepts a full ISO time", async () => {
    expect(listOf(await get(`/ui/systems/${SYSTEM}?to=2026-09-29`))).toContain('id="r-4"');
    expect(listOf(await get(`/ui/systems/${SYSTEM}?from=2026-09-30`))).not.toContain('id="r-');
    const precise = listOf(await get(`/ui/systems/${SYSTEM}?from=2026-09-29T12:38:00.000Z`));
    expect(precise).toContain('id="r-3"');
    expect(precise).not.toContain('id="r-2"');
  });
});

describe("the system's header, tabs and evidence sheet", () => {
  it("shows the name and the chain state from the real check, on every tab", async () => {
    for (const [path, tab] of [
      ["", UI.history.back],
      ["/checkpoints", UI.checkpoints.title],
      ["/manage", UI.settings.title],
    ] as const) {
      const body = await get(`/ui/systems/${SYSTEM}${path}`);
      expect(body, path).toContain(`<h1>${SYSTEM}</h1>`);
      // Not anchored yet: the monitor says yellow, and the header says what it says.
      expect(body, path).toContain(`<span class="pill yellow" data-chain="yellow">`);
      expect(body, path).toContain(`${UI.chain.yellow}</span>`);
      expect(body, path).toContain(
        `<p class="sys-health yellow">${healthMonitor.statusFor(SYSTEM, new Date(NOW)).message.replaceAll("'", "&#39;")}</p>`,
      );
      expect(body, path).toContain(`aria-current="page">${tab}</a>`);
      expect(body.match(/<nav class="tabs"[^]*?<\/nav>/)?.[0].match(/aria-current/g), path).toHaveLength(1);
      expect(body, path).toContain('<a class="button primary" href="#fascicolo">');
      expect(body, path).toContain('<section class="sheet-layer" id="fascicolo"');
    }
  });

  it("says 'Integro' only when the check says green, and 'Verifica fallita' when the chain no longer verifies", async () => {
    const checkpoint = await store.createCheckpoint(SYSTEM);
    await store.recordTimestamp(checkpoint!.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), NOW);
    expect(healthMonitor.statusFor(SYSTEM, new Date(NOW)).status).toBe("green");
    const green = await get(`/ui/systems/${SYSTEM}`);
    expect(green).toContain(`<span class="pill green" data-chain="green">`);
    expect(green).toContain(`${UI.chain.green}</span>`);
    expect(green).not.toContain('<p class="sys-health');

    const raw = new Database(join(directory, "sigillo.db"));
    raw.exec("DROP TRIGGER receipts_no_update");
    const row = raw.prepare("SELECT canonical FROM receipts WHERE system_id = ? AND seq = 2").get(SYSTEM) as { canonical: string };
    raw.prepare("UPDATE receipts SET canonical = ? WHERE system_id = ? AND seq = 2").run(row.canonical.replace('"ok"', '"error"'), SYSTEM);
    raw.close();
    const fresh = new ChainHealthMonitor(store, signer.publicKey, DAY_MS);
    fresh.check();
    const freshApp = await start(fresh);
    try {
      const red = await get(`/ui/systems/${SYSTEM}`, freshApp, await signIn(freshApp));
      expect(red).toContain(`<span class="pill red" data-chain="red">`);
      expect(red).toContain(`${UI.chain.red}</span>`);
      expect(red).not.toContain(`${UI.chain.green}</span>`);
    } finally {
      await freshApp.close();
    }
  });

  it("opens the evidence sheet with :target: the same form, the period and the optional disclosures", async () => {
    const body = await get(`/ui/systems/${SYSTEM}`);
    const sheet = /<section class="sheet-layer" id="fascicolo"[^]*?<\/section>/.exec(body)?.[0] ?? "";
    expect(sheet).toContain(`<form method="post" action="/ui/systems/${SYSTEM}/export">`);
    for (const field of ['type="date" name="from"', 'type="date" name="to"', 'name="subjects"', 'name="openings"']) {
      expect(sheet, field).toContain(field);
    }
    expect(sheet).toContain('<a class="button" href="#main">Annulla</a>');
    expect(STYLE).toContain(".sheet-layer:target {");
    expect(body).not.toContain("<script");
  });

  it("exports the period the sheet sends, and the whole chain without one", async () => {
    const zip = async (payload: string): Promise<string> => {
      const response = await app.inject({
        method: "POST",
        url: `/ui/systems/${SYSTEM}/export`,
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        payload,
      });
      expect(response.statusCode).toBe(200);
      const entry = readZip(new Uint8Array(response.rawPayload)).find((file) => file.name === "receipts.jsonl");
      return new TextDecoder().decode(entry?.data);
    };
    await store.append({ ...event("00", { action: { kind: "decision", name: "chiusura" } }), ts_event: "2026-09-30T08:00:00.000Z", ts_received: "2026-09-30T08:00:00.000Z" });
    expect((await zip("")).trim().split("\n")).toHaveLength(6);
    expect((await zip("from=2026-09-30&to=2026-09-30")).trim().split("\n")).toHaveLength(1);
    expect((await zip("from=2026-09-29&to=2026-09-29&subjects=&openings=")).trim().split("\n")).toHaveLength(5);
  }, 30_000);
});
