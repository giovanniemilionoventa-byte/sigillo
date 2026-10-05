import type { DocumentFingerprints, Receipt } from "@sigillo/core";
import type { AdminLogEntry, DocumentMatch, ReceiptStore, SystemRecord } from "../storage/store.js";
import type { ChainStatus } from "../health/chain-health.js";
import type { StoredExport } from "../backup/daily-export.js";
import { connectionStatus } from "../connection/watch.js";
import type { ProviderKeyRecord } from "../gateway/provider-keys.js";
import { discloseFields } from "./history.js";
import {
  archivedButShown,
  archivedPill,
  capital,
  chainPill,
  escape,
  initials,
  kindIcon,
  languageSwitch,
  notices,
  outcomePill,
  pageHead,
  STATE_ICON,
  systemPath,
  worstStatus,
  type Account,
  type SystemRow,
} from "./layout.js";
import {
  adminActor,
  describeAdminAction,
  describeDocumentMatch,
  formatCount,
  formatDate,
  formatListTime,
  formatTs,
  formatWhen,
  formatWhenInline,
  localDate,
  localDayRange,
  receiptTitle,
  systemTitle,
  UI,
} from "./strings.js";
import { ICONS, STATE_ICONS } from "./style.js";

/**
 * The pages of the web view other than a system's history: the main page,
 * the first steps, the systems, a new one, connecting an agent, managing a
 * system, its seals, the people, the customers, the settings, the result of
 * checking a document, and "not found". Each returns what goes inside
 * <main>; layout.ts puts it in the shell and ui.ts decides which one a
 * request gets.
 */

/** A link to one receipt, opened in its system's history. */
export function receiptPath(systemId: string, seq: number): string {
  return `${systemPath(systemId)}?ricevuta=${seq}#r-${seq}`;
}

const chevron = ICONS.chevronRight.replace("<svg ", '<svg class="chevron" ');


/** An organization's use of its monthly quota, when it has one. */
export interface Quota {
  used: number;
  limit: number;
  /** The first day of next month, when writes resume. */
  resume: string;
}

/** The quota as a notice: at 90% a warning, at the limit an alert. Nothing below. */
export function quotaNotice(quota: Quota | null): string {
  if (quota === null || quota.used < quota.limit * 0.9) return "";
  if (quota.used >= quota.limit) {
    return `<p class="notice bad" role="alert">${STATE_ICONS.bad}<span>${escape(UI.home.quotaFull(formatCount(quota.limit), formatDate(quota.resume)))}</span></p>`;
  }
  return `<p class="notice warn" role="status">${STATE_ICONS.warn}<span>${escape(UI.home.quotaNear(formatCount(quota.used), formatCount(quota.limit)))}</span></p>`;
}

/** The main page's one line: the situation, by the worst state shown, and where to look. */
export function homeStatus(shown: SystemRow[]): string {
  const t = UI.home.summary;
  if (shown.length === 0) return "";
  const worst = worstStatus(shown.map(({ health }) => health.status));
  const first = shown.find(({ health }) => health.status === worst);
  const count = shown.filter(({ health }) => health.status === worst).length;
  const words = worst === "red" ? t.red(count) : worst === "yellow" ? t.yellow(count) : t.green;
  const link =
    worst === "green" || first === undefined
      ? ""
      : `<a href="${systemPath(first.record.system_id)}">${escape(worst === "red" ? t.open : t.why)}</a>`;
  return `<div class="status ${worst}" role="status" data-status="${worst}">${STATE_ICON[worst]}<span>${escape(words)}</span>${link}</div>`;
}

/** The four figures: actions today, blocked and failed today, the last seal. */
function tiles(store: ReceiptStore, shown: SystemRow[], now: Date): string {
  const t = UI.home.tiles;
  const today = localDate(now.toISOString());
  const from = today === null ? undefined : localDayRange(today).from;
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
  const tile = (value: string, label: string, state = ""): string =>
    `<div class="card tile${state === "" ? "" : ` ${state}`}"><strong>${escape(value)}</strong><span>${escape(label)}</span></div>`;
  return `<div class="tiles">
${tile(formatCount(all), t.today)}
${tile(formatCount(blocked), t.blocked, blocked > 0 ? "yellow" : "")}
${tile(formatCount(failed), t.failed, failed > 0 ? "red" : "")}
${tile(lastSeal === null ? "—" : formatListTime(lastSeal, now), t.lastSeal)}
</div>`;
}

/** The first steps, for an account with no system yet, or with systems that never received an action. */
export function firstSteps(records: SystemRecord[]): string {
  const t = UI.home.steps;
  const created = records.length > 0;
  const step = (done: boolean, icon: string, tile: string, title: string, end: string, later = false): string =>
    `<li><div class="line${later ? " later" : ""}"><span class="tile-icon ${done ? "green" : tile}" aria-hidden="true">${done ? STATE_ICONS.ok : icon}</span><span class="line-text">${escape(title)}</span>${
      done ? `<span class="pill green">${STATE_ICONS.ok}${escape(t.done)}</span>` : end
    }</div></li>`;
  const first = records[0];
  return `${pageHead(UI.home.welcome)}
<ol class="card lines steps">
${step(true, "", "green", t.account, "")}
${step(created, ICONS.plus, "blue", t.create, `<a class="button primary" href="/ui/sistemi/nuovo">${escape(t.createButton)}</a>`)}
${step(
  false,
  ICONS.code,
  created ? "blue" : "grey",
  t.connect,
  first === undefined ? "" : `<a class="button primary" href="${systemPath(first.system_id)}/collega">${escape(t.connectButton)}</a>`,
  !created,
)}
${step(false, ICONS.seal, "grey", t.receive, "", true)}
</ol>`;
}

