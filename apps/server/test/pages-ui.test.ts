import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { it } from "./helpers/italian.js";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { buildServer } from "../src/http/server.js";
import { UI } from "../src/http/strings.js";
import { STATE_ICONS } from "../src/http/style.js";
import { VERIFY_DOCUMENT_SCRIPT } from "../src/http/ui.js";
import { ReceiptStore, type ChainEvent } from "../src/storage/store.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * The pages of direction B other than the history (PROGRESS.md, Interfaccia
 * B, B3): the main page, the systems, a new system's key, managing one, its
 * checkpoints, verifying a document, the people, not found. And the two
 * promises the whole phase makes: every form keeps its action, method and
 * fields, and no page carries a script but "verifica un documento".
 */

const SYSTEM = "acme-support-bot";
const EMPTY = "prova-per-errore";
const PASSWORD = "an administrator password";
const NOW = "2026-09-29T13:00:00.000Z";
const PERSON = "cliente-4821";

let directory: string;
let signer: TestSigner;
let store: ReceiptStore;
let keys: ApiKeyStore;
let app: FastifyInstance;
let cookie: string;

function event(minute: string, overrides: Partial<ChainEvent>): ChainEvent {
  return {
    system_id: SYSTEM,
    ts_event: `2026-09-29T12:${minute}:13.000Z`,
    ts_received: `2026-09-29T12:${minute}:13.000Z`,
    actor: { agent: "support-agent" },
    action: { kind: "tool_call", name: "x" },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "sdk" },
    ...overrides,
  };
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-pages-"));
  const databasePath = join(directory, "sigillo.db");
  signer = createTestSigner({ now: () => new Date(NOW) });
  store = ReceiptStore.open(databasePath, signer);
  keys = ApiKeyStore.open(databasePath);
  await store.createSystem(SYSTEM, "2026-09-29T12:16:13.000Z");
  await store.renameSystem(SYSTEM, "Assistente clienti", { actor: "web 192.0.2.10", ts: NOW });
  await store.append(event("36", { actor: { agent: "support-agent", on_behalf_of: PERSON }, action: { kind: "tool_call", name: "cerca_ordine" } }));
  await store.append(
    event("37", {
      action: { kind: "tool_call", name: "leggi_curriculum" },
      artifacts: [{ role: "input", label: "candidato-01.txt", media_type: "text/plain", sha256: "c".repeat(64) }],
    }),
  );
  await store.append(event("39", { action: { kind: "tool_call", name: "rimborsa_pagamento" }, outcome: "blocked" }));
  await store.createSystem(EMPTY, "2026-09-29T12:50:00.000Z");
  const checkpoint = await store.createCheckpoint(SYSTEM);
  await store.recordTimestamp(checkpoint!.id, "https://freetsa.org/tsr", Buffer.from([0x30]).toString("base64"), NOW);
  // Five minutes for a first checkpoint, so that EMPTY, opened ten minutes
  // before NOW and never sealed, is yellow.
  const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 60 * 60_000, 5 * 60_000);
  healthMonitor.check();
  app = buildServer({
    store,
    keys,
    now: () => new Date(NOW),
    ui: {
      password: PASSWORD,
      signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
      healthMonitor,
      checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
    },
  });
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/ui/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: `password=${encodeURIComponent(PASSWORD)}`,
  });
  cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
});

afterEach(async () => {
  await app.close();
  keys.close();
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const get = async (url: string, status = 200): Promise<string> => {
  const response = await app.inject({ method: "GET", url, headers: { cookie } });
  expect(response.statusCode, url).toBe(status);
  return response.body;
};
const post = async (url: string, payload: string): Promise<{ status: number; body: string }> => {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    payload,
  });
  return { status: response.statusCode, body: response.body };
};
const mainOf = (body: string): string => /<main id="main"[^>]*>([^]*)<\/main>/.exec(body)?.[1] ?? "";

/** Every form on a page: its method, its action, and the names of its fields, in order. */
function formsOf(body: string): string[] {
  return [...body.matchAll(/<form\b([^>]*)>([^]*?)<\/form>/g)].map(([, attributes = "", inside = ""]) => {
    const method = /method="([^"]+)"/.exec(attributes)?.[1] ?? "get";
    const action = /action="([^"]+)"/.exec(attributes)?.[1] ?? "";
    const names = [...inside.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);
    return `${method} ${action} [${names.join(" ")}]`;
  });
}

