import { GENESIS_PREV_HASH, receiptHashHex, type Receipt } from "@sigillo/core";
import type { SystemHealth } from "../health/chain-health.js";
import type { ReceiptStore, SystemRecord } from "../storage/store.js";
import { chainStamp, escape, kindIcon, outcomePill, systemPath } from "./layout.js";
import {
  actionKindLabel,
  artifactRoleWords,
  describeReceipt,
  formatDay,
  formatTime,
  formatTs,
  modelWhere,
  receiptSubtitle,
  receiptTitle,
  systemTitle,
  UI,
} from "./strings.js";
import { ICONS, STATE_ICONS } from "./style.js";

/**
 * One system's pages: the header and tabs they share, the evidence sheet,
 * and the history — the list of receipts with its filters, and the
 * inspector of the one selected. Everything is a link or a form: selecting a
 * receipt is `?ricevuta=<seq>`, a kind is `?kind=`, and every link keeps the
 * filters it was drawn under.
 */

/** The history's query parameters, as strings or absent. */
export interface HistoryQuery {
  kind?: string;
  name?: string;
  from?: string;
  to?: string;
  ricevuta?: string;
}

const FILTERS = ["kind", "name", "from", "to"] as const;
const KINDS = ["tool_call", "llm_call", "agent_step", "decision", "genesis"] as const;
/** The most receipts the list shows at once, newest first. */
export const HISTORY_LIMIT = 200;

/** Only the parameters the history knows, and only when they are non-empty strings. */
export function historyQuery(raw: Record<string, unknown>): HistoryQuery {
  const query: HistoryQuery = {};
  for (const key of [...FILTERS, "ricevuta"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) query[key] = value;
  }
  return query;
}

