import { escape } from "./layout.js";
import type { Language } from "./locale.js";
import { SEAL_SVG } from "./style.js";

/**
 * The live demo on the public home: a working copy of the console window, on
 * sample data, that runs entirely in the visitor's browser. An agent works and
 * each action is sealed as it happens; the visitor opens a receipt, rewrites
 * it the way someone with database access could, and presses Verify, which
 * recomputes every SHA-256 and shows where the chain stops adding up.
 *
 * The page renders the window at rest (one sample agent, every action sealed),
 * so it reads without the script. /demo.js (served from this origin, as the
 * CSP's script-src 'self' asks) takes it over: it reads the copy and the
 * sample agents from the JSON block next to the window, never from the
 * network. Nothing the visitor types leaves the page.
 *
 * The receipt hashed here is a simplified stand-in for the real format
 * (docs/FORMAT.md): the same idea (canonical JSON, SHA-256, each receipt
 * naming the hash of the one before), not the same bytes.
 */

type Kind = "open" | "tool" | "model" | "decision";

interface DemoStep {
  kind: Kind;
  name: string;
  at: string;
  args?: string;
  blocked?: boolean;
  why?: string;
}

interface DemoAgent {
  key: string;
  chip: string;
  name: string;
  id: string;
  agent: string;
  from: string;
  steps: DemoStep[];
}

interface DemoCopy {
  h2: string;
  lead: string;
  choose: string;
  window: string;
  list: string;
  replay: string;
  verify: string;
  pack: string;
  day: string;
  nav: [string, string, string];
  systems: string;
  user: [string, string];
  badge: { recording: string; checking: string; intact: string; tampered: string; unchecked: string };
  marks: { sealing: string; sealed: string; ok: string; bad: string; broken: string };
  empty: { working: string; idle: string };
  fields: { agent: string; when: string; today: string; from: string; receipt: string; args: string; prev: string; sealed: string; now: string };
  outcome: { done: string; blocked: string; label: string; action: string };
  rewrite: { tool: string; model: string; decision: string };
  save: string;
  cancel: string;
  editNote: string;
  edited: string;
  ok: { title: string; body: string };
  bad: { title: string; body: string };
  steps: [string, string][];
  foot: string;
  packSheet: { title: string; body: string; files: [string, string][]; note: string; close: string };
  agents: DemoAgent[];
}

const EN: DemoCopy = {
  h2: "Watch an AI agent leave a record it can't rewrite",
  lead: "This is the sigillo console, running on sample data in your browser. Pick an agent, let it work, then try to change what happened.",
  choose: "Choose a sample agent",
  window: "sigillo console, live demo",
  list: "Recorded actions",
  replay: "Replay",
  verify: "Verify the chain",
  pack: "Prepare the evidence pack",
  day: "Today · Wednesday 4 November",
  nav: ["Status", "Actions", "Evidence"],
  systems: "Systems",
  user: ["Acme Srl", "Compliance team"],
  badge: { recording: "Recording", checking: "Checking…", intact: "Intact", tampered: "Tampered", unchecked: "Not checked since a change" },
  marks: { sealing: "Sealing", sealed: "Sealed", ok: "Verified", bad: "Hash does not match", broken: "Not trusted after the break" },
  empty: { working: "The agent is working. Each action is sealed as it happens.", idle: "Click an action to open its receipt." },
  fields: { agent: "Agent", when: "When", today: "Today", from: "Arrived from", receipt: "Receipt", args: "Arguments (only the hash is kept)", prev: "Previous receipt", sealed: "Sealed hash", now: "Hash of what is stored now" },
  outcome: { done: "Completed", blocked: "Blocked", label: "Outcome", action: "Action" },
  rewrite: { tool: "Try to rewrite this tool call", model: "Try to rewrite this model call", decision: "Try to rewrite this decision" },
  save: "Save change",
  cancel: "Cancel",
  editNote: "This edits the stored row directly, like someone with access to the database. The seal is not updated.",
  edited: "edited",
  ok: { title: "All {n} receipts check out.", body: "Every hash matches its content and links to the receipt before it. The chain is signed and timestamped, so it can also be checked offline." },
  bad: { title: "Receipt #{seq} was changed after it was sealed.", body: "Its content no longer matches the hash that was signed at {at}. sigillo can't stop someone with database access from editing a row, but it makes the edit impossible to hide." },
  steps: [
    ["The agent works", "Each action gets a sealed receipt, linked to the one before."],
    ["Open a receipt", "Click any action to see what was sealed."],
    ["Rewrite the past", "Change an action, the way someone with database access could."],
    ["Verify", "sigillo recomputes every hash and finds the change."],
  ],
  foot: "Sample data. Nothing leaves your browser. The hashes are real SHA-256, computed on this page.",
  packSheet: {
    title: "Evidence pack for {name}",
    body: "One file you can hand to an auditor, a regulator or a court. It can be checked offline with the open-source verifier, without trusting sigillo.",
    files: [["receipts.jsonl", "{n} receipts"], ["checkpoint.json", "Merkle root, Ed25519 signature"], ["timestamp.tsr", "RFC 3161 timestamp"], ["public-key.pem", "to check the signature"], ["report.pdf", "readable summary"]],
    note: "In the demo nothing is downloaded.",
    close: "Close",
  },
  agents: [
    {
      key: "support", chip: "Customer support agent", name: "Customer support", id: "acme-support-bot", agent: "support-agent", from: "Python SDK",
      steps: [
        { kind: "open", name: "Ledger opened", at: "14:20" },
        { kind: "tool", name: "Used «find_order»", args: '{"order":"A-20931"}', at: "14:40" },
        { kind: "model", name: "Reply from «llama3.1:8b»", args: '{"prompt":"Customer asks for a refund of 640 EUR"}', at: "14:41" },
        { kind: "tool", name: "Tried «refund_payment»", args: '{"amount":640,"currency":"EUR"}', blocked: true, why: "Refunds over €200 need a person", at: "14:43" },
        { kind: "decision", name: "Decision «escalate_to_operator»", at: "14:44" },
        { kind: "model", name: "Reply from «llama3.1:8b»", args: '{"prompt":"Tell the customer an operator will call"}', at: "14:44" },
      ],
    },
    {
      key: "invoice", chip: "Invoice approval agent", name: "Invoice approvals", id: "ap-invoice-agent", agent: "finance-agent", from: "OpenTelemetry",
      steps: [
        { kind: "open", name: "Ledger opened", at: "09:02" },
        { kind: "tool", name: "Used «read_invoice»", args: '{"invoice":"INV-2026-1042"}', at: "09:14" },
        { kind: "tool", name: "Used «check_vendor»", args: '{"vat":"IT01234567890"}', at: "09:14" },
        { kind: "model", name: "Reply from «claude-sonnet»", args: '{"prompt":"Does the invoice match purchase order PO-778?"}', at: "09:15" },
        { kind: "decision", name: "Decision «approve_payment»", why: "€1,240.00 to Nordic Parts Oy", at: "09:15" },
        { kind: "tool", name: "Used «schedule_payment»", args: '{"amount":1240,"due":"2026-11-30"}', at: "09:16" },
      ],
    },
    {
      key: "cv", chip: "CV screening agent", name: "CV screening", id: "hr-cv-screening", agent: "hr-agent", from: "Python SDK",
      steps: [
        { kind: "open", name: "Ledger opened", at: "11:05" },
        { kind: "tool", name: "Used «parse_cv»", args: '{"file":"candidate-0187.pdf"}', at: "11:31" },
        { kind: "model", name: "Reply from «gpt-4.1-mini»", args: '{"prompt":"Score this CV against the job profile"}', at: "11:31" },
        { kind: "decision", name: "Decision «shortlist»", why: "Score 71 / 100", at: "11:32" },
        { kind: "tool", name: "Tried «send_rejection_email»", args: '{"candidate":"0187"}', blocked: true, why: "High-risk use: a person must review first", at: "11:32" },
        { kind: "decision", name: "Decision «queue_for_human_review»", at: "11:33" },
      ],
    },
  ],
};

