import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DOCUMENT_TEXT_SOURCE, type DocumentFingerprints } from "@sigillo/core";
import type { ApiKeyStore } from "../auth/api-keys.js";
import { UiSessions } from "../auth/sessions.js";
import { OPERATOR, storeFor, type Viewer } from "../auth/tenancy.js";
import { AttemptThrottle, type ThrottleSettings } from "../auth/throttle.js";
import type { Checkpointer } from "../checkpoint/checkpointer.js";
import { archiveFromStore, positionsIn, tokensIn } from "../export/from-store.js";
import type { ChainHealthMonitor } from "../health/chain-health.js";
import {
  normaliseDisplayName,
  StorageError,
  SystemNotDeletableError,
  type AdminRequest,
  type ReceiptStore,
  type SystemRecord,
} from "../storage/store.js";
import { registerFonts } from "./fonts.js";
import {
  anchoredSize,
  exportSheet,
  HISTORY_LIMIT,
  historyPage,
  historyQuery,
  selectedSeq,
  storeRange,
  systemHeader,
  type SystemTab,
} from "./history.js";
import { escape, homeRows, loginPage, page, pageHead, shellFor, type PageOptions } from "./layout.js";
import {
  checkpointsPage,
  homePage,
  managePage,
  notFoundPage,
  peoplePage,
  sistemiPage,
  systemCreatedPage,
  verifyDocumentResult,
  type SystemsView,
} from "./pages.js";
import { systemTitle, UI } from "./strings.js";
import { ICONS, STATE_ICONS } from "./style.js";

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

/** Who signed in, and the store as they may see it (tenancy.ts). */
interface Session {
  viewer: Viewer;
  store: ReceiptStore;
}

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
  /**
   * The sessions this view issues and accepts. The password above signs the
   * operator in; an organization's members are signed in by whatever
   * identity login is attached to the same sessions. Default: a fresh set.
   */
  sessions?: UiSessions;
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
  // The ids are the script's: it reads the file and the text, enables the
  // button, and shows or hides the two notices by them.
  return `<section class="block" aria-label="${escape(t.documentLabel)}">
<p class="warn" id="sigillo-doc-inactive">${escape(t.scriptInactive)}</p>
<div class="card padded">
<label class="drop">${ICONS.doc}<strong>${escape(t.dropTitle)}</strong><span class="muted">${escape(t.dropHint)}</span><input type="file" id="sigillo-doc-file"></label>
<label class="text-field"><span class="or">${escape(t.textLabel)}</span><textarea id="sigillo-doc-text" rows="6" cols="60"></textarea></label>
<p class="hint">${escape(t.textNote)}</p>
<button type="button" id="sigillo-doc-button" disabled>${escape(t.submit)}</button>
</div>
<p class="notice bad" id="sigillo-doc-failed" role="alert" hidden>${STATE_ICONS.bad}<span>${escape(t.computeFailed)} ${escape(t.browserError)}: <span id="sigillo-doc-error"></span>.</span></p>
<script>${VERIFY_DOCUMENT_SCRIPT}</script>
</section>`;
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


