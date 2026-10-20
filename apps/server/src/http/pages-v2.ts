import type { Receipt } from "@sigillo/core";
import type { ChainStatus } from "../health/chain-health.js";
import type { ExportRegisterEntry, ReceiptStore, SystemRecord } from "../storage/store.js";
import { connectionStatus } from "../connection/watch.js";
import { capital, escape, kindIcon, languageSwitch, STATE_ICON, systemPath, type SystemRow } from "./layout.js";
import { italianOffered } from "./locale.js";
import { firstSteps, quotaNotice, receiptPath, type Quota } from "./pages.js";
import {
  actionKindLabel,
  formatClock,
  formatCount,
  formatDate,
  formatDayHeading,
  formatTs,
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
  /** One run of an agent, by its trace (SIGILLO_RUNS); needs `system`. */
  run?: string;
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
  const run = text("run");
  return {
    ...(run !== undefined && /^[0-9a-f]{8,64}$/.test(run) ? { run } : {}),
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
  for (const key of ["system", "period", "kind", "outcome", "before", "run"]) {
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
export function actionsPage(view: { store: ReceiptStore; records: SystemRecord[]; query: ActionsQuery; now: Date; runs?: boolean }): string {
  const { store, records, query, now } = view;
  const runs = view.runs === true;
  if (runs && query.run !== undefined && query.system !== undefined) return runPage(store, records, query, now);
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
  let lastRun = "";
  const counts4 = new Map<string, number>();
  if (runs) {
    for (const record of systems) for (const run of store.runsOf(record.system_id, { limit: 500 })) counts4.set(`${record.system_id}/${run.trace}`, run.actions);
  }
  const runKey = (record: SystemRecord, receipt: Receipt): string => (runs && receipt.source.trace_id !== undefined ? `${record.system_id}/${receipt.source.trace_id}` : "");
  const items = page
    .map(({ record, receipt }, index) => {
      const day = formatDayHeading(receipt.ts_received, now);
      const heading = day === lastDay ? "" : `<li class="act-day">${escape(day)}</li>`;
      lastDay = day;
      const where = query.system === undefined ? `<span>${escape(systemTitle(record))}</span>` : "";
      const key = runKey(record, receipt);
      const sameAsBefore = key !== "" && key === lastRun;
      const next = page[index + 1];
      const sameAsNext = key !== "" && next !== undefined && runKey(next.record, next.receipt) === key;
      const header =
        key !== "" && !sameAsBefore
          ? `<li class="run-h"><a href="${escape(actionsUrl(query, { system: record.system_id, run: receipt.source.trace_id, period: "all" }))}">${escape(UI.v2more.runs.header(formatClock(receipt.ts_received), receipt.actor.agent, counts4.get(key) ?? 1))} ›</a></li>`
          : "";
      lastRun = key;
      const thread = key === "" ? "" : ` th${sameAsBefore ? "" : " first"}${sameAsNext ? "" : " last"}`;
      return `${heading}${header}<li><a class="act${thread}" href="${receiptPath(record.system_id, receipt.seq)}"><span class="tm">${escape(formatClock(receipt.ts_received))}</span>${kindIcon(receipt.action.kind)}<span class="tx">${escape(receiptTitle(receipt))}</span><span class="rt">${outcomeChip(receipt.outcome)}${where}</span></a></li>`;
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

/** The three tabs of Prove. */
export function evidenceTabs(current: "pack" | "seals" | "changes", system?: string): string {
  const t = UI.v2.evidence;
  const suffix = system === undefined ? "" : `?system=${encodeURIComponent(system)}`;
  const tab = (name: typeof current, href: string, label: string): string =>
    `<a href="${escape(href)}"${name === current ? ' aria-current="page"' : ""}>${escape(label)}</a>`;
  return `<nav class="tabs-v2" aria-label="${escape(t.title)}">${tab("pack", `/ui/evidence${suffix}`, t.packTab)}${tab("seals", `/ui/evidence/seals${suffix}`, t.seals)}${tab("changes", "/ui/evidence/changes", t.changes)}</nav>`;
}

/** What the evidence pack of one run holds, as the preview says it. */
export interface RunPreview {
  trace: string;
  system: string;
  count: number;
  firstAt: string;
  lastAt: string;
  /** Actions of other runs that fall inside the pack's contiguous window. */
  others: number;
}

/** «Mi prepari le prove?»: one form for the evidence pack, what it does not prove, and what to send to whoever receives it. */
export function evidencePage(view: {
  records: SystemRecord[];
  selected?: string;
  keyId: string;
  verifyAddress: string;
  disclose: string;
  run?: RunPreview;
  /** Whether Avanzato (names, digests) is offered: the operator's. */
  advanced?: boolean;
  /** Packs handed out, when SIGILLO_EXPORT_REGISTER is on. */
  handedOut?: ExportRegisterEntry[];
  /** Offer the pack reader (SIGILLO_PACK_READER). */
  readerLink?: boolean;
  now?: Date;
}): string {
  const t = UI.v2.evidence;
  const head = `<header class="q-head"><div><h1>${escape(t.question)}</h1></div></header>${evidenceTabs("pack", view.selected)}`;
  if (view.records.length === 0) {
    return `${head}<div class="card empty-state"><p>${escape(t.noSystems)}</p><a class="button primary" href="/ui/sistemi/nuovo">${escape(UI.v2.actions.createFirst)}</a></div>`;
  }
  const option = (record: SystemRecord): string =>
    `<option value="${escape(record.system_id)}"${record.system_id === view.selected ? " selected" : ""}>${escape(systemTitle(record))}</option>`;
  const r = UI.v2more.runs;
  let scope: string;
  let reveal = "";
  if (view.run !== undefined) {
    const run = view.run;
    const period = `${capital(formatWhenInline(run.firstAt, view.now ?? new Date()))}${run.firstAt.slice(0, 16) === run.lastAt.slice(0, 16) ? "" : `–${formatClock(run.lastAt)}`}`;
    scope = `<input type="hidden" name="run" value="${escape(run.trace)}"><p class="preview">${escape(run.others === 0 ? r.onlyThese(period, run.count) : r.withOthers(period, run.count, run.others))}</p>`;
    reveal = `<fieldset class="reveal"><legend>${escape(r.disclose)}</legend>
<label class="radio"><input type="radio" name="reveal" value="nothing" checked> <span>${escape(r.revealNothing)}</span></label>
<label class="radio"><input type="radio" name="reveal" value="inputs"> <span>${escape(r.revealInputs(run.count))}</span></label></fieldset>`;
  } else {
    scope = `<div class="row-fields"><label>${escape(t.from)}<input type="date" name="from"></label><label>${escape(t.to)}<input type="date" name="to"></label></div>
<p class="sign ink">${escape(t.wholeRecord)}</p>`;
  }
  const form = `<section class="card padded" aria-labelledby="fascicolo-titolo">
<h2 id="fascicolo-titolo" class="sr">${escape(t.title)}</h2>
<form method="post" action="/ui/export" class="evidence-form fields">
<label>${escape(t.system)}<select name="system_id">${view.records.map(option).join("")}</select></label>
${scope}
${reveal}
${view.advanced === true ? view.disclose : ""}
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
<li><span class="num">3</span><span>${escape(t.receiverSteps.verify(view.verifyAddress))}${view.readerLink === true ? `<br><a href="/ui/verify">${escape(UI.v2more.pack.title)} ›</a>` : ""}</span></li>
</ol>
</section>
<p><a href="/ui/impostazioni">${escape(t.dailyLink)} ›</a></p>`;
  const reg = UI.v2more.register;
  const handed =
    view.handedOut === undefined
      ? ""
      : `<section class="card" aria-labelledby="consegnati-titolo" style="margin-top: 24px"><div class="card-head"><h2 id="consegnati-titolo">${escape(reg.title)}</h2></div>${
          view.handedOut.length === 0
            ? `<p class="empty-state">${escape(reg.empty)}</p>`
            : `<table class="grid-table"><thead><tr><th scope="col">${escape(reg.columns.when)}</th><th scope="col">${escape(reg.columns.what)}</th><th scope="col">${escape(reg.columns.reveals)}</th><th scope="col">${escape(reg.columns.fingerprint)}</th></tr></thead><tbody>${view.handedOut
                .map(
                  (entry) =>
                    `<tr><td>${escape(formatTs(entry.ts))}</td><td>${escape(entry.trace !== null ? reg.run : entry.from === null && entry.to === null ? reg.wholeRecord : reg.period(entry.from === null ? "…" : formatDate(entry.from), entry.to === null ? "…" : formatDate(entry.to)))}</td><td>${escape(entry.disclosure === "nothing" ? reg.nothing : reg.some)}</td><td><code class="code-key">${escape(keyCode(entry.zipSha256.slice(0, 16)))}</code></td></tr>`,
                )
                .join("")}</tbody></table>`
        }</section>`;
  return `${head}<div class="model-b"><div>${form}</div><div>${receiver}</div></div>${handed}`;
}

/** Prove › Sigilli: the hourly seals and their timestamps, a day a line. */
export function sealsPage(view: { store: ReceiptStore; records: SystemRecord[]; selected?: string; now: Date }): string {
  const t = UI.v2more.seals;
  const head = `<header class="q-head"><div><h1>${escape(UI.v2.evidence.question)}</h1></div></header>${evidenceTabs("seals", view.selected)}`;
  const systems = view.selected === undefined ? view.records : view.records.filter((record) => record.system_id === view.selected);
  const days = new Map<string, { stamped: number; plain: number; lines: { at: string; size: number; stamped: boolean; system: string }[] }>();
  for (const record of systems) {
    for (const entry of view.store.readCheckpoints(record.system_id)) {
      const day = localDate(entry.checkpoint.ts) ?? entry.checkpoint.ts.slice(0, 10);
      const slot = days.get(day) ?? { stamped: 0, plain: 0, lines: [] };
      const stamped = view.store.readTimestamps(entry.id).length > 0;
      if (stamped) slot.stamped += 1;
      else slot.plain += 1;
      slot.lines.push({ at: entry.checkpoint.ts, size: entry.checkpoint.tree_size, stamped, system: systemTitle(record) });
      days.set(day, slot);
    }
  }
  const switcher =
    view.records.length < 2
      ? ""
      : `<nav class="filters-v2"><span class="flabel">${escape(t.system)}</span><span class="seg"><a href="/ui/evidence/seals"${view.selected === undefined ? ' aria-current="true"' : ""}>${escape(UI.v2.actions.allSystems)}</a>${view.records
          .map((record) => `<a href="/ui/evidence/seals?system=${escape(encodeURIComponent(record.system_id))}"${view.selected === record.system_id ? ' aria-current="true"' : ""}>${escape(systemTitle(record))}</a>`)
          .join("")}</span></nav>`;
  if (days.size === 0) return `${head}${switcher}<div class="card empty-state"><p>${escape(t.empty)}</p></div>`;
  const rows = [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 31)
    .map(([day, slot]) => {
      const count = slot.stamped + slot.plain;
      const first = slot.lines[0];
      const heading = first === undefined ? day : formatDayHeading(first.at, view.now);
      const note = slot.plain === 0 ? t.stamped : `${slot.plain} ${t.noStamp}`;
      const lines = slot.lines
        .sort((a, b) => (a.at < b.at ? 1 : -1))
        .map((line) => `<li>${escape(formatClock(line.at))} · ${escape(t.actions(line.size))} · ${escape(line.stamped ? t.stamped : t.noStamp)}${systems.length > 1 ? ` · ${escape(line.system)}` : ""}</li>`)
        .join("");
      return `<details class="day-row"><summary><span>${escape(heading)} — ${escape(UI.v2more.seals.day("", count).replace(/^ — /, ""))}</span><span class="sign ${slot.plain === 0 ? "ink" : "yellow"}">${escape(note)}</span></summary><ul>${lines}</ul></details>`;
    })
    .join("");
  return `${head}${switcher}<section class="card">${rows}</section>`;
}

/** Prove › Modifiche: who changed what, from the administrative log, by day. */
export function changesPage(view: { lines: { ts: string; text: string }[]; now: Date }): string {
  const t = UI.v2more.changes;
  const head = `<header class="q-head"><div><h1>${escape(UI.v2.evidence.question)}</h1></div></header>${evidenceTabs("changes")}`;
  if (view.lines.length === 0) return `${head}<div class="card empty-state"><p>${escape(t.empty)}</p></div>`;
  let day = "";
  const rows = view.lines
    .map((line) => {
      const heading = formatDayHeading(line.ts, view.now);
      const mark = heading === day ? "" : `<li class="act-day">${escape(heading)}</li>`;
      day = heading;
      return `${mark}<li class="act" style="grid-template-columns: 48px minmax(0, 1fr)"><span class="tm">${escape(formatClock(line.ts))}</span><span class="tx">${escape(line.text)}</span></li>`;
    })
    .join("");
  return `${head}<section class="card"><ol class="act-list">${rows}</ol></section>`;
}

/** The seal that covers a run, in words: "sealed at 17:00, timestamped" or "not sealed yet". */
function runSeal(store: ReceiptStore, systemId: string, lastSeq: number): string {
  const t = UI.v2more.runs;
  const covering = store.readCheckpoints(systemId).find((entry) => entry.checkpoint.tree_size > lastSeq);
  if (covering === undefined || store.readTimestamps(covering.id).length === 0) return t.sealedLater;
  return t.sealed(formatClock(covering.checkpoint.ts));
}

/** One run of an agent, as a list: the actions that share a trace, in the order they happened. */
function runPage(store: ReceiptStore, records: SystemRecord[], query: ActionsQuery, now: Date): string {
  const t = UI.v2more.runs;
  const record = records.find((candidate) => candidate.system_id === query.system);
  const receipts = record === undefined || query.run === undefined ? [] : store.runReceipts(record.system_id, query.run).filter((receipt) => receipt.action.kind !== "genesis");
  const back = `<p><a href="${escape(actionsUrl({ ...query }, { run: undefined, period: "7d" }))}">‹ ${escape(t.back)}</a></p>`;
  if (record === undefined || query.run === undefined || receipts.length === 0) {
    return `<header class="q-head"><div><h1>${escape(UI.v2.actions.question)}</h1></div></header><div class="card empty-state"><p>${escape(t.unknown)}</p></div>${back}`;
  }
  const first = receipts[0] as Receipt;
  const last = receipts[receipts.length - 1] as Receipt;
  const prepare = `/ui/evidence?system=${escape(encodeURIComponent(record.system_id))}&amp;run=${escape(query.run)}`;
  const rows = receipts
    .map((receipt, index) => {
      const thread = ` th${index === 0 ? " first" : ""}${index === receipts.length - 1 ? " last" : ""}`;
      return `<li><a class="act${thread}" href="${receiptPath(record.system_id, receipt.seq)}"><span class="tm">${escape(formatClock(receipt.ts_received))}</span>${kindIcon(receipt.action.kind)}<span class="tx">${escape(receiptTitle(receipt))}</span><span class="rt">${outcomeChip(receipt.outcome)}</span></a></li>`;
    })
    .join("\n");
  return `<header class="q-head"><div><h1>${escape(UI.v2.actions.question)}</h1></div><a class="button primary" href="${prepare}">${ICONS.download}${escape(t.prepare)}</a></header>
<div class="run-band"><span>${escape(t.band(formatWhenInline(first.ts_received, now), first.actor.agent, receipts.length))} · ${escape(runSeal(store, record.system_id, last.seq))}</span><a class="button" href="${escape(actionsUrl({ ...query }, { run: undefined, period: "7d" }))}">${escape(t.remove)} ✕</a></div>
<section class="card"><ol class="act-list">${rows}</ol><div class="more"><span>${escape(UI.v2.actions.shown(receipts.length))}</span><a href="/ui/verify-document?run=${escape(query.run)}&amp;system=${escape(encodeURIComponent(record.system_id))}">${escape(t.checkDocument)} ›</a></div></section>${back}`;
}


/** The keys of a system, under Collega: when each was made, one to retire, one to add (SIGILLO_EXTRA_KEYS). */
export function keysSection(systemId: string, active: { keyId: string; createdAt: string }[], extra: boolean, neverConnected: boolean): string {
  const t = UI.v2more.keys;
  const path = systemPath(systemId);
  const rows =
    active.length === 0
      ? `<p class="empty-state">${escape(t.none)}</p>`
      : active
          .map(
            (key) =>
              `<div class="keyline"><span>${escape(t.current(formatDate(key.createdAt)))} <code class="mono-s">${escape(key.keyId)}</code></span>${
                extra && active.length > 1
                  ? `<form method="post" action="${path}/key/retire"><input type="hidden" name="key_id" value="${escape(key.keyId)}"><button type="submit">${escape(t.retire)}</button></form>`
                  : "<span></span>"
              }<span></span></div>`,
          )
          .join("");
  const action = extra
    ? `<form method="post" action="${path}/key"><input type="hidden" name="mode" value="add"><button type="submit" class="primary">${escape(t.add)}</button></form>`
    : neverConnected
      ? `<form method="post" action="${path}/key"><button type="submit" class="primary">${escape(t.prepare)}</button></form>`
      : `<a class="button" href="${path}/manage#nuova-chiave">${escape(t.newKey)}</a>`;
  return `<section class="card" style="margin-top: 24px" aria-labelledby="chiavi-titolo"><div class="card-head"><h2 id="chiavi-titolo">${escape(t.title)}</h2>${action}</div>${rows}</section>`;
}


/** The two tabs of Amministrazione. */
export function adminTabs(current: "customers" | "service"): string {
  const tab = (name: typeof current, href: string, label: string): string => `<a href="${href}"${name === current ? ' aria-current="page"' : ""}>${escape(label)}</a>`;
  return `<nav class="tabs-v2" aria-label="${escape(UI.v2.nav.admin)}">${tab("customers", "/ui/clienti", UI.nav.clienti)}${tab("service", "/ui/admin/service", UI.v2more.service.title)}</nav>`;
}

/** Amministrazione › Servizio: the signer, the timestamp authority, the seals, the switches. */
export function servicePage(view: {
  signerOk: boolean;
  keyCode: string;
  tsaUrl?: string;
  checkpointMinutes: number;
  chains: number;
  lastSeal?: string;
  switches: Record<string, string>;
  version: string;
  now: Date;
}): string {
  const t = UI.v2more.service;
  const word = (value: string): string => (value === "all" ? t.switchAll : value === "operator" ? t.switchOperator : t.switchOff);
  const line = (label: string, value: string, action = ""): string => `<div class="vline"><span class="k">${escape(label)}</span><span>${value}</span><span>${action}</span></div>`;
  const NAMES: Record<string, string> = {
    consoleV2: "SIGILLO_CONSOLE_V2",
    runs: "SIGILLO_RUNS",
    extraKeys: "SIGILLO_EXTRA_KEYS",
    exportRegister: "SIGILLO_EXPORT_REGISTER",
    reportLanguage: "SIGILLO_REPORT_LANGUAGE",
    packReader: "SIGILLO_PACK_READER",
    siteV2: "SIGILLO_SITE_V2",
    agentUpload: "SIGILLO_AGENT_UPLOAD",
    transfer: "SIGILLO_TRANSFER",
  };
  const switches = Object.entries(view.switches)
    .filter(([key]) => NAMES[key] !== undefined)
    .map(([key, value]) => `<span class="chip"><code class="mono-s">${NAMES[key]}</code> ${escape(word(value))}</span>`)
    .join(" ");
  return `<header class="q-head"><div><h1>${escape(UI.v2.nav.admin)}</h1></div></header>${adminTabs("service")}
<div class="vlines">
${line(t.signer, view.signerOk ? sign("green", t.responds, view.keyCode) : sign("red", UI.chain.red))}
${line(t.stamp, view.tsaUrl === undefined ? sign("neutral", t.stampNone) : sign("green", t.stampLine(view.tsaUrl)))}
${line(t.seals, `${escape(t.sealsLine(view.checkpointMinutes, view.chains))}${view.lastSeal === undefined ? "" : ` · ${escape(formatWhenInline(view.lastSeal, view.now))}`}`, `<form method="post" action="/ui/checkpoint"><button type="submit">${escape(t.sealNow)}</button></form>`)}
${line(t.switches, `<span class="hstack">${switches}</span>`)}
${view.switches["siteV2"] !== undefined && view.switches["siteV2"] !== "off" ? line("Sito nuovo / New site", `<a href="/ui/admin/site">/ui/admin/site</a>`) : ""}
${view.switches["packReader"] !== undefined && view.switches["packReader"] !== "off" ? line(UI.v2more.pack.title, `<a href="/ui/verify">/ui/verify</a>`) : ""}
${line(t.version, escape(view.version))}
</div>`;
}

/** Account: who is signed in, the organization and its quota, appearance, language. */
export function accountPageV2(view: { account: { name: string; detail: string }; operator: boolean; quota: Quota | null; theme: "light" | "dark" | "system"; back: string }): string {
  const t = UI.v2more.account;
  const themeButton = (value: "light" | "dark" | "system", label: string): string =>
    `<button type="submit" name="theme" value="${value}" aria-pressed="${view.theme === value}">${escape(label)}</button>`;
  const quota =
    view.quota === null
      ? ""
      : `<div class="vline"><span class="k">${escape(t.organization)}</span><span>${escape(view.account.name)}<br><span class="sign ink">${escape(t.quota(formatCount(view.quota.used), formatCount(view.quota.limit)))}</span></span><span></span></div>`;
  return `<header class="q-head"><div><h1>${escape(t.title)}</h1></div></header>
<div class="mC"><div class="vlines">
<div class="vline"><span class="k">${escape(t.you)}</span><span>${escape(view.operator ? view.account.name : view.account.detail)}</span><form method="post" action="/ui/logout"><button type="submit">${escape(t.signOut)}</button></form></div>
${quota}
<div class="vline"><span class="k">${escape(t.appearance)}</span><form method="post" action="/ui/impostazioni/tema" class="seg"><input type="hidden" name="back" value="${escape(view.back)}">${themeButton("light", UI.settings.themes.light)}${themeButton("dark", UI.settings.themes.dark)}${themeButton("system", UI.settings.themes.system)}</form><span></span></div>
${italianOffered() ? `<div class="vline"><span class="k">${escape(t.language)}</span>${languageSwitch("seg", view.back)}<span></span></div>` : ""}
</div></div>`;
}


/** The pack reader's page (SIGILLO_PACK_READER): choose a pack, see what the inspector needs; all in the browser. */
export function packReaderPage(): string {
  const t = UI.v2more.pack;
  const texts = {
    keyCode: t.keyCode,
    keyMatches: t.keyMatches("{code}"),
    keyDiffers: t.keyDiffers,
    when: t.when,
    existedBy: t.existedBy("{when}", "{authority}"),
    whenLimit: t.whenLimit,
    contents: t.contents,
    checkDocument: t.checkDocument,
    docFound: t.docFound("{when}", "{label}", "{action}"),
    docNotFound: t.docNotFound,
    notProven: t.notProven,
    notProvenLines: t.notProvenLines(),
    full: t.full,
    fullHint: t.fullHint,
    ...UI.v2more.packReader,
  };
  const icon = (kind: string, svg: string): string => `<template id="icon-${kind}">${svg}</template>`;
  return `<header class="q-head"><div><h1>${escape(t.question)}</h1></div></header>
<div id="reader" data-texts="${escape(JSON.stringify(texts))}" class="mC">
<label class="drop" for="pack"><span>${escape(t.stays)}</span><span class="button">${escape(t.choose)}</span><input type="file" id="pack" accept=".zip,application/zip" class="sr"></label>
<div id="result" hidden></div>
${icon("ok", STATE_ICONS.ok)}${icon("bad", STATE_ICONS.bad)}${icon("warn", STATE_ICONS.warn)}${icon("neutral", STATE_ICONS.archived)}
<noscript><p class="notice warn">${escape(t.stays)}</p></noscript>
</div>
<script src="/ui/pack-reader.js" defer></script>`;
}