const IT: DemoCopy = {
  h2: "Guarda un agente AI lasciare un registro che non può riscrivere",
  lead: "Questa è la console di sigillo, con dati d'esempio, nel tuo browser. Scegli un agente, lascialo lavorare, poi prova a cambiare quello che è successo.",
  choose: "Scegli un agente d'esempio",
  window: "Console di sigillo, demo dal vivo",
  list: "Azioni registrate",
  replay: "Rivedi",
  verify: "Verifica la catena",
  pack: "Prepara il fascicolo",
  day: "Oggi · mercoledì 4 novembre",
  nav: ["Stato", "Azioni", "Prove"],
  systems: "Sistemi",
  user: ["Acme Srl", "Ufficio compliance"],
  badge: { recording: "Registra", checking: "Controllo…", intact: "Integro", tampered: "Alterato", unchecked: "Non controllato dopo una modifica" },
  marks: { sealing: "Sigillo in corso", sealed: "Sigillata", ok: "Verificata", bad: "L'impronta non corrisponde", broken: "Non affidabile dopo la rottura" },
  empty: { working: "L'agente sta lavorando. Ogni azione viene sigillata mentre accade.", idle: "Clicca un'azione per aprire la sua ricevuta." },
  fields: { agent: "Agente", when: "Quando", today: "Oggi", from: "Arrivata da", receipt: "Ricevuta", args: "Argomenti (si conserva solo l'impronta)", prev: "Ricevuta precedente", sealed: "Impronta sigillata", now: "Impronta di ciò che c'è ora" },
  outcome: { done: "Completata", blocked: "Bloccata", label: "Esito", action: "Azione" },
  rewrite: { tool: "Prova a riscrivere questa chiamata", model: "Prova a riscrivere questa risposta", decision: "Prova a riscrivere questa decisione" },
  save: "Salva la modifica",
  cancel: "Annulla",
  editNote: "Modifica la riga salvata direttamente, come farebbe chi ha accesso al database. Il sigillo non viene aggiornato.",
  edited: "modificata",
  ok: { title: "Tutte le {n} ricevute tornano.", body: "Ogni impronta corrisponde al contenuto e si lega alla ricevuta precedente. La catena è firmata e con marca temporale, quindi si controlla anche senza rete." },
  bad: { title: "La ricevuta n. {seq} è stata cambiata dopo il sigillo.", body: "Il contenuto non corrisponde più all'impronta firmata alle {at}. sigillo non può impedire a chi ha accesso al database di modificare una riga, ma rende la modifica impossibile da nascondere." },
  steps: [
    ["L'agente lavora", "Ogni azione riceve una ricevuta sigillata, legata alla precedente."],
    ["Apri una ricevuta", "Clicca un'azione per vedere cosa è stato sigillato."],
    ["Riscrivi il passato", "Cambia un'azione, come potrebbe fare chi ha accesso al database."],
    ["Verifica", "sigillo ricalcola ogni impronta e trova la modifica."],
  ],
  foot: "Dati d'esempio. Niente esce dal tuo browser. Le impronte sono SHA-256 vere, calcolate in questa pagina.",
  packSheet: {
    title: "Fascicolo di {name}",
    body: "Un unico file da consegnare a un revisore, a un'autorità o a un giudice. Si controlla senza rete con il verificatore open source, senza fidarsi di sigillo.",
    files: [["receipts.jsonl", "{n} ricevute"], ["checkpoint.json", "radice di Merkle, firma Ed25519"], ["timestamp.tsr", "marca temporale RFC 3161"], ["public-key.pem", "per controllare la firma"], ["report.pdf", "riepilogo leggibile"]],
    note: "Nella demo non si scarica niente.",
    close: "Chiudi",
  },
  agents: [
    {
      key: "support", chip: "Agente assistenza clienti", name: "Assistenza clienti", id: "acme-support-bot", agent: "support-agent", from: "SDK Python",
      steps: [
        { kind: "open", name: "Registro aperto", at: "14:20" },
        { kind: "tool", name: "Ha usato «cerca_ordine»", args: '{"ordine":"A-20931"}', at: "14:40" },
        { kind: "model", name: "Risposta da «llama3.1:8b»", args: '{"prompt":"Il cliente chiede un rimborso di 640 EUR"}', at: "14:41" },
        { kind: "tool", name: "Ha provato «rimborsa_pagamento»", args: '{"importo":640,"valuta":"EUR"}', blocked: true, why: "I rimborsi oltre 200 € richiedono una persona", at: "14:43" },
        { kind: "decision", name: "Decisione «passa_a_operatore»", at: "14:44" },
        { kind: "model", name: "Risposta da «llama3.1:8b»", args: '{"prompt":"Avvisa il cliente che chiamerà un operatore"}', at: "14:44" },
      ],
    },
    {
      key: "invoice", chip: "Agente approvazione fatture", name: "Approvazione fatture", id: "ap-invoice-agent", agent: "finance-agent", from: "OpenTelemetry",
      steps: [
        { kind: "open", name: "Registro aperto", at: "09:02" },
        { kind: "tool", name: "Ha usato «leggi_fattura»", args: '{"fattura":"INV-2026-1042"}', at: "09:14" },
        { kind: "tool", name: "Ha usato «controlla_fornitore»", args: '{"piva":"IT01234567890"}', at: "09:14" },
        { kind: "model", name: "Risposta da «claude-sonnet»", args: '{"prompt":"La fattura corrisponde all\'ordine PO-778?"}', at: "09:15" },
        { kind: "decision", name: "Decisione «approva_pagamento»", why: "1.240,00 € a Nordic Parts Oy", at: "09:15" },
        { kind: "tool", name: "Ha usato «programma_pagamento»", args: '{"importo":1240,"scadenza":"2026-11-30"}', at: "09:16" },
      ],
    },
    {
      key: "cv", chip: "Agente selezione CV", name: "Selezione CV", id: "hr-cv-screening", agent: "hr-agent", from: "SDK Python",
      steps: [
        { kind: "open", name: "Registro aperto", at: "11:05" },
        { kind: "tool", name: "Ha usato «leggi_curriculum»", args: '{"file":"candidato-0187.pdf"}', at: "11:31" },
        { kind: "model", name: "Risposta da «gpt-4.1-mini»", args: '{"prompt":"Valuta questo CV rispetto al profilo"}', at: "11:31" },
        { kind: "decision", name: "Decisione «in_rosa»", why: "Punteggio 71 / 100", at: "11:32" },
        { kind: "tool", name: "Ha provato «invia_email_rifiuto»", args: '{"candidato":"0187"}', blocked: true, why: "Uso ad alto rischio: prima deve guardare una persona", at: "11:32" },
        { kind: "decision", name: "Decisione «revisione_umana»", at: "11:33" },
      ],
    },
  ],
};

