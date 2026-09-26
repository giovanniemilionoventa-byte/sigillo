import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Receipt } from "@sigillo/core";
import type { ApiKeyStore } from "../auth/api-keys.js";
import { AttemptThrottle, type ThrottleSettings } from "../auth/throttle.js";
import type { Checkpointer } from "../checkpoint/checkpointer.js";
import { buildArchive } from "../export/archive.js";
import type { ChainHealthMonitor, ChainStatus } from "../health/chain-health.js";
import {
  normaliseDisplayName,
  StorageError,
  SystemNotDeletableError,
  type AdminRequest,
  type ArtifactMatch,
  type ReceiptStore,
  type SystemRecord,
} from "../storage/store.js";
import {
  actionKindLabel,
  describeAdminEntry,
  describeArtifact,
  describeDocumentMatch,
  describeReceipt,
  formatTs,
  systemTitle,
  UI,
} from "./strings.js";
import { SEAL_SVG, STYLE } from "./style.js";

/**
 * The operator's view: server-rendered HTML, no framework and no build step,
 * except the one inline script on the "verifica un documento" page.
 *
 * It answers three questions, in order — è tutto a posto? cosa ha fatto
 * l'AI? mi prepari le prove? — plus the secondary pages: the systems, with
 * creating one (and its first key) and managing one (its name, archiving it,
 * deleting it while its chain is still empty), and checking a document by
 * fingerprint. It never writes a receipt; besides creating a system and
 * those labels, its only write is running, on request, the same checkpoint
 * the server already does on a timer — sooner, not instead. The look is in
 * style.ts.
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

interface PageOptions {
  /** The document title, before " — sigillo". */
  title: string;
  /** Which entry of the navigation this page belongs to. */
  current?: "registro" | "sistemi" | "verifica";
  /** The page's own heading: a small line above, the title, and a system_id beneath when there is one. */
  head?: { eyebrow?: string; h1: string; sid?: string; badges?: string[] };
  body: string;
}

function page(options: PageOptions, signingKeyId: string): string {
  const here = (name: PageOptions["current"]): string => (options.current === name ? ' aria-current="page"' : "");
  const head =
    options.head === undefined
      ? ""
      : `<div class="page-head">
${options.head.eyebrow === undefined ? "" : `<p class="eyebrow">${escape(options.head.eyebrow)}</p>`}
<h1>${escape(options.head.h1)}${(options.head.badges ?? []).map((badge) => ` <span class="badge">${escape(badge)}</span>`).join("")}</h1>
${options.head.sid === undefined ? "" : `<code class="sid">${escape(options.head.sid)}</code>`}
</div>`;
  return `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(options.title)} — sigillo</title>
<style>${STYLE}</style>
</head><body>
<a class="skip" href="#main">${escape(UI.brand.skip)}</a>
<header class="masthead"><div class="masthead-inner">
  <a class="brand" href="/ui">${SEAL_SVG}<span><span class="wordmark">sigillo</span><span class="tagline">${escape(UI.brand.tagline)}</span></span></a>
  <nav aria-label="sezioni">
    <a href="/ui"${here("registro")}>${escape(UI.nav.registro)}</a>
    <a href="/ui/sistemi"${here("sistemi")}>${escape(UI.nav.sistemi)}</a>
    <form class="inline" method="post" action="/ui/logout"><button type="submit" class="link">${escape(UI.nav.esci)}</button></form>
  </nav>
</div></header>
<main id="main">
${head}
${options.body}
</main>
<footer class="colophon"><p>${escape(UI.brand.signingKey)} <code>${escape(signingKeyId)}</code></p></footer>
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
  return `<p class="notice">${escape(t.privacyNote)}</p>
<p class="warn" id="sigillo-doc-inactive">${escape(t.scriptInactive)}</p>
<div class="sheet formal">
<p><label>${escape(t.fileLabel)}<input type="file" id="sigillo-doc-file"></label></p>
<p><label>${escape(t.textLabel)}<textarea id="sigillo-doc-text" rows="6" cols="60"></textarea></label></p>
<p class="hint">${escape(t.textNote)}</p>
<p><button type="button" id="sigillo-doc-button" disabled>${escape(t.submit)}</button></p>
</div>
<p class="notice bad" id="sigillo-doc-failed" role="alert" hidden>${escape(t.computeFailed)} ${escape(t.browserError)}: <span id="sigillo-doc-error"></span>.</p>
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
    : `con marca temporale del ${formatTs(token.genTime)}`;
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
    return `<section id="sigillo-doc-result" class="sheet"><h2>${escape(t.resultTitle)}</h2>${searched}<p><strong>${escape(t.noMatch)}</strong></p>` +
      `<p class="hint">${escape(t.lineEndingsHint)}</p></section>`;
  }
  const names = new Map(store.listSystemRecords().map((record) => [record.system_id, record.display_name]));
  const items = matches
    .map((match) => {
      const sentence = describeDocumentMatch({ ...match, display_name: names.get(match.system_id) ?? null });
      const link = escape(encodeURIComponent(match.system_id));
      return `<li>${escape(sentence)} <a href="/ui/systems/${link}">${escape(t.seeReceipt)}</a> — ` +
        `<span class="muted">${escape(timestampStatus(store, match.system_id, match.seq))}</span></li>`;
    })
    .join("\n");
  return `<section id="sigillo-doc-result" class="sheet"><h2>${escape(t.resultTitle)}</h2>${searched}<ul>${items}</ul></section>`;
}

