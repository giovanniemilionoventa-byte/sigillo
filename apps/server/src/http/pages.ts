import type { DocumentFingerprints } from "@sigillo/core";
import type { DocumentMatch, ReceiptStore, SystemRecord } from "../storage/store.js";
import type { ChainStatus } from "../health/chain-health.js";
import { discloseFields, timestampStatus } from "./history.js";
import {
  archivedButShown,
  escape,
  kindIcon,
  notices,
  outcomePill,
  pageHead,
  semaphore,
  STATE_ICON,
  systemPath,
  worstStatus,
  type SystemRow,
} from "./layout.js";
import { describeAdminEntry, describeDocumentMatch, describeReceipt, formatTs, systemTitle, UI } from "./strings.js";
import { ICONS, STATE_ICONS } from "./style.js";

/**
 * The pages of the operator's view other than a system's history: the main
 * page with its three questions, the systems, managing one, its checkpoints,
 * a new system's key, the people, the result of checking a document, and
 * "not found". Each returns what goes inside <main>; layout.ts puts it in the
 * shell and ui.ts decides which one a request gets.
 */

/** A link to one receipt, opened in its system's history. */
function receiptPath(systemId: string, seq: number): string {
  return `${systemPath(systemId)}?ricevuta=${seq}#r-${seq}`;
}

/** The main page's title and subtitle: the situation in one sentence. */
export function homeSummary(shown: SystemRow[]): { h1: string; lead: string; status: ChainStatus | null } {
  const t = UI.home.summary;
  if (shown.length === 0) return { h1: t.none, lead: UI.home.noSystems, status: null };
  const count = (status: ChainStatus): number => shown.filter(({ health }) => health.status === status).length;
  const worst = worstStatus(shown.map(({ health }) => health.status));
  const h1 = worst === "red" ? t.red(count("red")) : worst === "yellow" ? t.yellow(count("yellow")) : t.green(shown.length);
  return { h1, lead: t.lead(shown.length), status: worst };
}

/** The checkpoint button and what it says, on the main page and a system's checkpoints. */
function checkpointNow(extra = ""): string {
  const t = UI.home;
  return `<div class="actions">
<form method="post" action="/ui/checkpoint"><button type="submit">${ICONS.seal}${escape(t.checkpointNow)}</button></form>
<p class="hint">${escape(t.checkpointHint)}${extra}</p>
</div>`;
}

/**
 * The main page: è tutto a posto? and cosa ha fatto l'AI? in the main
 * column, mi prepari le prove? as a panel on the right.
 */