const COPY: Record<Language, DemoCopy> = { en: EN, it: IT };

/** The window's icons, drawn in currentColor so both themes take them. */
const ICON: Record<string, string> = {
  open: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3.5C6.5 2.5 4 2.3 2 2.8v9.7c2-.5 4.5-.3 6 .7 1.5-1 4-1.2 6-.7V2.8c-2-.5-4.5-.3-6 .7zM8 3.5v9.7"/></svg>',
  tool: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2.2a3.3 3.3 0 0 0-3.7 4.5L2.4 10.6a1.4 1.4 0 0 0 2 2l3.9-3.9A3.3 3.3 0 0 0 12.8 5l-2 2-1.8-.1-.1-1.8 2-2c-.3-.4-.6-.7-.9-.9z"/></svg>',
  model: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1.2"/><rect x="6.3" y="6.3" width="3.4" height="3.4"/><path d="M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/></svg>',
  decision: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="6" r="1.6"/><path d="M4 5.1v5.8M12 7.6c0 2.4-2.5 3-6.4 4"/></svg>',
  spin: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3a7 7 0 1 1-7 7" stroke-linecap="round"/></svg>',
  sealed: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="7.2"/><path d="M10 6.6l3.4 3.4-3.4 3.4-3.4-3.4z" fill="currentColor" stroke="none"/></svg>',
  ok: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="7.2"/><path d="M6.7 10.2l2.2 2.2 4.4-4.6"/></svg>',
  bad: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="7.2"/><path d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2"/></svg>',
  broken: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2.5 2.5"><circle cx="10" cy="10" r="7.2"/></svg>',
  pencil: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/></svg>',
  file: '<svg viewBox="0 0 34 34" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 4h11l6 6v20H9z"/><path d="M20 4v6h6"/></svg>',
  lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
  replay: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 8a5.5 5.5 0 1 0 1.7-4"/><path d="M2.5 2.5v3h3"/></svg>',
  shield: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 1.5l5.5 2v4c0 3.4-2.4 6-5.5 7-3.1-1-5.5-3.6-5.5-7v-4z"/><path d="M5.5 8l1.8 1.8L10.8 6.3"/></svg>',
  download: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/></svg>',
  status: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1.5 8h3l2-4.5 3 9 2-4.5h3"/></svg>',
  actions: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01"/></svg>',
  evidence: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 1.5h5.5L13 5v9.5H4z"/><circle cx="8.5" cy="9.5" r="2"/></svg>',
};

const CHIP_ICON: Record<string, string> = { support: "model", invoice: "tool", cv: "decision" };