/** The main page: the situation, four figures, the systems, the latest actions, and the evidence file. */
export function homePage(view: {
  store: ReceiptStore;
  records: SystemRecord[];
  shown: SystemRow[];
  justCheckpointed: boolean;
  quota: Quota | null;
  now: Date;
}): string {
  const { store, records, shown, now } = view;
  const t = UI.home;
  const top = `${view.justCheckpointed ? notices({ notice: t.checkpointDone }) : ""}${quotaNotice(view.quota)}`;
  if (records.length === 0 || records.every((record) => record.receipts <= 1)) {
    return `${top}${firstSteps(records)}`;
  }

  const systems = shown
    .map(({ record, health }) => {
      // An archived system is here only for a reason, and the reason is said beside it.
      const reason = archivedButShown(record, health.status);
      const archived = reason === null ? "" : `<span class="line-aside">${escape(capital(reason))}</span>${archivedPill()}`;
      return `<li><a class="line" href="${systemPath(record.system_id)}"><span class="line-text">${escape(systemTitle(record))}</span>${archived}${chainPill(health.status)}${chevron}</a></li>`;
    })
    .join("\n");

  const recent = shown
    .flatMap(({ record }) => store.searchReceipts({ systemId: record.system_id, limit: 6 }).map((receipt) => ({ record, receipt })))
    .sort((a, b) => (a.receipt.ts_received < b.receipt.ts_received ? 1 : -1))
    .slice(0, 6);
  const activity = recent
    .map(
      ({ record, receipt }) =>
        `<li><a class="line" href="${receiptPath(record.system_id, receipt.seq)}"><span class="line-time">${escape(formatListTime(receipt.ts_received, now))}</span>${kindIcon(receipt.action.kind)}<span class="line-text">${escape(receiptTitle(receipt))}</span><span class="line-aside system">${escape(systemTitle(record))}</span>${
          receipt.outcome === "ok" ? "" : outcomePill(receipt.outcome)
        }</a></li>`,
    )
    .join("\n");

  const option = (record: SystemRecord): string => `<option value="${escape(record.system_id)}">${escape(systemTitle(record))}</option>`;
  const active = records.filter((record) => record.archived_at === null);
  const archived = records.filter((record) => record.archived_at !== null);
  const evidence = `<section aria-labelledby="fascicolo-titolo">
<h2 id="fascicolo-titolo">${escape(t.evidence)}</h2>
<div class="card padded">
<form method="post" action="/ui/export" class="fields">
<label>${escape(t.chooseSystem)}
  <select name="system_id">${active.map(option).join("")}${
    archived.length === 0 ? "" : `<optgroup label="${escape(t.archivedGroup)}">${archived.map(option).join("")}</optgroup>`
  }</select>
</label>
<div class="fields-row"><label>${escape(t.fromDate)}<input type="date" name="from"></label><label>${escape(t.toDate)}<input type="date" name="to"></label></div>
${discloseFields()}
<button type="submit" class="primary wide">${ICONS.download}${escape(t.generate)}</button>
</form>
</div>
<form method="post" action="/ui/checkpoint" class="section"><button type="submit" class="wide">${ICONS.seal}${escape(t.checkpointNow)}</button></form>
</section>`;

  return `${pageHead(t.heading)}
${top}${homeStatus(shown)}
${tiles(store, shown, now)}
<div class="cols">
<div>
<section class="section" aria-labelledby="sistemi-titolo"><h2 id="sistemi-titolo">${escape(t.systems)}</h2>
<ul class="card lines">${systems}</ul></section>
<section class="section" aria-labelledby="azioni-titolo"><h2 id="azioni-titolo">${escape(t.recent)}</h2>
${recent.length === 0 ? `<p class="card empty">${escape(t.noActions)}</p>` : `<ol class="card lines">${activity}</ol>`}</section>
</div>
${evidence}
</div>`;
}

export type SystemsView = "attivi" | "archiviati" | "tutti";

