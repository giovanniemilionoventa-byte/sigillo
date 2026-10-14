import type { Receipt } from "@sigillo/core";
import type { ChainStatus } from "../health/chain-health.js";
import type { ReceiptStore, SystemRecord } from "../storage/store.js";
import { connectionStatus } from "../connection/watch.js";
import { escape, kindIcon, STATE_ICON, systemPath, type SystemRow } from "./layout.js";
import { firstSteps, quotaNotice, receiptPath, type Quota } from "./pages.js";
import {
  actionKindLabel,
  formatClock,
  formatCount,
  formatDayHeading,
  formatListTime,
  formatWhenInline,
  localDate,
  localDayRange,
  receiptTitle,
  systemTitle,
  UI,
} from "./strings.js";
import { ICONS, STATE_ICONS } from "./style.js";
import { ICONS_V2, PROOF_ICONS } from "./style-v2.js";

/**
 * The pages of the redesigned console (SIGILLO_CONSOLE_V2) that have no
 * counterpart in the console as it was: Stato, which replaces the main page,
 * Azioni across every system, and Prove. Each page's title is its question,
 * and the first line under it is the answer, in the text colour.
 */

const chevron = `<span class="chev" aria-hidden="true">${ICONS.chevronRight}</span>`;

/** A state as a sign: the shape of the state, its word, its colour. */
function sign(status: ChainStatus | "neutral", word: string, detail = ""): string {
  const icon = status === "neutral" ? STATE_ICONS.archived : STATE_ICON[status];
  return `<span class="sign ${status}">${icon}<span>${escape(word)}</span>${detail === "" ? "" : `<span class="detail">${escape(detail)}</span>`}</span>`;
}

/** An outcome other than ok, in ink: a sign of its own and a word, never the colours of the record. */
export function outcomeChip(outcome: Receipt["outcome"]): string {
  if (outcome === "ok") return "";
  const icon = outcome === "error" ? ICONS_V2.failed : outcome === "blocked" ? ICONS_V2.blocked : ICONS_V2.unknown;
  return `<span class="out" data-outcome="${outcome}">${icon}${escape(UI.v2.outcomes[outcome])}</span>`;
}

/** The agent's signal, apart from the record's integrity: its heartbeat, or else its last action. */
export function agentSignal(store: ReceiptStore, record: SystemRecord, now: Date): { status: ChainStatus | "neutral"; html: string } {
  const t = UI.v2.signals;
  const heartbeat = connectionStatus(store, record.system_id);
  if (heartbeat !== null) {
    if (heartbeat.state === "open") return { status: "green", html: sign("green", t.recording) };
    if (heartbeat.state === "lost") return { status: "yellow", html: sign("yellow", t.disconnected(formatWhenInline(heartbeat.since, now))) };
    return { status: "neutral", html: sign("neutral", t.stopped(formatWhenInline(heartbeat.since, now))) };
  }
  if (record.receipts <= 1 || record.last_received === null) return { status: "neutral", html: sign("neutral", t.never) };
  return { status: "green", html: sign("green", t.lastAction(formatListTime(record.last_received, now))) };
}

/** The record's integrity: the chain's state, or "Nuovo" for a register with no action yet. */
function recordSignal(record: SystemRecord, status: ChainStatus): string {
  if (record.receipts <= 1 && status !== "red") return sign("neutral", UI.v2.signals.newRecord);
  return sign(status, UI.chain[status]);
}

