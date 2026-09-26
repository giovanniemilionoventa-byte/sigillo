import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Receipt } from "@sigillo/core";
import type { ApiKeyStore } from "../auth/api-keys.js";
import { AttemptThrottle, type ThrottleSettings } from "../auth/throttle.js";
import type { Checkpointer } from "../checkpoint/checkpointer.js";
import { buildArchive } from "../export/archive.js";
import type { ChainHealthMonitor, ChainStatus } from "../health/chain-health.js";
import type { ArtifactMatch, ReceiptStore } from "../storage/store.js";
import { actionKindLabel, describeArtifact, describeDocumentMatch, describeReceipt, UI } from "./strings.js";

/**
 * The operator's view: server-rendered HTML, no framework and no build step,
 * except the one inline script on the "verifica un documento" page.
 *
 * It answers three questions, in order — è tutto a posto? cosa ha fatto
 * l'AI? mi prepari le prove? — plus two secondary pages: creating a system
 * (and its first key) and checking a document by fingerprint. It never
 * writes a receipt; its only writes are creating a system and, on request,
 * running the same checkpoint the server already does on a timer — sooner,
 * not instead.
 */

const COOKIE = "sigillo_session";
const SESSION_HOURS = 12;

export interface UiOptions {
  store: ReceiptStore;
  keys: ApiKeyStore;
  /** The one password that opens this view. Without it the UI is not mounted. */
  password: string;
  signerKey: { key_id: string; public_key_base64: string };
  healthMonitor: ChainHealthMonitor;
  checkpointer: Checkpointer;
  now: () => Date;
  /** Limits on wrong passwords, per client address. Defaults: see parseThrottleSettings. */
  loginLimits?: ThrottleSettings;
  /**
   * Whether the session cookie carries `Secure`. "auto", the default, sets it
   * whenever the browser reached the server over HTTPS, as the request (and a
   * trusted proxy's X-Forwarded-Proto) shows it.
   */
  cookieSecure?: boolean | "auto";
}

export const DEFAULT_LOGIN_LIMITS: ThrottleSettings = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockoutMs: 5 * 60_000,
  maxLockoutMs: 60 * 60_000,
};

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
:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1a1a1a; --line: #d7d7d7; --muted: #5a5a5a; --tag-bg: #eef0f2;
  --green: #1a7a3c; --yellow: #8a6d00; --red: #a3122e; --focus: #2563eb;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #15171a; --fg: #eaeaea; --line: #3a3d42; --muted: #a6a6a6; --tag-bg: #262a30;
          --green: #5fd48a; --yellow: #e2c14c; --red: #ff8a8a; --focus: #7aa2ff; }
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
       margin: 0; padding: 1.5rem; max-width: 62rem; background: var(--bg); color: var(--fg); }
a { color: var(--focus); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: .75rem 1rem; border-bottom: 1px solid var(--line);
         padding-bottom: .75rem; margin-bottom: 1.5rem; }
header h1 { font-size: 1.1rem; margin: 0; letter-spacing: .02em; }
header nav { margin-left: auto; display: flex; gap: 1rem; font-size: .95rem; flex-wrap: wrap; }
h2 { font-size: 1.15rem; margin: 2rem 0 .75rem; }
h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
.table-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; min-width: 30rem; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line);
         vertical-align: top; }
th { font-weight: 600; white-space: nowrap; }
code, .hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
.hash { color: var(--muted); word-break: break-all; }
.muted { color: var(--muted); }
.warn { color: var(--red); }
form.filters { display: flex; flex-wrap: wrap; gap: .6rem; align-items: end; margin-bottom: 1rem; }
label { display: flex; flex-direction: column; font-size: .85rem; gap: .25rem; }
input, select, textarea, button { font: inherit; padding: .45rem .55rem; color: inherit;
  background: var(--bg); border: 1px solid var(--line); border-radius: .3rem; }
button { cursor: pointer; background: var(--tag-bg); }
button:hover { filter: brightness(0.95); }
button:disabled { cursor: not-allowed; opacity: .5; }
.empty { color: var(--muted); padding: 1rem 0; }
.dot { display: inline-block; width: .8em; height: .8em; border-radius: 50%; margin-right: .5em;
       vertical-align: middle; }
