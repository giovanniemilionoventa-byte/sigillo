import type { Receipt } from "@sigillo/core";
import type { ChainHealthMonitor, ChainStatus, SystemHealth } from "../health/chain-health.js";
import type { ReceiptStore, SystemRecord } from "../storage/store.js";
import { outcomeWord, systemTitle, UI } from "./strings.js";
import { ICONS, KIND_ICONS, SEAL_SVG, STATE_ICONS, STYLE } from "./style.js";

/**
 * What every page of the operator's view shares: the document around it, the
 * sidebar, and the small pieces each page is built from (a state, an outcome,
 * the kind of an action). The pages themselves are in pages.ts and
 * history.ts; the routes in ui.ts.
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

/** Which entry of the sidebar a page belongs to. */
export type NavCurrent = "registro" | "sistemi" | "archiviati" | "tutti" | "persone" | "verifica" | `system:${string}`;

/** A system as the sidebar and the main page show it: its record and its chain's health. */
export interface SystemRow {
  record: SystemRecord;
  health: SystemHealth;
}

/** What the sidebar needs, read once per page. */
export interface Shell {
  keyId: string;
  /** Whether the operator is looking: only then are the people pages offered (ui.ts, requireOperator). */
  operator: boolean;
  /** The systems the main page shows, in the same order. */
  systems: SystemRow[];
  archivedCount: number;
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
  keyId: string,
  operator: boolean,
): Shell {
  const { records, shown } = homeRows(store, healthMonitor, now);
  return { keyId, operator, systems: shown, archivedCount: records.filter((record) => record.archived_at !== null).length };
}

/** The worst state among the systems shown: one red makes the page red. */
export function worstStatus(statuses: ChainStatus[]): ChainStatus {
  return statuses.includes("red") ? "red" : statuses.includes("yellow") ? "yellow" : "green";
}

export const STATE_ICON: Record<ChainStatus, string> = { green: STATE_ICONS.ok, yellow: STATE_ICONS.warn, red: STATE_ICONS.bad };

/** A traffic light: icon of its own shape, word, colour. */
export function semaphore(status: ChainStatus): string {
  return `<span class="stamp ${status}"><span class="dot ${status}" aria-hidden="true">${STATE_ICON[status]}</span><span class="status-word ${status}">${escape(UI.status[status])}</span></span>`;
}

/** A chain's state in the header of a system: icon, and "Registro integro" / "Da controllare" / "Verifica fallita". */
export function chainStamp(status: ChainStatus): string {
  return `<span class="stamp ${status}" data-chain="${status}"><span class="dot ${status}" aria-hidden="true">${STATE_ICON[status]}</span>${escape(UI.chain[status])}</span>`;
}

export const OUTCOME_STATE: Record<Receipt["outcome"], { css: ChainStatus; icon: string }> = {
  ok: { css: "green", icon: STATE_ICONS.ok },
  error: { css: "red", icon: STATE_ICONS.bad },
  blocked: { css: "yellow", icon: STATE_ICONS.warn },
  unknown: { css: "yellow", icon: STATE_ICONS.warn },
};

/** An outcome as a pill: icon, word, the state's fill. */
export function outcomePill(outcome: Receipt["outcome"], large = false): string {
  const state = OUTCOME_STATE[outcome];
  return `<span class="pill ${state.css}${large ? " large" : ""}" data-outcome="${outcome}">${state.icon}${escape(outcomeWord(outcome))}</span>`;
}