/** The systems: the active, archived or all of them, as a table, and the button to create one. */
export function sistemiPage(
  store: ReceiptStore,
  view: SystemsView,
  extra: { notice?: string; error?: string },
  statusOf: (systemId: string) => ChainStatus,
  now: Date,
): string {
  const t = UI.systemsPage;
  const records = store.listSystemRecords();
  const inView = records.filter((record) =>
    view === "tutti" ? true : view === "archiviati" ? record.archived_at !== null : record.archived_at === null,
  );
  const count = (candidate: SystemsView): number =>
    candidate === "tutti" ? records.length : records.filter((record) => (candidate === "archiviati") === (record.archived_at !== null)).length;

  const views = `<nav class="segmented views" aria-label="${escape(t.heading)}">${(["attivi", "archiviati", "tutti"] as const)
    .map(
      (candidate) =>
        `<a href="/ui/sistemi?vista=${candidate}"${candidate === view ? ' aria-current="page"' : ""}>${escape(t.views[candidate])}<span class="count">${count(candidate)}</span></a>`,
    )
    .join("")}</nav>`;

  const connection = (record: SystemRecord): string => {
    const heartbeat = connectionStatus(store, record.system_id);
    if (heartbeat !== null) {
      return heartbeat.state === "open" ? t.connection.open : t.connection[heartbeat.state](formatTs(heartbeat.since));
    }
    const latest = store.searchReceipts({ systemId: record.system_id, limit: 1 })[0];
    return latest === undefined || latest.action.kind === "genesis" ? t.connection.none : t.connection[latest.source.type];
  };
  const archivedView = view === "archiviati";
  const rows = inView
    .map((record) => {
      const state = record.archived_at === null ? chainPill(statusOf(record.system_id)) : archivedPill();
      const when = archivedView
        ? record.archived_at === null
          ? "—"
          : formatDate(record.archived_at)
        : record.receipts <= 1 || record.last_received === null
          ? "—"
          : formatWhen(record.last_received, now);
      return `<li><a class="line" href="${systemPath(record.system_id)}"><span class="cell-main"><strong>${escape(systemTitle(record))}</strong><span>${escape(connection(record))}</span></span><span>${state}</span><span class="num">${formatCount(record.receipts)}</span><span class="when">${escape(when)}</span></a></li>`;
    })
    .join("\n");
  const list =
    inView.length === 0
      ? `<p class="card empty">${escape(t.noneInView[view])}</p>`
      : `<ul class="card lines table">
<li class="line head" aria-hidden="true"><span>${escape(t.columns.system)}</span><span>${escape(t.columns.state)}</span><span class="num">${escape(t.columns.receipts)}</span><span class="when">${escape(archivedView ? t.columns.archived : t.columns.last)}</span></li>
${rows}</ul>`;

  return `${pageHead(t.heading, `<a class="button primary" href="/ui/sistemi/nuovo">${ICONS.plus}${escape(UI.nav.newSystem)}</a>`)}
${notices(extra)}
${views}
${list}`;
}

/** Creating a system: its name, and the identifier, which may be left to follow from the name. */
export function newSystemPage(extra: { error?: string }, values: { system_id?: string; display_name?: string } = {}): string {
  const t = UI.systemsPage;
  return `<div class="narrow">${pageHead(t.newTitle)}
${notices(extra)}
<form method="post" action="/ui/sistemi" class="card padded fields">
<label>${escape(t.displayNameLabel)}
  <input type="text" name="display_name" value="${escape(values.display_name ?? "")}" maxlength="128" placeholder="${escape(t.displayNamePlaceholder)}" autofocus>
</label>
<details class="fold"${(values.system_id ?? "") === "" ? "" : " open"}><summary>${ICONS.chevronRight}<span>${escape(t.nameLabel)}</span></summary>
<div class="fold-body"><label><span class="sr">${escape(t.nameLabel)}</span>
  <input type="text" name="system_id" value="${escape(values.system_id ?? "")}" class="mono" placeholder="${escape(t.namePlaceholder)}" autocapitalize="off" autocomplete="off" spellcheck="false">
</label></div>
</details>
<button type="submit" class="primary big">${escape(t.submit)}</button>
</form></div>`;
}

/**
 * How to connect an agent, with the key in the snippet, or a placeholder where
 * it is not shown. Python only: its heartbeat is what lets sigillo say when an
 * agent was disconnected (connection/watch.ts). The OpenTelemetry and HTTP
 * endpoints still answer, the SDK itself sends to the first, but neither is
 * offered here.
 */
function connectWays(systemId: string, endpoint: string, token: string | null, model: boolean): string {
  const t = UI.connect;
  const key = token ?? t.keyPlaceholder;
  const python = [
    `# pip install -e 'sdk-python[langchain]'   ${UI.snippet.extras}`,
    "import sigillo",
    "",
    "sigillo.init(",
    `    endpoint="${endpoint}",`,
    `    api_key="${key}",`,
    `    system_id="${systemId}",`,
    '    instrument=["langchain"],',
    ")",
  ].join("\n");
  const pythonWay = `<label class="way" for="way-python"><span class="tile-icon blue" aria-hidden="true">${ICONS.python}</span>${escape(t.ways.python)}</label>`;
  if (!model) {
    return `<input type="radio" name="way" id="way-python" class="sr" checked>
<div class="ways">
${pythonWay}
</div>
<pre class="code python">${escape(python)}</pre>`;
  }
  // The model gateway (gateway/llm.ts): the customer's model key stays in
  // sigillo, and the agent reaches its model only through it.
  const gateway = [
    `# 1. ${t.modelStep1}`,
    `# 2. ${t.modelStep2}`,
    "from openai import OpenAI",
    "",
    "client = OpenAI(",
    `    base_url="${endpoint}/llm/openai/v1",`,
    `    api_key="${key}",`,
    ")",
    "",
    "# Anthropic, Claude Code",
    `ANTHROPIC_BASE_URL=${endpoint}/llm/anthropic`,
    `ANTHROPIC_API_KEY=${key}`,
    "",
    "# Google Gemini (google-genai)",
    "client = genai.Client(",
    `    api_key="${key}",`,
    `    http_options={"base_url": "${endpoint}/llm/gemini"},`,
    ")",
  ].join("\n");
  return `<input type="radio" name="way" id="way-python" class="sr" checked>
<input type="radio" name="way" id="way-model" class="sr">
<div class="ways">
${pythonWay}
<label class="way" for="way-model"><span class="tile-icon blue" aria-hidden="true">${ICONS.link}</span>${escape(t.ways.model)}</label>
</div>
<pre class="code python">${escape(python)}</pre>
<pre class="code model">${escape(gateway)}</pre>`;
}

