import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Receipt } from "@sigillo/core";
import { buildArchive } from "../export/archive.js";
import type { ArtifactMatch, ReceiptStore } from "../storage/store.js";

/**
 * A small operator's view: four pages of server-rendered HTML, no framework and
 * no build step.
 *
 * It is a window onto the log, never a way into it. Nothing here writes a
 * receipt: the only thing it can produce is an export, which is a read.
 */

const COOKIE = "sigillo_session";
const SESSION_HOURS = 12;

export interface UiOptions {
  store: ReceiptStore;
  /** The one password that opens this view. Without it the UI is not mounted. */
  password: string;
  signerKey: { key_id: string; public_key_base64: string };
  now: () => Date;
}

/** Everything that reaches HTML goes through here. */
function escape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root { color-scheme: light dark; --line: #d0d0d0; --muted: #666; }
* { box-sizing: border-box; }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
       margin: 0; padding: 2rem; max-width: 70rem; }
header { display: flex; align-items: baseline; gap: 1rem; border-bottom: 1px solid var(--line);
         padding-bottom: .75rem; margin-bottom: 1.5rem; }
header h1 { font-size: 1.1rem; margin: 0; letter-spacing: .02em; }
header nav { margin-left: auto; display: flex; gap: 1rem; font-size: .9rem; }
h2 { font-size: 1rem; margin: 2rem 0 .75rem; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--line);
         vertical-align: top; }
th { font-weight: 600; white-space: nowrap; }
code, .hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
.hash { color: var(--muted); word-break: break-all; }
.muted { color: var(--muted); }
.warn { color: #a11; }
form.filters { display: flex; flex-wrap: wrap; gap: .6rem; align-items: end; margin-bottom: 1rem; }
label { display: flex; flex-direction: column; font-size: .8rem; gap: .2rem; }
input, select, button { font: inherit; padding: .35rem .5rem; }
button { cursor: pointer; }
.empty { color: var(--muted); padding: 1rem 0; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — sigillo</title>
<style>${STYLE}</style>
</head><body>
<header>
  <h1>sigillo</h1>
  <span class="muted">${escape(title)}</span>
  <nav><a href="/ui">systems</a><a href="/ui/verify-document">verifica documento</a><a href="/ui/logout">sign out</a></nav>
</header>
${body}
</body></html>`;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The one script this UI carries. Hashing happens in the browser, with Web
 * Crypto: the document is never sent anywhere, only its fingerprint, as a
 * query parameter of an ordinary navigation. No library, no build step.
 *
 * Its exact bytes are what deploy/Caddyfile's CSP allows by `script-src
 * 'sha256-...'`: changing so much as a character here means recomputing that
 * hash (packages/verifier, sorry — apps/server/test/ui.test.ts checks the two
 * stay in step, so a mismatch fails in CI rather than in production).
 */
export const VERIFY_DOCUMENT_SCRIPT = `(function () {
  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(function (byte) { return byte.toString(16).padStart(2, "0"); })
      .join("");
  }
  document.getElementById("sigillo-doc-button").addEventListener("click", async function () {
    var fileInput = document.getElementById("sigillo-doc-file");
    var textInput = document.getElementById("sigillo-doc-text");
    var bytes;
    if (fileInput.files.length > 0) {
      bytes = await fileInput.files[0].arrayBuffer();
    } else if (textInput.value.length > 0) {
      bytes = new TextEncoder().encode(textInput.value);
    } else {
      return;
    }
    var digest = await crypto.subtle.digest("SHA-256", bytes);
    window.location.href = "/ui/verify-document?sha256=" + toHex(digest);
  });
})();`;

function verifyDocumentForm(): string {
  return `<p>${escape("Il documento non lascia il tuo computer: calcoliamo solo la sua impronta.")}</p>
<p><label>File<br><input type="file" id="sigillo-doc-file"></label></p>
<p><label>oppure incolla il testo<br><textarea id="sigillo-doc-text" rows="6" cols="60"></textarea></label></p>
<p><button type="button" id="sigillo-doc-button">Verifica</button></p>
<script>${VERIFY_DOCUMENT_SCRIPT}</script>`;
}

/** Italian, deliberately: this is the one page the fase 2 prompt gives exact user-facing text for. */
function timestampStatus(store: ReceiptStore, systemId: string, seq: number): string {
  const covering = store.readCheckpoints(systemId).find((entry) => entry.checkpoint.tree_size > seq);
  if (covering === undefined) return "non ancora coperto da un checkpoint";
  const tokens = store.readTimestamps(covering.id);
  return tokens.length > 0
    ? `con marca temporale del ${tokens[0]?.obtainedAt ?? ""}`
    : "checkpoint scritto, marca temporale in attesa";
}

function verifyDocumentResult(store: ReceiptStore, matches: ArtifactMatch[]): string {
  if (matches.length === 0) {
    return `<h2>Risultato</h2><p>${escape(
      "Nessuna azione registrata ha usato questo documento. Se ne hai una versione diversa, anche un solo carattere cambia il risultato.",
    )}</p>`;
  }
  const items = matches
    .map((match) => {
      const sentence =
        `✓ Questo documento è esattamente quello usato da ${match.system_id} il ${match.ts_received}, ` +
        `come «${match.label}», nell'azione ${match.action_name} (${match.role}). Non è stato modificato.`;
      const link = escape(encodeURIComponent(match.system_id));
      return `<li>${escape(sentence)} <a href="/ui/systems/${link}">vedi la ricevuta</a> — ` +
        `<span class="muted">${escape(timestampStatus(store, match.system_id, match.seq))}</span></li>`;
    })
    .join("\n");
  return `<h2>Risultato</h2><ul>${items}</ul>`;
}