.dot.green { background: var(--green); }
.dot.yellow { background: var(--yellow); }
.dot.red { background: var(--red); }
.status-word { font-weight: 600; }
form.inline { display: inline; margin: 0; }
button.link { background: none; border: none; padding: 0; color: var(--focus); text-decoration: underline; font-size: inherit; }
.status-word.green { color: var(--green); }
.status-word.yellow { color: var(--yellow); }
.status-word.red { color: var(--red); }
.tag { display: inline-block; background: var(--tag-bg); border-radius: .3rem; padding: .1rem .5rem;
       font-size: .85em; margin: .1rem .3rem .1rem 0; }
ul.actions { list-style: none; padding: 0; margin: 0; }
ul.actions > li { padding: .6rem 0; border-bottom: 1px solid var(--line); }
details { margin: .4rem 0 0; }
summary { cursor: pointer; color: var(--muted); font-size: .85em; }
details table { margin-top: .5rem; }
.card { border: 1px solid var(--line); border-radius: .5rem; padding: 1rem 1.2rem; margin-bottom: 1rem; }
.token-box { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--tag-bg);
  padding: .75rem; border-radius: .4rem; word-break: break-all; margin: .5rem 0; }
pre.code { background: var(--tag-bg); padding: 1rem; border-radius: .4rem; overflow-x: auto; font-size: .85em; }
@media (max-width: 640px) {
  body { padding: 1rem; }
  header nav { gap: .6rem 1rem; }
  .card { padding: .8rem; }
}
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — sigillo</title>
<style>${STYLE}</style>
</head><body>
<header>
  <h1>sigillo</h1>
  <span class="muted">${escape(title)}</span>
  <nav>
    <a href="/ui">${escape(UI.home.title)}</a>
    <a href="/ui/sistemi">${escape(UI.nav.sistemi)}</a>
    <a href="/ui/verify-document">${escape(UI.nav.verificaDocumento)}</a>
    <form class="inline" method="post" action="/ui/logout"><button type="submit" class="link">${escape(UI.nav.esci)}</button></form>
  </nav>
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
 * stay in step, so a mismatch fails in CI rather than in production). A
 * running Caddy keeps the policy it started with: after an update that
 * changes this script, Caddy has to be restarted too.
 *
 * It never fails in silence (session 6). Whatever is on the page when
 * Verifica is pressed is the result of an earlier attempt, for other bytes,
 * so a press that ends in anything but a navigation removes it and says why.
 * And the button is served disabled, under a warning, for the script to
 * enable: a browser that does not run it shows both.
 */
export const VERIFY_DOCUMENT_SCRIPT = `(function () {
  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer))
      .map(function (byte) { return byte.toString(16).padStart(2, "0"); })
      .join("");
  }
  var button = document.getElementById("sigillo-doc-button");
  var failed = document.getElementById("sigillo-doc-failed");
  document.getElementById("sigillo-doc-inactive").hidden = true;
  button.disabled = false;
  button.addEventListener("click", async function () {
    var fileInput = document.getElementById("sigillo-doc-file");
    var textInput = document.getElementById("sigillo-doc-text");
    failed.hidden = true;
    try {
      var bytes;
      var from;
      if (fileInput.files.length > 0) {
        bytes = await fileInput.files[0].arrayBuffer();
        from = "file";
      } else if (textInput.value.length > 0) {
        bytes = new TextEncoder().encode(textInput.value);
        from = "text";
      } else {
        return;
      }
      var digest = await crypto.subtle.digest("SHA-256", bytes);
      window.location.href = "/ui/verify-document?sha256=" + toHex(digest) + "&from=" + from;
    } catch (error) {
      var previous = document.getElementById("sigillo-doc-result");
      if (previous !== null) previous.remove();
      history.replaceState(null, "", "/ui/verify-document");
      document.getElementById("sigillo-doc-error").textContent = String(error && error.name);
      failed.hidden = false;
    }
  });
})();`;