/**
 * Connecting an agent: right after creating a system or giving it a new key,
 * with the key shown this once; or later, from the system's settings, without
 * it. Until the first action arrives the later page looks again by itself
 * every ten seconds (a refresh, not a script).
 */
export function connectPage(view: {
  record: SystemRecord;
  endpoint: string;
  token: string | null;
  mode: "created" | "newKey" | "connect";
  firstReceipt: Receipt | null;
  now: Date;
  /** Whether to offer the model gateway as a second way (a customer's system the gateway is open to). */
  model?: boolean;
}): string {
  const t = UI.connect;
  const { record, token, mode } = view;
  const name = systemTitle(record);
  const title = mode === "created" ? t.ready(name) : mode === "newKey" ? t.newKey(name) : t.title(name);
  const path = systemPath(record.system_id);
  const key =
    token === null
      ? ""
      : `<p class="label">${escape(t.keyLabel)}</p>
<code class="keybox">${escape(token)}</code>
<p class="key-note" role="status">${STATE_ICONS.warn}<span>${escape(t.keyNote)}</span></p>`;
  const arrived = view.firstReceipt;
  const wait =
    arrived !== null
      ? `<div class="card wait-line green" role="status">${STATE_ICONS.ok}<span>${escape(t.arrived(formatWhen(arrived.ts_received, view.now)))}</span><a class="button primary end" href="${path}">${escape(t.goToSystem)}</a></div>`
      : mode === "newKey"
        ? `<p class="section"><a class="button primary" href="${path}">${escape(t.goToSystem)}</a></p>`
        : `${mode === "connect" ? '<meta http-equiv="refresh" content="10">' : ""}<div class="card wait-line" role="status"><span class="spinner" aria-hidden="true"></span><span>${escape(t.waiting)}</span><a class="end" href="${path}/collega">${escape(t.check)}</a></div>`;
  return `<div class="narrow">${pageHead(title)}
${key}
${mode === "connect" ? "" : `<h2>${escape(t.heading)}</h2>`}
${connectWays(record.system_id, view.endpoint, token, view.model ?? false)}
${wait}
</div>`;
}

/** The model gateway's block on a system's page (gateway/llm.ts): present only where the gateway is open to the system. */
export interface ManageModel {
  endpoint: string;
  saved: ProviderKeyRecord[];
}

const PROVIDER_NAMES: Record<ProviderKeyRecord["provider"], string> = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Google Gemini" };