export function homePage(
  store: ReceiptStore,
  records: SystemRecord[],
  rows: SystemRow[],
  shown: SystemRow[],
  justCheckpointed: boolean,
): string {
  const t = UI.home;
  const summary = homeSummary(shown);
  const hidden = rows.length - shown.length;

  const head = `<header class="page-head">
<p class="eyebrow">${escape(t.heading)}</p>
<div class="headline">${
    summary.status === null ? "" : `<span class="state-disc ${summary.status}" aria-hidden="true">${STATE_ICON[summary.status]}</span>`
  }<h1>${escape(summary.h1)}</h1></div>
<p class="lead">${escape(summary.lead)}</p>
</header>
${justCheckpointed ? notices({ notice: t.checkpointDone }) : ""}`;

  if (records.length === 0) return `${head}<p class="empty">${escape(t.noSystems)}</p>`;

  const systems = shown
    .map(({ record, health }) => {
      const why = archivedButShown(record, health.status);
      const sid = record.display_name === null ? "" : `<code class="sid">${escape(record.system_id)}</code> · `;
      return `<li><a href="${systemPath(record.system_id)}" class="sys-row">
<span class="sys-row-text"><span class="sys-row-name">${escape(systemTitle(record))}${
        why === null ? "" : ` <span class="badge">${escape(UI.systemsPage.archivedBadge)}</span>`
      }</span>
<span class="sys-row-meta">${sid}${escape(health.message)}${why === null ? "" : ` <em>(${escape(t.archivedShownBecause)} ${escape(why)})</em>`}</span></span>
${semaphore(health.status)}${ICONS.chevronRight.replace("<svg ", '<svg class="chevron" ')}
</a></li>`;
    })
    .join("\n");
  const hiddenNote =
    hidden === 0
      ? ""
      : ` ${escape(t.archivedHidden(hidden))} <a href="/ui/sistemi?vista=archiviati">${escape(UI.systemsPage.views.archiviati)}</a>`;

  const q1 = `<section class="block" aria-labelledby="q1">
<div class="block-head"><h2 id="q1">${escape(t.q1)}</h2>${
    shown.length === 0 ? "" : `<span class="block-meta">${escape(t.systemsCount(shown.length))}</span>`
  }</div>
${shown.length === 0 ? "" : `<ul class="card card-list">${systems}</ul>`}
${checkpointNow(hiddenNote)}
</section>`;

  const recent = shown
    .flatMap(({ record }) => store.searchReceipts({ systemId: record.system_id, limit: 5 }).map((receipt) => ({ record, receipt })))
    .sort((a, b) => (a.receipt.ts_received < b.receipt.ts_received ? 1 : -1))
    .slice(0, 8);
  const activity = recent
    .map(({ record, receipt }) => {
      const [day, time] = formatTs(receipt.ts_received).split(", ");
      return `<li><a href="${receiptPath(record.system_id, receipt.seq)}" class="activity">
<span class="activity-time">${escape((time ?? "").slice(0, 5))}<span>${escape((day ?? "").replace(/ \d{4}$/, ""))}</span></span>
${kindIcon(receipt.action.kind, "small")}
<span class="activity-text"><span class="activity-who">${escape(systemTitle(record))} · n. ${receipt.seq}</span><span class="activity-what">${escape(describeReceipt(receipt))}</span></span>
${receipt.outcome === "ok" ? "" : outcomePill(receipt.outcome)}
</a></li>`;
    })
    .join("\n");
  const q2 = `<section class="block" aria-labelledby="q2">
<div class="block-head"><h2 id="q2">${escape(t.q2)}</h2>${
    recent.length === 0 ? "" : `<span class="block-meta">${escape(t.recentActivity)} · ${escape(t.actionsCount(recent.length))}</span>`
  }</div>
${recent.length === 0 ? `<p class="empty card">${escape(t.noSystems)}</p>` : `<ol class="card card-list">${activity}</ol>`}
</section>`;

  const option = (record: SystemRecord): string =>
    `<option value="${escape(record.system_id)}">${escape(
      record.display_name === null ? record.system_id : `${record.display_name} (${record.system_id})`,
    )}</option>`;
  const active = records.filter((record) => record.archived_at === null);
  const archived = records.filter((record) => record.archived_at !== null);
  const q3 = `<section class="block side-panel" aria-labelledby="q3">
<h2 id="q3">${escape(t.q3)}</h2>
<div class="card padded">
<p class="muted">${escape(t.generateHint)}</p>
<form method="post" action="/ui/export" class="fields">
<label>${escape(t.chooseSystem)}
  <select name="system_id">${active.map(option).join("")}${
    archived.length === 0 ? "" : `<optgroup label="${escape(t.archivedGroup)}">${archived.map(option).join("")}</optgroup>`
  }</select>
</label>
<div class="fields-row"><label>${escape(t.fromDate)}<input type="date" name="from"></label><label>${escape(t.toDate)}<input type="date" name="to"></label></div>
<p class="hint">${escape(t.wholeChain)}</p>
${discloseFields()}
<button type="submit" class="primary wide">${ICONS.download}${escape(t.generate)}</button>
</form>
</div>
</section>`;

  return `${head}
<div class="split">
<div>
${q1}
${q2}
</div>
${q3}
</div>`;
}

export type SystemsView = "attivi" | "archiviati" | "tutti";