/** The section, at rest: the first agent's actions, all sealed, nothing selected. /demo.js brings it to life. */
export function demoSection(language: Language): string {
  const c = COPY[language];
  const first = c.agents[0];
  if (first === undefined) return "";
  const icon = (name: string): string => ICON[name] ?? "";
  const chips = c.agents
    .map((a, i) => `<button class="dm-chip" type="button" data-sc="${escape(a.key)}" aria-pressed="${i === 0}">${icon(CHIP_ICON[a.key] ?? "tool")}${escape(a.chip)}</button>`)
    .join("");
  const systems = c.agents
    .map((a, i) => `<button class="dm-nav dm-sys${i === 0 ? " on" : ""}" type="button" data-sc="${escape(a.key)}"><span class="dm-dot ok"></span><span>${escape(a.name)}</span></button>`)
    .join("");
  const rows = first.steps
    .map(
      (s, i) => `<button class="dm-row" type="button" role="option" data-seq="${i + 1}" aria-selected="false"><span class="dm-t">${escape(s.at)}</span><span class="dm-kind">${icon(s.kind)}</span><span class="dm-name">${escape(s.name)}</span>${
        s.blocked === true ? `<span class="dm-tag">⚠ ${escape(c.outcome.blocked)}</span>` : ""
      }<span class="dm-seal sealed" title="${escape(c.marks.sealed)}">${icon("sealed")}</span></button>`,
    )
    .join("");
  // The copy and the sample agents for /demo.js. "<" is written as < so
  // nothing in the data can close the script element.
  const data = JSON.stringify({ copy: c, icons: ICON, chipIcons: CHIP_ICON }).replace(/</g, "\\u003c");
  return `<section class="s-sec dm" id="demo" aria-labelledby="dm-title"><div class="s-wrap">
<header class="dm-intro"><h2 id="dm-title">${escape(c.h2)}</h2><p class="s-lead">${escape(c.lead)}</p></header>
<div class="dm-chips" role="group" aria-label="${escape(c.choose)}" id="dm-chips">${chips}</div>
<div class="dm-stage">
<div class="dm-window" role="region" aria-label="${escape(c.window)}">
<div class="dm-bar"><div class="dm-lights" aria-hidden="true"><i></i><i></i><i></i></div><div class="dm-address">${icon("lock")}get-sigillo.eu/console</div><button class="dm-replay" id="dm-replay" type="button" hidden>${icon("replay")}${escape(c.replay)}</button></div>
<div class="dm-app">
<nav class="dm-side" aria-label="${escape(c.window)}">
<div class="dm-brand">${SEAL_SVG}<span>sigillo</span></div>
<div class="dm-nav">${icon("status")}${escape(c.nav[0])}</div><div class="dm-nav on">${icon("actions")}${escape(c.nav[1])}</div><div class="dm-nav">${icon("evidence")}${escape(c.nav[2])}</div>
<h3 class="dm-h">${escape(c.systems)}</h3><div class="dm-systems" id="dm-systems">${systems}</div>
<div class="dm-me"><span class="dm-avatar">A</span><span>${escape(c.user[0])}<br>${escape(c.user[1])}</span></div>
</nav>
<div class="dm-main">
<div class="dm-head"><div class="dm-head-top"><b class="dm-title" id="dm-name">${escape(first.name)}</b><span class="dm-id mono" id="dm-id">${escape(first.id)}</span><span class="dm-badge ok" id="dm-badge">${icon("ok")}${escape(c.badge.intact)}</span></div>
<div class="dm-actions"><button class="dm-btn pri" id="dm-verify" type="button" disabled>${icon("shield")}${escape(c.verify)}</button><button class="dm-btn" id="dm-pack" type="button" disabled>${icon("download")}${escape(c.pack)}</button></div></div>
<div class="dm-list" id="dm-list" role="listbox" aria-label="${escape(c.list)}"><div class="dm-day">${escape(c.day)}</div>${rows}</div>
</div>
<aside class="dm-detail" id="dm-detail" aria-live="polite"><div class="dm-empty">${icon("file")}<span>${escape(c.empty.idle)}</span></div></aside>
</div></div>
<div class="dm-scrim" id="dm-scrim" hidden></div>
</div>
<ol class="dm-steps" id="dm-steps">${c.steps.map(([t, d], i) => `<li class="dm-step"><b><i>${i + 1}</i>${escape(t)}</b><span>${escape(d)}</span></li>`).join("")}</ol>
<p class="dm-foot">${escape(c.foot)}</p>
<script type="application/json" id="dm-data">${data}</script>
</div></section>`;
}

