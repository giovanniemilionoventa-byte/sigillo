import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { DOCUMENT_TEXT_SOURCE, type DocumentFingerprints } from "@sigillo/core";
import type { ApiKeyStore } from "../auth/api-keys.js";
import type { FirebaseAuth } from "../auth/firebase.js";
import { UiSessions } from "../auth/sessions.js";
import { OPERATOR, storeFor, type Viewer } from "../auth/tenancy.js";
import { AttemptThrottle, type ThrottleSettings } from "../auth/throttle.js";
import type { Checkpointer } from "../checkpoint/checkpointer.js";
import { archiveFromStore, positionsIn, tokensIn } from "../export/from-store.js";
import type { ChainHealthMonitor } from "../health/chain-health.js";
import { AGENT_SETUP_SCRIPT } from "./agent-setup.js";
import {
  normaliseDisplayName,
  StorageError,
  SystemNotDeletableError,
  type AdminRequest,
  type ReceiptStore,
  type SystemRecord,
} from "../storage/store.js";
import { registerAccounts } from "./accounts.js";
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
import {
  escape,
  homeRows,
  loginPage,
  operatorLoginPage,
  page,
  pageHead,
  shellFor,
  type Account,
  type PageOptions,
} from "./layout.js";
import {
  adminLogPage,
  checkpointsPage,
  connectPage,
  homePage,
  managePage,
  newSystemPage,
  notFoundPage,
  organizationsPage,
  settingsPage,
  sistemiPage,
  verifyDocumentResult,
  type Quota,
  type SystemsView,
  type Theme,
} from "./pages.js";
import { currentLanguage, isLanguage, LANGUAGE_COOKIE, languageFor, withLanguage, type Language } from "./locale.js";
import { systemTitle, UI } from "./strings.js";
import { dailyExportPath, isDailyExportOn, listDailyExports, setDailyExport, type StoredExport } from "../backup/daily-export.js";
import { ICONS, STATE_ICONS } from "./style.js";
import { registerFavicon, registerSite, SITE_CONTACT_EMAIL, SITE_PATHS } from "./site.js";

/**
 * The web view: server-rendered HTML, no framework and no build step, except
 * the one inline script on the "verifica un documento" page.
 *
 * It answers three questions, in order — è tutto a posto? cosa ha fatto
 * l'AI? mi prepari le prove? — plus the secondary pages: the systems, with
 * creating one (and its key) and managing one (its name, a new key, archiving
 * it, deleting it while its chain is still empty), connecting an agent,
 * checking a document by fingerprint, and the settings. It never writes a
 * receipt; besides systems, keys and labels, its only writes are running, on
 * request, the same checkpoint the server already does on a timer — sooner,
 * not instead — and remembering the reader's light or dark theme in a cookie.
 * The look is in style.ts.
 */

const COOKIE = "sigillo_session";
/** The theme the reader chose in Impostazioni: "light", "dark" or "system"; absent, light. Not a secret, not a session. */
const THEME_COOKIE = "sigillo_theme";
const THEME_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

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
  /**
   * Customers' accounts (auth/firebase.ts, http/accounts.ts): Google and
   * email sign-in, sign-up, and the organizations they ask for. Without it
   * the view has the operator's password and nothing else.
   */
  /**
   * How many receipts an organization's systems together may receive in a
   * calendar month (server.ts, organizationMonthlyReceipts): shown to its
   * members in Impostazioni and, near and at the limit, on the main page.
   */
  organizationMonthlyReceipts?: number;
  /**
   * The directory backup.sh writes to, shared with the daily export
   * (backup/daily-export.ts). Given, Impostazioni lets every account turn the
   * daily export on or off and download its files.
   */
  backupDirectory?: string;
  /**
   * Who sees "upload your agent" on the connect page (agent-setup.ts):
   * `operator`, the administrator's own systems only, until the owner opens
   * it to `all`. Not given: nobody.
   */
  agentUpload?: "off" | "operator" | "all";
  accounts?: {
    firebase: FirebaseAuth;
    /** This installation's address as browsers reach it, e.g. https://sigillo.example.com. */
    publicUrl: string;
    /** Accounts created and reset links asked for, per client address. Default: 5 in 15 minutes. */
    requestLimits?: ThrottleSettings;
  };
}