function loginPage(message?: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>sigillo</title><style>${STYLE}</style></head><body>
<header><h1>sigillo</h1></header>
${message === undefined ? "" : `<p class="warn">${escape(message)}</p>`}
<form method="post" action="/ui/login">
  <label>Administrator password
    <input type="password" name="password" autofocus required>
  </label>
  <p><button type="submit">Sign in</button></p>
</form>
</body></html>`;
}

export function registerUi(app: FastifyInstance, options: UiOptions): void {
  // A fresh secret per process: a restart signs everyone out, which for an
  // operator's view is the right trade against storing anything.
  const sessionSecret = randomBytes(32);
  const { store } = options;

  const sign = (expiry: number): string =>
    `${expiry}.${createHmac("sha256", sessionSecret).update(String(expiry)).digest("hex")}`;

  const sessionValid = (cookie: string | undefined): boolean => {
    if (cookie === undefined) return false;
    const [expiry, mac] = cookie.split(".");
    if (expiry === undefined || mac === undefined) return false;
    const deadline = Number(expiry);
    if (!Number.isFinite(deadline) || deadline < options.now().getTime()) return false;
    const expected = createHmac("sha256", sessionSecret).update(expiry).digest("hex");
    return (
      mac.length === expected.length &&
      timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"))
    );
  };

  const cookieFrom = (request: FastifyRequest): string | undefined => {
    const header = request.headers.cookie;
    if (typeof header !== "string") return undefined;
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === COOKIE) return rest.join("=");
    }
    return undefined;
  };

  const requireSession = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (sessionValid(cookieFrom(request))) return true;
    void reply.redirect("/ui/login", 302);
    return false;
  };

  // The status is a parameter: setting it on the reply and then calling a
  // helper that sets 200 is exactly how a failed login comes to look like a
  // successful one.
  const html = (reply: FastifyReply, body: string, status = 200): FastifyReply =>
    reply.code(status).type("text/html; charset=utf-8").send(body);

  app.get("/", async (_request, reply) => reply.redirect("/ui", 302));

  app.get("/ui/login", async (request, reply) =>
    sessionValid(cookieFrom(request))
      ? reply.redirect("/ui", 302)
      : html(reply, loginPage()),
  );

  app.post("/ui/login", async (request, reply) => {
    const body = request.body as { password?: unknown } | undefined;
    const given = typeof body?.password === "string" ? body.password : "";
    const expected = options.password;

    const givenBytes = Buffer.from(given);
    const expectedBytes = Buffer.from(expected);
    const correct =
      givenBytes.length === expectedBytes.length && timingSafeEqual(givenBytes, expectedBytes);

    if (!correct) {
      return html(reply, loginPage("That password is not the one."), 401);
    }

    const expiry = options.now().getTime() + SESSION_HOURS * 3600 * 1000;
    return reply
      .header(
        "set-cookie",
        `${COOKIE}=${sign(expiry)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
      )
      .redirect("/ui", 302);
  });

  app.get("/ui/logout", async (_request, reply) =>
    reply.header("set-cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`).redirect(
      "/ui/login",
      302,
    ),
  );

  app.get("/ui", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const systems = store.listSystems();
    const rows = systems
      .map((systemId) => {
        const tip = store.tip(systemId);
        const checkpoint = store.latestCheckpoint(systemId);
        const anchored =
          checkpoint === null ? 0 : store.readTimestamps(checkpoint.id).length;
        const covered = checkpoint?.checkpoint.tree_size ?? 0;
        const total = tip === null ? 0 : tip.seq + 1;
        return `<tr>
  <td><a href="/ui/systems/${encodeURIComponent(systemId)}">${escape(systemId)}</a></td>
  <td>${total}</td>
  <td>${covered === 0 ? '<span class="warn">none</span>' : `${covered} of ${total}`}</td>
  <td>${
    checkpoint === null
      ? '<span class="warn">no checkpoint</span>'
      : anchored > 0
        ? escape(checkpoint.checkpoint.ts)
        : `<span class="warn">not anchored</span>`
  }</td>
</tr>`;
      })
      .join("\n");

    return html(
      reply,
      page(
        "systems",
        systems.length === 0
          ? '<p class="empty">No system yet. Create one with <code>sigillo-server system create</code>.</p>'
          : `<table>
<tr><th>system</th><th>receipts</th><th>covered by a checkpoint</th><th>last anchored</th></tr>
${rows}
</table>
<p class="muted">Signing key <span class="hash">${escape(options.signerKey.key_id)}</span></p>`,
      ),
    );
  });

  app.get("/ui/verify-document", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const query = request.query as { sha256?: string };
    const sha256 = query.sha256;
    const searched = typeof sha256 === "string" && SHA256_HEX.test(sha256);

    const body = `${verifyDocumentForm()}${
      searched ? verifyDocumentResult(store, store.findArtifactsBySha256(sha256)) : ""
    }`;
    return html(reply, page("verifica un documento", body));
  });

  app.get("/ui/systems/:systemId", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) {
      return html(reply, page("not found", `<p>No system called ${escape(systemId)}.</p>`), 404);
    }

    const query = request.query as Record<string, string | undefined>;
    const receipts = store.searchReceipts({
      systemId,
      ...(query["from"] === undefined ? {} : { from: query["from"] }),
      ...(query["to"] === undefined ? {} : { to: query["to"] }),
      ...(query["kind"] === undefined ? {} : { kind: query["kind"] }),
      ...(query["name"] === undefined ? {} : { name: query["name"] }),
      limit: 200,
    });

    const kinds = ["", "tool_call", "llm_call", "agent_step", "decision", "genesis"];
    const selected = query["kind"] ?? "";
    const link = escape(encodeURIComponent(systemId));

    return html(
      reply,
      page(
        systemId,
        `<form class="filters" method="get">
  <label>from (ts_received)<input type="text" name="from" placeholder="2026-03-29T00:00:00.000Z" value="${escape(query["from"] ?? "")}"></label>
  <label>to<input type="text" name="to" placeholder="2026-03-30T00:00:00.000Z" value="${escape(query["to"] ?? "")}"></label>
  <label>kind<select name="kind">${kinds
    .map(
      (kind) =>
        `<option value="${escape(kind)}"${kind === selected ? " selected" : ""}>${escape(kind === "" ? "any" : kind)}</option>`,
    )
    .join("")}</select></label>
  <label>action name<input type="text" name="name" value="${escape(query["name"] ?? "")}"></label>
  <button type="submit">Search</button>
</form>

<p><a href="/ui/systems/${link}/checkpoints">checkpoints</a></p>

<form method="post" action="/ui/systems/${link}/export">
  <button type="submit">Generate the evidence file</button>
  <span class="muted">downloads a .zip with the receipts, the checkpoints, the tokens and the report</span>
</form>

<h2>${receipts.length} receipt${receipts.length === 1 ? "" : "s"}${receipts.length === 200 ? " (newest 200)" : ""}</h2>
${
  receipts.length === 0
    ? '<p class="empty">Nothing matches.</p>'
    : `<table>
<tr><th>seq</th><th>received</th><th>agent</th><th>kind</th><th>action</th><th>outcome</th><th>hash</th></tr>
${receipts.map(receiptRow).join("\n")}
</table>`
}`,
      ),
    );
  });

  app.get("/ui/systems/:systemId/checkpoints", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const { systemId } = request.params as { systemId: string };
    const checkpoints = store.readCheckpoints(systemId);

    const rows = checkpoints
      .map((stored) => {
        const tokens = store.readTimestamps(stored.id);
        return `<tr>
  <td>${stored.checkpoint.tree_size}</td>
  <td>${escape(stored.checkpoint.ts)}</td>
  <td class="hash">${escape(stored.checkpoint.root_hash)}</td>
  <td>${
    tokens.length === 0
      ? '<span class="warn">waiting for a timestamp</span>'
      : tokens
          .map((token) => `${escape(token.obtainedAt)}<br><span class="muted">${escape(token.tsaUrl)}</span>`)
          .join("<br>")
  }</td>
</tr>`;
      })
      .join("\n");

    return html(
      reply,
      page(
        `${systemId} — checkpoints`,
        checkpoints.length === 0
          ? '<p class="empty">No checkpoint yet. One is written on the server\'s schedule, or now with <code>sigillo-server checkpoint</code>.</p>'
          : `<table>
<tr><th>receipts covered</th><th>written</th><th>Merkle root</th><th>anchored</th></tr>
${rows}
</table>`,
      ),
    );
  });

  app.post("/ui/systems/:systemId/export", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) {
      return reply.code(404).send({ error: `no system called ${systemId}` });
    }

    const archive = await buildArchive({
      systemId,
      receipts: store.readChain(systemId),
      checkpoints: store.readCheckpoints(systemId).map((stored) => ({
        stored,
        timestamps: store.readTimestamps(stored.id),
      })),
      keys: [options.signerKey],
      exportedAt: options.now().toISOString(),
    });

    const stamp = options.now().toISOString().slice(0, 10);
    // The system id reaches a header here, so it is restricted to a safe shape.
    const safeName = systemId.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    return reply
      .code(200)
      .type("application/zip")
      .header("content-disposition", `attachment; filename="sigillo-${safeName}-${stamp}.zip"`)
      .send(Buffer.from(archive.zip));
  });
}

function receiptRow(receipt: Receipt): string {
  return `<tr>
  <td>${receipt.seq}</td>
  <td>${escape(receipt.ts_received)}</td>
  <td>${escape(receipt.actor.agent)}${
    receipt.actor.on_behalf_of === undefined
      ? ""
      : `<br><span class="muted">for ${escape(receipt.actor.on_behalf_of)}</span>`
  }</td>
  <td>${escape(receipt.action.kind)}</td>
  <td>${escape(receipt.action.name)}</td>
  <td${receipt.outcome === "ok" ? "" : ' class="warn"'}>${escape(receipt.outcome)}</td>
  <td class="hash">${escape(receipt.prev_hash.slice(0, 12))}…</td>
</tr>`;
}

export { escape };