describe("every form keeps its action, method and field names", () => {
  it("on every page, exactly the forms it should have, each with its action, method and fields", async () => {
    const pages: [string, string[]][] = [
      [
        "/ui",
        [
          "post /ui/logout []",
          "post /ui/export [system_id from to subjects openings]",
          "post /ui/checkpoint []",
        ],
      ],
      ["/ui/sistemi", ["post /ui/logout []"]],
      ["/ui/sistemi/nuovo", ["post /ui/logout []", "post /ui/sistemi [display_name system_id]"]],
      [
        `/ui/systems/${SYSTEM}`,
        [
          "post /ui/logout []",
          `get /ui/systems/${SYSTEM} [name from to]`,
          `post /ui/systems/${SYSTEM}/export [from to subjects openings]`,
        ],
      ],
      [
        `/ui/systems/${SYSTEM}/checkpoints`,
        ["post /ui/logout []", "post /ui/checkpoint []", `post /ui/systems/${SYSTEM}/export [from to subjects openings]`],
      ],
      [
        `/ui/systems/${SYSTEM}/manage`,
        [
          "post /ui/logout []",
          `post /ui/systems/${SYSTEM}/rename [display_name]`,
          `post /ui/systems/${SYSTEM}/archive []`,
          `post /ui/systems/${SYSTEM}/key []`,
          `post /ui/systems/${SYSTEM}/export [from to subjects openings]`,
        ],
      ],
      [
        `/ui/systems/${EMPTY}/manage`,
        [
          "post /ui/logout []",
          `post /ui/systems/${EMPTY}/rename [display_name]`,
          `post /ui/systems/${EMPTY}/archive []`,
          `post /ui/systems/${EMPTY}/delete [confirm]`,
          `post /ui/systems/${EMPTY}/key []`,
          `post /ui/systems/${EMPTY}/export [from to subjects openings]`,
        ],
      ],
      ["/ui/verify-document", ["post /ui/logout []"]],
      // The sign-out is there twice: in the sidebar, and in the account's block.
      ["/ui/impostazioni", ["post /ui/logout []", "post /ui/logout []", "post /ui/impostazioni/tema []", "post /ui/lingua [back]"]],
    ];
    for (const [url, forms] of pages) {
      expect(formsOf(await get(url)), url).toEqual(forms);
    }
    await store.archiveSystem(EMPTY, { actor: "test", ts: NOW });
    expect(formsOf(await get(`/ui/systems/${EMPTY}/manage`))).toContain(`post /ui/systems/${EMPTY}/unarchive []`);
    const login = (await app.inject({ method: "GET", url: "/ui/login" })).body;
    expect(formsOf(login)).toEqual(["post /ui/login [password]", "post /ui/lingua [back]"]);
    const admin = (await app.inject({ method: "GET", url: "/ui/admin" })).body;
    expect(formsOf(admin)).toEqual(["post /ui/login [password]", "post /ui/lingua [back]"]);
  });

  it("carries no script anywhere but on 'verifica un documento', and there exactly the one the CSP allows", async () => {
    for (const url of ["/ui", "/ui/sistemi", "/ui/sistemi?vista=tutti", `/ui/systems/${SYSTEM}`, `/ui/systems/${SYSTEM}?ricevuta=1`,
      `/ui/systems/${SYSTEM}/checkpoints`, `/ui/systems/${SYSTEM}/manage`, "/ui/impostazioni", "/ui/impostazioni/registro",
      "/ui/sistemi/nuovo", `/ui/systems/${SYSTEM}/collega`]) {
      const body = await get(url);
      expect(body, url).not.toContain("<script");
      expect(body, url).not.toMatch(/\son[a-z]+=/);
    }
    const verify = await get("/ui/verify-document");
    const scripts = [...verify.matchAll(/<script>([^]*?)<\/script>/g)].map((match) => match[1]);
    expect(scripts).toEqual([VERIFY_DOCUMENT_SCRIPT]);
    expect(createHash("sha256").update(scripts[0] ?? "").digest("base64")).toBe(
      createHash("sha256").update(VERIFY_DOCUMENT_SCRIPT).digest("base64"),
    );
  });
});

