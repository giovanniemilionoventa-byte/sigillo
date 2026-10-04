import type { Receipt } from "@sigillo/core";
import type { ChainHealthMonitor, ChainStatus, SystemHealth } from "../health/chain-health.js";
import type { ReceiptStore, SystemRecord } from "../storage/store.js";
import { currentBack, currentLanguage } from "./locale.js";
import { outcomeWord, systemTitle, UI } from "./strings.js";
import { GOOGLE_LOGO, ICONS, KIND_ICONS, SEAL_SVG, STATE_ICONS, STYLE } from "./style.js";

/**
 * What every page of the web view shares: the document around it, the
 * sidebar, the sign-in pages' frame, and the small pieces each page is built
 * from (a state, an outcome, the kind of an action). The pages themselves are
 * in pages.ts and history.ts; the routes in ui.ts.
 */

/** Everything that reaches HTML goes through here. */
export function escape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A path segment for a system_id, escaped for an attribute. */
export function systemPath(systemId: string): string {
  return `/ui/systems/${escape(encodeURIComponent(systemId))}`;
}

/** A word with its first letter in capitals: "bloccato" is "Bloccato" at the start of a pill. */
export function capital(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Which entry of the sidebar a page belongs to. */
export type NavCurrent =
  | "registro"
  | "sistemi"
  | "persone"
  | "clienti"
  | "verifica"
  | "impostazioni"
  | `system:${string}`;

/** A system as the sidebar and the main page show it: its record and its chain's health. */
export interface SystemRow {
  record: SystemRecord;
  health: SystemHealth;
}

/** Who is signed in, as the foot of the sidebar and the settings show it. */
export interface Account {
  /** The organization's name, or "Amministratore". */
  name: string;
  /** The member's email, or how the operator signs in. */
  detail: string;
}

/** What the sidebar needs, read once per page. */
export interface Shell {
  /** Whether the operator is looking: only then are the people and customers pages offered (ui.ts, requireOperator). */
  operator: boolean;
  /** The systems the main page shows, in the same order. */
  systems: SystemRow[];
  account: Account;
  /** Customers waiting for the operator's approval, beside "Clienti". */
  waiting: number;
}

/**
 * Why an archived system is on the main page after all, or null if it is
 * not. Archiving takes a system out of sight, never a problem with it: a
 * chain that fails verification, or that keeps receiving actions, is shown.
 */
export function archivedButShown(record: SystemRecord, status: ChainStatus): string | null {
  if (record.archived_at === null) return null;
  if (status === "red") return UI.home.archivedRed;
  if (record.last_received !== null && record.last_received > record.archived_at) return UI.home.archivedActive;
  return null;
}

/** The systems the main page and the sidebar show, with their state: archived ones only when archivedButShown says so. */
export function homeRows(store: ReceiptStore, healthMonitor: ChainHealthMonitor, now: Date) {
  const records = store.listSystemRecords();
  const rows: SystemRow[] = records.map((record) => ({ record, health: healthMonitor.statusFor(record.system_id, now) }));
  const shown = rows.filter(({ record, health }) => record.archived_at === null || archivedButShown(record, health.status) !== null);
  return { records, rows, shown };
}

export function shellFor(
  store: ReceiptStore,
  healthMonitor: ChainHealthMonitor,
  now: Date,
  viewer: { operator: boolean; account: Account; waiting: number },
): Shell {
  const { shown } = homeRows(store, healthMonitor, now);
  return { ...viewer, systems: shown };
}

/** The worst state among the systems shown: one red makes the page red. */
export function worstStatus(statuses: ChainStatus[]): ChainStatus {
  return statuses.includes("red") ? "red" : statuses.includes("yellow") ? "yellow" : "green";
}

export const STATE_ICON: Record<ChainStatus, string> = { green: STATE_ICONS.ok, yellow: STATE_ICONS.warn, red: STATE_ICONS.bad };

/** A chain's state as a pill: "Integro", "Da controllare", "Verifica fallita", each with an icon of its own shape. */
export function chainPill(status: ChainStatus): string {
  return `<span class="pill ${status}" data-chain="${status}">${STATE_ICON[status]}${escape(UI.chain[status])}</span>`;
}

/** An archived system, as a pill. */
export function archivedPill(): string {
  return `<span class="pill" data-chain="archived">${STATE_ICONS.archived}${escape(UI.systemsPage.archivedBadge)}</span>`;
}

/** A chain's state as a coloured dot, with its words for a screen reader: the sidebar's. */
export function stateLight(status: ChainStatus): string {
  return `<span class="light ${status}" aria-hidden="true"></span><span class="sr">${escape(UI.chain[status])}: </span>`;
}

export const OUTCOME_STATE: Record<Receipt["outcome"], { css: ChainStatus; icon: string }> = {
  ok: { css: "green", icon: STATE_ICONS.ok },
  error: { css: "red", icon: STATE_ICONS.bad },
  blocked: { css: "yellow", icon: STATE_ICONS.warn },
  unknown: { css: "yellow", icon: STATE_ICONS.warn },
};

/** An outcome as a pill: icon, word, the state's fill. */
export function outcomePill(outcome: Receipt["outcome"]): string {
  const state = OUTCOME_STATE[outcome];
  return `<span class="pill ${state.css}" data-outcome="${outcome}">${state.icon}${escape(capital(outcomeWord(outcome)))}</span>`;
}

/** The kind of an action as an icon in a rounded square; the word is said elsewhere. */
export function kindIcon(kind: Receipt["action"]["kind"], size: "" | "large" = ""): string {
  return `<span class="kind ${kind}${size === "" ? "" : ` ${size}`}" aria-hidden="true">${KIND_ICONS[kind]}</span>`;
}

/** A confirmation or an error at the top of a page. */
export function notices(extra: { notice?: string; error?: string }): string {
  return (
    (extra.notice === undefined
      ? ""
      : `<p class="notice ok" role="status">${STATE_ICONS.ok}<span>${escape(extra.notice)}</span></p>`) +
    (extra.error === undefined
      ? ""
      : `<p class="notice bad" role="alert">${STATE_ICONS.bad}<span>${escape(extra.error)}</span></p>`)
  );
}

/** The heading of an ordinary page: the title, and an action on the right. */
export function pageHead(h1: string, action = ""): string {
  return `<header class="page-head"><h1>${escape(h1)}</h1>${action === "" ? "" : `<div class="end">${action}</div>`}</header>`;
}

export interface PageOptions {
  /** The document title, before " — sigillo". */
  title: string;
  /** Which entry of the sidebar this page belongs to. */
  current?: NavCurrent;
  /** The class of <main>: "content" for an ordinary page. */
  mainClass?: string;
  body: string;
}

/**
 * The start of every document. The theme the reader chose, if any, is added to
 * <html> on the way out (ui.ts, the onSend hook), so no page has to carry it.
 */
function documentStart(title: string): string {
  return `<!doctype html>
<html lang="${currentLanguage()}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>`;
}

/** Up to two letters for an avatar: "Acme S.r.l." is "AS", "mario.rossi@acme.it" is "MR". */
export function initials(name: string): string {
  const words = name
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter((word) => /^\p{L}/u.test(word));
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

function sidebar(shell: Shell, current: NavCurrent | undefined): string {
  const here = (name: NavCurrent): string => (current === name ? ' aria-current="page"' : "");
  const item = (href: string, name: NavCurrent, glyph: string, label: string, count?: number): string =>
    `<a class="side-item" href="${href}"${here(name)}>${glyph}<span class="side-label">${escape(label)}</span>${
      count === undefined || count === 0 ? "" : `<span class="side-count">${count}</span>`
    }</a>`;

  const systems = shell.systems
    .map(
      ({ record, health }) =>
        `<li><a class="side-item" href="${systemPath(record.system_id)}"${here(`system:${record.system_id}`)}>${stateLight(health.status)}<span class="side-label">${escape(systemTitle(record))}</span><span class="side-count">${record.receipts}</span></a></li>`,
    )
    .join("");

  return `<div class="sidebar" id="menu"><div class="sidebar-inner">
<div class="side-top"><a class="brand" href="/ui">${SEAL_SVG}<span>sigillo</span></a><a class="menu-close" href="#main" aria-label="${escape(UI.nav.close)}">${ICONS.close}</a></div>
<nav class="side-nav" aria-label="${escape(UI.nav.label)}">
${item("/ui", "registro", ICONS.home, UI.nav.registro)}
<div class="side-head"><a href="/ui/sistemi">${escape(UI.nav.sistemi)}</a><a class="side-add" href="/ui/sistemi/nuovo" aria-label="${escape(UI.nav.newSystem)}">${ICONS.plus}</a></div>
${systems === "" ? "" : `<ul class="side-list">${systems}</ul>`}
${item("/ui/sistemi", "sistemi", ICONS.list, UI.nav.allSystems)}
<p class="side-head">${escape(UI.nav.tools)}</p>
${item("/ui/verify-document", "verifica", ICONS.docCheck, UI.nav.verificaDocumento)}
${shell.operator ? item("/ui/persone", "persone", ICONS.people, UI.nav.persone) : ""}
${shell.operator ? item("/ui/clienti", "clienti", ICONS.building, UI.nav.clienti, shell.waiting) : ""}
<div class="side-spacer"></div>
${item("/ui/impostazioni", "impostazioni", ICONS.gear, UI.nav.impostazioni)}
</nav>
<div class="account"><span class="avatar" aria-hidden="true">${escape(initials(shell.account.name))}</span><span class="who"><strong>${escape(shell.account.name)}</strong><span>${escape(shell.account.detail)}</span></span>
<form method="post" action="/ui/logout"><button type="submit" class="icon-button" aria-label="${escape(UI.nav.esci)}" title="${escape(UI.nav.esci)}">${ICONS.logout}</button></form></div>
</div></div>`;
}

/** A page of the view, inside the shell: top bar (phone), sidebar, content. */
export function page(options: PageOptions, shell: Shell): string {
  return `${documentStart(`${options.title} — sigillo`)}<body>
<a class="skip" href="#main">${escape(UI.brand.skip)}</a>
<div class="app">
<header class="topbar"><a class="brand" href="/ui">${SEAL_SVG}<span>sigillo</span></a><a class="menu-open" href="#menu" aria-label="${escape(UI.nav.menu)}">${ICONS.menu}</a></header>
${sidebar(shell, options.current)}
<main id="main" class="${options.mainClass ?? "content"}">
${options.body}
</main>
</div>
</body></html>`;
}

/** A message on a sign-in page: an error is announced, a notice is not. */
function authMessage(extra: { notice?: string; error?: string }): string {
  if (extra.error !== undefined) {
    return `<p class="field-error" id="login-error" role="alert">${STATE_ICONS.bad}<span>${escape(extra.error)}</span></p>`;
  }
  return extra.notice === undefined ? "" : `<p class="message" role="status">${escape(extra.notice)}</p>`;
}

/** A field with its label for a screen reader and its placeholder for the eye. */
export function authField(
  label: string,
  attributes: string,
  options: { placeholder?: string; failed?: boolean } = {},
): string {
  return `<label><span class="sr">${escape(label)}</span><input ${attributes} placeholder="${escape(options.placeholder ?? label)}"${
    options.failed === true ? ' aria-invalid="true" aria-describedby="login-error"' : ""
  }></label>`;
}

/**
 * The frame of every sign-in page: one column in the middle, the seal (or
 * an icon that says what the page is about), a title, and what the page
 * holds. Nothing beside it.
 */
export function authPage(
  title: string,
  body: string,
  options: { icon?: "mail" | "clock"; message?: string; head?: string } = {},
): string {
  const icon =
    options.icon === "mail"
      ? `<div class="tile-icon blue" aria-hidden="true">${ICONS.mail}</div>`
      : options.icon === "clock"
        ? `<div class="tile-icon yellow" aria-hidden="true">${ICONS.clock}</div>`
        : SEAL_SVG;
  return `${documentStart(`${title} — sigillo`)}<body>
<main class="auth" id="main"><div class="auth-box">
${icon}
<h1>${escape(title)}</h1>
${options.message === undefined ? "" : `<p class="message">${escape(options.message)}</p>`}
${options.head ?? ""}${body}
${languageSwitch("auth-lang", currentBack())}
</div></main>
</body></html>`;
}

/**
 * The two languages as a form of two buttons, the reader's own pressed: it
 * sets the language cookie (ui.ts, /ui/lingua) and returns to `back`. Each
 * language is named in its own words, so a reader who landed in the wrong one
 * can still find theirs.
 */
export function languageSwitch(className: string, back: string): string {
  const now = currentLanguage();
  const buttons = (["en", "it"] as const)
    .map(
      (language) =>
        `<button type="submit" name="lang" value="${language}" lang="${language}" aria-pressed="${language === now}">${escape(UI.languages[language])}</button>`,
    )
    .join("");
  return `<form method="post" action="/ui/lingua" class="${className}" aria-label="${escape(UI.languageLabel)}"><input type="hidden" name="back" value="${escape(back)}">${buttons}</form>`;
}

/** The operator's password form, alone on its page. */
export function operatorLoginPage(message: string | undefined, title: string): string {
  const failed = message !== undefined;
  return authPage(
    title,
    `<form method="post" action="/ui/login">
${authField(UI.login.label, 'type="password" name="password" autocomplete="current-password" autofocus required', { placeholder: UI.login.placeholder, failed })}
${failed ? authMessage({ error: message }) : ""}
<button type="submit" class="primary">${escape(UI.login.submit)}</button>
</form>`,
  );
}

/**
 * The customers' sign-in page: Google, or an email address and then, on the
 * next page, its password. The operator's password is not here: it has its
 * own address (ui.ts, /ui/admin).
 */
export function loginPage(extra: { notice?: string; error?: string } = {}): string {
  const t = UI.account;
  return authPage(
    UI.login.title,
    `${authMessage(extra)}
<a class="button" href="/ui/login/google">${GOOGLE_LOGO}${escape(t.google)}</a>
<div class="or">${escape(t.or)}</div>
<form method="post" action="/ui/login/email">
${authField(t.email, 'type="email" name="email" autocomplete="email" required')}
<button type="submit" class="primary">${escape(t.continueEmail)}</button>
</form>
<p class="auth-foot"><a href="/ui/registrati">${escape(t.toSignUp)}</a></p>`,
  );
}

/** The second step of the email sign-in: the address chosen, its password. */
export function passwordStepPage(email: string, extra: { notice?: string; error?: string } = {}): string {
  const t = UI.account;
  const failed = extra.error !== undefined;
  return authPage(
    t.passwordTitle,
    `<form method="post" action="/ui/login/email">
<input type="hidden" name="email" value="${escape(email)}">
${authField(t.password, 'type="password" name="password" autocomplete="current-password" autofocus required', { failed })}
${authMessage(extra)}
<button type="submit" class="primary">${escape(t.signIn)}</button>
</form>
<p class="auth-foot"><a href="/ui/password">${escape(t.toReset)}</a></p>`,
    { head: `<p class="chip">${escape(email)} <a href="/ui/login">${escape(t.change)}</a></p>\n` },
  );
}

/** One of the other account pages: a title, a message if any, a form or nothing, the way back. */
export function accountPage(
  title: string,
  extra: { notice?: string; error?: string },
  form = "",
  options: { icon?: "mail" | "clock"; message?: string; back?: boolean } = {},
): string {
  return authPage(
    title,
    `${authMessage(extra)}
${form}
${options.back === false ? "" : `<p class="auth-foot"><a href="/ui/login">${escape(UI.account.toLogin)}</a></p>`}`,
    {
      ...(options.icon === undefined ? {} : { icon: options.icon }),
      ...(options.message === undefined ? {} : { message: options.message }),
    },
  );
}