/** The selected receipt's position, when `ricevuta` is one. */
export function selectedSeq(query: HistoryQuery): number | null {
  const value = query.ricevuta;
  if (value === undefined || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

/**
 * The period as the store compares it. A date alone (what the date fields
 * send) is the whole day, in UTC; a full ISO time, as older links carry, is
 * used as it is.
 */
export function storeRange(query: HistoryQuery): { from?: string; to?: string } {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const from = query.from === undefined ? undefined : DATE.test(query.from) ? `${query.from}T00:00:00.000Z` : query.from;
  const to = query.to === undefined ? undefined : DATE.test(query.to) ? `${query.to}T23:59:59.999Z` : query.to;
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/** A link to the history with the same filters, some changed; not yet escaped. */
export function historyUrl(systemId: string, query: HistoryQuery, changes: Partial<Record<keyof HistoryQuery, string | undefined>> = {}, fragment = ""): string {
  const merged: HistoryQuery = { ...query };
  for (const [key, value] of Object.entries(changes) as [keyof HistoryQuery, string | undefined][]) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  const parameters = new URLSearchParams();
  for (const key of [...FILTERS, "ricevuta"] as const) {
    const value = merged[key];
    if (value !== undefined) parameters.set(key, value);
  }
  const search = parameters.toString();
  return `/ui/systems/${encodeURIComponent(systemId)}${search === "" ? "" : `?${search}`}${fragment}`;
}

/**
 * How many receipts, from the start of the chain, a checkpoint with a
 * timestamp token covers: those are anchored, the rest are waiting.
 */
export function anchoredSize(store: ReceiptStore, systemId: string): number {
  return store
    .readCheckpoints(systemId)
    .filter((stored) => store.readTimestamps(stored.id).length > 0)
    .reduce((size, stored) => Math.max(size, stored.checkpoint.tree_size), 0);
}

/** Where one receipt stands with its anchoring, in words. */
export function timestampStatus(store: ReceiptStore, systemId: string, seq: number): string {
  const t = UI.anchoring;
  const covering = store.readCheckpoints(systemId).find((entry) => entry.checkpoint.tree_size > seq);
  if (covering === undefined) return t.notCovered;
  const token = store.readTimestamps(covering.id)[0];
  if (token === undefined) return t.waiting;
  return token.genTime === undefined ? t.unreadable : t.at(formatTs(token.genTime));
}

export type SystemTab = "history" | "checkpoints" | "manage";

/** The header of every page about one system, its tabs, and the evidence sheet its button opens. */
export function systemHeader(record: SystemRecord, health: SystemHealth, tab: SystemTab): string {
  const path = systemPath(record.system_id);
  const tabLink = (name: SystemTab, href: string, label: string): string =>
    `<a href="${href}"${name === tab ? ' aria-current="page"' : ""}><span class="cap">${escape(label)}</span></a>`;
  const archived = record.archived_at === null ? "" : ` <span class="badge">${escape(UI.systemsPage.archivedBadge)}</span>`;
  return `<header class="sys-head">
<div class="sys-title-row">
<div class="sys-title">
<h1>${escape(systemTitle(record))}${archived}</h1>
<p class="sys-meta"><code class="sid">${escape(record.system_id)}</code><span aria-hidden="true">·</span><span>${escape(UI.system.receipts(record.receipts))}</span><span aria-hidden="true">·</span>${chainStamp(health.status)}</p>
${health.status === "green" ? "" : `<p class="sys-health">${escape(health.message)}</p>`}
</div>
<a class="button primary" href="#fascicolo">${ICONS.download}${escape(UI.home.generate)}</a>
</div>
<nav class="tabs" aria-label="${escape(UI.system.tabsLabel)}">
${tabLink("history", path, UI.systemsPage.history)}
${tabLink("checkpoints", `${path}/checkpoints`, UI.checkpoints.title)}
${tabLink("manage", `${path}/manage`, UI.systemsPage.manage)}
</nav>
</header>`;
}

/** The two optional disclosures of an export, folded away: by default an export names nobody and opens nothing. */
export function discloseFields(): string {
  const t = UI.home.disclose;
  return `<details class="fold"><summary>${ICONS.chevronRight}<span>${escape(t.summary)}</span></summary>
<div class="fold-body">
<p class="hint">${escape(t.hint)}</p>
<label>${escape(t.subjectsLabel)}<input type="text" name="subjects" autocomplete="off" spellcheck="false"></label>
<label>${escape(t.openingsLabel)}<input type="text" name="openings" autocomplete="off" inputmode="numeric"></label>
<p class="hint">${escape(t.openingsHint)}</p>
</div>
</details>`;
}

/**
 * "Genera fascicolo" as a sheet over the page, opened by the header's link
 * to #fascicolo and closed by "Annulla": :target, no script. The form is the
 * one this page always had (POST /ui/systems/:id/export), with the period.
 */
export function exportSheet(record: SystemRecord): string {
  const t = UI.exportSheet;
  return `<section class="sheet-layer" id="fascicolo" aria-labelledby="fascicolo-title">
<div class="sheet">
<div class="sheet-head"><span class="icon-tile blue" aria-hidden="true">${ICONS.download}</span><div><h2 id="fascicolo-title">${escape(t.title(systemTitle(record)))}</h2><p>${escape(UI.home.generateHint)}</p></div></div>
<form method="post" action="${systemPath(record.system_id)}/export">
<div class="sheet-body">
<p class="group">${escape(t.period)}</p>
<div class="fields-row"><label>${escape(UI.home.fromDate)}<input type="date" name="from"></label><label>${escape(UI.home.toDate)}<input type="date" name="to"></label></div>
<p class="hint">${escape(UI.home.wholeChain)}</p>
${discloseFields()}
</div>
<div class="sheet-foot"><a class="button" href="#main">${escape(t.cancel)}</a><button type="submit" class="primary">${ICONS.download}${escape(UI.home.generate)}</button></div>
</form>
</div>
</section>`;
}

/** One receipt as a row of the list: a link that selects it. */
function receiptRow(receipt: Receipt, href: string, current: boolean): string {
  return `<li><a class="row" id="r-${receipt.seq}" href="${escape(href)}"${current ? ' aria-current="true"' : ""}>
<span class="row-time">${escape(formatTime(receipt.ts_received))}</span>
${kindIcon(receipt.action.kind)}<span class="sr">${escape(actionKindLabel(receipt.action.kind))}: </span>
<span class="row-text"><span class="row-title">${escape(receiptTitle(receipt))}</span><span class="row-sub">${escape(receiptSubtitle(receipt))}</span></span>
${receipt.outcome === "ok" ? "" : outcomePill(receipt.outcome)}
<span class="row-seq">n. ${receipt.seq}</span>
</a></li>`;
}

/** The list, a day at a time, newest first. */
function receiptList(systemId: string, receipts: Receipt[], query: HistoryQuery, selected: number | null): string {
  const days: { day: string; rows: string[] }[] = [];
  for (const receipt of receipts) {
    const day = formatDay(receipt.ts_received);
    const href = historyUrl(systemId, query, { ricevuta: String(receipt.seq) }, `#r-${receipt.seq}`);
    const row = receiptRow(receipt, href, receipt.seq === selected);
    const last = days[days.length - 1];
    if (last !== undefined && last.day === day) last.rows.push(row);
    else days.push({ day, rows: [row] });
  }
  return days
    .map(({ day, rows }) => `<h3 class="day">${escape(UI.history.dayUtc(day))}</h3>\n<ol class="rows">${rows.join("\n")}</ol>`)
    .join("\n");
}

/** One label/value line of the inspector. */
function fact(label: string, value: string, stack = false): string {
  return `<div${stack ? ' class="stack"' : ""}><dt>${escape(label)}</dt><dd>${value}</dd></div>`;
}

/** The selected receipt, in full: the sentence, who and when, files, its place in the chain, and its signature. */
function inspector(
  store: ReceiptStore,
  record: SystemRecord,
  receipt: Receipt,
  query: HistoryQuery,
  anchoredBelow: number,
): string {
  const t = UI.inspector;
  const systemId = record.system_id;
  const genesis = receipt.action.kind === "genesis";
  const model = receipt.v !== 1 ? receipt.model : undefined;
  const artifacts = receipt.v !== 1 ? (receipt.artifacts ?? []) : [];

  const who = [fact(t.kind, `<span class="cap">${escape(actionKindLabel(receipt.action.kind))}</span>`)];
  if (!genesis) who.push(fact(t.agent, escape(receipt.actor.agent)));
  if (receipt.actor.on_behalf_of !== undefined) {
    who.push(fact(t.onBehalfOf, `<a href="/ui/persone">${escape(receipt.actor.on_behalf_of)}</a>`));
  }
  if (model !== undefined) {
    const where = modelWhere(model.provider);
    who.push(fact(t.model, `<code>${escape(model.name)}</code>${where === null ? "" : `<span class="sub">${escape(where)}</span>`}`));
  }
  who.push(fact(t.received, escape(formatTs(receipt.ts_received))));
  who.push(fact(t.source, escape(genesis ? t.sources.genesis : t.sources[receipt.source.type])));

  const files =
    artifacts.length === 0
      ? ""
      : `<h3 class="group-label">${escape(t.files)}</h3>
<ul class="facts">${artifacts
          .map(
            (artifact) =>
              `<li class="file-row">${ICONS.doc}<span class="file-name"><code>${escape(artifact.label)}</code><span class="sub">${escape(artifactRoleWords(artifact.role))}</span></span><a href="/ui/verify-document">${escape(t.verifyFile)}</a></li>`,
          )
          .join("")}</ul>`;

  const anchored = receipt.seq < anchoredBelow;
  const previous =
    receipt.seq === 0
      ? `${escape(t.first)}<code class="hash-full">${escape(receipt.prev_hash)}</code>`
      : `<a href="${escape(historyUrl(systemId, query, { ricevuta: String(receipt.seq - 1) }, `#r-${receipt.seq - 1}`))}">${escape(t.receiptNo(receipt.seq - 1))}</a><code class="hash-full">${escape(receipt.prev_hash)}</code>`;
  const chain = [
    fact(t.fingerprint, `<code class="hash-full">${escape(receiptHashHex(receipt))}</code>`, true),
    fact(t.linkedTo, previous, true),
    fact(
      t.anchoring,
      anchored
        ? `<span class="stamp green">${STATE_ICONS.ok}${escape(UI.history.anchored)}</span>`
        : `<span class="stamp yellow">${STATE_ICONS.warn}${escape(UI.history.anchorPending)}</span>`,
    ),
    `<div class="note-row"><span>${
      anchored ? escape(t.anchoredNote) : `<span class="cap">${escape(timestampStatus(store, systemId, receipt.seq))}</span>`
    }</span><a href="${systemPath(systemId)}/checkpoints">${escape(t.seeCheckpoints)}</a></div>`,
  ];

  const llm = receipt.action.kind === "llm_call";
  const technical = [
    fact(t.signature, `<code class="hash-full">${escape(receipt.sig)}</code>`, true),
    fact(t.key, `<code>${escape(receipt.key_id)}</code>`),
  ];
  if (receipt.input_hash !== null) {
    technical.push(fact(llm ? t.promptHash : t.inputHash, `<code class="hash-full">${escape(receipt.input_hash)}</code>`, true));
  }
  if (receipt.output_hash !== null) {
    technical.push(fact(llm ? t.replyHash : t.outputHash, `<code class="hash-full">${escape(receipt.output_hash)}</code>`, true));
  }
  technical.push(fact(t.receivedIso, `<code>${escape(receipt.ts_received)}</code>`));
  technical.push(fact(t.eventIso, `<code>${escape(receipt.ts_event)}</code>`));
  technical.push(fact(t.version, `<code>v${receipt.v}</code>`));

  return `<a class="back" href="${escape(historyUrl(systemId, query, { ricevuta: undefined }, `#r-${receipt.seq}`))}">${ICONS.chevronLeft}${escape(UI.history.back)}</a>
<div class="insp-top"><p class="insp-no" id="dettaglio-titolo">${escape(t.receiptNo(receipt.seq))}</p>${outcomePill(receipt.outcome, true)}</div>
${kindIcon(receipt.action.kind, "large")}
<h2 class="insp-sentence">${escape(describeReceipt(receipt))}</h2>
${genesis && receipt.prev_hash === GENESIS_PREV_HASH ? `<p class="insp-note">${escape(t.genesisNote)}</p>` : ""}
<h3 class="group-label">${escape(t.whoWhen)}</h3>
<dl class="facts">${who.join("")}</dl>
${files}
<h3 class="group-label">${escape(t.chain)}</h3>
<dl class="facts">${chain.join("")}</dl>
<details class="tech"><summary><span class="when-closed">${escape(t.showTechnical)}</span><span class="when-open">${escape(t.hideTechnical)}</span></summary>
<dl class="facts">${technical.join("")}</dl>
</details>`;
}

export interface HistoryView {
  store: ReceiptStore;
  record: SystemRecord;
  health: SystemHealth;
  query: HistoryQuery;
  /** The receipts the filters let through, newest first, at most HISTORY_LIMIT. */
  receipts: Receipt[];
  /** How many receipts of each kind the filters other than the kind let through. */
  counts: Record<string, number>;
  /** The receipt in the inspector, and whether the address asked for it. */
  selected: Receipt | null;
  explicit: boolean;
  anchoredBelow: number;
}

/** The history of one system: header, filters, the list, and the inspector beside it. */
export function historyPage(view: HistoryView): string {
  const { record, query, receipts, counts, selected } = view;
  const t = UI.history;
  const systemId = record.system_id;
  const currentKind = query.kind ?? "";
  const all = Object.values(counts).reduce((sum, count) => sum + count, 0);

  const segment = (kind: string, label: string, count: number): string =>
    `<a href="${escape(historyUrl(systemId, query, { kind: kind === "" ? undefined : kind, ricevuta: undefined }))}"${
      kind === currentKind ? ' aria-current="page"' : ""
    }>${escape(label)}<span class="count">${count}</span></a>`;
  const segments = [segment("", t.allKinds, all), ...KINDS.map((kind) => segment(kind, t.kinds[kind], counts[kind] ?? 0))].join("");

  const filtered = query.name !== undefined || query.from !== undefined || query.to !== undefined;
  const dateValue = (value: string | undefined): string => (value !== undefined && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "");
  const search = `<details class="search"${filtered ? " open" : ""}><summary>${ICONS.search}<span>${escape(t.searchTitle)}</span></summary>
<form method="get" action="${systemPath(systemId)}">
${query.kind === undefined ? "" : `<input type="hidden" name="kind" value="${escape(query.kind)}">`}
<label><span class="cap">${escape(t.nameLabel)}</span><input type="text" name="name" value="${escape(query.name ?? "")}" autocomplete="off" spellcheck="false"></label>
<label><span class="cap">${escape(t.fromLabel)}</span><input type="date" name="from" value="${escape(dateValue(query.from))}"></label>
<label><span class="cap">${escape(t.toLabel)}</span><input type="date" name="to" value="${escape(dateValue(query.to))}"></label>
<button type="submit">${escape(t.searchButton)}</button>
</form>
${
  filtered
    ? `<p class="filter-line"><a href="${escape(historyUrl(systemId, query, { name: undefined, from: undefined, to: undefined, ricevuta: undefined }))}">${escape(t.clearFilters)}</a></p>`
    : ""
}
</details>`;

  const list =
    receipts.length === 0
      ? `<div class="empty-state"><strong>${escape(t.noMatches)}</strong><p>${escape(t.noMatchesHint)}</p></div>`
      : receiptList(systemId, receipts, query, selected?.seq ?? null);

  return `<section class="studio-list" aria-label="${escape(t.listLabel)}">
${systemHeader(record, view.health, "history")}
<div class="toolbar">
<nav class="segmented" aria-label="${escape(t.filterLabel)}">${segments}</nav>
<h2 class="list-count">${escape(t.shown(receipts.length, receipts.length === HISTORY_LIMIT))}</h2>
</div>
${search}
<div class="rows-scroll" id="elenco">
${list}
</div>
</section>
<aside class="inspector" id="dettaglio" aria-label="${escape(UI.inspector.label)}">
${selected === null ? "" : inspector(view.store, record, selected, query, view.anchoredBelow)}
</aside>
${exportSheet(record)}`;
}