/** The answer under «È tutto a posto?»: the worst thing first, and a link to it. */
function stateAnswer(store: ReceiptStore, shown: SystemRow[], now: Date): string {
  const t = UI.v2.stato;
  const red = shown.find(({ health }) => health.status === "red");
  if (red !== undefined) {
    return `<p class="answer red" role="status">${STATE_ICONS.bad}<span>${escape(t.failed(systemTitle(red.record)))}</span><a href="${systemPath(red.record.system_id)}">${escape(t.open)} ›</a></p>`;
  }
  const lost = shown
    .map((row) => ({ row, heartbeat: connectionStatus(store, row.record.system_id) }))
    .find(({ heartbeat }) => heartbeat?.state === "lost");
  if (lost !== undefined && lost.heartbeat !== null) {
    return `<p class="answer yellow" role="status">${STATE_ICONS.warn}<span>${escape(t.disconnected(systemTitle(lost.row.record), formatWhenInline(lost.heartbeat.since, now)))}</span><a href="${systemPath(lost.row.record.system_id)}/collega">${escape(t.open)} ›</a></p>`;
  }
  const yellow = shown.find(({ record, health }) => health.status === "yellow" && record.receipts > 1);
  if (yellow !== undefined) {
    return `<p class="answer yellow" role="status">${STATE_ICONS.warn}<span>${escape(t.toCheck(systemTitle(yellow.record), yellow.health.message))}</span><a href="${systemPath(yellow.record.system_id)}">${escape(t.open)} ›</a></p>`;
  }
  const recording = shown.filter(({ record }) => record.receipts > 1).length;
  return `<p class="answer green" role="status">${STATE_ICONS.ok}<span>${escape(recording === 0 ? t.noAlteration : t.allRecording(recording))}</span></p>`;
}

/** The start of today, in Italian time, as the store compares it. */
function startOfToday(now: Date): string | undefined {
  const today = localDate(now.toISOString());
  return today === null ? undefined : localDayRange(today).from;
}

/** «È tutto a posto?»: the answer, four figures that lead to the actions, the systems with two signals, what is worth a look. */
export function statoPage(view: { store: ReceiptStore; records: SystemRecord[]; shown: SystemRow[]; quota: Quota | null; now: Date }): string {
  const { store, records, shown, now } = view;
  const t = UI.v2.stato;
  if (records.length === 0 || records.every((record) => record.receipts <= 1)) {
    return `${quotaNotice(view.quota)}${firstSteps(records)}`;
  }

  const from = startOfToday(now);
  const totals: Record<string, number> = {};
  let lastSeal: string | null = null;
  for (const { record } of shown) {
    const counts = store.countReceiptsByOutcome({ systemId: record.system_id, ...(from === undefined ? {} : { from }) });
    for (const [outcome, count] of Object.entries(counts)) totals[outcome] = (totals[outcome] ?? 0) + count;
    const latest = store.latestCheckpoint(record.system_id);
    if (latest !== null && (lastSeal === null || latest.checkpoint.ts > lastSeal)) lastSeal = latest.checkpoint.ts;
  }
  const all = Object.values(totals).reduce((sum, count) => sum + count, 0);
  const blocked = totals["blocked"] ?? 0;
  const failed = totals["error"] ?? 0;
  const fig = (href: string, value: string, label: string): string =>
    `<a class="fig" href="${href}"><strong>${escape(value)}</strong><span>${escape(label)}</span></a>`;
  const figures = `<div class="figs">
${fig("/ui/actions?period=today", formatCount(all), t.figures.today)}
${fig("/ui/actions?period=today&amp;outcome=blocked", formatCount(blocked), t.figures.blocked(blocked))}
${fig("/ui/actions?period=today&amp;outcome=error", formatCount(failed), t.figures.failed(failed))}
${fig("/ui/evidence", lastSeal === null ? "—" : formatListTime(lastSeal, now), t.figures.lastSeal)}
</div>`;

  const rows = shown
    .map(({ record, health }) => {
      const agent = agentSignal(store, record, now);
      const never = record.receipts <= 1;
      const last = never || record.last_received === null ? "—" : formatListTime(record.last_received, now);
      const go = never
        ? `<a class="button" href="${systemPath(record.system_id)}/collega">${escape(t.connect)}</a>`
        : `<a href="${systemPath(record.system_id)}" aria-label="${escape(systemTitle(record))}">${chevron}</a>`;
      return `<tr><td><a class="name" href="${systemPath(record.system_id)}">${escape(systemTitle(record))}</a></td><td>${recordSignal(record, health.status)}</td><td>${agent.html}</td><td>${escape(last)}</td><td class="go">${go}</td></tr>`;
    })
    .join("\n");
  const systems = `<section class="card" aria-labelledby="sistemi-titolo">
<div class="card-head"><h2 id="sistemi-titolo">${escape(t.systems)}</h2></div>
<table class="grid-table"><thead><tr><th scope="col">${escape(t.columns.system)}</th><th scope="col">${escape(t.columns.record)}</th><th scope="col">${escape(t.columns.agent)}</th><th scope="col">${escape(t.columns.last)}</th><th scope="col"><span class="sr">${escape(t.open)}</span></th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="card-foot"><a href="/ui/sistemi/nuovo">${ICONS.plus.replace("<svg ", '<svg width="16" height="16" ')} ${escape(t.newSystem)}</a></div>
</section>`;

  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const problems = shown
    .flatMap(({ record }) =>
      store
        .searchReceipts({ systemId: record.system_id, from: weekAgo, outcomes: ["error", "blocked", "unknown"], actionsOnly: true, limit: 5 })
        .map((receipt) => ({ record, receipt })),
    )
    .sort((a, b) => (a.receipt.ts_received < b.receipt.ts_received ? 1 : -1))
    .slice(0, 5);
  const watch =
    problems.length === 0
      ? ""
      : `<section class="card" aria-labelledby="guardare-titolo">
<div class="card-head"><h2 id="guardare-titolo">${escape(t.watch)}</h2><span class="sign ink">${escape(t.watchWindow)}</span></div>
<ul class="watch">${problems
          .map(
            ({ record, receipt }) =>
              `<li><a href="${receiptPath(record.system_id, receipt.seq)}">${kindIcon(receipt.action.kind)}<span><span>${escape(receiptTitle(receipt))}</span><span class="meta">${outcomeChip(receipt.outcome)}<span>${escape(systemTitle(record))} · ${escape(formatListTime(receipt.ts_received, now))}</span></span></span>${chevron}</a></li>`,
          )
          .join("")}</ul>
<div class="card-foot"><a href="/ui/actions?outcome=problems&amp;period=7d">${escape(t.all)} ›</a></div>
</section>`;

  return `${quotaNotice(view.quota)}<header class="q-head"><div><h1>${escape(t.question)}</h1>${stateAnswer(store, shown, now)}</div></header>
<div class="model-b"><div>${figures}${systems}</div><div>${watch}</div></div>`;
}