function verifyDocumentForm(): string {
  const t = UI.verifyDocument;
  return `<p>${escape(t.privacyNote)}</p>
<p class="warn" id="sigillo-doc-inactive">${escape(t.scriptInactive)}</p>
<p><label>${escape(t.fileLabel)}<br><input type="file" id="sigillo-doc-file"></label></p>
<p><label>${escape(t.textLabel)}<br><textarea id="sigillo-doc-text" rows="6" cols="60"></textarea></label><br>
<span class="muted">${escape(t.textNote)}</span></p>
<p><button type="button" id="sigillo-doc-button" disabled>${escape(t.submit)}</button></p>
<p class="warn" id="sigillo-doc-failed" role="alert" hidden>${escape(t.computeFailed)} ${escape(t.browserError)}: <span id="sigillo-doc-error"></span>.</p>
<script>${VERIFY_DOCUMENT_SCRIPT}</script>`;
}

function timestampStatus(store: ReceiptStore, systemId: string, seq: number): string {
  const covering = store.readCheckpoints(systemId).find((entry) => entry.checkpoint.tree_size > seq);
  if (covering === undefined) return "non ancora coperto da un checkpoint";
  const tokens = store.readTimestamps(covering.id);
  const token = tokens[0];
  if (token === undefined) return "checkpoint scritto, marca temporale in attesa";
  return token.genTime === undefined
    ? "con marca temporale (ora attestata non leggibile dal token)"
    : `con marca temporale del ${token.genTime}`;
}

function verifyDocumentResult(
  store: ReceiptStore,
  sha256: string,
  from: "file" | "text" | undefined,
  matches: ArtifactMatch[],
): string {
  const t = UI.verifyDocument;
  // The fingerprint the browser computed, shown either way: set beside
  // Get-FileHash or sha256sum, it tells at once whether the page was given
  // the same bytes the agent read. Which input it was computed on, file or
  // text, the page's script says in `from`: when the two could disagree,
  // that is the next question.
  const source = from === undefined ? "" : `<p class="muted">${escape(from === "file" ? t.fromFile : t.fromText)}</p>`;
  const searched = `<p>${escape(t.searchedFingerprint)}: <span class="hash">${escape(sha256)}</span></p>${source}`;
  if (matches.length === 0) {
    return `<section id="sigillo-doc-result"><h2>${escape(t.resultTitle)}</h2>${searched}<p>${escape(t.noMatch)}</p>` +
      `<p class="muted">${escape(t.lineEndingsHint)}</p></section>`;
  }
  const items = matches
    .map((match) => {
      const sentence = describeDocumentMatch(match);
      const link = escape(encodeURIComponent(match.system_id));
      return `<li>${escape(sentence)} <a href="/ui/systems/${link}">${escape(t.seeReceipt)}</a> — ` +
        `<span class="muted">${escape(timestampStatus(store, match.system_id, match.seq))}</span></li>`;
    })
    .join("\n");
  return `<section id="sigillo-doc-result"><h2>${escape(t.resultTitle)}</h2>${searched}<ul>${items}</ul></section>`;
}

function loginPage(message?: string): string {
  return `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>sigillo</title><style>${STYLE}</style></head><body>
<header><h1>sigillo</h1></header>
${message === undefined ? "" : `<p class="warn">${escape(message)}</p>`}
<form method="post" action="/ui/login">
  <label>${escape(UI.login.label)}
    <input type="password" name="password" autofocus required>
  </label>
  <p><button type="submit">${escape(UI.login.submit)}</button></p>
</form>
</body></html>`;
}