/** A system's settings: its name, identifier and key, connecting it, archiving it, and deleting it while its chain is empty. */
export function managePage(
  record: SystemRecord,
  extra: { notice?: string; error?: string },
  keyIds: string[],
  model: ManageModel | null = null,
): string {
  const t = UI.manage;
  const path = systemPath(record.system_id);
  const deletable = record.receipts <= 1;
  const block = (tile: string, glyph: string, title: string, body: string): string =>
    `<section class="card block"><span class="tile-icon ${tile}" aria-hidden="true">${glyph}</span><div><h2>${escape(title)}</h2>${body}</div></section>`;

  const archive =
    record.archived_at === null
      ? `<form method="post" action="${path}/archive"><button type="submit">${ICONS.archive}${escape(t.archiveSubmit)}</button></form>`
      : `<p>${escape(t.archivedOn(formatDate(record.archived_at)))}</p>
<form method="post" action="${path}/unarchive"><button type="submit" class="primary">${escape(t.unarchiveSubmit)}</button></form>`;

  const removal = deletable
    ? `<form method="post" action="${path}/delete" class="inline">
  <label><span class="sr">${escape(t.deleteConfirmLabel(record.system_id))}</span>
    <input type="text" name="confirm" placeholder="${escape(t.deleteConfirmLabel(record.system_id))}" autocomplete="off" autocapitalize="off" spellcheck="false" required>
  </label>
  <button type="submit" class="danger">${ICONS.trash}${escape(t.deleteSubmit)}</button>
</form>`
    : `<p class="lockline">${ICONS.lock}<span>${escape(t.deleteRefused(record.receipts))}</span></p>`;

  const current = keyIds.length === 0 ? t.noKey : keyIds.map((id) => `sigillo_${id}_••••`).join(", ");
  const keySheet = `<section class="sheet-layer" id="nuova-chiave" aria-labelledby="nuova-chiave-titolo">
<div class="sheet"><form method="post" action="${path}/key">
<div class="sheet-body"><h2 id="nuova-chiave-titolo">${escape(t.newKey)}</h2><p>${escape(t.newKeyConfirm)}</p></div>
<div class="sheet-foot"><a class="button" href="#main">${escape(UI.exportSheet.cancel)}</a><button type="submit" class="primary">${ICONS.key}${escape(t.newKeySubmit)}</button></div>
</form></div>
</section>`;

  const modelBlock =
    model === null
      ? ""
      : block(
          "blue",
          ICONS.link,
          t.modelTitle,
          `${model.saved
            .map(
              (saved) => `<form method="post" action="${path}/llm-key/delete" class="inline">
  <input type="hidden" name="provider" value="${saved.provider}">
  <code class="keybox">${escape(`${PROVIDER_NAMES[saved.provider]} ••••${saved.last4}`)}</code>
  <button type="submit">${ICONS.trash}${escape(t.modelRemove)}</button>
</form>`,
            )
            .join("\n")}
<form method="post" action="${path}/llm-key" class="inline${model.saved.length === 0 ? "" : " section"}">
  <label><span class="sr">${escape(t.modelProvider)}</span>
    <select name="provider">${Object.entries(PROVIDER_NAMES)
      .map(([value, name]) => `<option value="${value}">${escape(name)}</option>`)
      .join("")}</select>
  </label>
  <label><span class="sr">${escape(t.modelKeyLabel)}</span>
    <input type="password" name="key" placeholder="${escape(t.modelKeyLabel)}" autocomplete="off" spellcheck="false" required>
  </label>
  <button type="submit" class="primary">${escape(t.modelSave)}</button>
</form>
<pre class="code section">${escape(
            [
              `# OpenAI`,
              `base_url="${model.endpoint}/llm/openai/v1"`,
              `api_key="${UI.connect.keyPlaceholder}"`,
              "",
              `# Anthropic, Claude Code`,
              `ANTHROPIC_BASE_URL=${model.endpoint}/llm/anthropic`,
              `ANTHROPIC_API_KEY=${UI.connect.keyPlaceholder}`,
              "",
              `# Google Gemini`,
              `base_url="${model.endpoint}/llm/gemini"`,
              `api_key="${UI.connect.keyPlaceholder}"`,
            ].join("\n"),
          )}</pre>`,
        );

  return `${notices(extra)}
<div class="blocks">
${block(
  "blue",
  ICONS.tag,
  t.nameTitle,
  `<form method="post" action="${path}/rename" class="inline">
  <label><span class="sr">${escape(t.nameLabel)}</span>
    <input type="text" name="display_name" value="${escape(record.display_name ?? "")}" maxlength="128" placeholder="${escape(record.system_id)}">
  </label>
  <button type="submit" class="primary">${escape(t.nameSubmit)}</button>
</form>`,
)}
${block("grey", ICONS.code, t.idTitle, `<code class="keybox">${escape(record.system_id)}</code>`)}
${block(
  "grey",
  ICONS.key,
  t.keyTitle,
  `<div class="inline"><code class="keybox" aria-label="${escape(t.keyLabel)}">${escape(current)}</code><a class="button" href="#nuova-chiave">${escape(t.newKey)}</a></div>
<p class="section"><a href="${path}/collega">${escape(t.connect)}</a></p>`,
)}
${modelBlock}
${block("grey", ICONS.archive, t.archiveTitle, archive)}
${block("red", ICONS.trash, t.deleteTitle, removal)}
</div>
${keySheet}`;
}

/** A system's seals, newest first: how many receipts each covers, and its timestamp or the wait for one. */
export function checkpointsPage(store: ReceiptStore, systemId: string, now: Date): string {
  const t = UI.checkpoints;
  const checkpoints = store.readCheckpoints(systemId).slice().reverse();
  const items = checkpoints
    .map((stored) => {
      const tokens = store.readTimestamps(stored.id);
      const stamp =
        tokens.length === 0
          ? `<span class="pill yellow">${STATE_ICONS.warn}${escape(t.waiting)}</span>`
          : `<span class="pill green">${STATE_ICONS.ok}${escape(t.stamped)}</span>`;
      const facts = [
        `<div><dt>${escape(t.written)}</dt><dd>${escape(formatTs(stored.checkpoint.ts))}</dd></div>`,
        `<div class="stack"><dt>${escape(t.root)}</dt><dd><code class="hash-full">${escape(stored.checkpoint.root_hash)}</code></dd></div>`,
        ...tokens.map(
          (token) =>
            `<div><dt>${escape(t.attested)}</dt><dd>${escape(token.genTime === undefined ? t.genTimeUnreadable : formatTs(token.genTime))}</dd></div>
<div><dt>${escape(t.authority)}</dt><dd><code>${escape(token.tsaUrl)}</code></dd></div>`,
        ),
      ];
      return `<li><details class="tech"><summary class="line"><span class="tile-icon green" aria-hidden="true">${ICONS.seal}</span><span class="line-text">${escape(t.sealed(stored.checkpoint.tree_size))} <span class="muted">${escape(formatWhen(stored.checkpoint.ts, now))}</span></span>${stamp}</summary>