/** The systems: the active, archived or all of them, how to connect an agent, creating one, and the administrative log. */
export function sistemiPage(store: ReceiptStore, view: SystemsView, extra: { notice?: string; error?: string }): string {
  const t = UI.systemsPage;
  const records = store.listSystemRecords();
  const inView = records.filter((record) =>
    view === "tutti" ? true : view === "archiviati" ? record.archived_at !== null : record.archived_at === null,
  );
  const count = (candidate: SystemsView): number =>
    candidate === "tutti" ? records.length : records.filter((record) => (candidate === "archiviati") === (record.archived_at !== null)).length;

  const views = `<nav class="segmented" aria-label="${escape(t.existing)}">${(["attivi", "archiviati", "tutti"] as const)
    .map(
      (candidate) =>
        `<a href="/ui/sistemi?vista=${candidate}"${candidate === view ? ' aria-current="page"' : ""}><span class="cap">${escape(t.views[candidate])}</span><span class="count">${count(candidate)}</span></a>`,
    )
    .join("")}</nav>`;

  const connection = (record: SystemRecord): string => {
    const latest = store.searchReceipts({ systemId: record.system_id, limit: 1 })[0];
    return latest === undefined || latest.action.kind === "genesis" ? t.connection.none : t.connection[latest.source.type];
  };
  const label = (name: keyof typeof t.columns): string => `<span class="cell-label">${escape(t.columns[name])}:</span>`;

  const list =
    inView.length === 0
      ? `<p class="empty">${escape(t.noneInView[view])}</p>`
      : `<div class="systems-grid systems-head" aria-hidden="true">${(["system", "state", "receipts", "last", "manage"] as const)
          .map((name) => `<span>${escape(t.columns[name])}</span>`)
          .join("")}</div>
<ul class="systems-list">${inView
          .map((record) => {
            const path = systemPath(record.system_id);
            const state =
              record.archived_at === null
                ? `<span class="stamp green"><span class="dot" aria-hidden="true">${STATE_ICONS.ok}</span><span class="status-word">${escape(t.active)}</span></span>`
                : `<span class="stamp archived"><span class="dot" aria-hidden="true">${STATE_ICONS.archived}</span><span class="status-word">${escape(t.archivedBadge)}</span></span>` +
                  `<span class="archived-on">${escape(UI.manage.archivedOn)} ${escape(formatTs(record.archived_at))}</span>`;
            return `<li class="systems-grid">
<span><span class="system-name"><a href="${path}">${escape(systemTitle(record))}</a></span><span class="connection">${
              record.display_name === null ? "" : `<code class="sid">${escape(record.system_id)}</code> · `
            }${escape(connection(record))}</span></span>
<span>${label("state")}${state}</span>
<span>${label("receipts")}<span class="num">${record.receipts}</span> <span class="sr">${escape(record.receipts <= 1 ? t.onlyGenesis : t.receipts(record.receipts))}</span></span>
<span class="when">${label("last")}${record.last_received === null ? "—" : escape(formatTs(record.last_received))}</span>
<span class="links"><a href="${path}"><span class="cap">${escape(t.history)}</span></a><a href="${path}/manage"><span class="cap">${escape(t.manage)}</span></a></span>
</li>`;
          })
          .join("\n")}</ul>`;

  const ways = [
    [ICONS.code, t.connectPython],
    [ICONS.link, t.connectOtlp],
    [ICONS.doc, t.connectNative],
  ] as const;
  const connect = `<h2 class="section-title">${escape(t.howToConnect)}</h2>
<p class="section-hint">${escape(t.howToConnectIntro)}</p>
<div class="ways">${ways
    .map(
      ([glyph, way]) =>
        `<div class="card way"><span class="icon-tile blue" aria-hidden="true">${glyph}</span><h3>${escape(way.title)}</h3><p>${escape(way.hint)}</p></div>`,
    )
    .join("")}</div>
<p class="hint">${escape(t.connectMore)}</p>`;

  const log = store.adminLog(20);
  const adminLog =
    log.length === 0
      ? `<p class="empty card">${escape(t.adminLogEmpty)}</p>`
      : `<ul class="card log">${log.map((entry) => `<li>${escape(describeAdminEntry(entry))}</li>`).join("")}</ul>`;

  return `${pageHead({
    eyebrow: t.eyebrow,
    h1: t.heading,
    action: `<a class="button primary" href="#crea">${ICONS.plus}${escape(t.newSystem)}</a>`,
  })}
${notices(extra)}
${views}
<div class="card systems-card">
${list}
</div>
${connect}
<h2 class="section-title" id="crea">${escape(t.createTitle)}</h2>
<div class="card padded">
<form method="post" action="/ui/sistemi" class="create-grid">
  <label>${escape(t.nameLabel)}
    <input type="text" name="system_id" placeholder="${escape(t.namePlaceholder)}" autocapitalize="off" autocomplete="off" spellcheck="false" required>
  </label>
  <label>${escape(t.displayNameLabel)}
    <input type="text" name="display_name" maxlength="128">
  </label>
  <button type="submit" class="primary">${ICONS.key}${escape(t.submit)}</button>
</form>
<p class="hint">${escape(t.idHint)}</p>
</div>
<h2 class="section-title">${escape(t.adminLogTitle)}</h2>
<p class="section-hint">${escape(t.adminLogHint)}</p>
${adminLog}`;
}