/** The section's rules, on the site's own tokens (style-v2.ts). Every class starts with dm-, so none of the site's rules reach in. */
export const DEMO_STYLE = `
:where(.dm) button { justify-content: flex-start; box-shadow: none; min-height: 0; white-space: normal; }
:where(.dm) button:disabled, :where(.dm) button:disabled:hover { cursor: default; }
.dm .s-wrap { display: grid; gap: 28px; }
.dm-intro { display: grid; justify-items: center; text-align: center; }
.dm-intro h2 { max-width: 22ch; margin: 0 auto 14px; text-wrap: balance; }
.dm-intro .s-lead { margin: 0 auto; text-wrap: balance; }
.dm-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
.dm-chip { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--separator); background: var(--surface); color: var(--label); font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
.dm-chip:hover { background: var(--hover); }
.dm-chip[aria-pressed="true"] { background: var(--selected); border-color: var(--action); color: var(--text); }
.dm-chip svg { width: 15px; height: 15px; }
.dm-stage { position: relative; }
.dm-window { border-radius: 14px; background: var(--canvas); box-shadow: var(--shadow-sheet); overflow: hidden; }
.dm-bar { display: grid; grid-template-columns: 80px minmax(0, 1fr) 80px; align-items: center; height: 40px; padding: 0 14px; border-bottom: 1px solid var(--separator); background: var(--sidebar); }
.dm-lights { display: flex; gap: 7px; }
.dm-lights i { width: 11px; height: 11px; border-radius: 50%; background: var(--fill); box-shadow: inset 0 0 0 1px var(--separator); }
.dm-address { justify-self: center; display: inline-flex; align-items: center; gap: 6px; padding: 3px 12px; border-radius: 6px; background: var(--fill); color: var(--secondary); font-size: 12.5px; max-width: 100%; overflow: hidden; white-space: nowrap; }
.dm-address svg { width: 12px; height: 12px; flex: none; }
.dm-replay { justify-self: end; border: 0; background: none; color: var(--secondary); font: inherit; font-size: 12.5px; display: inline-flex; gap: 5px; align-items: center; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
.dm-replay:hover { color: var(--text); background: var(--hover); }
.dm-replay svg { width: 13px; height: 13px; }
.dm-app { display: grid; grid-template-columns: 200px minmax(0, 1fr) 300px; height: 560px; font-size: 15px; }
.dm-side { background: var(--sidebar); border-right: 1px solid var(--separator); padding: 16px 10px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dm-brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; letter-spacing: 0.08em; text-transform: uppercase; padding: 0 8px 14px; }
.dm-brand svg { width: 22px; height: 22px; }
.dm-nav { display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 8px; border-radius: 6px; color: var(--label); font-size: 14px; font-weight: 500; }
.dm-nav svg { width: 15px; height: 15px; color: var(--secondary); flex: none; }
.dm-nav.on { background: var(--selected); box-shadow: inset 3px 0 0 var(--action); color: var(--text); font-weight: 600; }
.dm-h { margin: 14px 8px 4px; font-size: 11.5px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--secondary); font-weight: 600; }
.dm-systems { display: grid; gap: 2px; }
.dm-sys { border: 0; background: none; text-align: left; width: 100%; font: inherit; font-size: 14px; cursor: pointer; }
.dm-sys:hover { background: var(--hover); }
.dm-sys span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--secondary); flex: none; margin: 0 3px; }
.dm-dot.ok { background: var(--ok); }
.dm-dot.bad { background: var(--bad); }
.dm-dot.rec { background: var(--danger); animation: dm-pulse 1.2s infinite; }
.dm-me { margin-top: auto; display: flex; gap: 10px; align-items: center; padding: 10px 8px 0; border-top: 1px solid var(--separator); font-size: 13px; color: var(--secondary); }
.dm-avatar { width: 26px; height: 26px; border-radius: 50%; background: var(--action); color: var(--on-action); display: grid; place-items: center; font-size: 12px; font-weight: 650; flex: none; }
.dm-main { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--separator); }
.dm-head { padding: 18px 22px 14px; display: grid; gap: 12px; border-bottom: 1px solid var(--separator); }
.dm-head-top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.dm-title { font-size: 20px; letter-spacing: -0.01em; }
.dm-id { color: var(--secondary); font-size: 13px; }
.dm-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 12.5px; font-weight: 600; background: var(--fill); color: var(--label); }
.dm-badge svg { width: 13px; height: 13px; }
.dm-badge.ok { background: var(--ok-fill); color: var(--ok); }
.dm-badge.bad { background: var(--bad-fill); color: var(--bad); }
.dm-badge.warn { background: var(--warn-fill); color: var(--warn); }
.dm-badge.rec { color: var(--danger); }
.dm-badge.rec::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--danger); animation: dm-pulse 1.2s infinite; }
.dm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dm-btn { display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 14px; border-radius: 8px; border: 1px solid var(--separator); background: var(--surface); color: var(--text); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
.dm-btn:hover:not(:disabled) { background: var(--hover); }
.dm-btn:disabled { opacity: 0.45; cursor: default; }
.dm-btn.pri { background: var(--action); border-color: var(--action); color: var(--on-action); }
.dm-btn.pri:hover:not(:disabled) { background: var(--action); filter: brightness(1.1); }
.dm-btn svg { width: 15px; height: 15px; }
.dm-btn.nudge { animation: dm-nudge 1.6s ease-in-out infinite; }
.dm-list { flex: 1; overflow-y: auto; padding: 10px 14px 14px; }
.dm-day { margin: 6px 10px 8px; font-size: 13px; color: var(--secondary); font-weight: 600; }
.dm-row { width: 100%; display: grid; grid-template-columns: 44px 30px minmax(0, 1fr) auto 22px; align-items: center; gap: 10px; min-height: 48px; padding: 0 10px; border: 0; border-radius: 8px; background: none; color: var(--text); text-align: left; font: inherit; font-size: 14.5px; cursor: pointer; }
.dm-row.new { animation: dm-in 0.35s ease-out both; }
.dm-row:hover { background: var(--hover); }
.dm-row[aria-selected="true"] { background: var(--selected); box-shadow: inset 3px 0 0 var(--action); }
.dm-row.checking { background: var(--hover); }
.dm-row.is-bad { background: var(--bad-fill); }
.dm-t { color: var(--secondary); font-variant-numeric: tabular-nums; font-size: 13px; }
.dm-kind { width: 28px; height: 28px; border-radius: 7px; background: var(--fill); display: grid; place-items: center; color: var(--label); }
.dm-kind svg { width: 15px; height: 15px; }
.dm-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-name em { font-style: normal; color: var(--warn); font-size: 12px; margin-left: 6px; font-weight: 600; }
.dm-tag { font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--warn-fill); color: var(--warn); white-space: nowrap; }
.dm-seal { width: 20px; height: 20px; display: grid; place-items: center; color: var(--secondary); }
.dm-seal svg { width: 18px; height: 18px; }
.dm-seal.sealing svg { animation: dm-spin 0.8s linear infinite; }
.dm-seal.ok { color: var(--ok); }
.dm-seal.bad { color: var(--bad); }
.dm-seal.broken { opacity: 0.6; }
.dm-verdict { margin: 12px 10px 0; padding: 14px 16px; border-radius: 10px; font-size: 14px; display: grid; gap: 4px; animation: dm-in 0.35s ease-out both; }
.dm-verdict b { font-size: 15px; }
.dm-verdict span { color: var(--label); }
.dm-verdict.ok { background: var(--ok-fill); }
.dm-verdict.ok b { color: var(--ok); }
.dm-verdict.bad { background: var(--bad-fill); }
.dm-verdict.bad b { color: var(--bad); }
.dm-detail { padding: 22px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.dm-empty { color: var(--secondary); font-size: 14px; margin: auto 0; text-align: center; display: grid; gap: 10px; justify-items: center; }
.dm-empty svg { width: 34px; height: 34px; color: var(--separator); }
.dm-d-top { display: flex; justify-content: space-between; align-items: center; }
.dm-d-title { margin: 0; font-size: 18px; line-height: 1.3; font-weight: 650; overflow-wrap: anywhere; }
.dm-d-title small { display: block; font-weight: 400; font-size: 14px; color: var(--secondary); }
.dm-card { border: 1px solid var(--separator); border-radius: 10px; overflow: hidden; }
.dm-kv { display: flex; justify-content: space-between; gap: 12px; padding: 9px 13px; font-size: 13.5px; border-top: 1px solid var(--separator); }
.dm-kv:first-child { border-top: 0; }
.dm-kv > span:first-child { color: var(--secondary); flex: none; }
.dm-kv > span:last-child { text-align: right; min-width: 0; overflow-wrap: anywhere; }
.dm-hashes { font-family: var(--mono); font-size: 11.5px; color: var(--label); display: grid; gap: 8px; padding: 12px 13px; }
.dm-hashes div { display: grid; gap: 2px; }
.dm-hashes small { font-family: var(--font); color: var(--secondary); font-size: 11.5px; }
.dm-hashes code { overflow-wrap: anywhere; }
.dm-hashes code.bad { color: var(--bad); }
.dm-note { font-size: 12.5px; color: var(--secondary); margin: 0; }
.dm-edit { display: grid; gap: 10px; padding: 14px; border-radius: 10px; background: var(--fill); }
.dm-edit label { display: grid; gap: 4px; font-size: 12.5px; color: var(--secondary); }
.dm-edit input, .dm-edit select { min-height: 34px; border-radius: 7px; border: 1px solid var(--separator); background: var(--surface); color: var(--text); padding: 0 10px; font: inherit; font-size: 14px; width: 100%; }
.dm-edit-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.dm-link { border: 0; background: none; color: var(--link); padding: 0; font: inherit; font-size: 14px; font-weight: 600; display: inline-flex; gap: 6px; align-items: center; cursor: pointer; text-align: left; }
.dm-link svg { width: 14px; height: 14px; flex: none; }
.dm-steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.dm-step { padding: 14px 16px; border-radius: 10px; border: 1px solid var(--separator); display: grid; gap: 4px; align-content: start; transition: border-color .3s, background .3s; }
.dm-step b { font-size: 14px; display: flex; gap: 8px; align-items: center; }
.dm-step b i { font-style: normal; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 11.5px; background: var(--fill); color: var(--secondary); flex: none; }
.dm-step span { font-size: 13.5px; color: var(--secondary); }
.dm-step.now { border-color: var(--action); background: var(--selected); }
.dm-step.now b i { background: var(--action); color: var(--on-action); }
.dm-step.done b i { background: var(--ok-fill); color: var(--ok); }
.dm-foot { text-align: center; color: var(--secondary); font-size: 13px; margin: 0; }
.dm-scrim { position: absolute; inset: 0; background: var(--scrim); display: grid; place-items: center; padding: 16px; z-index: 2; border-radius: 14px; }
.dm-scrim[hidden] { display: none; }
.dm-sheet { width: min(440px, 100%); background: var(--surface); border-radius: 12px; box-shadow: var(--shadow-sheet); padding: 20px; display: grid; gap: 12px; animation: dm-in .25s ease-out both; }
.dm-sheet h3 { margin: 0; font-size: 17px; }
.dm-sheet p { margin: 0; color: var(--label); font-size: 14px; }
.dm-files { margin: 0; padding: 0; list-style: none; border: 1px solid var(--separator); border-radius: 10px; }
.dm-files li { display: flex; justify-content: space-between; gap: 10px; padding: 8px 12px; font-size: 13px; border-top: 1px solid var(--separator); }
.dm-files li:first-child { border-top: 0; }
.dm-files li span:last-child { color: var(--secondary); text-align: right; }
@keyframes dm-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes dm-spin { to { transform: rotate(360deg); } }
@keyframes dm-pulse { 50% { opacity: 0.3; } }
@keyframes dm-nudge { 0%, 100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 0 5px var(--selected); } }
@media (prefers-reduced-motion: reduce) { .dm *, .dm *::before { animation: none !important; transition: none !important; } }
@media (max-width: 1020px) { .dm-app { grid-template-columns: minmax(0, 1fr) 280px; } .dm-side { display: none; } }
@media (max-width: 760px) {
  .dm-app { grid-template-columns: minmax(0, 1fr); height: auto; }
  .dm-main { border-right: 0; border-bottom: 1px solid var(--separator); }
  .dm-list { max-height: 360px; }
  .dm-bar { grid-template-columns: 50px minmax(0, 1fr) 70px; }
  .dm-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .dm-row { grid-template-columns: 40px 28px minmax(0, 1fr) 22px; }
  .dm-row .dm-tag { display: none; }
}
`;