<dl class="facts">${facts.join("")}</dl></details></li>`;
    })
    .join("\n");

  return `${checkpoints.length === 0 ? `<p class="card empty">${escape(t.none)}</p>` : `<ol class="card lines seals">${items}</ol>`}
<form method="post" action="/ui/checkpoint" class="section"><button type="submit">${ICONS.seal}${escape(UI.home.checkpointNow)}</button></form>`;
}

/** The people page: search by identifier, through the subjects table, and the erasure of what it finds. */
export function peoplePage(
  store: ReceiptStore,
  search: { identifier: string; token: string | null } | null,
  extra: { notice?: string; error?: string },
  now: Date,
): string {
  const t = UI.people;
  const legacy = search === null ? 0 : store.legacyReceiptsNaming(search.identifier);
  const legacyNotice =
    legacy === 0 ? "" : `<p class="notice warn" role="status">${STATE_ICONS.warn}<span>${escape(t.legacy(legacy))}</span></p>\n`;
  let result = "";
  if (search !== null && search.token === null) {
    result = `<p class="card empty" role="status">${escape(t.notFound)}</p>`;
  } else if (search !== null && search.token !== null) {
    const token = search.token;
    const receipts = store.receiptsOnBehalfOf(token, 500);
    const records = new Map(store.listSystemRecords().map((record) => [record.system_id, record]));
    const items = receipts
      .map((receipt) => {
        const record = records.get(receipt.system_id);
        return `<li class="person-receipt"><a class="line" href="${receiptPath(receipt.system_id, receipt.seq)}">${kindIcon(receipt.action.kind)}<span class="line-text">${escape(receiptTitle(receipt))}</span><span class="line-aside">${escape(
          record === undefined ? receipt.system_id : systemTitle(record),
        )} · ${escape(formatWhen(receipt.ts_received, now))}</span>${receipt.outcome === "ok" ? "" : outcomePill(receipt.outcome)}${chevron}</a></li>`;
      })
      .join("\n");
    result = `<div class="cols">
<section aria-labelledby="persona-ricevute"><h2 id="persona-ricevute">${escape(t.receipts(receipts.length))} <code class="muted">${escape(token)}</code></h2>
${receipts.length === 0 ? "" : `<ol class="card lines">${items}</ol>`}
</section>
<section class="card padded" aria-labelledby="persona-cancella">
<h2 id="persona-cancella" class="danger-title">${ICONS.trash}${escape(t.eraseTitle)}</h2>
<p>${escape(t.eraseHint)}</p>
<form method="post" action="/ui/persone/cancella" class="fields">
  <input type="hidden" name="token" value="${escape(token)}">
  <label>${escape(t.eraseConfirm(token))}
    <input type="text" name="confirm" autocomplete="off" spellcheck="false" required>
  </label>
  <button type="submit" class="danger wide">${escape(t.eraseSubmit)}</button>
</form>
</section>
</div>`;
  }
  return `${pageHead(t.heading)}
${notices(extra)}
<form method="post" action="/ui/persone" class="inline narrow section-gap">
  <label><span class="sr">${escape(t.searchLabel)}</span>
    <input type="text" name="identifier" value="${escape(search?.identifier ?? "")}" placeholder="${escape(t.searchPlaceholder)}" autocomplete="off" autocapitalize="off" spellcheck="false" required>
  </label>
  <button type="submit" class="primary">${ICONS.search}${escape(t.searchSubmit)}</button>
</form>
${legacyNotice}${result}`;
}

/** What the store found for a document's fingerprints, beside the form that computed them. */
export function verifyDocumentResult(
  store: ReceiptStore,
  fingerprints: DocumentFingerprints | null,
  from: "file" | "text" | undefined,
  matches: DocumentMatch[],
  now: Date,
): string {
  const t = UI.verifyDocument;
  if (fingerprints === null) {
    return `<section aria-label="${escape(t.resultTitle)}"><div class="card placeholder">${escape(t.placeholder)}</div></section>`;
  }
  // The fingerprints the browser computed, shown either way: the exact one,
  // set beside Get-FileHash or sha256sum, tells at once whether the page was
  // given the same bytes the agent read. Which input they were computed on,
  // file or text, the page's script says in `from`.
  const source = from === undefined ? "" : `<p>${escape(from === "file" ? t.fromFile : t.fromText)}</p>`;
  const textLine =
    fingerprints.text === null
      ? `<p>${escape(t.textFingerprint)}: ${escape(t.noTextFingerprint)}</p>`
      : `<p>${escape(t.textFingerprint)}: <span class="hash text-hash">${escape(fingerprints.text)}</span></p>`;

  const names = new Map(store.listSystemRecords().map((record) => [record.system_id, record]));
  const sentences = matches.map((match) => {
    const record = names.get(match.system_id);
    return `<p data-match-sentence="${escape(match.kind)}">${escape(describeDocumentMatch({ ...match, display_name: record?.display_name ?? null }))}</p>`;
  });
  const technical = `<details class="tech"><summary>${ICONS.chevronRight}<span>${escape(t.technical)}</span></summary>