/** The page after creating a system: its key, shown this once, and three ways to use it. */
export function systemCreatedPage(record: SystemRecord | null, systemId: string, token: string): string {
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

  const way = (title: string, hint: string, code: string): string =>
    `<section class="card created-way"><h3>${escape(title)}</h3><p>${escape(hint)}</p><pre class="code">${escape(code)}</pre></section>`;

  return `${pageHead({ eyebrow: t.createdTitle, h1: record === null ? systemId : systemTitle(record) })}
<p><code class="sid">${escape(systemId)}</code></p>
<p class="notice bad" role="status">${STATE_ICONS.warn}<strong>${escape(t.tokenWarning)}</strong></p>
<div class="token-box">${escape(token)}</div>
<h2 class="section-title">${escape(t.howToConnect)}</h2>
<p class="section-hint">${escape(t.howToConnectIntro)}</p>
${way(t.connectPython.title, t.connectPython.hint, pythonCode)}
${way(t.connectOtlp.title, t.connectOtlp.hint, otlpCode)}
${way(t.connectNative.title, t.connectNative.hint, nativeCode)}
<p class="hint">${escape(t.connectMore)}</p>
<p class="actions"><a class="button primary" href="${systemPath(systemId)}/manage"><span class="cap">${escape(t.manage)}</span></a><a class="button" href="/ui/sistemi"><span class="cap">${escape(UI.nav.sistemi)}</span></a></p>`;
}

/** Managing one system: its label, whether it is archived, and — for a chain that never recorded anything — deleting it. */
export function managePage(record: SystemRecord, extra: { notice?: string; error?: string }): string {
  const t = UI.manage;
  const path = systemPath(record.system_id);
  const deletable = record.receipts <= 1;

  const archive =
    record.archived_at === null
      ? `<form method="post" action="${path}/archive"><button type="submit">${ICONS.archive}${escape(t.archiveSubmit)}</button></form>`
      : `<p><strong>${escape(t.archivedOn)} ${escape(formatTs(record.archived_at))}.</strong></p>
<form method="post" action="${path}/unarchive"><button type="submit" class="primary">${escape(t.unarchiveSubmit)}</button></form>`;

  const removal = deletable
    ? `<p class="card-text">${escape(t.deleteAllowed)}</p>
<form method="post" action="${path}/delete" class="fields-inline">
  <label>${escape(t.deleteConfirmLabel(record.system_id))}
    <input type="text" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false" required>
  </label>
  <button type="submit" class="danger">${ICONS.trash}${escape(t.deleteSubmit)}</button>
</form>`
    : `<p class="note">${ICONS.lock}<span>${escape(t.deleteRefused(record.receipts))}</span></p>`;

  const card = (tile: string, glyph: string, title: string, body: string): string =>
    `<section class="card manage-card"><span class="icon-tile ${tile}" aria-hidden="true">${glyph}</span><div><h2>${escape(title)}</h2>${body}</div></section>`;

  return `${notices(extra)}
<div class="stack-cards">
${card(
  "blue",
  ICONS.tag,
  t.nameTitle,
  `<p class="card-text">${escape(t.nameHint(record.system_id))}</p>
<form method="post" action="${path}/rename" class="fields-inline">
  <label>${escape(t.nameLabel)}
    <input type="text" name="display_name" value="${escape(record.display_name ?? "")}" maxlength="128">
  </label>
  <button type="submit" class="primary">${escape(t.nameSubmit)}</button>
</form>`,
)}
${card("grey", ICONS.archive, t.archiveTitle, `<p class="card-text">${escape(t.archiveHint)}</p>${archive}`)}
${card("red", ICONS.trash, t.deleteTitle, removal)}
</div>`;
}