describe("the main page (Registro)", () => {
  it("says the situation in one line, then four figures, the systems and the evidence", async () => {
    const main = mainOf(await get("/ui"));
    // The empty chain has no checkpoint yet: one system to look at, so the line says yellow and links to it.
    expect(main).toContain(`<div class="status yellow" role="status" data-status="yellow">`);
    expect(main).toContain(`<span>${UI.home.summary.yellow(1)}</span><a href="/ui/systems/${EMPTY}">${UI.home.summary.why}</a>`);
    const tiles = [...main.matchAll(/<div class="card tile[^"]*"><strong>([^<]+)<\/strong><span>([^<]+)<\/span><\/div>/g)].map((match) => [match[2], match[1]]);
    expect(tiles).toEqual([
      [UI.home.tiles.today, "3"],
      [UI.home.tiles.blocked, "1"],
      [UI.home.tiles.failed, "0"],
      [UI.home.tiles.lastSeal, "15:00"],
    ]);
    // The state, from the chain check: anchored and recent, so green.
    expect(main).toContain(`<a class="line" href="/ui/systems/${SYSTEM}"><span class="line-text">Assistente clienti</span><span class="pill green" data-chain="green">`);
    expect(main).toContain('<form method="post" action="/ui/export" class="fields">');
  });

  it("lists recent actions with their outcome only when it is not completed", async () => {
    const main = mainOf(await get("/ui"));
    expect(main).toContain(`<a class="line" href="/ui/systems/${SYSTEM}?ricevuta=3#r-3">`);
    expect(main).toContain(`<span class="pill yellow" data-outcome="blocked">${STATE_ICONS.warn}Bloccato</span>`);
    expect(main).not.toContain('data-outcome="ok"');
  });

  it("says when the checkpoint just ran, as a status", async () => {
    expect(mainOf(await get("/ui?checkpoint=1"))).toContain(`<p class="notice ok" role="status">`);
  });
});

describe("the systems page", () => {
  it("offers the active, archived and all systems as links with their counts, and a button to create one", async () => {
    await store.archiveSystem(EMPTY, { actor: "test", ts: NOW });
    const main = mainOf(await get("/ui/sistemi?vista=tutti"));
    expect(main).toContain('<a href="/ui/sistemi?vista=attivi">Attivi<span class="count">1</span></a>');
    expect(main).toContain('<a href="/ui/sistemi?vista=archiviati">Archiviati<span class="count">1</span></a>');
    expect(main).toContain('<a href="/ui/sistemi?vista=tutti" aria-current="page">Tutti<span class="count">2</span></a>');
    expect(main).toContain(`<a class="button primary" href="/ui/sistemi/nuovo">`);
    expect(main).toContain(`<a class="line" href="/ui/systems/${SYSTEM}"><span class="cell-main"><strong>Assistente clienti</strong><span>${UI.systemsPage.connection.sdk}</span></span>`);
    expect(main).toContain(UI.systemsPage.connection.none);
    expect(main).toContain(`data-chain="archived"`);
  });

  it("shows a new system's key once, inside the shell, with the Python way to use it and no other", async () => {
    const created = await post("/ui/sistemi", "system_id=nuovo&display_name=Il%20nuovo");
    expect(created.status).toBe(200);
    const main = mainOf(created.body);
    const token = /<code class="keybox">(sigillo_[0-9a-f]{16}_[0-9a-f]{64})<\/code>/.exec(main)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(main).toContain(`<h1>${UI.connect.ready("Il nuovo")}</h1>`);
    // Python only: its heartbeat is what tells when an agent was disconnected.
    const snippet = /<pre class="code python">([^]*?)<\/pre>/.exec(main)?.[1] ?? "";
    expect(snippet).toContain(token);
    expect(main).not.toContain('<pre class="code otel">');
    expect(main).not.toContain('<pre class="code api">');
    expect(main).toContain('<input type="radio" name="way" id="way-python" class="sr" checked>');
    expect(main).toContain('system_id=&quot;nuovo&quot;');
    expect(main).toContain(`href="/ui/systems/nuovo/collega"`);
    expect(created.body).toContain('<div class="sidebar" id="menu">');
    // Only the name is needed: the identifier is made from it.
    const named = mainOf((await post("/ui/sistemi", "display_name=Assistente%20vendite")).body);
    expect(named).toContain('system_id=&quot;assistente-vendite&quot;');
  });

  it("says why a system could not be created, as an alert, in the same page", async () => {
    const refused = await post("/ui/sistemi", `system_id=${SYSTEM}`);
    expect(refused.status).toBe(400);
    expect(mainOf(refused.body)).toContain('<p class="notice bad" role="alert">');
    expect(mainOf(refused.body)).toContain('<form method="post" action="/ui/sistemi"');
  });
});

describe("a system's checkpoints and management", () => {
  it("lists checkpoints newest first, each with the receipts it covers and its timestamp's attested time", async () => {
    await store.append(event("45", { action: { kind: "decision", name: "fine" } }));
    await store.createCheckpoint(SYSTEM);
    const main = mainOf(await get(`/ui/systems/${SYSTEM}/checkpoints`));
    const sizes = [...main.matchAll(/<span class="line-text">(\d+) ricevute sigillate/g)].map((match) => Number(match[1]));
    expect(sizes).toEqual([5, 4]);
    expect(main).toContain(`<span class="pill yellow">${STATE_ICONS.warn}${UI.checkpoints.waiting}</span>`);
    expect(main).toContain(`<span class="pill green">${STATE_ICONS.ok}${UI.checkpoints.stamped}</span>`);
    expect(main).toContain(UI.checkpoints.attested.replace("'", "&#39;"));
    expect(main).toContain("<code>https://freetsa.org/tsr</code>");
    expect(main).toContain('<form method="post" action="/ui/checkpoint" class="section">');
  });

  it("refuses deletion with recorded actions in a note, and offers it for an empty chain", async () => {
    const full = mainOf(await get(`/ui/systems/${SYSTEM}/manage`));
    expect(full).toContain('<p class="lockline"><svg');
    expect(full).toContain("Contiene 3 azioni registrate");
    expect(full).not.toContain("/delete");
    const empty = mainOf(await get(`/ui/systems/${EMPTY}/manage`));
    expect(empty).toContain(`<form method="post" action="/ui/systems/${EMPTY}/delete"`);
  });

  it("confirms a rename as a status and shows a refusal as an alert", async () => {
    expect(mainOf(await get(`/ui/systems/${SYSTEM}/manage?fatto=nome`))).toContain(`role="status">${STATE_ICONS.ok}<span>${UI.manage.renamed}</span>`);
    const refused = await post(`/ui/systems/${EMPTY}/delete`, "confirm=no");
    expect(refused.status).toBe(400);
    expect(mainOf(refused.body)).toContain('<p class="notice bad" role="alert">');
  });
});

describe("verifying a document", () => {
  it("keeps the ids the script needs, the inactive warning, and the disabled button", async () => {
    const main = mainOf(await get("/ui/verify-document"));
    for (const id of ["sigillo-doc-file", "sigillo-doc-text", "sigillo-doc-button", "sigillo-doc-failed", "sigillo-doc-error", "sigillo-doc-inactive"]) {
      expect(main.match(new RegExp(`id="${id}"`, "g")), id).toHaveLength(1);
    }
    expect(main).toContain(`<label class="drop">`);
    expect(main).not.toContain('id="sigillo-doc-result"');
  });

  it("opens the receipt a match comes from, and says it was found", async () => {
    const main = mainOf(await get(`/ui/verify-document?sha256=${"c".repeat(64)}`));
    expect(main).toContain(`<h3>${UI.verifyDocument.found}</h3>`);
    expect(main).toContain(`<a href="/ui/systems/${SYSTEM}?ricevuta=2#r-2">${UI.verifyDocument.seeReceipt} ›</a>`);
    expect(main).toContain(`<span class="pill green">${UI.verifyDocument.match.bytes}</span>`);
    const missed = mainOf(await get(`/ui/verify-document?sha256=${"d".repeat(64)}`));
    expect(missed).toContain(`<h3>${UI.verifyDocument.notFound}</h3>`);
    expect(missed).toContain(`<span class="tile-icon red" aria-hidden="true">${STATE_ICONS.bad}</span>`);
  });
});

describe("the people page", () => {
  it("is gone: no page, no sidebar entry (erasing a person is the operator's command, on the server)", async () => {
    expect((await app.inject({ method: "GET", url: "/ui/persone", headers: { cookie } })).statusCode).toBe(404);
    expect(await get("/ui")).not.toContain("/ui/persone");
  });
});

describe("not found", () => {
  it("is a page of the view, with its sidebar, its words, and a 404", async () => {
    for (const url of ["/ui/systems/mai-creato", "/ui/systems/mai-creato/checkpoints", "/ui/systems/mai-creato/manage"]) {
      const body = await get(url, 404);
      expect(body, url).toContain('<div class="sidebar" id="menu">');
      expect(body, url).toContain(`<h1>${UI.notFound.heading}</h1>`);
      expect(body, url).toContain(`<title>${UI.notFound.title} — sigillo</title>`);
    }
  });
});
