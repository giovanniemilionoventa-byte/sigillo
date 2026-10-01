import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DOCUMENT_TEXT_SOURCE, type DocumentFingerprints, type Receipt } from "@sigillo/core";
import type { ApiKeyStore } from "../auth/api-keys.js";
import { AttemptThrottle, type ThrottleSettings } from "../auth/throttle.js";
import type { Checkpointer } from "../checkpoint/checkpointer.js";
import { archiveFromStore, positionsIn, tokensIn } from "../export/from-store.js";
import type { ChainHealthMonitor, ChainStatus } from "../health/chain-health.js";
import {
  normaliseDisplayName,
  StorageError,
  SystemNotDeletableError,
  type AdminRequest,
  type DocumentMatch,
  type ReceiptStore,
  type SystemRecord,
} from "../storage/store.js";
import {
  describeAdminEntry,
  describeDocumentMatch,
  describeReceipt,
  formatTs,
  systemTitle,
  UI,
} from "./strings.js";
import { registerFonts } from "./fonts.js";
import {
  anchoredSize,
  discloseFields,
  exportSheet,
  HISTORY_LIMIT,
  historyPage,
  historyQuery,
  selectedSeq,
  storeRange,
  systemHeader,
  timestampStatus,
  type SystemTab,
} from "./history.js";
import {
  archivedButShown,
  escape,
  homeRows,
  loginPage,
  page,
  pageHead,
  semaphore,
  shellFor,
  worstStatus,
  type NavCurrent,
} from "./layout.js";
import { STATE_ICONS } from "./style.js";

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

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The one script this UI carries. Hashing happens in the browser, with Web
 * Crypto: the document is never sent anywhere, only its fingerprints, as
 * query parameters of an ordinary navigation. No library, no build step.
 *
 * Which fingerprints, and of what, is not decided here: the script embeds
 * DOCUMENT_TEXT_SOURCE from packages/core, the same characters Node runs for
 * `sigillo-verify doc` and the tests, so the browser applies sigillo-text/1
 * with the reference implementation itself, never a copy of it. This page
 * only hashes what `sigilloFingerprintInputs` hands it and puts the digests
 * in the address.
 *
 * Its exact bytes are what deploy/Caddyfile's CSP allows by `script-src
 * 'sha256-...'`: changing so much as a character here, or in
 * DOCUMENT_TEXT_SOURCE, means recomputing that hash.
 * apps/server/test/ui.test.ts checks the two stay in step, and
 * scripts/smoke-dist.mjs checks the built server's script against the same
 * line. A running Caddy keeps the policy it started with: deploy/update.sh
 * restarts it on every update, and checks the policy it then sends.
 *
 * It never fails in silence (session 6). Whatever is on the page when
 * Verifica is pressed is the result of an earlier attempt, for other bytes,
 * so a press that ends in anything but a navigation removes it and says why.
 * And the button is served disabled, under a warning, for the script to
 * enable: a browser that does not run it shows both.
 */
export const VERIFY_DOCUMENT_SCRIPT = `(function () {
${DOCUMENT_TEXT_SOURCE}

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
        bytes = new Uint8Array(await fileInput.files[0].arrayBuffer());
        from = "file";
      } else if (textInput.value.length > 0) {
        bytes = new TextEncoder().encode(textInput.value);
        from = "text";
      } else {
        return;
      }
      var found = { bytes: [], text: [], lines: [], json: [], "json-lines": [] };
      var inputs = sigilloFingerprintInputs(bytes);
      for (var i = 0; i < inputs.length; i += 1) {
        found[inputs[i].kind].push(toHex(await crypto.subtle.digest("SHA-256", inputs[i].data)));
      }
      var query = "sha256=" + found.bytes[0];
      if (found.text.length > 0) query += "&text=" + found.text[0];
      if (found.lines.length > 0) query += "&lines=" + found.lines.join(",");
      if (found.json.length > 0) query += "&json=" + found.json[0];
      if (found["json-lines"].length > 0) query += "&json_lines=" + found["json-lines"].join(",");
      window.location.href = "/ui/verify-document?" + query + "&from=" + from;
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

/**
 * The fingerprints the page's script put in the address, as the store
 * searches them. `sha256` is required; everything else is optional, and a
 * value that is not what the script writes is dropped, never searched. The
 * script sends at most MAX_VARIANTS of each list (text.ts: two tails, two
 * line-ending conventions, BOM or not).
 */
const MAX_VARIANTS = 8;

function fingerprintsFromQuery(query: Record<string, unknown>): DocumentFingerprints | null {
  const one = (value: unknown): string | null => (typeof value === "string" && SHA256_HEX.test(value) ? value : null);
  const list = (value: unknown): string[] =>
    typeof value === "string" ? value.split(",").filter((item) => SHA256_HEX.test(item)).slice(0, MAX_VARIANTS) : [];
  const bytes = one(query["sha256"]);
  if (bytes === null) return null;
  return {
    bytes,
    text: one(query["text"]),
    lines: list(query["lines"]),
    json: one(query["json"]),
    jsonLines: list(query["json_lines"]),
  };
}


function verifyDocumentResult(
  store: ReceiptStore,
  fingerprints: DocumentFingerprints,
  from: "file" | "text" | undefined,
  matches: DocumentMatch[],
): string {
  const t = UI.verifyDocument;
  // The fingerprints the browser computed, shown either way: the exact one,
  // set beside Get-FileHash or sha256sum, tells at once whether the page was
  // given the same bytes the agent read. Which input they were computed on,
  // file or text, the page's script says in `from`.
  const source = from === undefined ? "" : `<p class="muted">${escape(from === "file" ? t.fromFile : t.fromText)}</p>`;
  const textLine =
    fingerprints.text === null
      ? `<p>${escape(t.textFingerprint)}: <span class="muted">${escape(t.noTextFingerprint)}</span></p>`
      : `<p>${escape(t.textFingerprint)}: <span class="hash text-hash">${escape(fingerprints.text)}</span></p>`;
  const searched = `<p>${escape(t.searchedFingerprint)}: <span class="hash">${escape(fingerprints.bytes)}</span></p>${textLine}${source}`;
  if (matches.length === 0) {
    return `<section id="sigillo-doc-result" class="sheet"><h2>${escape(t.resultTitle)}</h2>${searched}<p><strong>${escape(t.noMatch)}</strong></p>` +
      `<p class="hint">${escape(t.noMatchHint)}</p></section>`;
  }
  const names = new Map(store.listSystemRecords().map((record) => [record.system_id, record.display_name]));
  const items = matches
    .map((match) => {
      const sentence = describeDocumentMatch({ ...match, display_name: names.get(match.system_id) ?? null });
      const link = escape(encodeURIComponent(match.system_id));
      return `<li data-match="${escape(match.kind)}">${escape(sentence)} <a href="/ui/systems/${link}">${escape(t.seeReceipt)}</a> — ` +
        `<span class="muted">${escape(timestampStatus(store, match.system_id, match.seq))}</span></li>`;
    })
    .join("\n");
  return `<section id="sigillo-doc-result" class="sheet"><h2>${escape(t.resultTitle)}</h2>${searched}<ul>${items}</ul></section>`;
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

  registerFonts(app);

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
  /** A page in the shell; the sidebar is read fresh, with the same health as the main page's traffic lights. */
  interface RenderOptions {
    title: string;
    current?: NavCurrent;
    head?: { eyebrow?: string; h1: string; lead?: string; sid?: string; badges?: string[] };
    mainClass?: string;
    body: string;
  }
  const render = (pageOptions: RenderOptions): string => {
    const head = pageOptions.head;
    const heading =
      head === undefined
        ? ""
        : pageHead(head) +
          (head.sid === undefined ? "" : `<p><code class="sid">${escape(head.sid)}</code></p>`) +
          (head.badges ?? []).map((badge) => `<span class="badge">${escape(badge)}</span>`).join(" ");
    return page(
      {
        title: pageOptions.title,
        ...(pageOptions.current === undefined ? {} : { current: pageOptions.current }),
        ...(pageOptions.mainClass === undefined ? {} : { mainClass: pageOptions.mainClass }),
        body: heading + pageOptions.body,
      },
      shellFor(store, options.healthMonitor, options.now(), keyId),
    );
  };

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
        head: { eyebrow: UI.home.eyebrow, ...homeSummary(store, options.healthMonitor, options.now()) },
        body: homePage(store, options.healthMonitor, options.now(), justCheckpointed, keyId),
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
    const body = request.body as
      | { system_id?: unknown; from?: unknown; to?: unknown; subjects?: unknown; openings?: unknown }
      | undefined;
    const systemId = typeof body?.system_id === "string" ? body.system_id : "";
    if (!store.hasSystem(systemId)) {
      return reply.code(404).send({ error: `no system called ${systemId}` });
    }
    return sendArchive(reply, systemId, dayBounds(body?.from, body?.to), body);
  });

  const systemsView = (value: unknown): SystemsView =>
    value === "archiviati" || value === "tutti" ? value : "attivi";

  const renderSistemi = (view: SystemsView, extra: { notice?: string; error?: string } = {}): string =>
    render({
      title: UI.systemsPage.title,
      current: view === "attivi" ? "sistemi" : view,
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

    const query = request.query as Record<string, unknown>;
    const fingerprints = fingerprintsFromQuery(query);
    const from = query["from"] === "file" || query["from"] === "text" ? query["from"] : undefined;

    const body = `${verifyDocumentForm()}${
      fingerprints === null ? "" : verifyDocumentResult(store, fingerprints, from, store.findDocument(fingerprints))
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

  /** A page about one system that is not its history: header and tabs, the page, the evidence sheet. */
  const systemPage = (record: SystemRecord, tab: SystemTab, title: string, body: string): string =>
    render({
      title,
      current: `system:${record.system_id}`,
      mainClass: "system-page",
      body: `${systemHeader(record, options.healthMonitor.statusFor(record.system_id, options.now()), tab)}
<div class="system-body">
${body}
</div>
${exportSheet(record)}`,
    });

  app.get("/ui/systems/:systemId", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;

    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(reply, systemId);

    const query = historyQuery(request.query as Record<string, unknown>);
    const filters = { systemId, ...storeRange(query), ...(query.name === undefined ? {} : { name: query.name }) };
    const receipts = store.searchReceipts({
      ...filters,
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      limit: HISTORY_LIMIT,
    });
    // The receipt the address asks for, shown even when the filters leave it
    // out of the list; without one, the most recent of those shown.
    const wanted = selectedSeq(query);
    const asked = wanted === null ? null : (receipts.find((receipt) => receipt.seq === wanted) ?? store.receiptAt(systemId, wanted));
    const selected = asked ?? receipts[0] ?? null;

    return html(
      reply,
      render({
        title: asked === null ? systemTitle(record) : `${UI.inspector.receiptNo(asked.seq)} — ${systemTitle(record)}`,
        current: `system:${systemId}`,
        mainClass: `studio${asked === null ? "" : " has-selection"}`,
        body: historyPage({
          store,
          record,
          health: options.healthMonitor.statusFor(systemId, options.now()),
          query,
          receipts,
          counts: store.countReceiptsByKind(filters),
          selected,
          explicit: asked !== null,
          anchoredBelow: anchoredSize(store, systemId),
        }),
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

    return html(
      reply,
      systemPage(
        record,
        "checkpoints",
        `${systemTitle(record)} — ${UI.checkpoints.title}`,
        `<p class="hint">${escape(UI.checkpoints.explain)}</p>
${
  checkpoints.length === 0
    ? `<p class="empty">${escape(UI.checkpoints.none)}</p>`
    : `<div class="table-scroll"><table class="wide">
<tr><th>ricevute coperte</th><th>scritto</th><th>radice Merkle</th><th>marca temporale (ora attestata dall'autorità)</th></tr>
${rows}
</table></div>`
}`,
      ),
    );
  });

  // Managing one system: its label, whether it is archived, and — for a
  // chain that never recorded anything — deleting it.

  const renderManage = (record: SystemRecord, extra: { notice?: string; error?: string } = {}): string =>
    systemPage(record, "manage", `${systemTitle(record)} — ${UI.systemsPage.manage}`, managePage(record, extra));

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

  // People: who the pseudonym tokens stand for. The identifier is posted,
  // never put in an address, so it stays out of the browser's history and of
  // any log that keeps addresses.

  const renderPeople = (
    search: { identifier: string; token: string | null } | null,
    extra: { notice?: string; error?: string } = {},
  ): string =>
    render({
      title: UI.people.title,
      current: "persone",
      head: { eyebrow: UI.people.eyebrow, h1: UI.people.heading },
      body: peoplePage(store, search, extra),
    });

  app.get("/ui/persone", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const erased = (request.query as { cancellato?: string }).cancellato;
    // Said only for an erasure the administrative log actually holds.
    const done =
      typeof erased === "string" &&
      store.adminLog(10_000).some((entry) => entry.action === "subject.erase" && entry.detail["token"] === erased);
    return html(reply, renderPeople(null, done ? { notice: UI.people.erased(erased) } : {}));
  });

  app.post("/ui/persone", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const body = request.body as { identifier?: unknown } | undefined;
    const identifier = typeof body?.identifier === "string" ? body.identifier : "";
    return html(reply, renderPeople({ identifier, token: store.subjectToken(identifier) }));
  });

  app.post("/ui/persone/cancella", async (request, reply) => {
    if (!requireSession(request, reply)) return reply;
    const body = request.body as { token?: unknown; confirm?: unknown } | undefined;
    const token = typeof body?.token === "string" ? body.token : "";
    // The exact token, typed out: not a "sei sicuro?" a thumb can tap.
    if (body?.confirm !== token || token === "") {
      return html(reply, renderPeople(null, { error: UI.people.confirmMismatch }), 400);
    }
    if (!(await store.eraseSubject(token, adminRequest(request)))) {
      return html(reply, renderPeople(null, { error: UI.people.notFound }), 404);
    }
    request.log.info({ action: "subject.erase", token }, "a subject was erased");
    return reply.redirect(`/ui/persone?cancellato=${encodeURIComponent(token)}`, 303);
  });

  async function sendArchive(
    reply: FastifyReply,
    systemId: string,
    range: { from?: string; to?: string },
    body: { subjects?: unknown; openings?: unknown } | undefined,
  ): Promise<FastifyReply> {
    const archive = await archiveFromStore(store, systemId, {
      range,
      // Nobody is named and no digest opened unless the operator asked, here,
      // for these tokens and these positions.
      subjects: tokensIn(body?.subjects),
      openings: positionsIn(body?.openings),
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
    // The sheet on the system's pages sends a period too; a form without one
    // exports the whole chain, as this route always did.
    const body = request.body as { from?: unknown; to?: unknown; subjects?: unknown; openings?: unknown } | undefined;
    return sendArchive(reply, systemId, dayBounds(body?.from, body?.to), body);
  });
}

/** An HTML date input gives YYYY-MM-DD; this makes it an inclusive whole-day bound. */
function dayBounds(from: unknown, to: unknown): { from?: string; to?: string } {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const start = typeof from === "string" && DATE.test(from) ? `${from}T00:00:00.000Z` : undefined;
  const end = typeof to === "string" && DATE.test(to) ? `${to}T23:59:59.999Z` : undefined;
  return { ...(start === undefined ? {} : { from: start }), ...(end === undefined ? {} : { to: end }) };
}

/** A receipt's place in the ledger's margin: its number, the day, the time. */
function ledgerMargin(receipt: Receipt): string {
  const [day, time] = formatTs(receipt.ts_received).split(", ");
  return `<div class="margin"><span class="no">n. ${receipt.seq}</span><span class="when">${escape(day ?? "")}</span> <span class="when">${escape(time ?? "")}</span></div>`;
}

/** The main page's title and subtitle: the situation in one sentence. */
function homeSummary(store: ReceiptStore, healthMonitor: ChainHealthMonitor, now: Date): { h1: string; lead: string } {
  const t = UI.home.summary;
  const { shown } = homeRows(store, healthMonitor, now);
  if (shown.length === 0) return { h1: t.none, lead: UI.home.noSystems };
  const count = (status: ChainStatus): number => shown.filter(({ health }) => health.status === status).length;
  const worst = worstStatus(shown.map(({ health }) => health.status));
  const h1 = worst === "red" ? t.red(count("red")) : worst === "yellow" ? t.yellow(count("yellow")) : t.green(shown.length);
  return { h1, lead: t.lead(shown.length) };
}

/**
 * One of the three questions as a line of the register: its numeral, the
 * question and a detail, the state on the right when there is one, and what
 * answers it underneath.
 */
function registerRow(
  numeral: string,
  id: string,
  title: string,
  detail: string | null,
  state: { stamp?: string; line?: string } | null,
  content: string,
): string {
  const right =
    state === null
      ? ""
      : `<div class="row-state">${state.stamp ?? ""}${state.line === undefined ? "" : `<span class="label">${escape(state.line)}</span>`}</div>`;
  return `<section class="question" aria-labelledby="${id}">
<div class="register-row"><span class="numeral" aria-hidden="true">${numeral}</span><div class="row-text"><h2 id="${id}">${escape(title)}</h2>${
    detail === null ? "" : `<p class="detail">${escape(detail)}</p>`
  }</div>${right}</div>
<div class="question-body">
${content}
</div>
</section>`;
}

function homePage(
  store: ReceiptStore,
  healthMonitor: ChainHealthMonitor,
  now: Date,
  justCheckpointed: boolean,
  keyId: string,
): string {
  const t = UI.home;
  const { records, rows, shown } = homeRows(store, healthMonitor, now);
  const hidden = rows.length - shown.length;

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
  ${discloseFields()}
  <button type="submit" class="primary">${escape(t.generate)}</button>
</form>
<p class="hint">${escape(t.wholeChain)}</p>
</div>`;

  const q1State =
    shown.length === 0
      ? null
      : { stamp: semaphore(worstStatus(shown.map(({ health }) => health.status))), line: t.systemsCount(shown.length) };
  const q2State = recent.length === 0 ? null : { line: t.actionsCount(recent.length) };
  const receipts = records.reduce((total, record) => total + record.receipts, 0);

  return `${registerRow("I", "q1", t.q1, null, q1State, q1)}
${registerRow("II", "q2", t.q2, t.recentActivity, q2State, q2)}
${registerRow("III", "q3", t.q3, t.generateHint, null, q3)}
<p class="register-foot label">key_id <code>${escape(keyId)}</code> · ${escape(UI.systemsPage.receipts(receipts))}</p>`;
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

  const connection = (record: SystemRecord): string => {
    const latest = store.searchReceipts({ systemId: record.system_id, limit: 1 })[0];
    return latest === undefined || latest.action.kind === "genesis" ? t.connection.none : t.connection[latest.source.type];
  };
  const cell = (name: keyof typeof t.columns, content: string): string =>
    `<td data-label="${escape(t.columns[name])}">${content}</td>`;

  const list =
    inView.length === 0
      ? `<p class="empty">${escape(t.noneInView[view])}</p>`
      : `<div class="table-scroll"><table class="systems-table">
<thead><tr>${(["system", "state", "receipts", "last", "manage"] as const).map((name) => `<th scope="col">${escape(t.columns[name])}</th>`).join("")}</tr></thead>
<tbody>${inView
          .map((record) => {
            const link = escape(encodeURIComponent(record.system_id));
            const state =
              record.archived_at === null
                ? `<span class="stamp green"><span class="dot" aria-hidden="true">${STATE_ICONS.ok}</span><span class="status-word">${escape(t.active)}</span></span>`
                : `<span class="stamp archived"><span class="dot" aria-hidden="true">${STATE_ICONS.archived}</span><span class="status-word">${escape(t.archivedBadge)}</span></span>` +
                  `<span class="label">${escape(UI.manage.archivedOn)} ${escape(formatTs(record.archived_at))}</span>`;
            return `<tr>
  ${cell("system", `<div class="system-name"><a href="/ui/systems/${link}">${escape(systemTitle(record))}</a></div><code class="sid">${escape(record.system_id)}</code> <span class="muted">· ${escape(connection(record))}</span>`)}
  ${cell("state", state)}
  ${cell("receipts", `<span class="num">${record.receipts}</span> <span class="sr">${escape(record.receipts <= 1 ? t.onlyGenesis : t.receipts(record.receipts))}</span>`)}
  ${cell("last", record.last_received === null ? "—" : `<span class="num">${escape(formatTs(record.last_received))}</span>`)}
  ${cell("manage", `<a href="/ui/systems/${link}">${escape(t.history)}</a> <a href="/ui/systems/${link}/manage">${escape(t.manage)}</a>`)}
</tr>`;
          })
          .join("\n")}</tbody></table></div>`;

  const ways = [t.connectPython, t.connectOtlp, t.connectNative]
    .map((way) => `<div class="way"><h3>${escape(way.title)}</h3><p class="hint">${escape(way.hint)}</p></div>`)
    .join("");
  const connect = `<h2>${escape(t.howToConnect)}</h2>
<p class="hint">${escape(t.howToConnectIntro)}</p>
<div class="ways">${ways}</div>
<p class="hint">${escape(t.connectMore)}</p>`;

  const log = store.adminLog(20);
  const adminLog =
    log.length === 0
      ? `<p class="empty">${escape(t.adminLogEmpty)}</p>`
      : `<ul class="log">${log.map((entry) => `<li>${escape(describeAdminEntry(entry))}</li>`).join("")}</ul>`;

  return `${extra.notice === undefined ? "" : `<p class="notice" role="status">${escape(extra.notice)}</p>`}
${extra.error === undefined ? "" : `<p class="notice bad warn" role="alert">${escape(extra.error)}</p>`}
${tabs}
${list}
${connect}
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

/** The people page: search by identifier, through the subjects table, and the erasure of what it finds. */
function peoplePage(
  store: ReceiptStore,
  search: { identifier: string; token: string | null } | null,
  extra: { notice?: string; error?: string },
): string {
  const t = UI.people;
  let result = "";
  if (search !== null && search.token === null) {
    result = `<p class="empty">${escape(t.notFound)}</p>`;
  } else if (search !== null && search.token !== null) {
    const token = search.token;
    const receipts = store.receiptsOnBehalfOf(token, 500);
    const records = new Map(store.listSystemRecords().map((record) => [record.system_id, record]));
    result = `<div class="sheet formal">
<p>${escape(t.tokenLabel)}: <code>${escape(token)}</code></p>
<h2>${escape(t.receipts(receipts.length))}</h2>
<ol class="ledger">${receipts
      .map((receipt) => {
        const record = records.get(receipt.system_id);
        const link = escape(encodeURIComponent(receipt.system_id));
        return `<li class="person-receipt">${ledgerMargin(receipt)}<div class="entry"><a class="who" href="/ui/systems/${link}">${escape(
          record === undefined ? receipt.system_id : systemTitle(record),
        )}</a>${escape(describeReceipt(receipt))} <span class="muted small">(seq ${receipt.seq})</span></div></li>`;
      })
      .join("\n")}</ol>
<h2>${escape(t.eraseTitle)}</h2>
<p class="hint">${escape(t.eraseHint)}</p>
<form method="post" action="/ui/persone/cancella" class="fields">
  <input type="hidden" name="token" value="${escape(token)}">
  <label>${escape(t.eraseConfirm(token))}
    <input type="text" name="confirm" autocomplete="off" spellcheck="false" required>
  </label>
  <button type="submit" class="danger">${escape(t.eraseSubmit)}</button>
</form>
</div>`;
  }
  return `${extra.notice === undefined ? "" : `<p class="notice" role="status">${escape(extra.notice)}</p>`}
${extra.error === undefined ? "" : `<p class="notice bad warn" role="alert">${escape(extra.error)}</p>`}
<p class="hint">${escape(t.intro)}</p>
<div class="sheet formal">
<form method="post" action="/ui/persone" class="fields">
  <label>${escape(t.searchLabel)}
    <input type="text" name="identifier" value="${escape(search?.identifier ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false" required>
  </label>
  <button type="submit" class="primary">${escape(t.searchSubmit)}</button>
</form>
</div>
${result}`;
}