/** A system's checkpoints, newest first, each with its timestamp or the wait for one. */
export function checkpointsPage(store: ReceiptStore, systemId: string): string {
  const t = UI.checkpoints;
  const checkpoints = store.readCheckpoints(systemId).slice().reverse();
  const items = checkpoints
    .map((stored) => {
      const tokens = store.readTimestamps(stored.id);
      const stamp =
        tokens.length === 0
          ? `<span class="stamp yellow">${STATE_ICONS.warn}${escape(t.waiting)}</span>`
          : tokens
              .map(
                (token) =>
                  `<span class="stamp green">${STATE_ICONS.ok}${escape(t.stamped)}</span>
<span class="cp-time">${escape(token.genTime === undefined ? t.genTimeUnreadable : formatTs(token.genTime))}</span>
<span class="cp-caption">${escape(t.attested)}</span>
<span class="cp-tsa"><code>${escape(token.tsaUrl)}</code> · ${escape(t.receivedAt)} ${escape(formatTs(token.obtainedAt))}</span>`,
              )
              .join("");
      return `<li>
<div><span class="cp-size">${stored.checkpoint.tree_size}</span><span class="cp-caption">${escape(t.covered)}</span></div>
<div><span class="cp-caption">${escape(t.written)}</span><span class="cp-value">${escape(formatTs(stored.checkpoint.ts))}</span>
<span class="cp-caption cp-gap">${escape(t.root)}</span><code class="hash-full">${escape(stored.checkpoint.root_hash)}</code></div>
<div>${stamp}</div>
</li>`;
    })
    .join("\n");

  return `<div class="info-line">${ICONS.info}<p>${escape(t.explain)}</p></div>
${checkpoints.length === 0 ? `<p class="empty card">${escape(t.none)}</p>` : `<div class="card"><ol class="checkpoints" reversed>${items}</ol></div>`}
${checkpointNow()}`;
}