export function registerUi(app: FastifyInstance, options: UiOptions): void {
  // A fresh secret per process: a restart signs everyone out, which for an
  // operator's view is the right trade against storing anything.
  const sessionSecret = randomBytes(32);
  // Part of what every session cookie signs. Signing out moves it on, and with
  // it every cookie issued before, copies included, stops working: there is
  // one password, so every session is the same person's (review point 12).
  let epoch = 0;
  const { store, keys } = options;
  const loginThrottle = new AttemptThrottle(options.loginLimits ?? DEFAULT_LOGIN_LIMITS);
  const cookieSecure = options.cookieSecure ?? "auto";

  const mac = (expiry: string, sessionEpoch: number): string =>
    createHmac("sha256", sessionSecret).update(`${expiry}.${sessionEpoch}`).digest("hex");

  const sign = (expiry: number): string => `${expiry}.${mac(String(expiry), epoch)}`;

  const sessionValid = (cookie: string | undefined): boolean => {
    if (cookie === undefined) return false;
    const [expiry, given] = cookie.split(".");
    if (expiry === undefined || given === undefined) return false;
    const deadline = Number(expiry);
    if (!Number.isFinite(deadline) || deadline < options.now().getTime()) return false;
    const expected = mac(expiry, epoch);
    return (
      given.length === expected.length &&
      timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"))
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

  const cookieAttributes = (request: FastifyRequest): string => {
    const secure = cookieSecure === "auto" ? request.protocol === "https" : cookieSecure;
    return `HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
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

  const isUi = (request: FastifyRequest): boolean =>
    request.url === "/ui" || request.url.startsWith("/ui/") || request.url.startsWith("/ui?");

  // Nothing behind the password is worth keeping in a cache, and one page
  // shows an API key the only time it exists.
  app.addHook("onSend", async (request, reply) => {
    if (isUi(request)) void reply.header("cache-control", "no-store");
  });

  // SameSite=Strict already keeps the cookie off cross-site requests in
  // current browsers. A form posted from another origin is refused as well,
  // without relying on that: when a browser says where a POST comes from and
  // it is not this host, nothing is done.
  //
  // Each of the three signals below can only refuse. Sec-Fetch-Site comes
  // first: a browser always sends it, and no referrer policy blanks it. Origin
  // is checked whenever it names a host. It is "null" on every form post
  // behind Caddy, whose Referrer-Policy: no-referrer makes the Fetch standard
  // send Origin: null and no Referer on a non-CORS POST; then Sec-Fetch-Site
  // decides, and only a browser too old to send that falls back on the
  // Referer. docs/SECURITY.md has the whole story.
  app.addHook("preHandler", async (request, reply) => {
    if (request.method !== "POST" || !isUi(request)) return;
    const origin = request.headers.origin;
    const site = request.headers["sec-fetch-site"];
    if (origin === undefined && site === undefined) return;
    const isThisHost = (url: string | undefined): boolean => {
      if (url === undefined) return false;
      try {
        return new URL(url).host === request.headers.host;
      } catch {
        return false;
      }
    };
    const refused =
      (site !== undefined && site !== "same-origin" && site !== "none") ||
      (origin !== undefined && origin !== "null" && !isThisHost(origin)) ||
      (origin === "null" && site === undefined && !isThisHost(request.headers.referer));
    if (refused) {
      await reply.code(403).type("text/plain; charset=utf-8").send("cross-origin request refused\n");
    }
  });

  app.get("/", async (_request, reply) => reply.redirect("/ui", 302));

  app.get("/ui/login", async (request, reply) =>
    sessionValid(cookieFrom(request))
      ? reply.redirect("/ui", 302)
      : html(reply, loginPage()),
  );

  app.post("/ui/login", async (request, reply) => {
    const client = request.ip;
    const now = options.now().getTime();

    // A locked-out client gets the very answer a wrong password gets, and its
    // password is not even looked at: from outside, a lockout cannot be told
    // apart from a guess that was wrong, and no guess made during one can be
    // learned to be right.
    if (loginThrottle.isLocked(client, now)) {
      return html(reply, loginPage(UI.login.wrong), 401);
    }

    const body = request.body as { password?: unknown } | undefined;
    const given = typeof body?.password === "string" ? body.password : "";
    const expected = options.password;

    const givenBytes = Buffer.from(given);
    const expectedBytes = Buffer.from(expected);
    const correct =
      givenBytes.length === expectedBytes.length && timingSafeEqual(givenBytes, expectedBytes);

    if (!correct) {
      loginThrottle.recordFailure(client, now);
      return html(reply, loginPage(UI.login.wrong), 401);
    }

    loginThrottle.recordSuccess(client);
    const expiry = now + SESSION_HOURS * 3600 * 1000;
    return reply
      .header(
        "set-cookie",
        `${COOKIE}=${sign(expiry)}; ${cookieAttributes(request)}; Max-Age=${SESSION_HOURS * 3600}`,
      )
      .redirect("/ui", 302);
  });

  app.post("/ui/logout", async (request, reply) => {
    if (sessionValid(cookieFrom(request))) epoch += 1;
    return reply
      .header("set-cookie", `${COOKIE}=; ${cookieAttributes(request)}; Max-Age=0`)
      .redirect("/ui/login", 303);
  });

  app.get("/ui", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const query = request.query as { checkpoint?: string };
    const justCheckpointed = query.checkpoint === "1";
    return html(
      reply,
      page(UI.home.title, homePage(store, options.healthMonitor, options.now(), justCheckpointed)),
    );
  });

  app.post("/ui/checkpoint", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    await options.checkpointer.runOnce();
    return reply.redirect("/ui?checkpoint=1", 303);
  });

  app.post("/ui/export", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const body = request.body as { system_id?: unknown; from?: unknown; to?: unknown } | undefined;
    const systemId = typeof body?.system_id === "string" ? body.system_id : "";
    if (!store.hasSystem(systemId)) {
      return reply.code(404).send({ error: `no system called ${systemId}` });
    }
    return sendArchive(reply, systemId, dayBounds(body?.from, body?.to));
  });

  app.get("/ui/sistemi", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    return html(reply, page(UI.systemsPage.title, sistemiPage(store, options.signerKey.key_id)));
  });

  app.post("/ui/sistemi", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const body = request.body as { system_id?: unknown } | undefined;
    const systemId = typeof body?.system_id === "string" ? body.system_id.trim() : "";

    try {
      await store.createSystem(systemId, options.now().toISOString());
      // On the write queue: see ReceiptStore.exclusive.
      const issued = await store.exclusive(() => keys.issue(systemId, options.now().toISOString()));
      return html(reply, page(UI.systemsPage.title, systemCreatedPage(systemId, issued.token)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return html(
        reply,
        page(
          UI.systemsPage.title,
          `${sistemiPage(store, options.signerKey.key_id)}<p class="warn">${escape(message)}</p>`,
        ),
        400,
      );
    }
  });

  app.get("/ui/verify-document", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const query = request.query as { sha256?: string; from?: string };
    const sha256 = query.sha256;
    const searched = typeof sha256 === "string" && SHA256_HEX.test(sha256);
    const from = query.from === "file" || query.from === "text" ? query.from : undefined;

    const body = `${verifyDocumentForm()}${
      searched ? verifyDocumentResult(store, sha256, from, store.findArtifactsBySha256(sha256)) : ""
    }`;
    return html(reply, page(UI.verifyDocument.title, body));
  });

  app.get("/ui/systems/:systemId", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) {
      return html(reply, page("non trovato", `<p>Nessun sistema chiamato ${escape(systemId)}.</p>`), 404);
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

    return html(reply, page(systemId, historyPage(systemId, receipts, query)));
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
      ? `<span class="warn">${escape(UI.checkpoints.waiting)}</span>`
      : tokens
          .map(
            (token) =>
              `${escape(token.genTime ?? UI.checkpoints.genTimeUnreadable)}<br>` +
              `<span class="muted">${escape(token.tsaUrl)} · ${escape(UI.checkpoints.receivedAt)} ${escape(token.obtainedAt)}</span>`,
          )
          .join("<br>")
  }</td>
</tr>`;
      })
      .join("\n");

    return html(
      reply,
      page(
        `${systemId} — ${UI.checkpoints.title}`,
        checkpoints.length === 0
          ? `<p class="empty">${escape(UI.checkpoints.none)}</p>`
          : `<div class="table-scroll"><table>
<tr><th>ricevute coperte</th><th>scritto</th><th>radice Merkle</th><th>marca temporale (ora attestata dall'autorità)</th></tr>
${rows}
</table></div>`,
      ),
    );
  });

  async function sendArchive(
    reply: FastifyReply,
    systemId: string,
    range: { from?: string; to?: string },
  ): Promise<FastifyReply> {
    const receipts =
      range.from === undefined && range.to === undefined
        ? store.readChain(systemId)
        : store.readChainInRange(systemId, range.from, range.to);

    const archive = await buildArchive({
      systemId,
      receipts,
      checkpoints: store.readCheckpoints(systemId).map((stored) => ({
        stored,
        timestamps: store.readTimestamps(stored.id),
      })),
      chainLeaves: store.readReceiptHashes(systemId),
      // Every key the chain has been signed with, not only today's.
      keys: store.signingKeys(),
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
  }

  app.post("/ui/systems/:systemId/export", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) {
      return reply.code(404).send({ error: `no system called ${systemId}` });
    }
    return sendArchive(reply, systemId, {});
  });
}