/** The filters of Azioni, from the address. */
export interface ActionsQuery {
  system?: string;
  period: "today" | "yesterday" | "7d" | "30d" | "all";
  kind?: string;
  outcome?: "problems" | "error" | "blocked";
  before?: string;
}

const PERIODS = ["today", "yesterday", "7d", "30d", "all"] as const;
const KINDS = ["tool_call", "llm_call", "agent_step", "decision"] as const;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function actionsQuery(raw: Record<string, unknown>): ActionsQuery {
  const text = (name: string): string | undefined => (typeof raw[name] === "string" && raw[name] !== "" ? (raw[name] as string) : undefined);
  const period = text("period");
  const kind = text("kind");
  const outcome = text("outcome");
  const before = text("before");
  const system = text("system");
  return {
    period: PERIODS.find((candidate) => candidate === period) ?? "7d",
    ...(system === undefined ? {} : { system }),
    ...(kind !== undefined && (KINDS as readonly string[]).includes(kind) ? { kind } : {}),
    ...(outcome === "problems" || outcome === "error" || outcome === "blocked" ? { outcome } : {}),
    ...(before !== undefined && ISO.test(before) ? { before } : {}),
  };
}

function actionsUrl(query: ActionsQuery, changes: Partial<Record<keyof ActionsQuery, string | undefined>>): string {
  const merged: Record<string, string | undefined> = { ...query, ...changes };
  if (!("before" in changes)) merged["before"] = undefined;
  const parameters = new URLSearchParams();
  for (const key of ["system", "period", "kind", "outcome", "before"]) {
    const value = merged[key];
    if (value !== undefined) parameters.set(key, value);
  }
  const search = parameters.toString();
  return `/ui/actions${search === "" ? "" : `?${search}`}`;
}

/** The instants a period of Azioni spans, in Italian days. */
function periodRange(period: ActionsQuery["period"], now: Date): { from?: string; to?: string } {
  const today = localDate(now.toISOString());
  if (today === null || period === "all") return {};
  const day = (offset: number): string => {
    const [year, month, date] = today.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(year, month - 1, date + offset)).toISOString().slice(0, 10);
  };
  if (period === "today") return { from: localDayRange(today).from };
  if (period === "yesterday") return localDayRange(day(-1));
  return { from: localDayRange(day(period === "7d" ? -6 : -29)).from };
}

