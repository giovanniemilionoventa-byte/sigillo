import { GENESIS_PREV_HASH, receiptHashHex, type Receipt } from "@sigillo/core";
import type { SystemHealth } from "../health/chain-health.js";
import type { ReceiptStore, SystemRecord } from "../storage/store.js";
import { archivedPill, capital, chainPill, escape, kindIcon, outcomePill, systemPath } from "./layout.js";
import {
  actionKindLabel,
  artifactRoleWords,
  formatClock,
  formatDayHeading,
  formatTs,
  formatWhen,
  formatWhenInline,
  localDayRange,
  modelWhere,
  receiptTitle,
  systemTitle,
  UI,
} from "./strings.js";
import { ICONS } from "./style.js";

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
  /** One agent's receipts only, e.g. one Claude Code session. */
  agent?: string;
  from?: string;
  to?: string;
  ricevuta?: string;
}

const FILTERS = ["kind", "name", "agent", "from", "to"] as const;
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
 * send) is the whole day in Italian time, as the history shows it; a full ISO
 * time, as older links carry, is used as it is.
 */
export function storeRange(query: HistoryQuery): { from?: string; to?: string } {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const from = query.from === undefined ? undefined : DATE.test(query.from) ? localDayRange(query.from).from : query.from;
  const to = query.to === undefined ? undefined : DATE.test(query.to) ? localDayRange(query.to).to : query.to;
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

/** The header of every page about one system, its tabs, and the button that opens its evidence sheet. */
export function systemHeader(record: SystemRecord, health: SystemHealth, tab: SystemTab): string {
  const path = systemPath(record.system_id);
  const tabLink = (name: SystemTab, href: string, label: string): string =>
    `<a href="${href}"${name === tab ? ' aria-current="page"' : ""}>${escape(label)}</a>`;
  return `<header class="sys-head">
<div class="titleline"><h1>${escape(systemTitle(record))}</h1>${chainPill(health.status)}${record.archived_at === null ? "" : archivedPill()}
<span class="end"><a class="button primary" href="#fascicolo">${ICONS.download}<span class="label-long">${escape(UI.system.evidence)}</span></a></span></div>
${health.status === "green" ? "" : `<p class="sys-health ${health.status}">${escape(health.message)}</p>`}
<nav class="tabs" aria-label="${escape(UI.system.tabsLabel)}">
${tabLink("history", path, UI.history.back)}
${tabLink("checkpoints", `${path}/checkpoints`, UI.checkpoints.title)}
${tabLink("manage", `${path}/manage`, UI.settings.title)}
</nav>
</header>`;
}

/** The two optional disclosures of an export, folded away: by default an export names nobody and opens nothing. */
export function discloseFields(): string {
  const t = UI.home.disclose;
  return `<details class="fold"><summary>${ICONS.chevronRight}<span>${escape(t.summary)}</span></summary>
<div class="fold-body">
<p>${escape(t.hint)}</p>
<label>${escape(t.subjectsLabel)}<input type="text" name="subjects" autocomplete="off" spellcheck="false"></label>
<label>${escape(t.openingsLabel)}<input type="text" name="openings" autocomplete="off" inputmode="numeric"></label>
</div>
</details>`;
}

/**
 * The evidence file as a sheet over the page, opened by the header's link to
 * #fascicolo and closed by "Annulla": :target, no script. The form is the
 * one this page always had (POST /ui/systems/:id/export), with the period.
 */
export function exportSheet(record: SystemRecord): string {
  const t = UI.exportSheet;
  return `<section class="sheet-layer" id="fascicolo" aria-labelledby="fascicolo-title">
<div class="sheet">
<form method="post" action="${systemPath(record.system_id)}/export">
<div class="sheet-body">
<h2 id="fascicolo-title">${escape(t.title(systemTitle(record)))}</h2>
<div class="fields-row"><label>${escape(UI.home.fromDate)}<input type="date" name="from"></label><label>${escape(UI.home.toDate)}<input type="date" name="to"></label></div>
${discloseFields()}
</div>
<div class="sheet-foot"><a class="button" href="#main">${escape(t.cancel)}</a><button type="submit" class="primary">${ICONS.download}${escape(t.submit)}</button></div>
</form>
</div>
</section>`;
}

/** One receipt as a row of the list: a link that selects it. */
function receiptRow(receipt: Receipt, href: string, current: boolean): string {
  return `<li><a class="row" id="r-${receipt.seq}" href="${escape(href)}"${current ? ' aria-current="true"' : ""}>
<span class="row-time">${escape(formatClock(receipt.ts_received))}</span>
${kindIcon(receipt.action.kind)}<span class="sr">${escape(actionKindLabel(receipt.action.kind))}: </span>
<span class="row-title">${escape(receiptTitle(receipt))}</span>
${receipt.outcome === "ok" ? "" : outcomePill(receipt.outcome)}
</a></li>`;
}

/**
 * The list, a day at a time, newest first. When the receipts come from more
 * than one agent (Claude Code names each of its sessions as an agent), each
 * run of one agent's receipts gets a heading with its name, so sessions read
 * apart. The genesis receipt names no agent and takes no heading.
 */
function receiptList(systemId: string, receipts: Receipt[], query: HistoryQuery, selected: number | null, now: Date): string {
  const named = (receipt: Receipt): string => (receipt.action.kind === "genesis" ? "" : receipt.actor.agent);
  const several = new Set(receipts.map(named).filter((agent) => agent !== "")).size > 1;
  const days: { day: string; runs: { agent: string; rows: string[] }[] }[] = [];
  for (const receipt of receipts) {
    const day = formatDayHeading(receipt.ts_received, now);
    const href = historyUrl(systemId, query, { ricevuta: String(receipt.seq) }, `#r-${receipt.seq}`);
    const row = receiptRow(receipt, href, receipt.seq === selected);
    let last = days[days.length - 1];
    if (last === undefined || last.day !== day) {
      last = { day, runs: [] };
      days.push(last);
    }
    const agent = several ? named(receipt) : "";
    const run = last.runs[last.runs.length - 1];
    if (run !== undefined && (run.agent === agent || agent === "")) run.rows.push(row);
    else last.runs.push({ agent, rows: [row] });
  }
  return days
    .map(({ day, runs }) => {
      const lists = runs
        .map(({ agent, rows }) => `${agent === "" ? "" : `<p class="label run">${escape(agent)}</p>\n`}<ol class="rows">${rows.join("\n")}</ol>`)
        .join("\n");
      return `<h3 class="day">${escape(day)}</h3>\n${lists}`;
    })
    .join("\n");
}

/** One label/value line of the inspector. */
function fact(label: string, value: string, stack = false): string {
  return `<div${stack ? ' class="stack"' : ""}><dt>${escape(label)}</dt><dd>${value}</dd></div>`;
}

/** What a receipt is, in a few words: "Strumento: rimborsa_pagamento", "Modello: llama3.1:8b". */
export function receiptHeading(receipt: Receipt): string {
  if (receipt.action.kind === "genesis") return receiptTitle(receipt);
  const model = receipt.v !== 1 ? receipt.model : undefined;
  const name = receipt.action.kind === "llm_call" && model !== undefined ? model.name : receipt.action.name;
  return `${capital(actionKindLabel(receipt.action.kind))}: ${name}`;
}

/** The selected receipt: who, when, files, whether it is sealed, and everything technical folded away. */
function inspector(
  store: ReceiptStore,
  record: SystemRecord,
  receipt: Receipt,
  query: HistoryQuery,
  anchoredBelow: number,
  now: Date,
): string {
  const t = UI.inspector;
  const systemId = record.system_id;
  const genesis = receipt.action.kind === "genesis";
  const model = receipt.v !== 1 ? receipt.model : undefined;
  const artifacts = receipt.v !== 1 ? (receipt.artifacts ?? []) : [];

  const who: string[] = [];
  if (!genesis) who.push(fact(t.agent, escape(receipt.actor.agent)));
  if (receipt.actor.on_behalf_of !== undefined) {
    who.push(fact(t.onBehalfOf, escape(receipt.actor.on_behalf_of)));
  }
  if (model !== undefined) {
    const where = modelWhere(model.provider);
    who.push(fact(t.model, `${escape(model.name)}${where === null ? "" : `<span class="sub">${escape(where)}</span>`}`));
  }
  who.push(fact(t.when, escape(formatWhen(receipt.ts_received, now))));
  who.push(fact(t.source, escape(genesis ? t.sources.genesis : t.sources[receipt.source.type])));

  const files =
    artifacts.length === 0
      ? ""
      : `<ul class="facts" aria-label="${escape(t.files)}">${artifacts
          .map(
            (artifact) =>
              `<li class="file-row">${ICONS.doc}<span class="file-name">${escape(artifact.label)}<span class="sub">${escape(artifactRoleWords(artifact.role))}</span></span><a href="/ui/verify-document">${escape(t.verifyFile)}</a></li>`,
          )
          .join("")}</ul>`;

  const anchored = receipt.seq < anchoredBelow;
  const seal = anchored
    ? `<span class="ok">${escape(t.sealedAt(sealTime(store, systemId, receipt.seq, now)))}</span>`
    : `<span class="wait">${escape(t.sealWaiting)}</span>`;

  const previous =
    receipt.seq === 0
      ? `${escape(t.first)}<code class="hash-full">${escape(receipt.prev_hash)}</code>`
      : `<a href="${escape(historyUrl(systemId, query, { ricevuta: String(receipt.seq - 1) }, `#r-${receipt.seq - 1}`))}">${escape(t.linkedTo(receipt.seq - 1))}</a><code class="hash-full">${escape(receipt.prev_hash)}</code>`;
  const llm = receipt.action.kind === "llm_call";
  const technical = [
    fact(t.fingerprint, `<code class="hash-full">${escape(receiptHashHex(receipt))}</code>`, true),
    fact(UI.inspector.receiptNo(receipt.seq), previous, true),
    fact(t.signature, `<code class="hash-full">Ed25519 · ${escape(receipt.key_id)}</code><code class="hash-full">${escape(receipt.sig)}</code>`, true),
    fact(t.timestamp, `${escape(timestampStatus(store, systemId, receipt.seq))} · <a href="${systemPath(systemId)}/checkpoints">${escape(UI.checkpoints.title)}</a>`, true),
  ];
  if (receipt.input_hash !== null) {
    technical.push(fact(llm ? t.promptHash : t.inputHash, `<code class="hash-full">${escape(receipt.input_hash)}</code>`, true));
  }
  if (receipt.output_hash !== null) {
    technical.push(fact(llm ? t.replyHash : t.outputHash, `<code class="hash-full">${escape(receipt.output_hash)}</code>`, true));
  }
  technical.push(fact(t.receivedIso, `<code>${escape(receipt.ts_received)}</code>`, true));
  technical.push(fact(t.eventIso, `<code>${escape(receipt.ts_event)}</code>`, true));
  technical.push(fact(t.version, `<code>v${receipt.v}</code>`));

  return `<a class="back" href="${escape(historyUrl(systemId, query, { ricevuta: undefined }, `#r-${receipt.seq}`))}">${ICONS.chevronLeft}${escape(UI.history.back)}</a>
<div class="insp-top">${kindIcon(receipt.action.kind, "large")}${outcomePill(receipt.outcome)}</div>
<h2 class="insp-title" id="dettaglio-titolo">${escape(receiptHeading(receipt))}</h2>
${genesis && receipt.prev_hash === GENESIS_PREV_HASH ? `<p class="insp-note">${escape(t.genesisNote)}</p>` : ""}
<dl class="facts">${who.join("")}</dl>
${files}
<dl class="facts">${fact(t.seal, seal)}</dl>
<details class="tech"><summary>${ICONS.chevronRight}<span>${escape(t.technical)}</span></summary>
<dl class="facts">${technical.join("")}</dl>
</details>`;
}

/** When the first checkpoint with a timestamp that covers `seq` was written, as the inspector says it. */
function sealTime(store: ReceiptStore, systemId: string, seq: number, now: Date): string {
  const covering = store
    .readCheckpoints(systemId)
    .find((entry) => entry.checkpoint.tree_size > seq && store.readTimestamps(entry.id).length > 0);
  return covering === undefined ? "" : formatWhenInline(covering.checkpoint.ts, now);
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
  /** The agents that wrote to this system lately (store.recentAgents). */
  agents: { agent: string; count: number }[];
  /** The receipt in the inspector, and whether the address asked for it. */
  selected: Receipt | null;
  explicit: boolean;
  anchoredBelow: number;
  now: Date;
}

/** The history of one system: header, filters, the list, and the inspector beside it. */
export function historyPage(view: HistoryView): string {
  const { record, query, receipts, counts, selected, agents } = view;
  const t = UI.history;
  const systemId = record.system_id;
  const currentKind = query.kind ?? "";
  const all = Object.values(counts).reduce((sum, count) => sum + count, 0);

  const segment = (kind: string, label: string, count: number): string =>
    `<a href="${escape(historyUrl(systemId, query, { kind: kind === "" ? undefined : kind, ricevuta: undefined }))}"${
      kind === currentKind ? ' aria-current="page"' : ""
    }>${escape(label)}<span class="count">${count}</span></a>`;
  // A kind with nothing in it is not offered, unless it is the one chosen.
  const segments = [
    segment("", t.allKinds, all),
    ...KINDS.filter((kind) => (counts[kind] ?? 0) > 0 || kind === currentKind).map((kind) => segment(kind, t.kinds[kind], counts[kind] ?? 0)),
  ].join("");

  const filtered = query.name !== undefined || query.agent !== undefined || query.from !== undefined || query.to !== undefined;
  // Offered when more than one agent wrote here, or one is already chosen (so it can be undone).
  const agentChoices = agents.some((entry) => entry.agent === query.agent) || query.agent === undefined ? agents : [{ agent: query.agent, count: 0 }, ...agents];
  const agentSelect =
    agentChoices.length < 2 && query.agent === undefined
      ? ""
      : `<label>${escape(t.agentLabel)}<select name="agent"><option value="">${escape(t.allAgents)}</option>${agentChoices
          .map(
            (entry) =>
              `<option value="${escape(entry.agent)}"${entry.agent === query.agent ? " selected" : ""}>${escape(entry.agent)}${entry.count === 0 ? "" : ` (${entry.count})`}</option>`,
          )
          .join("")}</select></label>\n`;
  const dateValue = (value: string | undefined): string => (value !== undefined && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "");
  const search = `<details class="search"${filtered ? " open" : ""}><summary aria-label="${escape(t.searchTitle)}" title="${escape(t.searchTitle)}">${ICONS.search}</summary>
<form method="get" action="${systemPath(systemId)}">
${query.kind === undefined ? "" : `<input type="hidden" name="kind" value="${escape(query.kind)}">`}
<label>${escape(t.nameLabel)}<input type="text" name="name" value="${escape(query.name ?? "")}" autocomplete="off" spellcheck="false"></label>
${agentSelect}<label>${escape(t.fromLabel)}<input type="date" name="from" value="${escape(dateValue(query.from))}"></label>
<label>${escape(t.toLabel)}<input type="date" name="to" value="${escape(dateValue(query.to))}"></label>
<button type="submit" class="primary">${escape(t.searchButton)}</button>
</form>
</details>`;
  const clear = filtered
    ? `<p class="filter-line"><a href="${escape(historyUrl(systemId, query, { name: undefined, agent: undefined, from: undefined, to: undefined, ricevuta: undefined }))}">${escape(t.clearFilters)}</a></p>`
    : "";

  const list =
    receipts.length === 0
      ? `<div class="empty-state">${escape(t.noMatches)}</div>`
      : receiptList(systemId, receipts, query, selected?.seq ?? null, view.now);

  return `<section class="studio-list" aria-label="${escape(t.listLabel)}">
${systemHeader(record, view.health, "history")}
<div class="toolbar">
<nav class="segmented" aria-label="${escape(t.filterLabel)}">${segments}</nav>
${search}
</div>
${clear}
<div class="rows-scroll" id="elenco">
${list}
${receipts.length === HISTORY_LIMIT ? `<p class="empty-state">${escape(t.capped)}</p>` : ""}
</div>
</section>
<aside class="inspector" id="dettaglio" aria-label="${escape(UI.inspector.label)}">
${selected === null ? "" : inspector(view.store, record, selected, query, view.anchoredBelow, view.now)}
</aside>
${exportSheet(record)}`;
}