/** An HTML date input gives YYYY-MM-DD; this makes it an inclusive whole-day bound. */
function dayBounds(from: unknown, to: unknown): { from?: string; to?: string } {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const start = typeof from === "string" && DATE.test(from) ? `${from}T00:00:00.000Z` : undefined;
  const end = typeof to === "string" && DATE.test(to) ? `${to}T23:59:59.999Z` : undefined;
  return { ...(start === undefined ? {} : { from: start }), ...(end === undefined ? {} : { to: end }) };
}

function semaphore(status: ChainStatus): string {
  return `<span class="dot ${status}" aria-hidden="true"></span><span class="status-word ${status}">${escape(UI.status[status])}</span>`;
}

function homePage(
  store: ReceiptStore,
  healthMonitor: ChainHealthMonitor,
  now: Date,
  justCheckpointed: boolean,
): string {
  const t = UI.home;
  const systems = store.listSystems();

  const q1 =
    systems.length === 0
      ? `<p class="empty">${escape(t.noSystems)}</p>`
      : `<div class="table-scroll"><table>
<tr><th>sistema</th><th>stato</th><th></th></tr>
${systems
  .map((systemId) => {
    const health = healthMonitor.statusFor(systemId, now);
    const link = escape(encodeURIComponent(systemId));
    return `<tr>
  <td><a href="/ui/systems/${link}">${escape(systemId)}</a></td>
  <td>${semaphore(health.status)}</td>
  <td class="muted">${escape(health.message)}</td>
</tr>`;
  })
  .join("\n")}
</table></div>
${justCheckpointed ? `<p>${escape(t.checkpointDone)}</p>` : ""}
<form method="post" action="/ui/checkpoint">
  <button type="submit">${escape(t.checkpointNow)}</button>
  <span class="muted">${escape(t.checkpointHint)}</span>
</form>`;

  const recent = systems
    .flatMap((systemId) =>
      store.searchReceipts({ systemId, limit: 5 }).map((receipt) => ({ systemId, receipt })),
    )
    .sort((a, b) => (a.receipt.ts_received < b.receipt.ts_received ? 1 : -1))
    .slice(0, 8);

  const q2 =
    recent.length === 0
      ? `<p class="empty">${escape(t.noSystems)}</p>`
      : `<ul class="actions">
${recent
  .map(
    ({ systemId, receipt }) =>
      `<li>${escape(describeReceipt(receipt))} <a href="/ui/systems/${escape(encodeURIComponent(systemId))}">${escape(t.seeHistory)}</a></li>`,
  )
  .join("\n")}
</ul>`;

  const q3 =
    systems.length === 0
      ? `<p class="empty">${escape(t.noSystems)}</p>`
      : `<form method="post" action="/ui/export">
  <label>${escape(t.chooseSystem)}
    <select name="system_id">${systems.map((s) => `<option value="${escape(s)}">${escape(s)}</option>`).join("")}</select>
  </label>
  <label>${escape(t.fromDate)}<input type="date" name="from"></label>
  <label>${escape(t.toDate)}<input type="date" name="to"></label>
  <button type="submit">${escape(t.generate)}</button>
</form>
<p class="muted">${escape(t.wholeChain)} ${escape(t.generateHint)}</p>`;

  return `<h2>${escape(t.q1)}</h2>${q1}
<h2>${escape(t.q2)}</h2>${q2}
<h2>${escape(t.q3)}</h2>${q3}`;
}