<div class="card padded prints">
${sentences.join("\n")}
<p>${escape(t.searchedFingerprint)}: <span class="hash">${escape(fingerprints.bytes)}</span></p>
${textLine}
${source}
${matches.length === 0 ? `<p>${escape(t.noMatchHint)}</p>
` : ""}</div>
</details>`;

  let found: string;
  if (matches.length === 0) {
    found = `<div class="result"><span class="tile-icon red" aria-hidden="true">${STATE_ICONS.bad}</span><div>
<h3>${escape(t.notFound)}</h3>
<p>${escape(t.noMatch)}</p>
</div></div>`;
  } else {
    const items = matches
      .map((match) => {
        const record = names.get(match.system_id);
        const system = record === undefined ? match.system_id : systemTitle(record);
        return `<li data-match="${escape(match.kind)}"><p>${escape(t.usedBy(system, formatWhenInline(match.ts_received, now), match.action_name))} <span class="pill green">${escape(t.match[match.kind])}</span></p><a href="${receiptPath(match.system_id, match.seq)}">${escape(t.seeReceipt)} ›</a></li>`;
      })
      .join("\n");
    found = `<div class="result"><span class="tile-icon green" aria-hidden="true">${STATE_ICONS.ok}</span><div>
<h3>${escape(t.found)}</h3>
<ul class="matches">${items}</ul>
</div></div>`;
  }
  return `<section id="sigillo-doc-result" aria-labelledby="sigillo-doc-result-title">
<h2 id="sigillo-doc-result-title" class="sr">${escape(t.resultTitle)}</h2>
<div class="card">${found}</div>
${technical}
</section>`;
}

/** A page that is not there: a system by an identifier nobody has, or one this viewer cannot see. */
export function notFoundPage(): string {
  return `<div class="lost"><div class="tile-icon grey" aria-hidden="true">${ICONS.search}</div>
<h1>${escape(UI.notFound.heading)}</h1>
<a class="button primary" href="/ui">${escape(UI.notFound.back)}</a></div>`;
}

/** The operator's list of customers: who waits, who is in, who signs in for each, and how many systems each has. */
export function organizationsPage(store: ReceiptStore, extra: { notice?: string; error?: string }): string {
  const t = UI.organizations;
  const organizations = store
    .listOrganizations()
    .sort((a, b) => Number(a.approved_at !== null) - Number(b.approved_at !== null) || b.created_at.localeCompare(a.created_at));
  const systems = store.listSystemRecords();
  const items = organizations
    .map((organization) => {
      const members = store.usersOf(organization.organization_id);
      const count = systems.filter((record) => record.organization_id === organization.organization_id).length;
      const who =
        members.length === 0
          ? t.noMembers
          : [members[0]?.email ?? "", members.length > 1 ? t.people(members.length) : ""].filter((part) => part !== "").join(" · ");
      const state =
        organization.approved_at === null
          ? `<span class="pill yellow">${STATE_ICONS.warn}${escape(t.waiting)}</span>`
          : `<span class="pill green">${STATE_ICONS.ok}${escape(t.active)}</span>`;
      const end =
        organization.approved_at === null
          ? `<form method="post" action="/ui/clienti/${escape(encodeURIComponent(organization.organization_id))}/approva"><button type="submit" class="primary">${escape(t.approve)}</button></form>`
          : escape(t.since(formatDate(organization.approved_at)));
      return `<li class="line" data-organization="${escape(organization.organization_id)}"><span class="cell-main"><strong>${escape(organization.name)}</strong><span>${escape(who)}</span></span><span>${state}</span><span class="num">${count}</span><span class="when">${end}</span></li>`;
    })
    .join("\n");
  return `${pageHead(t.heading)}
${notices(extra)}
${
  organizations.length === 0
    ? `<p class="card empty">${escape(t.none)}</p>`
    : `<ul class="card lines table organizations">
<li class="line head" aria-hidden="true"><span>${escape(t.columns.name)}</span><span>${escape(t.columns.state)}</span><span class="num">${escape(t.columns.systems)}</span><span class="when"></span></li>
${items}</ul>`
}`;
}

export type Theme = "light" | "dark" | "system";

/** One entry of the administrative log as a line: when, what, who. */
function adminLine(entry: AdminLogEntry, now: Date): string {
  return `<li class="line"><span class="line-time">${escape(formatListTime(entry.ts, now))}</span><span class="line-text" title="${escape(formatTs(entry.ts))}">${escape(describeAdminAction(entry))}</span><span class="line-aside">${escape(adminActor(entry.actor))}</span></li>`;
}

/** The settings: who is signed in, the organization and its quota, the look, the administrative log, the signing key. */
export function settingsPage(view: {
  account: Account;
  organization: { name: string; systems: number; used: number; limit: number | null } | null;
  theme: Theme;
  log: AdminLogEntry[];
  keyId: string;
  /** The daily export (backup/daily-export.ts): whether it is on for this account, and the files it has. Null where the server keeps none. */
  dailyExport: { on: boolean; files: StoredExport[]; names: Map<string, string> } | null;
  now: Date;
  extra: { notice?: string; error?: string };
}): string {
  const t = UI.settings;
  const { account, organization } = view;
  const quota =
    organization === null
      ? ""
      : `<section class="section" aria-labelledby="organizzazione"><h2 id="organizzazione">${escape(t.organization)}</h2>