const PAGE = 100;

/** «Cosa ha fatto l'AI?» across every system of the account, or one: filters in view, by day, a page at a time. */
export function actionsPage(view: { store: ReceiptStore; records: SystemRecord[]; query: ActionsQuery; now: Date }): string {
  const { store, records, query, now } = view;
  const t = UI.v2.actions;
  const head = `<header class="q-head"><div><h1>${escape(t.question)}</h1></div><a class="button primary" href="/ui/evidence${query.system === undefined ? "" : `?system=${escape(encodeURIComponent(query.system))}`}">${ICONS.download}${escape(t.prepare)}</a></header>`;
  if (records.length === 0) {
    return `${head}<div class="card empty-state"><p>${escape(t.noSystems)}</p><a class="button primary" href="/ui/sistemi/nuovo">${escape(t.createFirst)}</a></div>`;
  }
  const systems = query.system === undefined ? records : records.filter((record) => record.system_id === query.system);
  const range = periodRange(query.period, now);
  const outcomes = query.outcome === undefined ? undefined : query.outcome === "problems" ? ["error", "blocked", "unknown"] : [query.outcome];
  const filter = (record: SystemRecord) => ({
    systemId: record.system_id,
    ...range,
    ...(outcomes === undefined ? {} : { outcomes }),
    ...(query.before === undefined ? {} : { before: query.before }),
    actionsOnly: true,
  });
  const found = systems
    .flatMap((record) =>
      store.searchReceipts({ ...filter(record), ...(query.kind === undefined ? {} : { kind: query.kind }), limit: PAGE + 1 }).map((receipt) => ({ record, receipt })),
    )
    .sort((a, b) => (a.receipt.ts_received < b.receipt.ts_received ? 1 : -1));
  const page = found.slice(0, PAGE);
  const more = found.length > PAGE;

  const counts: Record<string, number> = {};
  for (const record of systems) {
    for (const [kind, count] of Object.entries(store.countReceiptsByKind(filter(record)))) counts[kind] = (counts[kind] ?? 0) + count;
  }
  const total = KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);

  const seg = (label: string, href: string, on: boolean, count?: number): string =>
    `<a href="${escape(href)}"${on ? ' aria-current="true"' : ""}>${escape(label)}${count === undefined ? "" : `<span class="c">${formatCount(count)}</span>`}</a>`;
  const systemSeg =
    records.length < 2
      ? ""
      : `<span><span class="flabel">${escape(t.system)}</span><span class="seg">${seg(t.allSystems, actionsUrl(query, { system: undefined }), query.system === undefined)}${records
          .map((record) => seg(systemTitle(record), actionsUrl(query, { system: record.system_id }), query.system === record.system_id))
          .join("")}</span></span>`;
  const filters = `<nav class="filters-v2" aria-label="${escape(t.title)}">
${systemSeg}
<span><span class="flabel">${escape(t.period)}</span><span class="seg">${PERIODS.map((period) => seg(t.periods[period], actionsUrl(query, { period }), query.period === period)).join("")}</span></span>
<span><span class="flabel">${escape(t.kind)}</span><span class="seg">${seg(t.allKinds, actionsUrl(query, { kind: undefined }), query.kind === undefined, total)}${KINDS.filter((kind) => (counts[kind] ?? 0) > 0)
    .map((kind) => seg(capitalize(actionKindLabel(kind)), actionsUrl(query, { kind }), query.kind === kind, counts[kind] ?? 0))
    .join("")}</span></span>
<span><span class="flabel">${escape(t.outcome)}</span><span class="seg">${seg(t.allOutcomes, actionsUrl(query, { outcome: undefined }), query.outcome === undefined)}${seg(t.problems, actionsUrl(query, { outcome: "problems" }), query.outcome === "problems")}</span></span>
</nav>`;

  if (page.length === 0) {
    return `${head}${filters}<div class="card empty-state"><p>${escape(t.none)}</p></div>`;
  }
  let lastDay = "";
  const items = page
    .map(({ record, receipt }) => {
      const day = formatDayHeading(receipt.ts_received, now);
      const heading = day === lastDay ? "" : `<li class="act-day">${escape(day)}</li>`;
      lastDay = day;
      const where = query.system === undefined ? `<span>${escape(systemTitle(record))}</span>` : "";
      return `${heading}<li><a class="act" href="${receiptPath(record.system_id, receipt.seq)}"><span class="tm">${escape(formatClock(receipt.ts_received))}</span>${kindIcon(receipt.action.kind)}<span class="tx">${escape(receiptTitle(receipt))}</span><span class="rt">${outcomeChip(receipt.outcome)}${where}</span></a></li>`;
    })
    .join("\n");
  const oldest = page[page.length - 1];
  const foot = `<div class="more"><span>${escape(t.shown(page.length))}</span>${
    more && oldest !== undefined ? `<a href="${escape(actionsUrl(query, { before: oldest.receipt.ts_received }))}">${escape(t.older)} ›</a>` : query.before !== undefined ? `<a href="${escape(actionsUrl(query, { before: undefined }))}">${escape(t.newest)}</a>` : ""
  }</div>`;
  return `${head}${filters}<section class="card"><ol class="act-list">${items}</ol>${foot}</section>`;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The key code an inspector checks the signatures against, in groups of four. */