/** The people page: search by identifier, through the subjects table, and the erasure of what it finds. */
export function peoplePage(
  store: ReceiptStore,
  search: { identifier: string; token: string | null } | null,
  extra: { notice?: string; error?: string },
): string {
  const t = UI.people;
  let result = "";
  if (search !== null && search.token === null) {
    result = `<p class="notice" role="status">${ICONS.info}<span>${escape(t.notFound)}</span></p>`;
  } else if (search !== null && search.token !== null) {
    const token = search.token;
    const receipts = store.receiptsOnBehalfOf(token, 500);
    const records = new Map(store.listSystemRecords().map((record) => [record.system_id, record]));
    const items = receipts
      .map((receipt) => {
        const record = records.get(receipt.system_id);
        return `<li class="person-receipt"><a href="${receiptPath(receipt.system_id, receipt.seq)}">${kindIcon(receipt.action.kind, "small")}<span class="activity-text"><span class="activity-who">${escape(
          record === undefined ? receipt.system_id : systemTitle(record),
        )} · n. ${receipt.seq} · ${escape(formatTs(receipt.ts_received))}</span><span class="activity-what">${escape(describeReceipt(receipt))}</span></span>${
          receipt.outcome === "ok" ? "" : outcomePill(receipt.outcome)
        }${ICONS.chevronRight.replace("<svg ", '<svg class="chevron" ')}</a></li>`;
      })
      .join("\n");
    result = `<div class="split person-result">
<section class="card padded" aria-labelledby="persona-ricevute">
<div class="token-head"><span class="state-disc small neutral" aria-hidden="true">${ICONS.people}</span><div><p class="eyebrow">${escape(t.tokenLabel)}</p><code>${escape(token)}</code></div></div>
<h2 class="group-label" id="persona-ricevute">${escape(t.receipts(receipts.length))}</h2>
${receipts.length === 0 ? "" : `<ol class="person-receipts">${items}</ol>`}
</section>
<section class="card padded side-panel" aria-labelledby="persona-cancella">
<div class="token-head"><span class="icon-tile red" aria-hidden="true">${ICONS.trash}</span><h2 id="persona-cancella">${escape(t.eraseTitle)}</h2></div>
<p class="hint erase-hint">${escape(t.eraseHint)}</p>
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
  return `${pageHead({ eyebrow: t.eyebrow, h1: t.heading })}
<p class="intro">${escape(t.intro)}</p>
${notices(extra)}
<form method="post" action="/ui/persone" class="fields-inline person-search">
  <label>${escape(t.searchLabel)}
    <input type="text" name="identifier" value="${escape(search?.identifier ?? "")}" autocomplete="off" autocapitalize="off" spellcheck="false" required>
  </label>
  <button type="submit" class="primary">${ICONS.search}${escape(t.searchSubmit)}</button>
</form>
${result}`;
}

/** What the store found for a document's fingerprints, beside the form that computed them. */
export function verifyDocumentResult(
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
  const source = from === undefined ? "" : `<p>${escape(from === "file" ? t.fromFile : t.fromText)}</p>`;
  const textLine =
    fingerprints.text === null
      ? `<p>${escape(t.textFingerprint)}: <span class="muted">${escape(t.noTextFingerprint)}</span></p>`
      : `<p>${escape(t.textFingerprint)}: <span class="hash text-hash">${escape(fingerprints.text)}</span></p>`;
  const searched = `<div class="result-prints"><p>${escape(t.searchedFingerprint)}: <span class="hash">${escape(fingerprints.bytes)}</span></p>${textLine}${source}</div>`;

  let found: string;
  if (matches.length === 0) {
    found = `<div class="result-head"><span class="state-disc small yellow" aria-hidden="true">${STATE_ICONS.warn}</span><div>
<h3>${escape(t.notFound)}</h3>
<p><strong>${escape(t.noMatch)}</strong></p>
<p class="hint">${escape(t.noMatchHint)}</p>
</div></div>`;
  } else {
    const names = new Map(store.listSystemRecords().map((record) => [record.system_id, record.display_name]));
    const items = matches
      .map((match) => {
        const sentence = describeDocumentMatch({ ...match, display_name: names.get(match.system_id) ?? null });
        return `<li data-match="${escape(match.kind)}">${escape(sentence)}<span class="match-links"><a href="${receiptPath(match.system_id, match.seq)}"><span class="cap">${escape(t.seeReceipt)}</span></a><span class="muted">${escape(timestampStatus(store, match.system_id, match.seq))}</span></span></li>`;
      })
      .join("\n");
    found = `<div class="result-head"><span class="state-disc small green" aria-hidden="true">${STATE_ICONS.ok}</span><div>
<h3>${escape(t.found)}</h3>
<ul class="result-matches">${items}</ul>
</div></div>`;
  }
  return `<section id="sigillo-doc-result" class="block" aria-labelledby="sigillo-doc-result-title">
<h2 id="sigillo-doc-result-title">${escape(t.resultTitle)}</h2>
<div class="card padded">
${found}
${searched}
</div>
</section>`;
}

/** No system by that identifier. */
export function notFoundPage(systemId: string): string {
  return `${pageHead({ h1: UI.notFound.heading })}
<p class="notice" role="status">${ICONS.info}<span>${escape(UI.notFound.system(systemId))}</span></p>
<p class="actions"><a class="button" href="/ui/sistemi?vista=tutti">${escape(UI.nav.allSystems)}</a></p>`;
}