export function registerUi(app: FastifyInstance, options: UiOptions): void {
  // Every system, every organization's. Never handed to a page as it is: a
  // page gets storeFor(this, the viewer), which for the operator is this.
  const allSystems = options.store;
  const { keys } = options;
  const sessions = options.sessions ?? new UiSessions();
  const loginThrottle = new AttemptThrottle(options.loginLimits ?? DEFAULT_LOGIN_LIMITS);
  const cookieSecure = options.cookieSecure ?? "auto";

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

  /**
   * Who signed in, or null. An organization's session counts only while the
   * organization exists and is approved: the operator withdrawing an approval
   * signs its members out at their next page.
   */
  const viewerOf = (request: FastifyRequest): Viewer | null => {
    const viewer = sessions.read(cookieFrom(request), options.now().getTime());
    if (viewer === null || viewer.kind === "operator") return viewer;
    const organization = allSystems.organization(viewer.organizationId);
    return organization !== null && organization.approved_at !== null ? viewer : null;
  };

  /**
   * The operator's session, or null after answering. The people pages work on
   * the subjects table, which every system shares: one person has one token
   * whichever organization's agent acted for them. Until pseudonyms are kept
   * per organization, those pages are the operator's alone, and to anyone
   * else they do not exist.
   */
  const requireOperator = (request: FastifyRequest, reply: FastifyReply): Session | null => {
    const session = requireSession(request, reply);
    if (session === null) return null;
    if (session.viewer.kind === "operator") return session;
    reply.callNotFound();
    return null;
  };

  /** The viewer and the store as they may see it, or null after redirecting to the sign-in page. */
  const requireSession = (request: FastifyRequest, reply: FastifyReply): Session | null => {
    const viewer = viewerOf(request);
    if (viewer !== null) return { viewer, store: storeFor(allSystems, viewer) };
    void reply.redirect("/ui/login", 302);
    return null;
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
    viewerOf(request) !== null
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
    const session = sessions.issue(OPERATOR, now);
    return reply
      .header("set-cookie", `${COOKIE}=${session.value}; ${cookieAttributes(request)}; Max-Age=${session.maxAgeSeconds}`)
      .redirect("/ui", 302);
  });

  app.post("/ui/logout", async (request, reply) => {
    const viewer = viewerOf(request);
    if (viewer !== null) sessions.endAll(viewer);
    return reply
      .header("set-cookie", `${COOKIE}=; ${cookieAttributes(request)}; Max-Age=0`)
      .redirect("/ui/login", 303);
  });

  const keyId = options.signerKey.key_id;
  /** A page in the shell; the sidebar is read fresh, with the same health as the main page's traffic lights. */
  const render = (session: Session, pageOptions: PageOptions): string =>
    page(
      pageOptions,
      shellFor(session.store, options.healthMonitor, options.now(), keyId, session.viewer.kind === "operator"),
    );

  /** Who is acting, for the administrative log: this view has one password, so an address is what there is. */
  const adminRequest = (request: FastifyRequest): AdminRequest => ({
    actor: `web ${request.ip}`,
    ts: options.now().toISOString(),
  });

  app.get("/ui", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const query = request.query as { checkpoint?: string };
    const justCheckpointed = query.checkpoint === "1";
    return html(
      reply,
      render(session, {
        title: UI.home.heading,
        current: "registro",
        body: (() => {
          const { records, rows, shown } = homeRows(store, options.healthMonitor, options.now());
          return homePage(store, records, rows, shown, justCheckpointed);
        })(),
      }),
    );
  });

  app.post("/ui/checkpoint", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    // The same checkpoint the timer runs, over every chain: sooner, not
    // different, and nothing of anyone's is shown by it.
    await options.checkpointer.runOnce();
    return reply.redirect("/ui?checkpoint=1", 303);
  });

  app.post("/ui/export", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const body = request.body as
      | { system_id?: unknown; from?: unknown; to?: unknown; subjects?: unknown; openings?: unknown }
      | undefined;
    const systemId = typeof body?.system_id === "string" ? body.system_id : "";
    if (!store.hasSystem(systemId)) {
      return reply.code(404).send({ error: `no system called ${systemId}` });
    }
    return sendArchive(store, reply, systemId, dayBounds(body?.from, body?.to), body);
  });

  const systemsView = (value: unknown): SystemsView =>
    value === "archiviati" || value === "tutti" ? value : "attivi";

  const renderSistemi = (session: Session, view: SystemsView, extra: { notice?: string; error?: string } = {}): string =>
    render(session, {
      title: UI.systemsPage.title,
      current: view === "attivi" ? "sistemi" : view,
      body: sistemiPage(session.store, view, extra),
    });

  app.get("/ui/sistemi", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const query = request.query as { vista?: string; eliminato?: string };
    // Said only for a deletion the administrative log actually holds: the
    // query string alone cannot make the page claim one.
    const deleted =
      typeof query.eliminato === "string" && !store.hasSystem(query.eliminato) && store.deletionOf(query.eliminato) !== null
        ? UI.systemsPage.deleted(query.eliminato)
        : undefined;
    return html(reply, renderSistemi(session, systemsView(query.vista), deleted === undefined ? {} : { notice: deleted }));
  });

  app.post("/ui/sistemi", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const body = request.body as { system_id?: unknown; display_name?: unknown } | undefined;
    const typed = typeof body?.system_id === "string" ? body.system_id.trim() : "";
    const displayName = typeof body?.display_name === "string" ? body.display_name : "";
    // An organization's systems are named `<organization_id>.<name>`: two
    // organizations never compete for an identifier, and no refusal ("already
    // exists") can tell one about another's systems.
    const prefix = session.viewer.kind === "organization" ? `${session.viewer.organizationId}.` : "";
    const name = prefix !== "" && typed.startsWith(prefix) ? typed.slice(prefix.length) : typed;
    const systemId = name === "" ? "" : `${prefix}${name}`;

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
        render(session, {
          title: UI.systemsPage.title,
          current: "sistemi",
          body: systemCreatedPage(record, systemId, issued.token),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return html(reply, renderSistemi(session, "attivi", { error: message }), 400);
    }
  });

  app.get("/ui/verify-document", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;

    const query = request.query as Record<string, unknown>;
    const fingerprints = fingerprintsFromQuery(query);
    const from = query["from"] === "file" || query["from"] === "text" ? query["from"] : undefined;

    const body = `${pageHead({ eyebrow: UI.verifyDocument.eyebrow, h1: UI.verifyDocument.heading })}
<p class="pill-note">${ICONS.lock}${escape(UI.verifyDocument.privacyNote)}</p>
<div class="split even verify">
${verifyDocumentForm()}
${fingerprints === null ? "" : verifyDocumentResult(store, fingerprints, from, store.findDocument(fingerprints))}
</div>`;
    return html(
      reply,
      render(session, {
        title: UI.verifyDocument.title,
        current: "verifica",
        body,
      }),
    );
  });

  const notFound = (session: Session, reply: FastifyReply, systemId: string): FastifyReply =>
    html(
      reply,
      render(session, { title: UI.notFound.title, body: notFoundPage(systemId) }),
      404,
    );

  /** A page about one system that is not its history: header and tabs, the page, the evidence sheet. */
  const systemPage = (session: Session, record: SystemRecord, tab: SystemTab, title: string, body: string): string =>
    render(session, {
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
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;

    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(session, reply, systemId);

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
      render(session, {
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
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;

    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(session, reply, systemId);
    return html(
      reply,
      systemPage(session, record, "checkpoints", `${systemTitle(record)} — ${UI.checkpoints.title}`, checkpointsPage(store, systemId)),
    );
  });

  // Managing one system: its label, whether it is archived, and — for a
  // chain that never recorded anything — deleting it.

  const renderManage = (session: Session, record: SystemRecord, extra: { notice?: string; error?: string } = {}): string =>
    systemPage(session, record, "manage", `${systemTitle(record)} — ${UI.systemsPage.manage}`, managePage(record, extra));

  const DONE: Record<string, string> = {
    nome: UI.manage.renamed,
    archiviato: UI.manage.archived,
    riattivato: UI.manage.unarchived,
  };

  app.get("/ui/systems/:systemId/manage", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(session, reply, systemId);
    const done = (request.query as { fatto?: string }).fatto;
    const notice = done === undefined ? undefined : DONE[done];
    return html(reply, renderManage(session, record, notice === undefined ? {} : { notice }));
  });

  const manageUrl = (systemId: string, done: string): string =>
    `/ui/systems/${encodeURIComponent(systemId)}/manage?fatto=${done}`;

  app.post("/ui/systems/:systemId/rename", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(session, reply, systemId);
    const body = request.body as { display_name?: unknown } | undefined;
    const displayName = typeof body?.display_name === "string" ? body.display_name : "";
    try {
      await store.renameSystem(systemId, displayName, adminRequest(request));
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      return html(reply, renderManage(session, record, { error: error.message }), 400);
    }
    return reply.redirect(manageUrl(systemId, "nome"), 303);
  });

  app.post("/ui/systems/:systemId/archive", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) return notFound(session, reply, systemId);
    await store.archiveSystem(systemId, adminRequest(request));
    return reply.redirect(manageUrl(systemId, "archiviato"), 303);
  });

  app.post("/ui/systems/:systemId/unarchive", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) return notFound(session, reply, systemId);
    await store.unarchiveSystem(systemId, adminRequest(request));
    return reply.redirect(manageUrl(systemId, "riattivato"), 303);
  });

  app.post("/ui/systems/:systemId/delete", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(session, reply, systemId);

    // The exact system_id, typed out: not a "sei sicuro?" a thumb can tap.
    const body = request.body as { confirm?: unknown } | undefined;
    if (body?.confirm !== systemId) {
      return html(reply, renderManage(session, record, { error: UI.manage.confirmMismatch }), 400);
    }

    try {
      // Whether the chain is empty is decided here, inside the store's own
      // transaction, from what the database holds now — not from the page
      // the button was on, which may be minutes old.
      await store.deleteEmptySystem(systemId, adminRequest(request));
    } catch (error) {
      if (!(error instanceof SystemNotDeletableError)) throw error;
      const now = store.systemRecord(systemId) ?? record;
      return html(reply, renderManage(session, now, { error: UI.manage.deleteRefused(error.receipts) }), 409);
    }
    options.healthMonitor.forget(systemId);
    request.log.info({ system: systemId, action: "system.delete" }, "an empty system was deleted");
    return reply.redirect(`/ui/sistemi?eliminato=${encodeURIComponent(systemId)}`, 303);
  });

  // People: who the pseudonym tokens stand for. The identifier is posted,
  // never put in an address, so it stays out of the browser's history and of
  // any log that keeps addresses.

  const renderPeople = (
    session: Session,
    search: { identifier: string; token: string | null } | null,
    extra: { notice?: string; error?: string } = {},
  ): string =>
    render(session, {
      title: UI.people.title,
      current: "persone",
      body: peoplePage(session.store, search, extra),
    });

  app.get("/ui/persone", async (request, reply) => {
    const session = requireOperator(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const erased = (request.query as { cancellato?: string }).cancellato;
    // Said only for an erasure the administrative log actually holds.
    const done =
      typeof erased === "string" &&
      store.adminLog(10_000).some((entry) => entry.action === "subject.erase" && entry.detail["token"] === erased);
    return html(reply, renderPeople(session, null, done ? { notice: UI.people.erased(erased) } : {}));
  });

  app.post("/ui/persone", async (request, reply) => {
    const session = requireOperator(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const body = request.body as { identifier?: unknown } | undefined;
    const identifier = typeof body?.identifier === "string" ? body.identifier : "";
    return html(reply, renderPeople(session, { identifier, token: store.subjectToken(identifier) }));
  });

  app.post("/ui/persone/cancella", async (request, reply) => {
    const session = requireOperator(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const body = request.body as { token?: unknown; confirm?: unknown } | undefined;
    const token = typeof body?.token === "string" ? body.token : "";
    // The exact token, typed out: not a "sei sicuro?" a thumb can tap.
    if (body?.confirm !== token || token === "") {
      return html(reply, renderPeople(session, null, { error: UI.people.confirmMismatch }), 400);
    }
    if (!(await store.eraseSubject(token, adminRequest(request)))) {
      return html(reply, renderPeople(session, null, { error: UI.people.notFound }), 404);
    }
    request.log.info({ action: "subject.erase", token }, "a subject was erased");
    return reply.redirect(`/ui/persone?cancellato=${encodeURIComponent(token)}`, 303);
  });

  async function sendArchive(
    store: ReceiptStore,
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
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;

    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) {
      return reply.code(404).send({ error: `no system called ${systemId}` });
    }
    // The sheet on the system's pages sends a period too; a form without one
    // exports the whole chain, as this route always did.
    const body = request.body as { from?: unknown; to?: unknown; subjects?: unknown; openings?: unknown } | undefined;
    return sendArchive(store, reply, systemId, dayBounds(body?.from, body?.to), body);
  });
}

/** An HTML date input gives YYYY-MM-DD; this makes it an inclusive whole-day bound. */
function dayBounds(from: unknown, to: unknown): { from?: string; to?: string } {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const start = typeof from === "string" && DATE.test(from) ? `${from}T00:00:00.000Z` : undefined;
  const end = typeof to === "string" && DATE.test(to) ? `${to}T23:59:59.999Z` : undefined;
  return { ...(start === undefined ? {} : { from: start }), ...(end === undefined ? {} : { to: end }) };
}