export function keyCode(keyId: string): string {
  return keyId.replace(/(.{4})(?=.)/g, "$1 ");
}

/** «Mi prepari le prove?»: one form for the evidence pack, what it does not prove, and what to send to whoever receives it. */
export function evidencePage(view: { records: SystemRecord[]; selected?: string; keyId: string; verifyAddress: string; disclose: string }): string {
  const t = UI.v2.evidence;
  const head = `<header class="q-head"><div><h1>${escape(t.question)}</h1></div></header>`;
  if (view.records.length === 0) {
    return `${head}<div class="card empty-state"><p>${escape(t.noSystems)}</p><a class="button primary" href="/ui/sistemi/nuovo">${escape(UI.v2.actions.createFirst)}</a></div>`;
  }
  const option = (record: SystemRecord): string =>
    `<option value="${escape(record.system_id)}"${record.system_id === view.selected ? " selected" : ""}>${escape(systemTitle(record))}</option>`;
  const form = `<section class="card padded" aria-labelledby="fascicolo-titolo">
<h2 id="fascicolo-titolo" class="sr">${escape(t.title)}</h2>
<form method="post" action="/ui/export" class="evidence-form fields">
<label>${escape(t.system)}<select name="system_id">${view.records.map(option).join("")}</select></label>
<div class="row-fields"><label>${escape(t.from)}<input type="date" name="from"></label><label>${escape(t.to)}<input type="date" name="to"></label></div>
<p class="sign ink">${escape(t.wholeRecord)}</p>
${view.disclose}
<div class="np"><h3>${escape(t.notProven)}</h3><ul>${t.notProvenLines().map((line) => `<li>${escape(line)}</li>`).join("")}</ul></div>
<div><button type="submit" class="primary">${PROOF_ICONS.full.replace("<svg ", '<svg width="18" height="18" ')}${escape(t.download)}</button></div>
<p class="sign ink">${escape(t.contents)}</p>
</form>
</section>`;
  const receiver = `<section class="card padded" aria-labelledby="riceve-titolo">
<h2 id="riceve-titolo" class="card-title">${escape(t.receiver)}</h2>
<ol class="steps-v2">
<li><span class="num">1</span><span>${escape(t.receiverSteps.file)}</span></li>
<li><span class="num">2</span><span>${escape(t.receiverSteps.code)}<br><span class="code-key">${escape(keyCode(view.keyId))}</span></span></li>
<li><span class="num">3</span><span>${escape(t.receiverSteps.verify(view.verifyAddress))}</span></li>
</ol>
</section>
<p><a href="/ui/impostazioni">${escape(t.dailyLink)} ›</a></p>`;
  return `${head}<div class="model-b"><div>${form}</div><div>${receiver}</div></div>`;
}