function sistemiPage(store: ReceiptStore, signingKeyId: string): string {
  const t = UI.systemsPage;
  const systems = store.listSystems();
  const list =
    systems.length === 0
      ? `<p class="empty">—</p>`
      : `<ul>${systems
          .map(
            (s) =>
              `<li><a href="/ui/systems/${escape(encodeURIComponent(s))}">${escape(s)}</a></li>`,
          )
          .join("")}</ul>`;

  return `<h2>${escape(t.existing)}</h2>${list}
<p class="muted">Firma con la chiave <span class="hash">${escape(signingKeyId)}</span></p>
<h2>${escape(t.createTitle)}</h2>
<form method="post" action="/ui/sistemi">
  <label>${escape(t.nameLabel)}
    <input type="text" name="system_id" placeholder="${escape(t.namePlaceholder)}" required>
  </label>
  <button type="submit">${escape(t.submit)}</button>
</form>`;
}

function systemCreatedPage(systemId: string, token: string): string {
  const t = UI.systemsPage;
  const code = [
    "pip install -e sdk-python",
    "python3 -c \"",
    "import sigillo",
    "sigillo.init(",
    "    endpoint='https://<il-tuo-dominio>',",
    `    api_key='${token}',`,
    `    system_id='${systemId}',`,
    "    instrument=['langchain'],",
    ")\"",
  ].join("\n");

  return `<h2>${escape(t.createdTitle)}</h2>
<p><strong>${escape(systemId)}</strong></p>
<p class="warn">${escape(t.tokenWarning)}</p>
<div class="token-box">${escape(token)}</div>
<h3>${escape(t.howToConnect)}</h3>
<pre class="code">${escape(code)}</pre>`;
}