/**
 * /demo.js. Written without backquotes and without dollar-brace, so that it
 * can sit in this template literal as it is (String.raw keeps its
 * backslashes). The SHA-256 is FIPS 180-4, in a few lines, so the demo needs
 * neither a secure context nor an await.
 */
export const DEMO_SCRIPT = String.raw`"use strict";
(function () {
  var root = document.getElementById("demo");
  var dataEl = document.getElementById("dm-data");
  if (!root || !dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  var C = D.copy, ICON = D.icons;

  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256(text) {
    var msg = new TextEncoder().encode(text);
    var len = msg.length, total = ((len + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(total); buf.set(msg); buf[len] = 0x80;
    var dv = new DataView(buf.buffer);
    dv.setUint32(total - 4, (len * 8) >>> 0); dv.setUint32(total - 8, Math.floor(len / 0x20000000));
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var W = new Array(64);
    function r(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var o = 0; o < total; o += 64) {
      var i;
      for (i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = r(W[i-15], 7) ^ r(W[i-15], 18) ^ (W[i-15] >>> 3);
        var s1 = r(W[i-2], 17) ^ r(W[i-2], 19) ^ (W[i-2] >>> 10);
        W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        var t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(function (x) { return ("00000000" + x.toString(16)).slice(-8); }).join("");
  }
  window.sigilloDemoSha256 = sha256;

  // Keys sorted, no whitespace: the idea of RFC 8785, enough for a flat object.
  function canonical(obj) {
    return "{" + Object.keys(obj).sort().map(function (k) { return JSON.stringify(k) + ":" + JSON.stringify(obj[k]); }).join(",") + "}";
  }
  function body(sc, row) {
    return canonical({ v: 1, system: sc.id, seq: row.seq, kind: row.kind, name: row.name, outcome: row.blocked ? "blocked" : "completed", at: "2026-11-04T" + row.at + ":00Z", args_sha256: row.argsHash, prev: row.prev });
  }
  function recompute(sc, row) { return sha256(body(sc, row)); }

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var GENESIS = "0000000000000000000000000000000000000000000000000000000000000000";
  var S = null, timers = [];
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]; }); }
  function fill(template, values) { return template.replace(/\{(\w+)\}/g, function (_, k) { return values[k]; }); }
  function short(h) { return h.slice(0, 12) + "…" + h.slice(-6); }

  function seal(sc, step, i, prev) {
    var row = { kind: step.kind, name: step.name, at: step.at, args: step.args, why: step.why, blocked: !!step.blocked, seq: i + 1, prev: prev, edited: false, mark: "sealing", fresh: true };
    row.argsHash = sha256(step.args || "{}");
    row.hash = recompute(sc, row);
    row.orig = { name: row.name, blocked: row.blocked };
    return row;
  }
  function clear() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, reduced ? 0 : ms)); }

  function start(key) {
    clear();
    var sc = C.agents.filter(function (a) { return a.key === key; })[0] || C.agents[0];
    S = { sc: sc, rows: [], selected: null, phase: "recording", editing: false, verdict: null, step: 1 };
    $("dm-scrim").hidden = true;
    $("dm-replay").hidden = false;
    renderAll();
    function add(i) {
      if (i >= sc.steps.length) { S.phase = "done"; S.step = 2; renderAll(); return; }
      var prev = i ? S.rows[i - 1].hash : GENESIS;
      var row = seal(sc, sc.steps[i], i, prev);
      S.rows.push(row);
      renderAll();
      row.fresh = false;
      later(function () { row.mark = "sealed"; renderAll(); }, 450);
      later(function () { add(i + 1); }, i === 0 ? 500 : 950);
    }
    if (reduced) {
      sc.steps.forEach(function (_, i) { var r = seal(sc, sc.steps[i], i, i ? S.rows[i - 1].hash : GENESIS); r.mark = "sealed"; r.fresh = false; S.rows.push(r); });
      S.phase = "done"; S.step = 2; renderAll();
    } else add(0);
  }

  function renderAll() { renderChips(); renderSystems(); renderHead(); renderList(); renderDetail(); renderSteps(); }
  function renderChips() {
    Array.prototype.forEach.call($("dm-chips").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-sc") === S.sc.key)); });
  }
  function renderSystems() {
    $("dm-systems").innerHTML = C.agents.map(function (a) {
      var on = a.key === S.sc.key;
      var dot = !on ? "ok" : S.phase === "recording" ? "rec" : S.verdict === "bad" ? "bad" : "ok";
      return '<button class="dm-nav dm-sys' + (on ? " on" : "") + '" type="button" data-sc="' + esc(a.key) + '"><span class="dm-dot ' + dot + '"></span><span>' + esc(a.name) + "</span></button>";
    }).join("");
  }
  function renderHead() {
    $("dm-name").textContent = S.sc.name;
    $("dm-id").textContent = S.sc.id;
    var b = $("dm-badge");
    var anyEdit = S.rows.some(function (r) { return r.edited; });
    if (S.phase === "recording") { b.className = "dm-badge rec"; b.textContent = C.badge.recording; }
    else if (S.phase === "verifying") { b.className = "dm-badge"; b.textContent = C.badge.checking; }
    else if (S.verdict === "bad") { b.className = "dm-badge bad"; b.innerHTML = ICON.bad + esc(C.badge.tampered); }
    else if (anyEdit && S.verdict !== "ok") { b.className = "dm-badge warn"; b.textContent = C.badge.unchecked; }
    else { b.className = "dm-badge ok"; b.innerHTML = ICON.ok + esc(C.badge.intact); }
    var busy = S.phase === "recording" || S.phase === "verifying";
    $("dm-verify").disabled = busy;
    $("dm-pack").disabled = busy;
    $("dm-verify").classList.toggle("nudge", S.step === 4 && S.phase === "done");
  }
  function renderList() {
    var list = $("dm-list");
    var rows = S.rows.map(function (r) {
      var cls = "dm-row" + (r.fresh ? " new" : "") + (r.check ? " checking" : "") + (r.mark === "bad" ? " is-bad" : "");
      var label = C.marks[r.mark];
      return '<button class="' + cls + '" type="button" role="option" data-seq="' + r.seq + '" aria-selected="' + (S.selected === r.seq) + '">' +
        '<span class="dm-t">' + esc(r.at) + '</span><span class="dm-kind">' + ICON[r.kind] + "</span>" +
        '<span class="dm-name">' + esc(r.name) + (r.edited ? "<em>" + esc(C.edited) + "</em>" : "") + "</span>" +
        (r.blocked ? '<span class="dm-tag">⚠ ' + esc(C.outcome.blocked) + "</span>" : "") +
        '<span class="dm-seal ' + r.mark + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + ICON[r.mark === "sealing" ? "spin" : r.mark] + "</span></button>";
    }).join("");
    var verdict = "";
    if (S.verdict === "ok") verdict = '<div class="dm-verdict ok" role="status"><b>' + esc(fill(C.ok.title, { n: S.rows.length })) + "</b><span>" + esc(C.ok.body) + "</span></div>";
    if (S.verdict === "bad") {
      var k = S.rows.filter(function (r) { return r.mark === "bad"; })[0];
      verdict = '<div class="dm-verdict bad" role="status"><b>' + esc(fill(C.bad.title, { seq: k.seq })) + "</b><span>" + esc(fill(C.bad.body, { at: k.at })) + "</span></div>";
    }
    var keep = list.scrollTop;
    list.innerHTML = '<div class="dm-day">' + esc(C.day) + "</div>" + rows + verdict;
    list.scrollTop = S.phase === "recording" ? list.scrollHeight : (S.verdict ? list.scrollHeight : keep);
  }
  function renderDetail() {
    var d = $("dm-detail");
    var r = S.rows.filter(function (x) { return x.seq === S.selected; })[0];
    if (!r) {
      d.innerHTML = '<div class="dm-empty">' + ICON.file + "<span>" + esc(S.phase === "recording" ? C.empty.working : C.empty.idle) + "</span></div>";
      return;
    }
    var status = r.mark === "ok" ? '<span class="dm-badge ok">' + ICON.ok + esc(C.marks.ok) + "</span>"
      : r.mark === "bad" ? '<span class="dm-badge bad">' + ICON.bad + esc(C.badge.tampered) + "</span>"
      : r.blocked ? '<span class="dm-badge warn">' + esc(C.outcome.blocked) + "</span>"
      : '<span class="dm-badge ok">' + ICON.ok + esc(C.outcome.done) + "</span>";
    var editBlock = "";
    if (S.editing) {
      editBlock = '<form class="dm-edit" id="dm-edit">' +
        '<label for="dm-edit-name">' + esc(C.outcome.action) + '<input id="dm-edit-name" value="' + esc(r.name) + '" autocomplete="off"></label>' +
        '<label for="dm-edit-outcome">' + esc(C.outcome.label) + '<select id="dm-edit-outcome"><option value="done"' + (r.blocked ? "" : " selected") + ">" + esc(C.outcome.done) + '</option><option value="blocked"' + (r.blocked ? " selected" : "") + ">" + esc(C.outcome.blocked) + "</option></select></label>" +
        '<div class="dm-edit-btns"><button class="dm-btn pri" type="submit">' + esc(C.save) + '</button><button class="dm-btn" type="button" id="dm-edit-cancel">' + esc(C.cancel) + "</button></div>" +
        '<p class="dm-note">' + esc(C.editNote) + "</p></form>";
    } else if (S.phase !== "verifying" && r.kind !== "open") {
      editBlock = '<button class="dm-link" type="button" id="dm-edit-open">' + ICON.pencil + esc(C.rewrite[r.kind]) + "</button>";
    }
    var now = r.mark === "bad" ? recompute(S.sc, r) : null;
    d.innerHTML = '<div class="dm-d-top"><span class="dm-kind">' + ICON[r.kind] + "</span>" + status + "</div>" +
      '<h3 class="dm-d-title">' + esc(r.name) + (r.why ? "<small>" + esc(r.why) + "</small>" : "") + "</h3>" +
      '<div class="dm-card">' +
        '<div class="dm-kv"><span>' + esc(C.fields.agent) + "</span><span>" + esc(S.sc.agent) + "</span></div>" +
        '<div class="dm-kv"><span>' + esc(C.fields.when) + "</span><span>" + esc(C.fields.today) + ", " + esc(r.at) + "</span></div>" +
        '<div class="dm-kv"><span>' + esc(C.fields.from) + "</span><span>" + esc(S.sc.from) + "</span></div>" +
        '<div class="dm-kv"><span>' + esc(C.fields.receipt) + '</span><span class="mono">#' + r.seq + "</span></div></div>" +
      '<div class="dm-card dm-hashes">' +
        (r.args ? "<div><small>" + esc(C.fields.args) + "</small><code>" + short(r.argsHash) + "</code></div>" : "") +
        "<div><small>" + esc(C.fields.prev) + "</small><code>" + short(r.prev) + "</code></div>" +
        "<div><small>" + esc(C.fields.sealed) + "</small><code>" + short(r.hash) + "</code></div>" +
        (now ? "<div><small>" + esc(C.fields.now) + '</small><code class="bad">' + short(now) + "</code></div>" : "") +
      "</div>" + editBlock;
  }
  function renderSteps() {
    Array.prototype.forEach.call($("dm-steps").children, function (li, i) {
      li.classList.toggle("now", i + 1 === S.step);
      li.classList.toggle("done", i + 1 < S.step);
    });
  }

  root.addEventListener("click", function (e) {
    var t = e.target;
    var sc = t.closest("[data-sc]");
    if (sc) { start(sc.getAttribute("data-sc")); return; }
    var row = t.closest(".dm-row");
    if (row && S && S.phase !== "verifying") {
      S.selected = Number(row.getAttribute("data-seq")); S.editing = false;
      if (S.step === 2 && S.phase === "done") S.step = 3;
      renderAll(); return;
    }
    if (t.closest("#dm-edit-open")) { S.editing = true; renderDetail(); var n = $("dm-edit-name"); n.focus(); n.select(); return; }
    if (t.closest("#dm-edit-cancel")) { S.editing = false; renderDetail(); return; }
    if (t.closest("#dm-replay")) { start(S.sc.key); return; }
    if (t.closest("#dm-verify")) { verify(); return; }
    if (t.closest("#dm-pack")) { openPack(); return; }
    if (t.id === "dm-scrim" || t.closest("#dm-pack-close")) { $("dm-scrim").hidden = true; }
  });
  root.addEventListener("submit", function (e) {
    if (e.target.id !== "dm-edit") return;
    e.preventDefault();
    var r = S.rows.filter(function (x) { return x.seq === S.selected; })[0];
    var name = $("dm-edit-name").value.trim() || r.name;
    r.name = name; r.blocked = $("dm-edit-outcome").value === "blocked";
    r.edited = name !== r.orig.name || r.blocked !== r.orig.blocked;
    S.editing = false; S.verdict = null;
    S.rows.forEach(function (x) { if (x.mark !== "sealing") x.mark = "sealed"; });
    S.step = 4; renderAll();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") $("dm-scrim").hidden = true; });

  function verify() {
    clear();
    S.phase = "verifying"; S.verdict = null; S.editing = false;
    S.rows.forEach(function (x) { x.mark = "sealed"; x.check = false; });
    renderAll();
    var broken = false, i = 0;
    function next() {
      if (i > 0) S.rows[i - 1].check = false;
      if (i >= S.rows.length) {
        S.phase = "done"; S.verdict = broken ? "bad" : "ok";
        if (broken) S.selected = S.rows.filter(function (r) { return r.mark === "bad"; })[0].seq;
        S.step = broken ? 5 : 4; renderAll(); return;
      }
      var r = S.rows[i];
      var expected = i ? S.rows[i - 1].hash : GENESIS;
      if (broken) r.mark = "broken";
      else if (r.prev !== expected || recompute(S.sc, r) !== r.hash) { r.mark = "bad"; broken = true; }
      else r.mark = "ok";
      r.check = true; i++; renderAll();
      later(next, 380);
    }
    next();
  }

  function openPack() {
    var scrim = $("dm-scrim");
    var files = C.packSheet.files.map(function (f) { return '<li><span class="mono">' + esc(f[0]) + "</span><span>" + esc(fill(f[1], { n: S.rows.length })) + "</span></li>"; }).join("");
    scrim.innerHTML = '<div class="dm-sheet" role="dialog" aria-modal="true" aria-labelledby="dm-pack-title"><h3 id="dm-pack-title">' + esc(fill(C.packSheet.title, { name: S.sc.name })) + "</h3>" +
      "<p>" + esc(C.packSheet.body) + '</p><ul class="dm-files">' + files + '</ul><p class="dm-note">' + esc(C.packSheet.note) + "</p>" +
      '<div><button class="dm-btn pri" type="button" id="dm-pack-close">' + esc(C.packSheet.close) + "</button></div></div>";
    scrim.hidden = false;
    $("dm-pack-close").focus();
  }

  // The window rests as the page drew it until it is on screen, then the agent starts working.
  var first = C.agents[0].key;
  if ("IntersectionObserver" in window) {
    var seen = new IntersectionObserver(function (entries) {
      if (entries.some(function (x) { return x.isIntersecting; })) { seen.disconnect(); if (!S) start(first); }
    }, { threshold: 0.35 });
    seen.observe(root.querySelector(".dm-window"));
  } else start(first);
})();
`;