function loginPage(message?: string): string {
  return `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>sigillo</title><style>${STYLE}</style></head><body>
<main class="login" id="main">
${SEAL_SVG}
<span class="wordmark">sigillo</span>
<p class="tagline">${escape(UI.brand.tagline)}</p>
${message === undefined ? "" : `<p class="notice bad" role="alert">${escape(message)}</p>`}
<form method="post" action="/ui/login" class="sheet formal">
  <label>${escape(UI.login.label)}
    <input type="password" name="password" autocomplete="current-password" autofocus required>
  </label>
  <p><button type="submit" class="primary">${escape(UI.login.submit)}</button></p>
</form>
</main>
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

  const keyId = options.signerKey.key_id;
  const render = (pageOptions: PageOptions): string => page(pageOptions, keyId);

  /** Who is acting, for the administrative log: this view has one password, so an address is what there is. */
  const adminRequest = (request: FastifyRequest): AdminRequest => ({
    actor: `web ${request.ip}`,
    ts: options.now().toISOString(),
  });

  app.get("/ui", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const query = request.query as { checkpoint?: string };
    const justCheckpointed = query.checkpoint === "1";
    return html(
      reply,
      render({
        title: UI.home.heading,
        current: "registro",
        head: { eyebrow: UI.home.eyebrow, h1: UI.home.heading },
        body: homePage(store, options.healthMonitor, options.now(), justCheckpointed),
      }),
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

  const systemsView = (value: unknown): SystemsView =>
    value === "archiviati" || value === "tutti" ? value : "attivi";

  const renderSistemi = (view: SystemsView, extra: { notice?: string; error?: string } = {}): string =>
    render({
      title: UI.systemsPage.title,
      current: "sistemi",
      head: { eyebrow: UI.systemsPage.eyebrow, h1: UI.systemsPage.heading },
      body: sistemiPage(store, view, extra),
    });

  app.get("/ui/sistemi", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const query = request.query as { vista?: string; eliminato?: string };
    // Said only for a deletion the administrative log actually holds: the
    // query string alone cannot make the page claim one.
    const deleted =
      typeof query.eliminato === "string" && !store.hasSystem(query.eliminato) && store.deletionOf(query.eliminato) !== null
        ? UI.systemsPage.deleted(query.eliminato)
        : undefined;
    return html(reply, renderSistemi(systemsView(query.vista), deleted === undefined ? {} : { notice: deleted }));
  });

  app.post("/ui/sistemi", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const body = request.body as { system_id?: unknown; display_name?: unknown } | undefined;
    const systemId = typeof body?.system_id === "string" ? body.system_id.trim() : "";
    const displayName = typeof body?.display_name === "string" ? body.display_name : "";

    try {
      // Checked before the chain is opened: a genesis cannot be taken back
      // because its label turned out to be too long.
      normaliseDisplayName(displayName);
      await store.createSystem(systemId, options.now().toISOString());
      if (displayName.trim().length > 0) {
        await store.renameSystem(systemId, displayName, adminRequest(request));
      }
      // On the write queue: see ReceiptStore.exclusive.
      const issued = await store.exclusive(() => keys.issue(systemId, options.now().toISOString()));
      const record = store.systemRecord(systemId);
      return html(
        reply,
        render({
          title: UI.systemsPage.title,
          current: "sistemi",
          head: { eyebrow: UI.systemsPage.createdTitle, h1: record === null ? systemId : systemTitle(record), sid: systemId },
          body: systemCreatedPage(systemId, issued.token),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return html(reply, renderSistemi("attivi", { error: message }), 400);
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
    return html(
      reply,
      render({
        title: UI.verifyDocument.title,
        current: "verifica",
        head: { eyebrow: UI.verifyDocument.eyebrow, h1: UI.verifyDocument.heading },
        body,
      }),
    );
  });

  const notFound = (reply: FastifyReply, systemId: string): FastifyReply =>
    html(
      reply,
      render({ title: "non trovato", head: { h1: "Non trovato" }, body: `<p>Nessun sistema chiamato ${escape(systemId)}.</p>` }),
      404,
    );

  /** The heading of every page about one system: its name, its system_id, and whether it is archived. */
  const systemHead = (record: SystemRecord, eyebrow: string): NonNullable<PageOptions["head"]> => ({
    eyebrow,
    h1: systemTitle(record),
    sid: record.system_id,
    badges: record.archived_at === null ? [] : [UI.systemsPage.archivedBadge],
  });

  app.get("/ui/systems/:systemId", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(reply, systemId);

    const query = request.query as Record<string, string | undefined>;
    const receipts = store.searchReceipts({
      systemId,
      ...(query["from"] === undefined ? {} : { from: query["from"] }),
      ...(query["to"] === undefined ? {} : { to: query["to"] }),
      ...(query["kind"] === undefined ? {} : { kind: query["kind"] }),
      ...(query["name"] === undefined ? {} : { name: query["name"] }),
      limit: 200,
    });

    return html(
      reply,
      render({
        title: systemTitle(record),
        head: systemHead(record, UI.history.eyebrow),
        body: historyPage(systemId, receipts, query),
      }),
    );
  });

  app.get("/ui/systems/:systemId/checkpoints", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(reply, systemId);
    const checkpoints = store.readCheckpoints(systemId);

    const rows = checkpoints
      .map((stored) => {
        const tokens = store.readTimestamps(stored.id);
        return `<tr>
  <td>${stored.checkpoint.tree_size}</td>
  <td>${escape(formatTs(stored.checkpoint.ts))}</td>
  <td class="hash">${escape(stored.checkpoint.root_hash)}</td>
  <td>${
    tokens.length === 0
      ? `<span class="warn">${escape(UI.checkpoints.waiting)}</span>`
      : tokens
          .map(
            (token) =>
              `${escape(token.genTime === undefined ? UI.checkpoints.genTimeUnreadable : formatTs(token.genTime))}<br>` +
              `<span class="muted small">${escape(token.tsaUrl)} · ${escape(UI.checkpoints.receivedAt)} ${escape(formatTs(token.obtainedAt))}</span>`,
          )
          .join("<br>")
  }</td>
</tr>`;
      })
      .join("\n");

    const link = escape(encodeURIComponent(systemId));
    return html(
      reply,
      render({
        title: `${systemTitle(record)} — ${UI.checkpoints.title}`,
        head: systemHead(record, UI.checkpoints.title),
        body: `<p class="small"><a href="/ui/systems/${link}">← ${escape(UI.systemsPage.history)}</a></p>
<p class="hint">${escape(UI.checkpoints.explain)}</p>
${
  checkpoints.length === 0
    ? `<p class="empty">${escape(UI.checkpoints.none)}</p>`
    : `<div class="table-scroll"><table class="wide">
<tr><th>ricevute coperte</th><th>scritto</th><th>radice Merkle</th><th>marca temporale (ora attestata dall'autorità)</th></tr>
${rows}
</table></div>`
}`,
      }),
    );
  });

  // Managing one system: its label, whether it is archived, and — for a
  // chain that never recorded anything — deleting it.

  const renderManage = (record: SystemRecord, extra: { notice?: string; error?: string } = {}): string =>
    render({
      title: `${systemTitle(record)} — ${UI.systemsPage.manage}`,
      current: "sistemi",
      head: systemHead(record, UI.manage.eyebrow),
      body: managePage(record, extra),
    });

  const DONE: Record<string, string> = {
    nome: UI.manage.renamed,
    archiviato: UI.manage.archived,
    riattivato: UI.manage.unarchived,
  };

  app.get("/ui/systems/:systemId/manage", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(reply, systemId);
    const done = (request.query as { fatto?: string }).fatto;
    const notice = done === undefined ? undefined : DONE[done];
    return html(reply, renderManage(record, notice === undefined ? {} : { notice }));
  });

  const manageUrl = (systemId: string, done: string): string =>
    `/ui/systems/${encodeURIComponent(systemId)}/manage?fatto=${done}`;

  app.post("/ui/systems/:systemId/rename", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(reply, systemId);
    const body = request.body as { display_name?: unknown } | undefined;
    const displayName = typeof body?.display_name === "string" ? body.display_name : "";
    try {
      await store.renameSystem(systemId, displayName, adminRequest(request));
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      return html(reply, renderManage(record, { error: error.message }), 400);
    }
    return reply.redirect(manageUrl(systemId, "nome"), 303);
  });

  app.post("/ui/systems/:systemId/archive", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) return notFound(reply, systemId);
    await store.archiveSystem(systemId, adminRequest(request));
    return reply.redirect(manageUrl(systemId, "archiviato"), 303);
  });

  app.post("/ui/systems/:systemId/unarchive", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) return notFound(reply, systemId);
    await store.unarchiveSystem(systemId, adminRequest(request));
    return reply.redirect(manageUrl(systemId, "riattivato"), 303);
  });

  app.post("/ui/systems/:systemId/delete", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(reply, systemId);

    // The exact system_id, typed out: not a "sei sicuro?" a thumb can tap.
    const body = request.body as { confirm?: unknown } | undefined;
    if (body?.confirm !== systemId) {
      return html(reply, renderManage(record, { error: UI.manage.confirmMismatch }), 400);
    }

    try {
      // Whether the chain is empty is decided here, inside the store's own
      // transaction, from what the database holds now — not from the page
      // the button was on, which may be minutes old.
      await store.deleteEmptySystem(systemId, adminRequest(request));
    } catch (error) {
      if (!(error instanceof SystemNotDeletableError)) throw error;
      const now = store.systemRecord(systemId) ?? record;
      return html(reply, renderManage(now, { error: UI.manage.deleteRefused(error.receipts) }), 409);
    }
    options.healthMonitor.forget(systemId);
    request.log.info({ system: systemId, action: "system.delete" }, "an empty system was deleted");
    return reply.redirect(`/ui/sistemi?eliminato=${encodeURIComponent(systemId)}`, 303);
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
      // The name as it is now: the archive keeps it, whatever it becomes later.
      displayName: store.systemRecord(systemId)?.display_name ?? null,
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
  return `<span class="stamp ${status}"><span class="dot ${status}" aria-hidden="true"></span><span class="status-word ${status}">${escape(UI.status[status])}</span></span>`;
}

/** A receipt's place in the ledger's margin: its number, the day, the time. */
function ledgerMargin(receipt: Receipt): string {
  const [day, time] = formatTs(receipt.ts_received).split(", ");
  return `<div class="margin"><span class="no">n. ${receipt.seq}</span><span class="when">${escape(day ?? "")}</span> <span class="when">${escape(time ?? "")}</span></div>`;
}

/**
 * Why an archived system is on the main page after all, or null if it is
 * not. Archiving takes a system out of sight, never a problem with it: a
 * chain that fails verification, or that keeps receiving actions, is shown.
 */
function archivedButShown(record: SystemRecord, status: ChainStatus): string | null {
  if (record.archived_at === null) return null;
  if (status === "red") return UI.home.archivedRed;
  if (record.last_received !== null && record.last_received > record.archived_at) return UI.home.archivedActive;
  return null;
}

function homePage(
  store: ReceiptStore,
  healthMonitor: ChainHealthMonitor,
  now: Date,
  justCheckpointed: boolean,
): string {
  const t = UI.home;
  const records = store.listSystemRecords();
  const rows = records.map((record) => ({ record, health: healthMonitor.statusFor(record.system_id, now) }));
  const shown = rows.filter(
    ({ record, health }) => record.archived_at === null || archivedButShown(record, health.status) !== null,
  );
  const hidden = rows.length - shown.length;

  const question = (numeral: string, id: string, title: string, content: string): string =>
    `<section class="question" aria-labelledby="${id}">
<div class="question-head"><span class="numeral" aria-hidden="true">${numeral}</span><h2 id="${id}">${escape(title)}</h2></div>
${content}
</section>`;

  const q1 =
    records.length === 0
      ? `<p class="empty">${escape(t.noSystems)}</p>`
      : `<ul class="systems">
${shown
  .map(({ record, health }) => {
    const link = escape(encodeURIComponent(record.system_id));
    const why = archivedButShown(record, health.status);
    const sid = record.display_name === null ? "" : `<code class="sid">${escape(record.system_id)}</code> · `;
    return `<li>
  <div class="system-name"><a href="/ui/systems/${link}">${escape(systemTitle(record))}</a>${
    why === null ? "" : ` <span class="badge">${escape(UI.systemsPage.archivedBadge)}</span>`
  }</div>
  ${semaphore(health.status)}
  <p class="system-meta">${sid}${escape(health.message)}${why === null ? "" : ` <em>(${escape(t.archivedShownBecause)} ${escape(why)})</em>`}</p>
</li>`;
  })
  .join("\n")}
</ul>
${hidden === 0 ? "" : `<p class="hint">${escape(t.archivedHidden(hidden))} <a href="/ui/sistemi?vista=archiviati">${escape(UI.nav.sistemi)}</a></p>`}
${justCheckpointed ? `<p class="notice" role="status">${escape(t.checkpointDone)}</p>` : ""}
<form method="post" action="/ui/checkpoint" class="fields">
  <button type="submit">${escape(t.checkpointNow)}</button>
</form>
<p class="hint">${escape(t.checkpointHint)}</p>`;

  const recent = shown
    .flatMap(({ record }) =>
      store.searchReceipts({ systemId: record.system_id, limit: 5 }).map((receipt) => ({ record, receipt })),
    )
    .sort((a, b) => (a.receipt.ts_received < b.receipt.ts_received ? 1 : -1))
    .slice(0, 8);

  const q2 =
    recent.length === 0
      ? `<p class="empty">${escape(t.noSystems)}</p>`
      : `<ol class="ledger">
${recent
  .map(
    ({ record, receipt }) =>
      `<li>${ledgerMargin(receipt)}<div class="entry"><a class="who" href="/ui/systems/${escape(encodeURIComponent(record.system_id))}" title="${escape(t.seeHistory)}">${escape(systemTitle(record))}</a>${escape(describeReceipt(receipt))}</div></li>`,
  )
  .join("\n")}
</ol>`;

  const option = (record: SystemRecord): string =>
    `<option value="${escape(record.system_id)}">${escape(
      record.display_name === null ? record.system_id : `${record.display_name} (${record.system_id})`,
    )}</option>`;
  const active = records.filter((record) => record.archived_at === null);
  const archived = records.filter((record) => record.archived_at !== null);

  const q3 =
    records.length === 0
      ? `<p class="empty">${escape(t.noSystems)}</p>`
      : `<div class="sheet formal">
<form method="post" action="/ui/export" class="fields">
  <label>${escape(t.chooseSystem)}
    <select name="system_id">${active.map(option).join("")}${
      archived.length === 0 ? "" : `<optgroup label="${escape(t.archivedGroup)}">${archived.map(option).join("")}</optgroup>`
    }</select>
  </label>
  <label>${escape(t.fromDate)}<input type="date" name="from"></label>
  <label>${escape(t.toDate)}<input type="date" name="to"></label>
  <button type="submit" class="primary">${escape(t.generate)}</button>
</form>
<p class="hint">${escape(t.wholeChain)} ${escape(t.generateHint)}</p>
</div>`;

  return `${question("I", "q1", t.q1, q1)}
${question("II", "q2", t.q2, q2)}
${question("III", "q3", t.q3, q3)}`;
}

type SystemsView = "attivi" | "archiviati" | "tutti";

function sistemiPage(store: ReceiptStore, view: SystemsView, extra: { notice?: string; error?: string }): string {
  const t = UI.systemsPage;
  const records = store.listSystemRecords();
  const inView = records.filter((record) =>
    view === "tutti" ? true : view === "archiviati" ? record.archived_at !== null : record.archived_at === null,
  );
  const count = (candidate: SystemsView): number =>
    candidate === "tutti"
      ? records.length
      : records.filter((record) => (candidate === "archiviati") === (record.archived_at !== null)).length;

  const tabs = `<ul class="tabs" aria-label="${escape(t.existing)}">${(["attivi", "archiviati", "tutti"] as const)
    .map(
      (candidate) =>
        `<li><a href="/ui/sistemi?vista=${candidate}"${candidate === view ? ' aria-current="page"' : ""}>${escape(t.views[candidate])} (${count(candidate)})</a></li>`,
    )
    .join("")}</ul>`;

  const list =
    inView.length === 0
      ? `<p class="empty">${escape(t.noneInView[view])}</p>`
      : `<ul class="systems">${inView
          .map((record) => {
            const link = escape(encodeURIComponent(record.system_id));
            const meta = [
              `<code class="sid">${escape(record.system_id)}</code>`,
              escape(record.receipts <= 1 ? t.onlyGenesis : t.receipts(record.receipts)),
              ...(record.last_received === null ? [] : [`${escape(t.lastActivity)} ${escape(formatTs(record.last_received))}`]),
              ...(record.archived_at === null ? [] : [`${escape(UI.manage.archivedOn)} ${escape(formatTs(record.archived_at))}`]),
            ].join(" · ");
            return `<li>
  <div class="system-name"><a href="/ui/systems/${link}">${escape(systemTitle(record))}</a>${
    record.archived_at === null ? "" : ` <span class="badge">${escape(t.archivedBadge)}</span>`
  }</div>
  <p class="system-meta">${meta}</p>
  <div class="system-links"><a href="/ui/systems/${link}">${escape(t.history)}</a><a href="/ui/systems/${link}/manage">${escape(t.manage)}</a></div>
</li>`;
          })
          .join("\n")}</ul>`;

  const log = store.adminLog(20);
  const adminLog =
    log.length === 0
      ? `<p class="empty">${escape(t.adminLogEmpty)}</p>`
      : `<ul class="log">${log.map((entry) => `<li>${escape(describeAdminEntry(entry))}</li>`).join("")}</ul>`;

  return `${extra.notice === undefined ? "" : `<p class="notice" role="status">${escape(extra.notice)}</p>`}
${extra.error === undefined ? "" : `<p class="notice bad warn" role="alert">${escape(extra.error)}</p>`}
${tabs}
${list}
<h2>${escape(t.createTitle)}</h2>
<div class="sheet formal">
<form method="post" action="/ui/sistemi" class="fields">
  <label>${escape(t.nameLabel)}
    <input type="text" name="system_id" placeholder="${escape(t.namePlaceholder)}" autocapitalize="off" autocomplete="off" spellcheck="false" required>
  </label>
  <label>${escape(t.displayNameLabel)}
    <input type="text" name="display_name" maxlength="128">
  </label>
  <button type="submit" class="primary">${escape(t.submit)}</button>
</form>
<p class="hint">${escape(t.idHint)}</p>
</div>
<h2>${escape(t.adminLogTitle)}</h2>
<p class="hint">${escape(t.adminLogHint)}</p>
${adminLog}`;
}

function managePage(record: SystemRecord, extra: { notice?: string; error?: string }): string {
  const t = UI.manage;
  const link = escape(encodeURIComponent(record.system_id));
  const deletable = record.receipts <= 1;

  const archive =
    record.archived_at === null
      ? `<form method="post" action="/ui/systems/${link}/archive" class="fields"><button type="submit">${escape(t.archiveSubmit)}</button></form>`
      : `<p><strong>${escape(t.archivedOn)} ${escape(formatTs(record.archived_at))}.</strong></p>
<form method="post" action="/ui/systems/${link}/unarchive" class="fields"><button type="submit" class="primary">${escape(t.unarchiveSubmit)}</button></form>`;

  const removal = deletable
    ? `<p>${escape(t.deleteAllowed)}</p>
<form method="post" action="/ui/systems/${link}/delete" class="fields">
  <label>${escape(t.deleteConfirmLabel(record.system_id))}
    <input type="text" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false" required>
  </label>
  <button type="submit" class="danger">${escape(t.deleteSubmit)}</button>
</form>`
    : `<p>${escape(t.deleteRefused(record.receipts))}</p>`;

  return `<p class="small"><a href="/ui/systems/${link}">← ${escape(UI.systemsPage.history)}</a> · <a href="/ui/sistemi">${escape(UI.nav.sistemi)}</a></p>
${extra.notice === undefined ? "" : `<p class="notice" role="status">${escape(extra.notice)}</p>`}
${extra.error === undefined ? "" : `<p class="notice bad warn" role="alert">${escape(extra.error)}</p>`}
<section class="sheet">
<h2>${escape(t.nameTitle)}</h2>
<form method="post" action="/ui/systems/${link}/rename" class="fields">
  <label>${escape(t.nameLabel)}
    <input type="text" name="display_name" value="${escape(record.display_name ?? "")}" maxlength="128">
  </label>
  <button type="submit" class="primary">${escape(t.nameSubmit)}</button>
</form>
<p class="hint">${escape(t.nameHint(record.system_id))}</p>
</section>
<section class="sheet">
<h2>${escape(t.archiveTitle)}</h2>
<p>${escape(t.archiveHint)}</p>
${archive}
</section>
<section class="sheet${deletable ? " danger" : ""}">
<h2>${escape(t.deleteTitle)}</h2>
${removal}
</section>`;
}

function systemCreatedPage(systemId: string, token: string): string {
  const t = UI.systemsPage;
  const pythonCode = [
    "pip install -e 'sdk-python[langchain]'   # o [crewai], [openai], o più insieme",
    "python3 -c \"",
    "import sigillo",
    "sigillo.init(",
    "    endpoint='https://<il-tuo-dominio>',",
    `    api_key='${token}',`,
    `    system_id='${systemId}',`,
    "    instrument=['langchain'],   # 'crewai' e 'openai' sono altrettanto reali",
    ")\"",
  ].join("\n");

  const otlpCode = [
    `curl -X POST https://<il-tuo-dominio>/v1/traces \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    "  -d '{",
    '    "resourceSpans": [{ "scopeSpans": [{ "spans": [{',
    `      "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",`,
    `      "spanId": "00f067aa0ba902b7",`,
    `      "name": "azione",`,
    `      "startTimeUnixNano": "1712000000000000000",`,
    `      "endTimeUnixNano": "1712000000500000000",`,
    `      "status": { "code": "STATUS_CODE_OK" },`,
    '      "attributes": [',
    '        { "key": "gen_ai.operation.name", "value": { "stringValue": "execute_tool" } },',
    `        { "key": "gen_ai.tool.name", "value": { "stringValue": "azione" } },`,
    `        { "key": "gen_ai.agent.name", "value": { "stringValue": "${systemId}" } }`,
    "      ]",
    "    }] }] }]",
    "  }'",
  ].join("\n");

  const nativeCode = [
    `curl -X POST https://<il-tuo-dominio>/api/v1/receipts \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    "  -d '{",
    '    "actor": { "agent": "agente" },',
    '    "action": { "kind": "decision", "name": "azione" },',
    '    "outcome": "ok"',
    "  }'",
  ].join("\n");

  return `<p class="notice bad"><strong>${escape(t.tokenWarning)}</strong></p>
<div class="token-box">${escape(token)}</div>
<h2>${escape(t.howToConnect)}</h2>
<p class="hint">${escape(t.howToConnectIntro)}</p>
<h3>${escape(t.connectPython.title)}</h3>
<p class="hint">${escape(t.connectPython.hint)}</p>
<pre class="code">${escape(pythonCode)}</pre>
<h3>${escape(t.connectOtlp.title)}</h3>
<p class="hint">${escape(t.connectOtlp.hint)}</p>
<pre class="code">${escape(otlpCode)}</pre>
<h3>${escape(t.connectNative.title)}</h3>
<p class="hint">${escape(t.connectNative.hint)}</p>
<pre class="code">${escape(nativeCode)}</pre>
<p class="hint">${escape(t.connectMore)}</p>
<p><a href="/ui/systems/${escape(encodeURIComponent(systemId))}/manage">${escape(t.manage)}</a> · <a href="/ui/sistemi">${escape(UI.nav.sistemi)}</a></p>`;
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

  return `<li>${ledgerMargin(receipt)}<div class="entry">${escape(describeReceipt(receipt))} ${artifacts}${details}</div></li>`;
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
  const filtered = ["from", "to", "kind", "name"].some((field) => (query[field] ?? "").length > 0);

  return `<p class="system-links"><a href="/ui/systems/${link}/checkpoints">${escape(UI.checkpoints.title)}</a> <a href="/ui/systems/${link}/manage">${escape(UI.systemsPage.manage)}</a></p>

<div class="sheet formal">
<form method="post" action="/ui/systems/${link}/export" class="fields">
  <button type="submit" class="primary">${escape(UI.home.generate)}</button>
</form>
<p class="hint">${escape(UI.home.generateHint)}</p>
</div>

<details class="search"${filtered ? " open" : ""}><summary>${escape(t.searchTitle)}</summary>
<form class="fields" method="get">
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
</details>

<h2>${receipts.length} ricevut${receipts.length === 1 ? "a" : "e"}${receipts.length === 200 ? " (le 200 più recenti)" : ""}</h2>
${
  receipts.length === 0
    ? `<p class="empty">${escape(t.noMatches)}</p>`
    : `<ol class="ledger" reversed>${receipts.map(receiptListItem).join("\n")}</ol>`
}`;
}

export { escape };