<div class="card padded"><div class="spread"><strong>${escape(organization.name)}</strong><span class="muted">${escape(t.systems(organization.systems))}</span></div>
${
  organization.limit === null
    ? `<p class="muted section">${escape(t.noLimit(formatCount(organization.used)))}</p>`
    : `<div class="meter${organization.used >= organization.limit ? " red" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="${organization.limit}" aria-valuenow="${Math.min(organization.used, organization.limit)}"><span style="width: ${Math.min(100, Math.round((organization.used / organization.limit) * 100))}%"></span></div>
<p class="muted">${escape(t.quota(formatCount(organization.used), formatCount(organization.limit)))}</p>`
}</div></section>`;
  const themes = (["light", "dark", "system"] as const)
    .map(
      (theme) =>
        `<button type="submit" name="theme" value="${theme}"${theme === view.theme ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${escape(t.themes[theme])}</button>`,
    )
    .join("");
  return `<div class="narrow">${pageHead(t.heading)}
${notices(view.extra)}
<section class="section" aria-labelledby="account"><h2 id="account">${escape(t.account)}</h2>
<div class="card"><div class="line"><span class="avatar large" aria-hidden="true">${escape(initials(account.name))}</span><span class="who"><strong>${escape(account.name)}</strong><span>${escape(account.detail)}</span></span>
<form method="post" action="/ui/logout"><button type="submit">${ICONS.logout}${escape(UI.nav.esci)}</button></form></div></div></section>
${quota}
<section class="section" aria-labelledby="aspetto"><h2 id="aspetto">${escape(t.appearance)}</h2>
<form method="post" action="/ui/impostazioni/tema" class="segmented" aria-label="${escape(t.themeLabel)}">${themes}</form></section>
<section class="section" aria-labelledby="lingua"><h2 id="lingua">${escape(UI.languageLabel)}</h2>
${languageSwitch("segmented", "/ui/impostazioni")}</section>
${view.dailyExport === null ? "" : dailyExportSection(view.dailyExport)}
<section class="section" aria-labelledby="registro-amministrativo"><h2 id="registro-amministrativo">${escape(t.adminLog)}${
    view.log.length === 0 ? "" : `<a class="end" href="/ui/impostazioni/registro">${escape(t.adminLogAll)}</a>`
  }</h2>
${view.log.length === 0 ? `<p class="card empty">${escape(t.adminLogEmpty)}</p>` : `<ol class="card lines log">${view.log.map((entry) => adminLine(entry, view.now)).join("\n")}</ol>`}</section>
<section class="section" aria-labelledby="chiave-firma"><h2 id="chiave-firma">${escape(t.signingKey)}</h2>
<div class="card"><div class="line"><span class="tile-icon grey" aria-hidden="true">${ICONS.key}</span><code class="line-text keyid">${escape(view.keyId)}</code></div></div></section>
</div>`;
}

/** The daily export: on or off, and the files it has made, the newest first. Each button saves itself, as the theme's do. */
function dailyExportSection(view: { on: boolean; files: StoredExport[]; names: Map<string, string> }): string {
  const t = UI.settings.dailyExport;
  const lines = view.files
    .slice(0, 14)
    .map(
      (file) =>
        `<a class="line" href="/ui/impostazioni/esportazioni/${escape(file.fileName)}" download><span class="line-text">${escape(formatDate(`${file.day}T12:00:00Z`))} · ${escape(view.names.get(file.systemId) ?? file.systemId)}</span><span class="line-aside">${escape(t.size(file.bytes))}</span><span class="line-aside">${escape(t.download)}</span></a>`,
    )
    .join("\n");
  return `<section class="section" aria-labelledby="esportazione-giornaliera"><h2 id="esportazione-giornaliera">${escape(t.heading)}</h2>
<div class="card"><div class="line" data-daily-export="${view.on ? "on" : "off"}"><span class="tile-icon ${view.on ? "green" : "grey"}" aria-hidden="true">${view.on ? STATE_ICONS.ok : ICONS.folder}</span><span class="line-text">${escape(view.on ? t.stateOn : t.stateOff)}</span></div></div>
<form method="post" action="/ui/impostazioni/esportazione-giornaliera" class="segmented setting-controls" aria-label="${escape(t.heading)}"><button type="submit" name="enabled" value="on" aria-pressed="${view.on}">${escape(t.on)}</button><button type="submit" name="enabled" value="off" aria-pressed="${!view.on}">${escape(t.off)}</button></form>
${lines === "" ? (view.on ? `<p class="card empty export-files">${escape(t.empty)}</p>` : "") : `<div class="card lines export-files">${lines}</div>`}</section>`;
}

/** The whole administrative log, newest first. */
export function adminLogPage(log: AdminLogEntry[], now: Date): string {
  const t = UI.settings;
  return `<div class="narrow">${pageHead(t.adminLog)}
${log.length === 0 ? `<p class="card empty">${escape(t.adminLogEmpty)}</p>` : `<ol class="card lines log">${log.map((entry) => adminLine(entry, now)).join("\n")}</ol>`}
</div>`;
}