/** Sign-ups and password resets per client address: each one sends an email. */
export const DEFAULT_REQUEST_LIMITS: ThrottleSettings = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockoutMs: 15 * 60_000,
  maxLockoutMs: 60 * 60_000,
};

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
  return `<section aria-label="${escape(t.documentLabel)}">
<p class="notice warn" id="sigillo-doc-inactive">${escape(t.scriptInactive)}</p>
<label class="drop"><span class="tile-icon blue" aria-hidden="true">${ICONS.upload}</span><strong>${escape(t.dropTitle)}</strong><span class="muted">${escape(t.dropHint)}</span><input type="file" id="sigillo-doc-file"></label>
<label><span class="or">${escape(t.textLabel)}</span><textarea id="sigillo-doc-text" rows="6" cols="60"></textarea></label>
<button type="button" id="sigillo-doc-button" class="big" disabled>${escape(t.submit)}</button>
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

/** An identifier made from a name, for a system created with a name alone: "Assistente vendite" is "assistente-vendite". */
export function identifierFrom(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** The first instant of the calendar month (UTC) `at` falls in, and of the next one: a quota's month. */
function monthBounds(at: Date): { start: string; next: string } {
  return {
    start: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString(),
    next: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString(),
  };
}


export function registerUi(app: FastifyInstance, options: UiOptions): void {
  // Every system, every organization's. Never handed to a page as it is: a
  // page gets storeFor(this, the viewer), which for the operator too is only
  // the operator's own systems. Read whole only for the customers' names,
  // approval and quota counts (accountOf, quotaOf, the Clienti page).
  const allSystems = options.store;
  const { keys } = options;
  const sessions = options.sessions ?? new UiSessions();
  const loginThrottle = new AttemptThrottle(options.loginLimits ?? DEFAULT_LOGIN_LIMITS);
  const cookieSecure = options.cookieSecure ?? "auto";

  const cookieNamed = (request: FastifyRequest, cookieName: string): string | undefined => {
    const header = request.headers.cookie;
    if (typeof header !== "string") return undefined;
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === cookieName) return rest.join("=");
    }
    return undefined;
  };
  const cookieFrom = (request: FastifyRequest): string | undefined => cookieNamed(request, COOKIE);

  const cookieAttributes = (request: FastifyRequest): string => {
    const secure = cookieSecure === "auto" ? request.protocol === "https" : cookieSecure;
    return `HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`;
  };

  /** The reader's language: the one chosen on a sign-in page or in Impostazioni, else the browser's (locale.ts). */
  const languageOf = (request: FastifyRequest): Language => {
    const acceptLanguage = request.headers["accept-language"];
    return languageFor(
      cookieNamed(request, LANGUAGE_COOKIE),
      typeof acceptLanguage === "string" ? acceptLanguage : undefined,
      currentLanguage(),
    );
  };

  // Every page of the view is written in its reader's language: each route's
  // handler runs inside withLanguage, which strings.ts reads. The language
  // switch of a sign-in page returns to the page it is on when that page was
  // asked for plainly, and to the sign-in page after a form.
  app.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/ui")) return;
    const handler = route.handler;
    route.handler = function (this: FastifyInstance, request, reply) {
      const back = request.method === "GET" && isUi(request) ? request.url : "/ui/login";
      return withLanguage(languageOf(request), back, () => handler.call(this, request, reply));
    };
  });

  /** The theme the reader chose, from its cookie; until they choose, light, whatever their system prefers. */
  const themeOf = (request: FastifyRequest): Theme => {
    const value = cookieNamed(request, THEME_COOKIE);
    return value === "dark" || value === "system" ? value : "light";
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
    if (organization === null || organization.approved_at === null) return null;
    // A member must still be one: someone moved or removed is out at once.
    if (viewer.userId !== undefined && allSystems.userByUid(viewer.userId)?.organization_id !== viewer.organizationId) {
      return null;
    }
    return viewer;
  };

  /**
   * The operator's session, or null after answering. The people pages work on
   * the subjects table, which every system shares: one person has one token
   * whichever organization's agent acted for them. Until pseudonyms are kept
   * per organization, those pages are the operator's alone, and to anyone
   * else they do not exist; and even there they reach only the operator's own
   * systems (tenancy.ts).
   */
  const requireOperator = (request: FastifyRequest, reply: FastifyReply): Session | null => {
    const session = requireSession(request, reply);
    if (session === null) return null;
    if (session.viewer.kind === "operator") return session;
    reply.callNotFound();
    return null;
  };

  /** A fresh session cookie for `viewer`, as a Set-Cookie value. */
  const sessionCookie = (request: FastifyRequest, viewer: Viewer): string => {
    const session = sessions.issue(viewer, options.now().getTime());
    return `${COOKIE}=${session.value}; ${cookieAttributes(request)}; Max-Age=${session.maxAgeSeconds}`;
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
  // shows an API key the only time it exists. And every page of the view
  // carries the theme its reader chose, on <html>, where the stylesheet
  // looks for it (style.ts): one place, rather than in every page's code.
  app.addHook("onSend", async (request, reply, payload) => {
    if (!isUi(request)) return payload;
    void reply.header("cache-control", "no-store");
    const theme = themeOf(request);
    if (theme === "system" || typeof payload !== "string") return payload;
    if (!String(reply.getHeader("content-type") ?? "").startsWith("text/html")) return payload;
    return payload.replace(/^(<!doctype html>\n<html lang="[a-z]+")>/, `$1 data-theme="${theme}">`);
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
  // Now that the policy lets images from this origin through, every browser
  // asks for /favicon.ico on every page: it gets the seal, not a 404.
  registerFavicon(app);

  // Where customers sign in, the root of the domain is the public site
  // (site.ts); an installation run by its operator alone goes straight to the
  // console, as it always has.
  if (options.accounts === undefined) {
    app.get("/", async (_request, reply) => reply.redirect("/ui", 302));
  } else {
    registerSite(app, {
      languageOf,
      themeOf,
      endpoint: options.accounts.publicUrl.replace(/\/+$/, ""),
      ...(SITE_CONTACT_EMAIL === undefined ? {} : { contactEmail: SITE_CONTACT_EMAIL }),
    });
  }

  // Signing in. With customers' accounts, /ui/login is theirs (Google, or an
  // email and then its password) and the operator's password has its own
  // address, /ui/admin; without them, /ui/login is the operator's password.

  const operatorLogin = (message?: string): string =>
    operatorLoginPage(message, options.accounts === undefined ? UI.login.title : UI.login.adminTitle);

  app.get("/ui/login", async (request, reply) => {
    if (viewerOf(request) !== null) return reply.redirect("/ui", 302);
    return html(reply, options.accounts === undefined ? operatorLogin() : loginPage());
  });

  app.get("/ui/admin", async (request, reply) => {
    if (viewerOf(request) !== null) return reply.redirect("/ui", 302);
    return html(reply, operatorLogin());
  });

  app.post("/ui/login", async (request, reply) => {
    const client = request.ip;
    const now = options.now().getTime();

    // A locked-out client gets the very answer a wrong password gets, and its
    // password is not even looked at: from outside, a lockout cannot be told
    // apart from a guess that was wrong, and no guess made during one can be
    // learned to be right.
    if (loginThrottle.isLocked(client, now)) {
      return html(reply, operatorLogin(UI.login.wrong), 401);
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
      return html(reply, operatorLogin(UI.login.wrong), 401);
    }

    loginThrottle.recordSuccess(client);
    return reply.header("set-cookie", sessionCookie(request, OPERATOR)).redirect("/ui", 302);
  });

  if (options.accounts !== undefined) {
    registerAccounts(app, {
      store: allSystems,
      firebase: options.accounts.firebase,
      sessions,
      publicUrl: options.accounts.publicUrl.replace(/\/+$/, ""),
      now: options.now,
      loginThrottle,
      requestThrottle: new AttemptThrottle(options.accounts.requestLimits ?? DEFAULT_REQUEST_LIMITS),
      html,
      cookieAttributes,
      sessionCookie,
    });
  }

  app.post("/ui/logout", async (request, reply) => {
    const viewer = viewerOf(request);
    if (viewer !== null) sessions.endAll(viewer);
    return reply
      .header("set-cookie", `${COOKIE}=; ${cookieAttributes(request)}; Max-Age=0`)
      .redirect("/ui/login", 303);
  });

  const keyId = options.signerKey.key_id;

  /** Who is signed in, as the sidebar and the settings name them. */
  const accountOf = (viewer: Viewer): Account => {
    if (viewer.kind === "operator") return { name: UI.settings.operator, detail: UI.settings.operatorDetail };
    const organization = allSystems.organization(viewer.organizationId);
    const member = viewer.userId === undefined ? null : allSystems.userByUid(viewer.userId);
    return { name: organization?.name ?? viewer.organizationId, detail: member?.email ?? "" };
  };

  /** A page in the shell; the sidebar is read fresh, with the same health as the main page's traffic lights. */
  const render = (session: Session, pageOptions: PageOptions): string => {
    const operator = session.viewer.kind === "operator";
    return page(
      pageOptions,
      shellFor(session.store, options.healthMonitor, options.now(), {
        operator,
        account: accountOf(session.viewer),
        waiting: operator ? allSystems.listOrganizations().filter((organization) => organization.approved_at === null).length : 0,
      }),
    );
  };

  /** An organization's use of its monthly quota; null for the operator, whose systems have none. */
  const quotaOf = (viewer: Viewer): Quota | null => {
    const limit = options.organizationMonthlyReceipts;
    if (viewer.kind !== "organization" || limit === undefined) return null;
    const month = monthBounds(options.now());
    return { used: allSystems.receiptsSince(viewer.organizationId, month.start), limit, resume: month.next };
  };

  /**
   * Whether the connect page offers "upload your agent" (agent-setup.ts): to
   * the operator's own systems, and to every account's once it is opened.
   */
  const offersUpload = (record: SystemRecord): boolean =>
    options.agentUpload === "all" || (options.agentUpload === "operator" && record.organization_id === null);

  // The script of "upload your agent": the same for everyone, and nothing in
  // it is secret, so it is served without a session.
  app.get("/ui/agent-setup.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").header("cache-control", "no-cache").send(AGENT_SETUP_SCRIPT),
  );

  /** Where agents send their actions, as the snippets of the connect page write it. */
  const endpointFor = (request: FastifyRequest): string =>
    options.accounts?.publicUrl.replace(/\/+$/, "") ?? `${request.protocol}://${request.headers.host ?? "localhost"}`;

  /**
   * Who is acting, for the administrative log: the operator by address (one
   * password, so an address is what there is), a member by account.
   */
  const adminRequest = (request: FastifyRequest, viewer: Viewer = OPERATOR): AdminRequest => {
    const member = viewer.kind === "organization" && viewer.userId !== undefined ? allSystems.userByUid(viewer.userId) : null;
    return {
      actor: member === null ? `web ${request.ip}` : `web ${member.email} (${viewer.kind === "organization" ? viewer.organizationId : ""})`,
      ts: options.now().toISOString(),
    };
  };

  app.get("/ui", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const query = request.query as { checkpoint?: string };
    const now = options.now();
    const { records, shown } = homeRows(store, options.healthMonitor, now);
    return html(
      reply,
      render(session, {
        title: UI.home.heading,
        current: "registro",
        body: homePage({ store, records, shown, justCheckpointed: query.checkpoint === "1", quota: quotaOf(session.viewer), now }),
      }),
    );
  });

  app.post("/ui/checkpoint", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    // The same checkpoint the timer runs, over every chain: sooner, not
    // different, and nothing of anyone's is shown by it. Never two at once,
    // and at most one every few seconds, however many accounts press it
    // (Checkpointer.requestRun).
    await options.checkpointer.requestRun();
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
      current: "sistemi",
      body: sistemiPage(
        session.store,
        view,
        extra,
        (systemId) => options.healthMonitor.statusFor(systemId, options.now()).status,
        options.now(),
      ),
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

  const renderNewSystem = (session: Session, extra: { error?: string } = {}, values: { system_id?: string; display_name?: string } = {}): string =>
    render(session, { title: UI.systemsPage.newTitle, current: "sistemi", body: newSystemPage(extra, values) });

  app.get("/ui/sistemi/nuovo", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    return html(reply, renderNewSystem(session));
  });

  app.post("/ui/sistemi", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const body = request.body as { system_id?: unknown; display_name?: unknown } | undefined;
    const displayName = typeof body?.display_name === "string" ? body.display_name : "";
    const given = typeof body?.system_id === "string" ? body.system_id.trim() : "";
    // A name alone is enough: the identifier follows from it.
    const typed = given === "" ? identifierFrom(displayName) : given;
    // An organization's systems are named `<organization_id>.<name>`: two
    // organizations never compete for an identifier, and no refusal ("already
    // exists") can tell one about another's systems.
    const prefix = session.viewer.kind === "organization" ? `${session.viewer.organizationId}.` : "";
    const name = prefix !== "" && typed.startsWith(prefix) ? typed.slice(prefix.length) : typed;
    const systemId = name === "" ? "" : `${prefix}${name}`;
    const refuse = (error: string): FastifyReply =>
      html(reply, renderNewSystem(session, { error }, { system_id: given, display_name: displayName }), 400);
    if (systemId === "") return refuse(UI.systemsPage.nameRequired);
    // The operator's systems have no prefix, and never take a customer's: an
    // identifier under an organization's name is refused whether or not that
    // system exists, so the refusal says nothing about a customer's systems.
    const under = systemId.split(".")[0] ?? "";
    if (prefix === "" && systemId.includes(".") && allSystems.organization(under) !== null) {
      return refuse(UI.systemsPage.exists);
    }

    try {
      // Checked before the chain is opened: a genesis cannot be taken back
      // because its label turned out to be too long.
      normaliseDisplayName(displayName);
      await store.createSystem(systemId, options.now().toISOString());
      if (displayName.trim().length > 0) {
        await store.renameSystem(systemId, displayName, adminRequest(request, session.viewer));
      }
      // On the write queue: see ReceiptStore.exclusive.
      const issued = await store.exclusive(() => keys.issue(systemId, options.now().toISOString()));
      const record = store.systemRecord(systemId);
      if (record === null) throw new StorageError(`unknown system ${systemId}`);
      return html(
        reply,
        render(session, {
          title: UI.connect.ready(systemTitle(record)),
          current: `system:${systemId}`,
          body: connectPage({ record, endpoint: endpointFor(request), token: issued.token, mode: "created", firstReceipt: null, now: options.now(), upload: offersUpload(record) }),
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return refuse(/already exists/.test(message) ? UI.systemsPage.exists : message);
    }
  });

  app.get("/ui/verify-document", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;

    const query = request.query as Record<string, unknown>;
    const fingerprints = fingerprintsFromQuery(query);
    const from = query["from"] === "file" || query["from"] === "text" ? query["from"] : undefined;

    const body = `${pageHead(UI.verifyDocument.heading)}
<div class="cols even">
${verifyDocumentForm()}
${verifyDocumentResult(store, fingerprints, from, fingerprints === null ? [] : store.findDocument(fingerprints), options.now())}
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

  const notFound = (session: Session, reply: FastifyReply): FastifyReply =>
    html(reply, render(session, { title: UI.notFound.title, body: notFoundPage() }), 404);

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
    if (record === null) return notFound(session, reply);

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
          now: options.now(),
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
    if (record === null) return notFound(session, reply);
    return html(
      reply,
      systemPage(
        session,
        record,
        "checkpoints",
        `${systemTitle(record)} — ${UI.checkpoints.title}`,
        checkpointsPage(store, systemId, options.now()),
      ),
    );
  });

  // Connecting an agent, after the key was shown: the same three ways, and
  // whether the first action has arrived.
  app.get("/ui/systems/:systemId/collega", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(session, reply);
    const firstReceipt = record.receipts > 1 ? store.receiptAt(systemId, 1) : null;
    return html(
      reply,
      render(session, {
        title: UI.connect.title(systemTitle(record)),
        current: `system:${systemId}`,
        body: connectPage({ record, endpoint: endpointFor(request), token: null, mode: "connect", firstReceipt, now: options.now() }),
      }),
    );
  });

  // Managing one system: its label, its key, whether it is archived, and —
  // for a chain that never recorded anything — deleting it.

  const activeKeys = (systemId: string): string[] =>
    keys
      .list(systemId)
      .filter((key) => key.revokedAt === null)
      .map((key) => key.keyId);

  const renderManage = (
    session: Session,
    record: SystemRecord,
    extra: { notice?: string; error?: string } = {},
  ): string => {
    return systemPage(
      session,
      record,
      "manage",
      `${systemTitle(record)} — ${UI.settings.title}`,
      managePage(record, extra, activeKeys(record.system_id)),
    );
  };

  // Keys into UI.manage, read when a page is written, in its reader's language.
  const DONE: Record<string, "renamed" | "archived" | "unarchived"> = {
    nome: "renamed",
    archiviato: "archived",
    riattivato: "unarchived",
  };

  app.get("/ui/systems/:systemId/manage", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(session, reply);
    const done = (request.query as { fatto?: string }).fatto;
    const key = done !== undefined && Object.hasOwn(DONE, done) ? DONE[done] : undefined;
    const notice = key === undefined ? undefined : UI.manage[key];
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
    if (record === null) return notFound(session, reply);
    const body = request.body as { display_name?: unknown } | undefined;
    const displayName = typeof body?.display_name === "string" ? body.display_name : "";
    try {
      await store.renameSystem(systemId, displayName, adminRequest(request, session.viewer));
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      return html(reply, renderManage(session, record, { error: error.message }), 400);
    }
    return reply.redirect(manageUrl(systemId, "nome"), 303);
  });

  // A new key: every key the system had stops working at once, and the new
  // one is shown this once, with the ways to use it.
  app.post("/ui/systems/:systemId/key", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(session, reply);
    const at = options.now().toISOString();
    // On the write queue: see ReceiptStore.exclusive.
    const issued = await store.exclusive(() => {
      for (const old of activeKeys(systemId)) keys.revoke(old, at);
      return keys.issue(systemId, at);
    });
    request.log.info({ system: systemId, action: "key.rotate", key: issued.keyId }, "a system was given a new key");
    return html(
      reply,
      render(session, {
        title: UI.connect.newKey(systemTitle(record)),
        current: `system:${systemId}`,
        body: connectPage({ record, endpoint: endpointFor(request), token: issued.token, mode: "newKey", firstReceipt: null, now: options.now(), upload: offersUpload(record) }),
      }),
    );
  });

  app.post("/ui/systems/:systemId/archive", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) return notFound(session, reply);
    await store.archiveSystem(systemId, adminRequest(request, session.viewer));
    return reply.redirect(manageUrl(systemId, "archiviato"), 303);
  });

  app.post("/ui/systems/:systemId/unarchive", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    if (!store.hasSystem(systemId)) return notFound(session, reply);
    await store.unarchiveSystem(systemId, adminRequest(request, session.viewer));
    return reply.redirect(manageUrl(systemId, "riattivato"), 303);
  });

  app.post("/ui/systems/:systemId/delete", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store } = session;
    const { systemId } = request.params as { systemId: string };
    const record = store.systemRecord(systemId);
    if (record === null) return notFound(session, reply);

    // The exact system_id, typed out: not a "sei sicuro?" a thumb can tap.
    const body = request.body as { confirm?: unknown } | undefined;
    if (body?.confirm !== systemId) {
      return html(reply, renderManage(session, record, { error: UI.manage.confirmMismatch }), 400);
    }

    try {
      // Whether the chain is empty is decided here, inside the store's own
      // transaction, from what the database holds now — not from the page
      // the button was on, which may be minutes old.
      await store.deleteEmptySystem(systemId, adminRequest(request, session.viewer));
    } catch (error) {
      if (!(error instanceof SystemNotDeletableError)) throw error;
      const now = store.systemRecord(systemId) ?? record;
      return html(reply, renderManage(session, now, { error: UI.manage.deleteRefused(error.receipts) }), 409);
    }
    options.healthMonitor.forget(systemId);
    request.log.info({ system: systemId, action: "system.delete" }, "an empty system was deleted");
    return reply.redirect(`/ui/sistemi?eliminato=${encodeURIComponent(systemId)}`, 303);
  });

  // The settings: who is signed in, the organization's quota, the theme, the
  // administrative log and the signing key.

  app.get("/ui/impostazioni", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const { store, viewer } = session;
    const organization =
      viewer.kind === "organization"
        ? {
            name: allSystems.organization(viewer.organizationId)?.name ?? viewer.organizationId,
            systems: store.listSystemRecords().length,
            used: allSystems.receiptsSince(viewer.organizationId, monthBounds(options.now()).start),
            limit: options.organizationMonthlyReceipts ?? null,
          }
        : null;
    return html(
      reply,
      render(session, {
        title: UI.settings.title,
        current: "impostazioni",
        body: settingsPage({
          account: accountOf(viewer),
          organization,
          theme: themeOf(request),
          log: store.adminLog(8),
          keyId,
          dailyExport: dailyExportView(session),
          now: options.now(),
          extra: {},
        }),
      }),
    );
  });

  /** Whose daily export this is: an organization's id, or the empty string for the operator. */
  const ownerOf = (viewer: Viewer): string => (viewer.kind === "organization" ? viewer.organizationId : "");

  function dailyExportView(session: Session): { on: boolean; files: StoredExport[]; names: Map<string, string> } | null {
    const directory = options.backupDirectory;
    if (directory === undefined) return null;
    const records = session.store.listSystemRecords();
    const owner = ownerOf(session.viewer);
    return {
      on: isDailyExportOn(directory, owner),
      files: listDailyExports(directory, owner, records.map((record) => record.system_id)),
      names: new Map(records.map((record) => [record.system_id.replaceAll(/[^A-Za-z0-9._-]/g, "_"), systemTitle(record)])),
    };
  }

  app.post("/ui/impostazioni/esportazione-giornaliera", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const directory = options.backupDirectory;
    if (directory === undefined) return reply.code(404).send();
    const body = request.body as { enabled?: unknown } | undefined;
    if (body?.enabled === "on" || body?.enabled === "off") {
      setDailyExport(directory, ownerOf(session.viewer), body.enabled === "on");
      request.log.info({ action: "daily-export.settings", enabled: body.enabled === "on" }, "daily export setting changed");
    }
    return reply.redirect("/ui/impostazioni", 303);
  });

  // A file of the account's own: the name must be one the export makes, and
  // the system it names one the account can see.
  app.get("/ui/impostazioni/esportazioni/:fileName", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const directory = options.backupDirectory;
    const { fileName } = request.params as { fileName: string };
    if (directory === undefined) return reply.code(404).send();
    const owner = ownerOf(session.viewer);
    const visible = listDailyExports(directory, owner, session.store.listSystemRecords().map((record) => record.system_id));
    const path = visible.some((file) => file.fileName === fileName) ? dailyExportPath(directory, owner, fileName) : null;
    if (path === null) return reply.code(404).send({ error: "no such file" });
    return reply
      .code(200)
      .type("application/zip")
      .header("content-disposition", `attachment; filename="sigillo-${fileName}"`)
      .send(readFileSync(path));
  });

  app.post("/ui/impostazioni/tema", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    const body = request.body as { theme?: unknown } | undefined;
    const theme = body?.theme === "light" || body?.theme === "dark" || body?.theme === "system" ? body.theme : null;
    const cookie =
      theme === null
        ? `${THEME_COOKIE}=; ${cookieAttributes(request)}; Max-Age=0`
        : `${THEME_COOKIE}=${theme}; ${cookieAttributes(request)}; Max-Age=${THEME_MAX_AGE_SECONDS}`;
    return reply.header("set-cookie", cookie).redirect("/ui/impostazioni", 303);
  });

  // The language, from a sign-in page, from Impostazioni or from the public
  // site: no session needed, since the sign-in pages have the switch too. The
  // way back is a page of the view or of the site, never somewhere else.
  app.post("/ui/lingua", async (request, reply) => {
    const body = request.body as { lang?: unknown; back?: unknown } | undefined;
    const back =
      typeof body?.back === "string" &&
      ((/^\/ui(?:[/?][^\\\s]*)?$/.test(body.back) && !body.back.includes("..")) || (SITE_PATHS as readonly string[]).includes(body.back))
        ? body.back
        : "/ui";
    if (!isLanguage(body?.lang)) return reply.redirect(back, 303);
    const cookie = `${LANGUAGE_COOKIE}=${body.lang}; ${cookieAttributes(request)}; Max-Age=${THEME_MAX_AGE_SECONDS}`;
    return reply.header("set-cookie", cookie).redirect(back, 303);
  });

  app.get("/ui/impostazioni/registro", async (request, reply) => {
    const session = requireSession(request, reply);
    if (session === null) return reply;
    return html(
      reply,
      render(session, {
        title: UI.settings.adminLog,
        current: "impostazioni",
        body: adminLogPage(session.store.adminLog(500), options.now()),
      }),
    );
  });

  // The customers: the operator's alone.

  app.get("/ui/clienti", async (request, reply) => {
    const session = requireOperator(request, reply);
    if (session === null) return reply;
    const approved = (request.query as { approvato?: string }).approvato;
    const organization = typeof approved === "string" ? allSystems.organization(approved) : null;
    const notice = organization?.approved_at === null || organization === null ? undefined : UI.organizations.approved(organization.name);
    return html(
      reply,
      render(session, {
        title: UI.organizations.title,
        current: "clienti",
        body: organizationsPage(allSystems, notice === undefined ? {} : { notice }),
      }),
    );
  });

  app.post("/ui/clienti/:organizationId/approva", async (request, reply) => {
    const session = requireOperator(request, reply);
    if (session === null) return reply;
    const { organizationId } = request.params as { organizationId: string };
    if (allSystems.organization(organizationId) === null) return reply.callNotFound();
    await allSystems.approveOrganization(organizationId, adminRequest(request, session.viewer));
    request.log.info({ action: "organization.approve", organization: organizationId }, "an organization was approved");
    return reply.redirect(`/ui/clienti?approvato=${encodeURIComponent(organizationId)}`, 303);
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

/**
 * An HTML date input gives YYYY-MM-DD; this makes it an inclusive whole-day
 * bound. A day that does not exist (2026-02-30, 9999-99-99, which a browser
 * without a date picker lets anyone type) is no bound, as an empty field is:
 * it used to reach the export as an impossible time and fail it with a 500.
 */
function dayBounds(from: unknown, to: unknown): { from?: string; to?: string } {
  const bound = (value: unknown, time: string): string | undefined => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
    const instant = `${value}T${time}Z`;
    const parsed = Date.parse(instant);
    return Number.isNaN(parsed) || new Date(parsed).toISOString() !== instant ? undefined : instant;
  };
  const start = bound(from, "00:00:00.000");
  const end = bound(to, "23:59:59.999");
  return { ...(start === undefined ? {} : { from: start }), ...(end === undefined ? {} : { to: end }) };
}