function receiptListItem(receipt: Receipt): string {
  const artifacts =
    receipt.v === 2 && receipt.artifacts !== undefined
      ? receipt.artifacts
          .map((a) => `<span class="tag">${escape(describeArtifact(a.role, a.label))}</span>`)
          .join(" ")
      : "";

  const rows: string[] = [
    `<tr><th>seq</th><td>${receipt.seq}</td></tr>`,
    `<tr><th>ricevuto</th><td>${escape(receipt.ts_received)}</td></tr>`,
    `<tr><th>tipo</th><td>${escape(receipt.action.kind)}</td></tr>`,
    `<tr><th>impronta precedente</th><td class="hash">${escape(receipt.prev_hash)}</td></tr>`,
    `<tr><th>firma</th><td class="hash">${escape(receipt.sig)}</td></tr>`,
    `<tr><th>chiave</th><td class="hash">${escape(receipt.key_id)}</td></tr>`,
  ];
  if (receipt.input_hash !== null) {
    rows.push(`<tr><th>impronta input</th><td class="hash">${escape(receipt.input_hash)}</td></tr>`);
  }
  if (receipt.output_hash !== null) {
    rows.push(`<tr><th>impronta output</th><td class="hash">${escape(receipt.output_hash)}</td></tr>`);
  }

  const details = `<details><summary>${escape(UI.history.technicalDetails)}</summary>
<div class="table-scroll"><table>${rows.join("\n")}</table></div>
</details>`;

  return `<li>${escape(describeReceipt(receipt))} ${artifacts}${details}</li>`;
}

function historyPage(
  systemId: string,
  receipts: Receipt[],
  query: Record<string, string | undefined>,
): string {
  const t = UI.history;
  const kinds = ["", "tool_call", "llm_call", "agent_step", "decision", "genesis"];
  const selected = query["kind"] ?? "";
  const link = escape(encodeURIComponent(systemId));

  return `<form class="filters" method="get">
  <label>${escape(t.fromLabel)}<input type="text" name="from" placeholder="2026-03-29T00:00:00.000Z" value="${escape(query["from"] ?? "")}"></label>
  <label>${escape(t.toLabel)}<input type="text" name="to" placeholder="2026-03-30T00:00:00.000Z" value="${escape(query["to"] ?? "")}"></label>
  <label>${escape(t.kindLabel)}<select name="kind">${kinds
    .map(
      (kind) =>
        `<option value="${escape(kind)}"${kind === selected ? " selected" : ""}>${escape(kind === "" ? t.kindAny : actionKindLabel(kind as Receipt["action"]["kind"]))}</option>`,
    )
    .join("")}</select></label>
  <label>${escape(t.nameLabel)}<input type="text" name="name" value="${escape(query["name"] ?? "")}"></label>
  <button type="submit">${escape(t.searchButton)}</button>
</form>

<p><a href="/ui/systems/${link}/checkpoints">${escape(UI.checkpoints.title)}</a></p>

<form method="post" action="/ui/systems/${link}/export">
  <button type="submit">${escape(UI.home.generate)}</button>
  <span class="muted">${escape(UI.home.generateHint)}</span>
</form>

<h2>${receipts.length} ricevut${receipts.length === 1 ? "a" : "e"}${receipts.length === 200 ? " (le 200 più recenti)" : ""}</h2>
${
  receipts.length === 0
    ? `<p class="empty">${escape(t.noMatches)}</p>`
    : `<ul class="actions">${receipts.map(receiptListItem).join("\n")}</ul>`
}`;
}

export { escape };