/** The kind of an action as an icon in a rounded square; the word is said elsewhere. */
export function kindIcon(kind: Receipt["action"]["kind"], size: "" | "small" | "large" = ""): string {
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

/** The heading of an ordinary page: a small line above, the title, a lead, and an action on the right. */
export function pageHead(head: { eyebrow?: string; h1: string; lead?: string; action?: string }): string {
  const text = `${head.eyebrow === undefined ? "" : `<p class="eyebrow">${escape(head.eyebrow)}</p>`}
<h1>${escape(head.h1)}</h1>`;
  return `<header class="page-head">${
    head.action === undefined ? text : `<div class="page-head-row"><div>${text}</div>${head.action}</div>`
  }${head.lead === undefined ? "" : `<p class="lead">${escape(head.lead)}</p>`}</header>`;
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

function documentStart(title: string): string {
  return `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>`;
}

function sidebar(shell: Shell, current: NavCurrent | undefined): string {
  const here = (name: NavCurrent): string => (current === name ? ' aria-current="page"' : "");
  const item = (href: string, name: NavCurrent, glyph: string, label: string, count?: number): string =>
    `<a class="side-item" href="${href}"${here(name)}>${glyph}<span class="side-label cap">${escape(label)}</span>${
      count === undefined ? "" : `<span class="side-count">${count}</span>`
    }</a>`;

  const systems = shell.systems
    .map(({ record, health }) => {
      const status = health.status;
      return `<li><a class="side-item" href="${systemPath(record.system_id)}"${here(`system:${record.system_id}`)}><span class="dot ${status}" aria-hidden="true">${STATE_ICON[status]}</span><span class="sr">${escape(UI.status[status])}: </span><span class="side-label">${escape(systemTitle(record))}</span><span class="side-count">${record.receipts}</span></a></li>`;
    })
    .join("");

  return `<div class="sidebar" id="menu"><div class="sidebar-inner">
<div class="side-top"><a class="brand" href="/ui">${SEAL_SVG}<span><span class="wordmark">sigillo</span><span class="tagline">${escape(UI.brand.tagline)}</span></span></a><a class="menu-close" href="#main">${ICONS.close}${escape(UI.nav.close)}</a></div>
<nav class="side-nav" aria-label="${escape(UI.nav.label)}">
${item("/ui", "registro", ICONS.home, UI.nav.registro)}
<div class="side-head"><a class="cap" href="/ui/sistemi"${here("sistemi")}>${escape(UI.nav.sistemi)}</a><a class="side-add" href="/ui/sistemi#crea" aria-label="${escape(UI.systemsPage.createTitle)}">${ICONS.plus}</a></div>
${systems === "" ? "" : `<ul class="side-list">${systems}</ul>`}
${item("/ui/sistemi?vista=archiviati", "archiviati", `<span class="dot archived" aria-hidden="true">${STATE_ICONS.archived}</span>`, UI.systemsPage.views.archiviati, shell.archivedCount)}
${item("/ui/sistemi?vista=tutti", "tutti", ICONS.list, UI.nav.allSystems)}
<p class="side-head">${escape(UI.nav.tools)}</p>
${item("/ui/verify-document", "verifica", ICONS.docCheck, UI.nav.verificaDocumento)}
${shell.operator ? item("/ui/persone", "persone", ICONS.people, UI.nav.persone) : ""}
</nav>
<div class="side-foot">
<p class="side-key">${ICONS.key}<span>${escape(UI.brand.signingKey)} <code>${escape(shell.keyId)}</code></span></p>
<form method="post" action="/ui/logout"><button type="submit" class="side-item">${ICONS.logout}<span class="cap">${escape(UI.nav.esci)}</span></button></form>
</div>
</div></div>`;
}

/** A page of the view, inside the shell: top bar (phone), sidebar, content. */
export function page(options: PageOptions, shell: Shell): string {
  return `${documentStart(`${options.title} — sigillo`)}<body>
<a class="skip" href="#main">${escape(UI.brand.skip)}</a>
<div class="app">
<header class="topbar"><a class="brand" href="/ui">${SEAL_SVG}<span><span class="wordmark">sigillo</span></span></a><a class="menu-open" href="#menu">${ICONS.menu}${escape(UI.nav.menu)}</a></header>
${sidebar(shell, options.current)}
<main id="main" class="${options.mainClass ?? "content"}">
${options.body}
</main>
</div>
</body></html>`;
}

/** The sign-in page: who this is on the left, the password on the right. */
export function loginPage(message?: string): string {
  const t = UI.login;
  const point = (tile: string, glyph: string, title: string, text: string): string =>
    `<li><span class="icon-tile ${tile}" aria-hidden="true">${glyph}</span><span><strong>${escape(title)}</strong><span class="muted">${escape(text)}</span></span></li>`;
  const failed = message !== undefined;
  return `${documentStart("sigillo")}<body>
<div class="login">
<aside class="login-id">
<div class="login-brand">${SEAL_SVG}<span><span class="wordmark">sigillo</span><span class="tagline">${escape(UI.brand.tagline)}</span></span></div>
<h2 class="login-pitch">${escape(t.pitch)}</h2>
<ul class="login-points">
${point("green", ICONS.seal, UI.home.q1, t.points.q1)}
${point("blue", ICONS.list, UI.home.q2, t.points.q2)}
${point("purple", ICONS.folder, UI.home.q3, t.points.q3)}
</ul>
</aside>
<main class="login-main" id="main">
<form method="post" action="/ui/login" class="login-form">
<h1>${escape(t.submit)}</h1>
<p class="lead">${escape(t.lead)}</p>
<label>${escape(t.label)}
  <input type="password" name="password" autocomplete="current-password" autofocus required${
    failed ? ' aria-invalid="true" aria-describedby="login-error"' : ""
  }>
</label>
${failed ? `<p class="field-error" id="login-error" role="alert">${STATE_ICONS.bad}<span>${escape(message)}</span></p>` : ""}
<button type="submit" class="primary">${escape(t.submit)}</button>
<p class="login-note">${escape(t.restricted)}</p>
</form>
</main>
</div>
</body></html>`;
}
