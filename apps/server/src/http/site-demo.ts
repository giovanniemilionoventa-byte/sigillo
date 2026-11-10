import { escape } from "./layout.js";
import type { Language } from "./locale.js";

/**
 * The live demo on the public home: three steps, one button at a time. An
 * agent works and each action becomes a receipt in sigillo's own format
 * (docs/FORMAT.md, version 4): canonical JSON (RFC 8785), SHA-256, an Ed25519
 * signature over the hash, each receipt carrying the hash of the one before.
 * The visitor then rewrites one stored receipt, the way someone with database
 * access could, and presses Verify, which runs the verifier's own checks and
 * shows where the chain stops adding up.
 *
 * The page renders the chain at rest (the first sample agent, every action
 * sealed), so it reads without the script. /demo.js (served from this origin,
 * as the CSP's script-src 'self' asks) takes it over: it reads the copy and
 * the sample agents from the JSON block in the page, never from the network.
 * It makes a fresh Ed25519 key in the visitor's browser for every run, signs
 * with it and verifies with it, so the server holds no key for the demo and
 * nothing the visitor does leaves the page. In a browser without Ed25519 the
 * receipts are still hashed and chained, and the verdict says the signature
 * check was skipped.
 *
 * Only the receipt's metadata and hashes exist in the demo, as in the product:
 * a tool's arguments are hashed (scheme "plain") and never shown or kept.
 */

type Kind = "genesis" | "tool_call" | "llm_call" | "decision";

interface DemoStep {
  kind: Kind;
  /** The tool, model or decision name; absent for the opening receipt, which is named after the system. */
  name?: string;
  at: string;
  /** The arguments as JSON text. Only their hash goes into the receipt. */
  args?: string;
  blocked?: boolean;
}

interface DemoAgent {
  key: string;
  tab: string;
  name: string;
  id: string;
  agent: string;
  from: "sdk" | "otlp";
  sealAt: string;
  steps: DemoStep[];
}

interface DemoCopy {
  h2: string;
  lead: string;
  sub: string;
  choose: string;
  window: string;
  reset: string;
  steps: [string, string, string];
  go: { start: string; recording: string; edit: string; save: string; verify: string; checking: string; pack: string };
  hints: { idle: string; recording: string; ready: string; editing: string; edited: string; done: string };
  badge: { idle: string; recording: string; intact: string; edited: string; checking: string; tampered: string };
  marks: { sealing: string; sealed: string; ok: string; bad: string; broken: string };
  no: string;
  edited: string;
  date: string;
  titles: { genesis: string; tool_ok: string; tool_fail: string; llm_ok: string; llm_fail: string; decision_ok: string; decision_fail: string };
  short: { genesis: string; tool_ok: string; tool_fail: string; llm: string; decision: string };
  outcomes: { ok: string; blocked: string };
  rp: {
    empty: string;
    agent: string;
    when: string;
    from: string;
    sources: { sdk: string; otlp: string };
    seal: string;
    sealedAt: string;
    sealing: string;
    details: string;
    fp: string;
    fpNow: string;
    linked: string;
    first: string;
    sig: string;
    input: string;
    version: string;
  };
  edit: { title: string; action: string; outcome: string; cancel: string; note: string };
  side: {
    idle: { k: string; t: string; p: string };
    recording: { k: string; t: string; p: string };
    ready: { k: string; t: string; p: string };
    editing: { k: string; t: string; p: string };
    edited: { k: string; t: string; p: string };
  };
  ok: { tag: string; title: string; body: string; checks: [string, string, string]; nosig: string };
  bad: { tag: string; title: string; checks: { fp: string; sig: string; link: string }; note: string };
  packSheet: { title: string; body: string; files: [string, string][]; note: string; close: string };
  agents: DemoAgent[];
}

const EN: DemoCopy = {
  h2: "Try to rewrite an AI agent's record",
  lead: "Three clicks. Let an agent work, change what happened, then see sigillo catch it.",
  sub: "Sample data, running in your browser. Nothing you do here is sent anywhere.",
  choose: "Choose a sample agent",
  window: "sigillo demo",
  reset: "Reset",
  steps: ["Record", "Edit", "Verify"],
  go: { start: "Start the agent", recording: "Recording…", edit: "Edit a receipt", save: "Save change", verify: "Verify the chain", checking: "Checking…", pack: "See the evidence pack" },
  hints: {
    idle: "Press “Start the agent”: each action it takes will get a signed receipt.",
    recording: "Each action is sealed as it happens, and linked to the one before.",
    ready: "Next: rewrite one stored receipt, the way someone with database access could.",
    editing: "Change the action or its outcome, then save. The signature is not updated.",
    edited: "The change is saved. Now ask sigillo to check the chain.",
    done: "Want to hand it to an auditor? The evidence pack can be checked offline.",
  },
  badge: { idle: "Not connected", recording: "Recording", intact: "Intact", edited: "Edited, not checked", checking: "Checking…", tampered: "Tampered" },
  marks: { sealing: "Sealing…", sealed: "Sealed", ok: "Verified", bad: "Altered", broken: "Not trusted" },
  no: "No. {n}",
  edited: "edited",
  date: "4 Nov 2026",
  titles: {
    genesis: "The system «{name}» opened its ledger.",
    tool_ok: "The agent «{agent}» used the tool «{name}» — completed.",
    tool_fail: "The agent «{agent}» tried the tool «{name}» — blocked.",
    llm_ok: "The agent «{agent}» called the model «{name}» — completed.",
    llm_fail: "The agent «{agent}» tried to call the model «{name}» — blocked.",
    decision_ok: "The decision «{name}» was taken — completed.",
    decision_fail: "The decision «{name}» was attempted — blocked.",
  },
  short: { genesis: "Ledger opened", tool_ok: "Used «{name}»", tool_fail: "Tried «{name}»", llm: "Reply from «{name}»", decision: "Decision «{name}»" },
  outcomes: { ok: "Completed", blocked: "Blocked" },
  rp: {
    empty: "Select a receipt to open it.",
    agent: "Agent",
    when: "When",
    from: "Arrived from",
    sources: { sdk: "Python SDK", otlp: "OpenTelemetry" },
    seal: "Seal",
    sealedAt: "Sealed on {date} at {time}",
    sealing: "Waiting",
    details: "Technical details",
    fp: "Fingerprint sealed",
    fpNow: "Fingerprint of what is stored now",
    linked: "Linked to receipt no. {n}",
    first: "First receipt: no previous one",
    sig: "Signature",
    input: "Input fingerprint",
    version: "Format version",
  },
  edit: { title: "Rewrite the stored receipt", action: "Action", outcome: "Outcome", cancel: "Cancel", note: "This edits the stored row directly, like someone with access to the database. The seal is not updated." },
  side: {
    idle: { k: "Step 1 of 3", t: "Let an agent work", p: "Pick a sample agent above, then press the button below. Each action it takes becomes a receipt, signed and linked to the one before." },
    recording: { k: "Step 1 of 3", t: "Receipts are arriving", p: "Each one holds the hash of the receipt before it. That link is the chain." },
    ready: { k: "Step 2 of 3", t: "Now try to cheat", p: "Imagine you have access to the database and want the record to say something else. Pick a receipt in the chain, then press “Edit a receipt”." },
    editing: { k: "Step 2 of 3", t: "Rewrite the stored receipt", p: "Change the action name or the outcome in the panel, then press “Save change”." },
    edited: { k: "Step 3 of 3", t: "Ask sigillo to check", p: "The receipt now says something else, but its seal is the old one. Press “Verify the chain”." },
  },
  ok: {
    tag: "Intact",
    title: "All {n} receipts check out.",
    body: "Every receipt hashes to what was sealed, and links to the one before it.",
    checks: ["Each fingerprint (SHA-256 of the canonical JSON) matches", "Each Ed25519 signature is valid", "Each receipt links to the one before"],
    nosig: "This browser cannot check Ed25519 signatures, so only fingerprints and links were checked.",
  },
  bad: {
    tag: "Caught",
    title: "Receipt no. {seq} was changed after it was sealed.",
    checks: {
      fp: "The recomputed SHA-256 (canonical JSON, RFC 8785) is not the sealed one",
      sig: "The Ed25519 signature of key {key} no longer holds",
      link: "The prev_hash of receipt no. {next} no longer matches",
    },
    note: "sigillo cannot stop someone with database access from editing a row, but it makes the edit impossible to hide. What a tool's arguments said was never stored: only their fingerprint.",
  },
  packSheet: {
    title: "Evidence pack for {name}",
    body: "One file you can hand to an auditor, a regulator or a court. It can be checked offline with the open-source verifier, without trusting sigillo.",
    files: [["receipts.jsonl", "{n} receipts"], ["checkpoint.json", "Merkle root, Ed25519 signature"], ["timestamp.tsr", "RFC 3161 timestamp"], ["public-key.pem", "to check the signature"], ["report.pdf", "readable summary"]],
    note: "In the demo nothing is downloaded.",
    close: "Close",
  },
  agents: [
    {
      key: "support", tab: "Customer support", name: "Customer support", id: "acme-support-bot", agent: "support-agent", from: "sdk", sealAt: "15:00",
      steps: [
        { kind: "genesis", at: "14:20" },
        { kind: "tool_call", name: "find_order", args: '{"order":"A-20931"}', at: "14:40" },
        { kind: "llm_call", name: "llama3.1:8b", args: '{"prompt":"Customer asks for a refund of 640 EUR"}', at: "14:41" },
        { kind: "tool_call", name: "refund_payment", args: '{"amount":640,"currency":"EUR"}', blocked: true, at: "14:43" },
        { kind: "decision", name: "escalate_to_operator", at: "14:44" },
        { kind: "llm_call", name: "llama3.1:8b", args: '{"prompt":"Tell the customer an operator will call"}', at: "14:44" },
      ],
    },
    {
      key: "invoice", tab: "Invoice approvals", name: "Invoice approvals", id: "ap-invoice-agent", agent: "finance-agent", from: "otlp", sealAt: "10:00",
      steps: [
        { kind: "genesis", at: "09:02" },
        { kind: "tool_call", name: "read_invoice", args: '{"invoice":"INV-2026-1042"}', at: "09:14" },
        { kind: "tool_call", name: "check_vendor", args: '{"vat":"IT01234567890"}', at: "09:14" },
        { kind: "llm_call", name: "claude-sonnet", args: '{"prompt":"Does the invoice match purchase order PO-778?"}', at: "09:15" },
        { kind: "decision", name: "approve_payment", args: '{"amount":1240,"payee":"Nordic Parts Oy"}', at: "09:15" },
        { kind: "tool_call", name: "schedule_payment", args: '{"amount":1240,"due":"2026-11-30"}', at: "09:16" },
      ],
    },
    {
      key: "cv", tab: "CV screening", name: "CV screening", id: "hr-cv-screening", agent: "hr-agent", from: "sdk", sealAt: "12:00",
      steps: [
        { kind: "genesis", at: "11:05" },
        { kind: "tool_call", name: "parse_cv", args: '{"file":"candidate-0187.pdf"}', at: "11:31" },
        { kind: "llm_call", name: "gpt-4.1-mini", args: '{"prompt":"Score this CV against the job profile"}', at: "11:31" },
        { kind: "decision", name: "shortlist", args: '{"score":71}', at: "11:32" },
        { kind: "tool_call", name: "send_rejection_email", args: '{"candidate":"0187"}', blocked: true, at: "11:32" },
        { kind: "decision", name: "queue_for_human_review", at: "11:33" },
      ],
    },
  ],
};

const IT: DemoCopy = {
  h2: "Prova a riscrivere il registro di un agente AI",
  lead: "Tre clic. Lascia lavorare un agente, cambia quello che è successo e guarda sigillo accorgersene.",
  sub: "Dati d'esempio, nel tuo browser. Quello che fai qui non viene inviato da nessuna parte.",
  choose: "Scegli un agente d'esempio",
  window: "Demo di sigillo",
  reset: "Ricomincia",
  steps: ["Registra", "Modifica", "Verifica"],
  go: { start: "Avvia l'agente", recording: "Registrazione…", edit: "Modifica una ricevuta", save: "Salva la modifica", verify: "Verifica la catena", checking: "Controllo…", pack: "Vedi il fascicolo" },
  hints: {
    idle: "Premi «Avvia l'agente»: ogni azione che compie riceverà una ricevuta firmata.",
    recording: "Ogni azione viene sigillata mentre accade e legata alla precedente.",
    ready: "Ora: riscrivi una ricevuta salvata, come potrebbe fare chi ha accesso al database.",
    editing: "Cambia l'azione o il suo esito, poi salva. La firma non viene aggiornata.",
    edited: "La modifica è salvata. Ora chiedi a sigillo di controllare la catena.",
    done: "Vuoi consegnarlo a un revisore? Il fascicolo si controlla anche senza rete.",
  },
  badge: { idle: "Non collegato", recording: "Registra", intact: "Integro", edited: "Modificato, non controllato", checking: "Controllo…", tampered: "Alterato" },
  marks: { sealing: "Sigillo in corso…", sealed: "Sigillata", ok: "Verificata", bad: "Alterata", broken: "Non affidabile" },
  no: "N. {n}",
  edited: "modificata",
  date: "4 nov 2026",
  titles: {
    genesis: "Il sistema «{name}» ha aperto il registro.",
    tool_ok: "L'agente «{agent}» ha usato lo strumento «{name}» — completato.",
    tool_fail: "L'agente «{agent}» ha tentato lo strumento «{name}» — bloccato.",
    llm_ok: "L'agente «{agent}» ha chiamato il modello «{name}» — completato.",
    llm_fail: "L'agente «{agent}» ha tentato di chiamare il modello «{name}» — bloccato.",
    decision_ok: "La decisione «{name}» è stata presa — completato.",
    decision_fail: "La decisione «{name}» è stata tentata — bloccato.",
  },
  short: { genesis: "Registro aperto", tool_ok: "Ha usato «{name}»", tool_fail: "Ha tentato «{name}»", llm: "Risposta da «{name}»", decision: "Decisione «{name}»" },
  outcomes: { ok: "Completata", blocked: "Bloccata" },
  rp: {
    empty: "Seleziona una ricevuta per aprirla.",
    agent: "Agente",
    when: "Quando",
    from: "Arrivata da",
    sources: { sdk: "SDK Python", otlp: "OpenTelemetry" },
    seal: "Sigillo",
    sealedAt: "Sigillata il {date} alle {time}",
    sealing: "In attesa",
    details: "Dettagli tecnici",
    fp: "Impronta sigillata",
    fpNow: "Impronta di ciò che c'è ora",
    linked: "Collegata alla ricevuta n. {n}",
    first: "Prima ricevuta: nessuna precedente",
    sig: "Firma",
    input: "Impronta input",
    version: "Versione del formato",
  },
  edit: { title: "Riscrivi la ricevuta salvata", action: "Azione", outcome: "Esito", cancel: "Annulla", note: "Modifica la riga salvata direttamente, come farebbe chi ha accesso al database. Il sigillo non viene aggiornato." },
  side: {
    idle: { k: "Passo 1 di 3", t: "Lascia lavorare un agente", p: "Scegli un agente d'esempio qui sopra, poi premi il pulsante in basso. Ogni azione diventa una ricevuta, firmata e legata alla precedente." },
    recording: { k: "Passo 1 di 3", t: "Arrivano le ricevute", p: "Ognuna contiene l'impronta della ricevuta prima di lei. Quel legame è la catena." },
    ready: { k: "Passo 2 di 3", t: "Ora prova a barare", p: "Immagina di avere accesso al database e di volere che il registro dica un'altra cosa. Scegli una ricevuta nella catena, poi premi «Modifica una ricevuta»." },
    editing: { k: "Passo 2 di 3", t: "Riscrivi la ricevuta salvata", p: "Cambia il nome dell'azione o l'esito nel pannello, poi premi «Salva la modifica»." },
    edited: { k: "Passo 3 di 3", t: "Chiedi a sigillo di controllare", p: "La ricevuta ora dice altro, ma il suo sigillo è quello vecchio. Premi «Verifica la catena»." },
  },
  ok: {
    tag: "Integro",
    title: "Tutte le {n} ricevute tornano.",
    body: "Ogni ricevuta ha l'impronta sigillata e si lega a quella prima di lei.",
    checks: ["Ogni impronta (SHA-256 del JSON canonico) corrisponde", "Ogni firma Ed25519 è valida", "Ogni ricevuta si lega alla precedente"],
    nosig: "Questo browser non sa controllare le firme Ed25519: sono state controllate solo impronte e legami.",
  },
  bad: {
    tag: "Scoperto",
    title: "La ricevuta n. {seq} è stata cambiata dopo il sigillo.",
    checks: {
      fp: "L'impronta SHA-256 ricalcolata (JSON canonico, RFC 8785) non è quella sigillata",
      sig: "La firma Ed25519 della chiave {key} non vale più",
      link: "Il prev_hash della ricevuta n. {next} non corrisponde più",
    },
    note: "sigillo non può impedire a chi ha accesso al database di modificare una riga, ma rende la modifica impossibile da nascondere. Cosa dicevano gli argomenti di uno strumento non è mai stato salvato: c'è solo la loro impronta.",
  },
  packSheet: {
    title: "Fascicolo di {name}",
    body: "Un unico file da consegnare a un revisore, a un'autorità o a un giudice. Si controlla senza rete con il verificatore open source, senza fidarsi di sigillo.",
    files: [["receipts.jsonl", "{n} ricevute"], ["checkpoint.json", "radice di Merkle, firma Ed25519"], ["timestamp.tsr", "marca temporale RFC 3161"], ["public-key.pem", "per controllare la firma"], ["report.pdf", "riepilogo leggibile"]],
    note: "Nella demo non si scarica niente.",
    close: "Chiudi",
  },
  agents: [
    {
      key: "support", tab: "Assistenza clienti", name: "Assistenza clienti", id: "acme-support-bot", agent: "support-agent", from: "sdk", sealAt: "15:00",
      steps: [
        { kind: "genesis", at: "14:20" },
        { kind: "tool_call", name: "cerca_ordine", args: '{"ordine":"A-20931"}', at: "14:40" },
        { kind: "llm_call", name: "llama3.1:8b", args: '{"prompt":"Il cliente chiede un rimborso di 640 EUR"}', at: "14:41" },
        { kind: "tool_call", name: "rimborsa_pagamento", args: '{"importo":640,"valuta":"EUR"}', blocked: true, at: "14:43" },
        { kind: "decision", name: "passa_a_operatore", at: "14:44" },
        { kind: "llm_call", name: "llama3.1:8b", args: '{"prompt":"Avvisa il cliente che chiamerà un operatore"}', at: "14:44" },
      ],
    },
    {
      key: "invoice", tab: "Approvazione fatture", name: "Approvazione fatture", id: "ap-invoice-agent", agent: "finance-agent", from: "otlp", sealAt: "10:00",
      steps: [
        { kind: "genesis", at: "09:02" },
        { kind: "tool_call", name: "leggi_fattura", args: '{"fattura":"INV-2026-1042"}', at: "09:14" },
        { kind: "tool_call", name: "controlla_fornitore", args: '{"piva":"IT01234567890"}', at: "09:14" },
        { kind: "llm_call", name: "claude-sonnet", args: '{"prompt":"La fattura corrisponde all\'ordine PO-778?"}', at: "09:15" },
        { kind: "decision", name: "approva_pagamento", args: '{"importo":1240,"beneficiario":"Nordic Parts Oy"}', at: "09:15" },
        { kind: "tool_call", name: "programma_pagamento", args: '{"importo":1240,"scadenza":"2026-11-30"}', at: "09:16" },
      ],
    },
    {
      key: "cv", tab: "Selezione CV", name: "Selezione CV", id: "hr-cv-screening", agent: "hr-agent", from: "sdk", sealAt: "12:00",
      steps: [
        { kind: "genesis", at: "11:05" },
        { kind: "tool_call", name: "leggi_curriculum", args: '{"file":"candidato-0187.pdf"}', at: "11:31" },
        { kind: "llm_call", name: "gpt-4.1-mini", args: '{"prompt":"Valuta questo CV rispetto al profilo"}', at: "11:31" },
        { kind: "decision", name: "in_rosa", args: '{"punteggio":71}', at: "11:32" },
        { kind: "tool_call", name: "invia_email_rifiuto", args: '{"candidato":"0187"}', blocked: true, at: "11:32" },
        { kind: "decision", name: "revisione_umana", at: "11:33" },
      ],
    },
  ],
};

const COPY: Record<Language, DemoCopy> = { en: EN, it: IT };

/** The demo's icons, drawn in currentColor so both themes take them. */
const ICON: Record<string, string> = {
  genesis: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3.5C6.5 2.5 4 2.3 2 2.8v9.7c2-.5 4.5-.3 6 .7 1.5-1 4-1.2 6-.7V2.8c-2-.5-4.5-.3-6 .7zM8 3.5v9.7"/></svg>',
  tool_call: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 2.2a3.3 3.3 0 0 0-3.7 4.5L2.4 10.6a1.4 1.4 0 0 0 2 2l3.9-3.9A3.3 3.3 0 0 0 12.8 5l-2 2-1.8-.1-.1-1.8 2-2c-.3-.4-.6-.7-.9-.9z"/></svg>',
  llm_call: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="8" height="8" rx="1.2"/><rect x="6.3" y="6.3" width="3.4" height="3.4"/><path d="M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/></svg>',
  decision: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="6" r="1.6"/><path d="M4 5.1v5.8M12 7.6c0 2.4-2.5 3-6.4 4"/></svg>',
  ok: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="7.2"/><path d="M6.7 10.2l2.2 2.2 4.4-4.6"/></svg>',
  bad: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10" cy="10" r="7.2"/><path d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2"/></svg>',
  pencil: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10.5 2.5l3 3-8 8H2.5v-3z"/></svg>',
  replay: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 8a5.5 5.5 0 1 0 1.7-4"/><path d="M2.5 2.5v3h3"/></svg>',
  shield: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 1.5l5.5 2v4c0 3.4-2.4 6-5.5 7-3.1-1-5.5-3.6-5.5-7v-4z"/><path d="M5.5 8l1.8 1.8L10.8 6.3"/></svg>',
  download: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/></svg>',
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 2.8v10.4L13 8z"/></svg>',
};

/** The short title a card or the list uses for a receipt, from the copy's templates. */
function shortTitle(c: DemoCopy, step: DemoStep): string {
  const name = step.name ?? "";
  const template =
    step.kind === "genesis" ? c.short.genesis : step.kind === "tool_call" ? (step.blocked === true ? c.short.tool_fail : c.short.tool_ok) : step.kind === "llm_call" ? c.short.llm : c.short.decision;
  return template.replace("{name}", name);
}

/** The section, at rest: the first agent's receipts, all sealed, nothing selected. /demo.js brings it to life. */
export function demoSection(language: Language): string {
  const c = COPY[language];
  const first = c.agents[0];
  if (first === undefined) return "";
  const tabs = c.agents
    .map((a, i) => `<button class="dm-tab" type="button" data-sc="${escape(a.key)}" aria-pressed="${i === 0}">${escape(a.tab)}</button>`)
    .join("");
  const prog = c.steps
    .map((label, i) => `<span class="dm-pstep${i === 0 ? " now" : ""}"><i>${i + 1}</i>${escape(label)}</span>${i < c.steps.length - 1 ? "<hr>" : ""}`)
    .join("");
  const cards = first.steps
    .map(
      (s, i) =>
        `<div class="dm-rc"><span class="dm-n">${escape(c.no.replace("{n}", String(i)))} · ${escape(s.at)}</span><b>${escape(shortTitle(c, s))}</b><span class="dm-tag ok">${escape(c.marks.sealed)}</span></div>`,
    )
    .join("");
  // The copy and the sample agents for /demo.js. "<" is written as < so
  // nothing in the data can close the script element.
  const data = JSON.stringify({ copy: c, icons: ICON }).replace(/</g, "\\u003c");
  return `<section class="s-sec dm" id="demo" aria-labelledby="dm-title"><div class="s-wrap">
<header class="dm-intro"><h2 id="dm-title">${escape(c.h2)}</h2><p class="s-lead">${escape(c.lead)}</p></header>
<div class="dm-tabs" role="group" aria-label="${escape(c.choose)}" id="dm-tabs">${tabs}</div>
<div class="dm-card" role="region" aria-label="${escape(c.window)}">
<div class="dm-prog"><div class="dm-psteps" id="dm-prog">${prog}</div><span class="dm-id mono" id="dm-id">${escape(first.id)}</span><span class="dm-badge ok" id="dm-badge">${ICON.ok}${escape(c.badge.intact)}</span></div>
<div class="dm-chain" id="dm-chain">${cards}</div>
<div class="dm-res"><div class="dm-rp" id="dm-rp" aria-live="polite"><p class="dm-empty">${escape(c.rp.empty)}</p></div><div class="dm-side" id="dm-side" aria-live="polite"></div></div>
<div class="dm-foot"><span class="dm-hint" id="dm-hint">${escape(c.sub)}</span><button class="dm-btn" id="dm-reset" type="button">${ICON.replay}${escape(c.reset)}</button><button class="dm-btn pri" id="dm-go" type="button"></button></div>
<div class="dm-scrim" id="dm-scrim" hidden></div>
</div>
<script type="application/json" id="dm-data">${data}</script>
</div></section>`;
}

/** The section's rules, on the site's own tokens (style-v2.ts). Every class starts with dm-, so none of the site's rules reach in. */
export const DEMO_STYLE = `
:where(.dm) button { justify-content: flex-start; box-shadow: none; min-height: 0; white-space: normal; }
:where(.dm) button:disabled, :where(.dm) button:disabled:hover { cursor: default; }
.s-sec.dm { padding: 56px 0; }
.dm .s-wrap { display: grid; gap: 24px; }
.dm-intro { display: grid; justify-items: center; text-align: center; }
.dm-intro h2 { max-width: 22ch; margin: 0 auto 14px; text-wrap: balance; }
.dm-intro .s-lead { margin: 0 auto; text-wrap: balance; }
.dm-tabs { justify-self: center; display: flex; flex-wrap: wrap; justify-content: center; gap: 4px; padding: 4px; border-radius: 12px; background: var(--segment); }
.dm-tab { min-height: 36px; padding: 0 16px; border: 0; border-radius: 9px; background: none; color: var(--secondary); font: inherit; font-size: 14.5px; font-weight: 500; cursor: pointer; white-space: nowrap; }
.dm-tab:hover { color: var(--text); }
.dm-tab[aria-pressed="true"] { background: var(--segment-on); color: var(--text); box-shadow: var(--shadow-segment); }
.dm-card { position: relative; border: 1px solid var(--separator); border-radius: 20px; background: var(--surface); padding: 24px 26px 22px; display: grid; gap: 22px; }
.dm-prog { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; font-size: 14px; color: var(--secondary); }
.dm-psteps { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-right: auto; }
.dm-pstep { display: inline-flex; align-items: center; gap: 8px; }
.dm-pstep i { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-style: normal; font-size: 12px; font-weight: 700; background: var(--fill); }
.dm-pstep.now { color: var(--text); font-weight: 600; }
.dm-pstep.now i { background: var(--action); color: var(--on-action); }
.dm-pstep.done i { background: var(--ok-fill); color: var(--ok); }
.dm-psteps hr { width: 36px; border: 0; border-top: 1px solid var(--separator); margin: 0; }
.dm-id { font-size: 13px; color: var(--secondary); }
.dm-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; background: var(--fill); color: var(--label); }
.dm-badge svg { width: 13px; height: 13px; }
.dm-badge.ok { background: var(--ok-fill); color: var(--ok); }
.dm-badge.bad { background: var(--bad-fill); color: var(--bad); }
.dm-badge.warn { background: var(--warn-fill); color: var(--warn); }
.dm-chain { display: flex; gap: 22px; overflow-x: auto; padding: 4px 2px 6px; }
.dm-rc { position: relative; flex: 1 0 138px; min-width: 0; display: grid; gap: 6px; align-content: start; padding: 14px; border: 1px solid var(--separator); border-radius: 14px; background: var(--canvas); color: var(--text); font: inherit; text-align: left; font-size: 14px; }
button.dm-rc { cursor: pointer; }
button.dm-rc:hover { background: var(--hover); }
.dm-rc::after { content: ""; position: absolute; left: 100%; top: 50%; width: 22px; border-top: 2px solid var(--ok); opacity: 0.6; }
.dm-rc:last-child::after { display: none; }
.dm-rc.lk-bad::after { border-top: 2px dashed var(--bad); opacity: 1; }
.dm-rc.lk-gone::after { border-top: 2px dashed var(--thread); opacity: 1; }
.dm-rc[aria-pressed="true"] { border-color: var(--action); box-shadow: 0 0 0 3px var(--selected); }
.dm-rc.is-bad { border-color: var(--bad); background: var(--bad-fill); }
.dm-rc.is-broken { opacity: 0.55; border-style: dashed; }
.dm-rc.ghost { border-style: dashed; opacity: 0.45; min-height: 112px; }
.dm-rc.new { animation: dm-in 0.35s ease-out both; }
.dm-rc b { font-size: 13.5px; line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
.dm-n { font-size: 11.5px; letter-spacing: 0.05em; color: var(--secondary); font-weight: 600; text-transform: uppercase; }
.dm-h { font-size: 11px; color: var(--secondary); overflow-wrap: anywhere; }
.dm-h.bad { color: var(--bad); }
.dm-tag { justify-self: start; font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--fill); color: var(--label); }
.dm-tag.ok { background: var(--ok-fill); color: var(--ok); }
.dm-tag.bad { background: var(--bad-fill); color: var(--bad); }
.dm-tag.warn { background: var(--warn-fill); color: var(--warn); }
.dm-res { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 20px; }
.dm-rp { border: 1px solid var(--separator); border-radius: 14px; background: var(--canvas); padding: 18px 20px; display: grid; gap: 12px; align-content: start; min-height: 300px; }
.dm-empty { margin: auto; color: var(--secondary); font-size: 14px; }
.dm-rp-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.dm-kind { width: 30px; height: 30px; border-radius: 8px; background: var(--fill); display: grid; place-items: center; color: var(--label); }
.dm-kind svg { width: 16px; height: 16px; }
.dm-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.dm-title { margin: 0; font-size: 18px; line-height: 1.35; font-weight: 600; overflow-wrap: anywhere; }
.dm-tbl { border: 1px solid var(--separator); border-radius: 12px; overflow: hidden; background: var(--surface); }
.dm-kv { display: flex; justify-content: space-between; gap: 14px; padding: 10px 14px; font-size: 14px; border-top: 1px solid var(--separator); }
.dm-kv:first-child { border-top: 0; }
.dm-kv > span:first-child { color: var(--secondary); flex: none; }
.dm-kv > span:last-child { text-align: right; min-width: 0; overflow-wrap: anywhere; }
.dm-kv .okv { color: var(--ok); font-weight: 500; }
.dm-det > summary { list-style: none; cursor: pointer; color: var(--link); font-size: 14px; font-weight: 500; display: inline-flex; gap: 6px; align-items: center; }
.dm-det > summary::-webkit-details-marker { display: none; }
.dm-det > summary::before { content: "›"; display: inline-block; transition: transform 0.15s; }
.dm-det[open] > summary::before { transform: rotate(90deg); }
.dm-det .dm-tbl { margin-top: 10px; }
.dm-fp { display: grid; gap: 2px; padding: 10px 14px; border-top: 1px solid var(--separator); font-size: 12px; }
.dm-fp:first-child { border-top: 0; }
.dm-fp small { color: var(--secondary); font-size: 12px; }
.dm-fp code { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; color: var(--label); }
.dm-fp code.bad { color: var(--bad); }
.dm-edit { display: grid; gap: 10px; }
.dm-edit label { display: grid; gap: 4px; font-size: 13px; color: var(--secondary); }
.dm-edit input, .dm-edit select { min-height: 38px; border-radius: 8px; border: 1px solid var(--separator); background: var(--fill); color: var(--text); padding: 0 10px; font: inherit; font-size: 14.5px; width: 100%; }
.dm-edit input:focus, .dm-edit select:focus { outline: 2px solid var(--focus); outline-offset: 1px; }
.dm-note { margin: 0; font-size: 12.5px; color: var(--secondary); }
.dm-link { border: 0; background: none; color: var(--link); padding: 0; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; justify-self: start; }
.dm-side { border-radius: 14px; padding: 20px 22px; display: grid; gap: 10px; align-content: start; background: var(--selected); border: 1px solid var(--separator); }
.dm-side .k { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--link); }
.dm-side h3 { margin: 0; font-size: 20px; line-height: 1.25; }
.dm-side p { margin: 0; font-size: 14.5px; line-height: 1.55; color: var(--label); }
.dm-side.bad { background: var(--bad-fill); border-color: color-mix(in srgb, var(--bad) 40%, transparent); }
.dm-side.bad .k { color: var(--bad); }
.dm-side.ok { background: var(--ok-fill); border-color: color-mix(in srgb, var(--ok) 40%, transparent); }
.dm-side.ok .k { color: var(--ok); }
.dm-checks { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 10px; font-size: 14px; line-height: 1.4; color: var(--text); }
.dm-checks li { display: flex; gap: 10px; align-items: flex-start; }
.dm-checks i { flex: none; width: 20px; height: 20px; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; font-style: normal; font-size: 11px; font-weight: 700; background: var(--bad-fill); color: var(--bad); }
.dm-side.ok .dm-checks i { background: var(--ok-fill); color: var(--ok); box-shadow: 0 0 0 1px var(--ok); }
.dm-side.bad .dm-checks i { box-shadow: 0 0 0 1px var(--bad); }
.dm-checks .mono { font-size: 12px; color: var(--secondary); display: block; margin-top: 2px; overflow-wrap: anywhere; }
.dm-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding-top: 20px; border-top: 1px solid var(--separator); }
.dm-hint { margin-right: auto; color: var(--secondary); font-size: 14px; flex: 1 1 260px; }
.dm:not(.live) #dm-go, .dm:not(.live) #dm-reset { display: none; }
.dm-btn { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 20px; border-radius: 10px; border: 1px solid var(--separator); background: var(--fill); color: var(--text); font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; }
.dm-btn:hover:not(:disabled) { background: var(--hover); }
.dm-btn:disabled { opacity: 0.5; }
.dm-btn.pri { background: var(--action); border-color: var(--action); color: var(--on-action); }
.dm-btn.pri:hover:not(:disabled) { background: var(--action); filter: brightness(1.1); }
.dm-btn.pulse:not(:disabled) { animation: dm-ring 1.8s ease-in-out infinite; }
.dm-btn svg { width: 15px; height: 15px; }
.dm-scrim { position: absolute; inset: 0; background: var(--scrim); display: grid; place-items: center; padding: 16px; z-index: 2; border-radius: 20px; }
.dm-scrim[hidden] { display: none; }
.dm-sheet { width: min(440px, 100%); background: var(--surface); border-radius: 12px; box-shadow: var(--shadow-sheet); padding: 20px; display: grid; gap: 12px; animation: dm-in 0.25s ease-out both; }
.dm-sheet h3 { margin: 0; font-size: 17px; }
.dm-sheet p { margin: 0; color: var(--label); font-size: 14px; }
.dm-files { margin: 0; padding: 0; list-style: none; border: 1px solid var(--separator); border-radius: 10px; }
.dm-files li { display: flex; justify-content: space-between; gap: 10px; padding: 8px 12px; font-size: 13px; border-top: 1px solid var(--separator); }
.dm-files li:first-child { border-top: 0; }
.dm-files li span:last-child { color: var(--secondary); text-align: right; }
@keyframes dm-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes dm-ring { 0%, 100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 0 5px var(--selected); } }
@media (prefers-reduced-motion: reduce) { .dm *, .dm *::before { animation: none !important; transition: none !important; } }
@media (max-width: 860px) {
  .dm-res { grid-template-columns: minmax(0, 1fr); }
  .dm-rp { min-height: 0; }
}
@media (max-width: 760px) {
  .s-sec.dm { padding: 36px 0; }
  .dm-card { padding: 16px 14px 16px; border-radius: 16px; }
  .dm-chain { gap: 22px; }
  .dm-rc { flex: 0 0 168px; }
  .dm-tabs { justify-content: flex-start; width: 100%; overflow-x: auto; flex-wrap: nowrap; }
  .dm-foot { position: sticky; bottom: 0; background: var(--surface); padding-bottom: 4px; }
  .dm-btn { flex: 1 1 auto; justify-content: center; }
}
`;

/**
 * /demo.js. Written without backquotes and without dollar-brace, so that it
 * can sit in this template literal as it is (String.raw keeps its
 * backslashes). The SHA-256 is FIPS 180-4, in a few lines, so hashing needs
 * neither a secure context nor an await; the signatures are the browser's own
 * Ed25519 (WebCrypto).
 */
export const DEMO_SCRIPT = String.raw`"use strict";
(function () {
  var root = document.getElementById("demo");
  var dataEl = document.getElementById("dm-data");
  if (!root || !dataEl) return;
  var D = JSON.parse(dataEl.textContent);
  var C = D.copy, ICON = D.icons;

  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var enc = new TextEncoder();
  function sha256Bytes(msg) {
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
    var out = new Uint8Array(32);
    for (var j = 0; j < 8; j++) out[j * 4] = H[j] >>> 24, out[j * 4 + 1] = (H[j] >>> 16) & 255, out[j * 4 + 2] = (H[j] >>> 8) & 255, out[j * 4 + 3] = H[j] & 255;
    return out;
  }
  function hex(bytes) { return Array.prototype.map.call(bytes, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  function fromHex(h) { var o = new Uint8Array(h.length / 2); for (var i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; }
  function sha256Text(text) { return hex(sha256Bytes(enc.encode(text))); }
  window.sigilloDemoSha256 = sha256Text;
  function b64(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function unb64(text) { var s = atob(text), o = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) o[i] = s.charCodeAt(i); return o; }

  // RFC 8785 for what a receipt holds: sorted keys, no whitespace, integers, strings, null.
  function canon(v) {
    if (v === null) return "null";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canon(v[k]); }).join(",") + "}";
  }
  // The receipt hash (FORMAT.md section 4): SHA-256 of the canonical form without "sig".
  function receiptHash(r) {
    var o = {};
    Object.keys(r).forEach(function (k) { if (k !== "sig") o[k] = r[k]; });
    return sha256Text(canon(o));
  }

  var subtle = window.crypto && window.crypto.subtle;
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var GENESIS = "0000000000000000000000000000000000000000000000000000000000000000";
  var S = null, timers = [], runId = 0;
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (ch) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]; }); }
  function fill(template, values) { return template.replace(/\{(\w+)\}/g, function (_, k) { return values[k]; }); }
  function short(h) { return h.slice(0, 8) + "…" + h.slice(-4); }
  function clear() { timers.forEach(clearTimeout); timers = []; }
  function later(fn, ms) { timers.push(setTimeout(fn, reduced ? 0 : ms)); }
  function pause(ms) { return new Promise(function (resolve) { later(resolve, ms); }); }

  // A fresh Ed25519 key for every run, in this browser only. Without Ed25519 the chain still hashes and links.
  function makeKey() {
    if (!subtle) return Promise.resolve(null);
    return subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]).then(function (pair) {
      var both = Object.keys(pair).map(function (name) { return pair[name]; });
      var signer = both.filter(function (k) { return k.type === "private"; })[0];
      var checker = both.filter(function (k) { return k.type === "public"; })[0];
      return subtle.exportKey("raw", checker).then(function (raw) {
        return { priv: signer, pub: checker, id: hex(sha256Bytes(new Uint8Array(raw))).slice(0, 16) };
      });
    }).catch(function () { return null; });
  }
  function build(sc, step, i, prev, keyId) {
    var genesis = step.kind === "genesis";
    var sec = ("0" + ((11 + i * 7) % 60)).slice(-2);
    var at = "2026-11-04T" + step.at + ":" + sec + ".118Z";
    var hasArgs = !!step.args;
    var r = {
      v: 4, system_id: sc.id, seq: i, ts_event: at, ts_received: at,
      actor: { agent: sc.agent },
      action: { kind: step.kind, name: genesis ? sc.id : step.name },
      input_hash: hasArgs ? sha256Text(canon(JSON.parse(step.args))) : null,
      input_hash_scheme: hasArgs ? "plain" : null,
      output_hash: null, output_hash_scheme: null,
      outcome: step.blocked ? "blocked" : "ok",
      source: { type: genesis ? "api" : sc.from },
      prev_hash: prev, key_id: keyId
    };
    if (step.kind === "llm_call") r.model = { name: step.name, provider: null, digest: null };
    return r;
  }
  function seal(sc, key, step, i, prev) {
    var r = build(sc, step, i, prev, key ? key.id : "0000000000000000");
    var h = receiptHash(r);
    var done = function (sig) {
      r.sig = sig;
      return { r: r, at: step.at, hash: h, mark: "sealing", fresh: true, edited: false, orig: { name: r.action.name, outcome: r.outcome } };
    };
    if (!key) return Promise.resolve(done(""));
    return subtle.sign("Ed25519", key.priv, fromHex(h)).then(function (sig) { return done(b64(new Uint8Array(sig))); });
  }

  function idle(keyName) {
    clear(); runId++;
    var sc = C.agents.filter(function (a) { return a.key === keyName; })[0] || (S && S.sc) || C.agents[0];
    S = { sc: sc, rows: [], selected: null, phase: "idle", key: null, verdict: null, target: null };
    $("dm-scrim").hidden = true;
    renderAll();
  }
  function record() {
    var token = ++runId, sc = S.sc;
    S.phase = "recording"; renderAll();
    makeKey().then(function (key) {
      if (token !== runId) return;
      S.key = key;
      var chain = Promise.resolve([]);
      sc.steps.forEach(function (step, i) {
        chain = chain.then(function (rows) {
          var prev = i ? rows[i - 1].hash : GENESIS;
          return seal(sc, key, step, i, prev).then(function (row) { rows.push(row); return rows; });
        });
      });
      return chain;
    }).then(function (rows) {
      if (!rows || token !== runId) return;
      var i = 0;
      function reveal() {
        if (token !== runId) return;
        if (i >= rows.length) {
          S.phase = "ready";
          var d = rows.filter(function (x) { return x.r.action.kind === "decision"; })[0] || rows[rows.length - 1];
          S.target = d.r.seq; S.selected = d.r.seq;
          renderAll(); return;
        }
        var row = rows[i++];
        S.rows.push(row); renderAll(); row.fresh = false;
        later(function () { row.mark = "sealed"; renderAll(); }, 450);
        later(reveal, reduced ? 0 : 800);
      }
      reveal();
    });
  }

  function sentence(r) {
    var k = r.action.kind, t = C.titles, blocked = r.outcome === "blocked";
    var vals = { agent: r.actor.agent, name: r.action.name };
    if (k === "genesis") return fill(t.genesis, vals);
    if (k === "tool_call") return fill(blocked ? t.tool_fail : t.tool_ok, vals);
    if (k === "llm_call") return fill(blocked ? t.llm_fail : t.llm_ok, vals);
    return fill(blocked ? t.decision_fail : t.decision_ok, vals);
  }
  function cardTitle(r) {
    var k = r.action.kind, s = C.short;
    if (k === "genesis") return s.genesis;
    var tpl = k === "tool_call" ? (r.outcome === "blocked" ? s.tool_fail : s.tool_ok) : k === "llm_call" ? s.llm : s.decision;
    return fill(tpl, { name: r.action.name });
  }

  function step() {
    return { idle: 1, recording: 1, ready: 2, editing: 2, edited: 3, verifying: 3, done: 4 }[S.phase];
  }
  function renderAll() { renderTabs(); renderProg(); renderChain(); renderRp(); renderSide(); renderFoot(); }
  function renderTabs() {
    Array.prototype.forEach.call($("dm-tabs").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-sc") === S.sc.key)); });
  }
  function renderProg() {
    var n = step();
    $("dm-prog").innerHTML = C.steps.map(function (label, i) {
      var cls = i + 1 < n ? " done" : i + 1 === n ? " now" : "";
      return '<span class="dm-pstep' + cls + '"><i>' + (i + 1 < n ? "✓" : i + 1) + "</i>" + esc(label) + "</span>" + (i < C.steps.length - 1 ? "<hr>" : "");
    }).join("");
    $("dm-id").textContent = S.sc.id;
    var b = $("dm-badge"), p = S.phase;
    if (p === "idle") { b.className = "dm-badge"; b.textContent = C.badge.idle; }
    else if (p === "recording") { b.className = "dm-badge"; b.textContent = C.badge.recording; }
    else if (p === "verifying") { b.className = "dm-badge"; b.textContent = C.badge.checking; }
    else if (S.verdict && S.verdict.ok === false) { b.className = "dm-badge bad"; b.innerHTML = ICON.bad + esc(C.badge.tampered); }
    else if (p === "edited" || p === "editing" && S.rows.some(function (x) { return x.edited; })) { b.className = "dm-badge warn"; b.textContent = C.badge.edited; }
    else { b.className = "dm-badge ok"; b.innerHTML = ICON.ok + esc(C.badge.intact); }
  }
  function renderChain() {
    var html = "";
    var total = S.sc.steps.length;
    for (var i = 0; i < total; i++) {
      var row = S.rows[i], next = S.rows[i + 1];
      if (!row) {
        html += '<div class="dm-rc ghost" aria-hidden="true"><span class="dm-n">' + esc(fill(C.no, { n: i })) + " · " + esc(S.sc.steps[i].at) + "</span><b>…</b></div>";
        continue;
      }
      var cls = "dm-rc" + (row.fresh ? " new" : "") + (row.mark === "bad" ? " is-bad" : "") + (row.mark === "broken" ? " is-broken" : "");
      if (next && next.mark === "bad") cls += " lk-bad";
      else if (row.mark === "bad" || row.mark === "broken") cls += " lk-gone";
      var tag = row.mark === "bad" ? "bad" : row.mark === "broken" ? "warn" : row.mark === "sealing" ? "" : "ok";
      var hash = '<span class="dm-h mono' + (row.now ? " bad" : "") + '">' + short(row.hash) + (row.now ? " ≠ " + short(row.now) : "") + "</span>";
      html += '<button class="' + cls + '" type="button" data-seq="' + row.r.seq + '" aria-pressed="' + (S.selected === row.r.seq) + '">' +
        '<span class="dm-n">' + esc(fill(C.no, { n: row.r.seq })) + " · " + esc(row.at) + "</span><b>" + esc(cardTitle(row.r)) + "</b>" + hash +
        '<span class="dm-tag ' + tag + '">' + esc(C.marks[row.mark]) + (row.edited ? " · " + esc(C.edited) : "") + "</span></button>";
    }
    $("dm-chain").innerHTML = html;
  }
  function renderRp() {
    var d = $("dm-rp");
    var row = S.rows.filter(function (x) { return x.r.seq === S.selected; })[0];
    if (!row) { d.innerHTML = '<p class="dm-empty">' + esc(C.rp.empty) + "</p>"; return; }
    var r = row.r;
    var open = S.phase === "done" || row.edited;
    var now = row.edited ? receiptHash(r) : null;
    var tags = (row.edited ? '<span class="dm-tag warn">' + esc(C.edited) + "</span>" : "") +
      '<span class="dm-tag ' + (r.outcome === "blocked" ? "warn" : "ok") + '">' + esc(r.outcome === "blocked" ? C.outcomes.blocked : C.outcomes.ok) + "</span>";
    var top = '<div class="dm-rp-top"><span class="dm-kind">' + ICON[r.action.kind === "genesis" ? "genesis" : r.action.kind] + '</span><span class="dm-tags">' + tags + "</span></div>";
    if (S.phase === "editing" && S.target === r.seq) {
      d.innerHTML = top + '<h3 class="dm-title">' + esc(C.edit.title) + '</h3><form class="dm-edit" id="dm-edit">' +
        '<label for="dm-edit-name">' + esc(C.edit.action) + '<input id="dm-edit-name" maxlength="256" value="' + esc(r.action.name) + '" autocomplete="off"></label>' +
        '<label for="dm-edit-outcome">' + esc(C.edit.outcome) + '<select id="dm-edit-outcome"><option value="ok"' + (r.outcome === "ok" ? " selected" : "") + ">" + esc(C.outcomes.ok) + '</option><option value="blocked"' + (r.outcome === "blocked" ? " selected" : "") + ">" + esc(C.outcomes.blocked) + "</option></select></label>" +
        '<button class="dm-link" type="button" id="dm-edit-cancel">' + esc(C.edit.cancel) + '</button><p class="dm-note">' + esc(C.edit.note) + "</p></form>";
      return;
    }
    var facts = (r.action.kind === "genesis" ? "" : '<div class="dm-kv"><span>' + esc(C.rp.agent) + "</span><span>" + esc(r.actor.agent) + "</span></div>") +
      '<div class="dm-kv"><span>' + esc(C.rp.when) + "</span><span>" + esc(C.date) + ", " + esc(row.at) + "</span></div>" +
      '<div class="dm-kv"><span>' + esc(C.rp.from) + "</span><span>" + esc(C.rp.sources[r.source.type] || "sigillo") + "</span></div>";
    var sealed = row.mark === "sealing" ? '<span>' + esc(C.rp.sealing) + "</span>" : '<span class="okv">' + esc(fill(C.rp.sealedAt, { date: C.date, time: S.sc.sealAt })) + "</span>";
    var tech = '<div class="dm-fp"><small>' + esc(C.rp.fp) + "</small><code>" + row.hash + "</code></div>" +
      (now ? '<div class="dm-fp"><small>' + esc(C.rp.fpNow) + '</small><code class="bad">' + now + "</code></div>" : "") +
      '<div class="dm-fp"><small>' + esc(r.seq === 0 ? C.rp.first : fill(C.rp.linked, { n: r.seq - 1 })) + "</small><code>" + r.prev_hash + "</code></div>" +
      '<div class="dm-fp"><small>' + esc(C.rp.sig) + "</small><code>" + (r.sig ? "Ed25519 · " + r.key_id + "<br>" + r.sig : "—") + "</code></div>" +
      (r.input_hash ? '<div class="dm-fp"><small>' + esc(C.rp.input) + "</small><code>" + r.input_hash + "</code></div>" : "") +
      '<div class="dm-fp"><small>' + esc(C.rp.version) + "</small><code>v" + r.v + "</code></div>";
    d.innerHTML = top + '<h3 class="dm-title">' + esc(sentence(r)) + '</h3><div class="dm-tbl">' + facts + '</div><div class="dm-tbl"><div class="dm-kv"><span>' + esc(C.rp.seal) + "</span>" + sealed + "</div></div>" +
      '<details class="dm-det"' + (open ? " open" : "") + "><summary>" + esc(C.rp.details) + '</summary><div class="dm-tbl">' + tech + "</div></details>";
  }
  function renderSide() {
    var el = $("dm-side"), v = S.verdict;
    if (S.phase === "done" && v) {
      var items = "";
      if (v.ok) {
        items = C.ok.checks.map(function (t, i) { return "<li><i>" + (i === 1 && !v.sig ? "–" : "✓") + "</i><span>" + esc(t) + "</span></li>"; }).join("");
        el.className = "dm-side ok";
        el.innerHTML = '<span class="k">' + esc(C.ok.tag) + "</span><h3>" + esc(fill(C.ok.title, { n: S.rows.length })) + "</h3><p>" + esc(C.ok.body) + '</p><ul class="dm-checks">' + items + "</ul>" + (v.sig ? "" : '<p class="dm-note">' + esc(C.ok.nosig) + "</p>");
        return;
      }
      items = '<li><i>✕</i><span>' + esc(C.bad.checks.fp) + '<span class="mono">' + short(v.sealed) + " → " + short(v.now) + "</span></span></li>" +
        (v.sig ? '<li><i>✕</i><span>' + esc(fill(C.bad.checks.sig, { key: short(v.key) })) + "</span></li>" : "") +
        (v.next === null ? "" : '<li><i>✕</i><span>' + esc(fill(C.bad.checks.link, { next: v.next })) + "</span></li>");
      el.className = "dm-side bad";
      el.innerHTML = '<span class="k">' + esc(C.bad.tag) + "</span><h3>" + esc(fill(C.bad.title, { seq: v.seq })) + '</h3><ul class="dm-checks">' + items + '</ul><p class="dm-note">' + esc(C.bad.note) + "</p>";
      return;
    }
    var p = S.phase === "verifying" ? C.side.edited : C.side[S.phase];
    el.className = "dm-side";
    el.innerHTML = '<span class="k">' + esc(p.k) + "</span><h3>" + esc(p.t) + "</h3><p>" + esc(p.p) + "</p>";
  }
  function renderFoot() {
    var go = $("dm-go"), p = S.phase;
    var label = { idle: C.go.start, recording: C.go.recording, ready: C.go.edit, editing: C.go.save, edited: C.go.verify, verifying: C.go.checking, done: C.go.pack }[p];
    var icon = { idle: ICON.play, ready: ICON.pencil, edited: ICON.shield, done: ICON.download }[p] || "";
    go.innerHTML = icon + esc(label);
    go.disabled = p === "recording" || p === "verifying";
    go.classList.toggle("pulse", !go.disabled);
    $("dm-hint").textContent = p === "verifying" ? C.hints.edited : C.hints[p === "idle" ? "idle" : p];
    $("dm-reset").disabled = p === "idle";
  }

  function beginEdit() {
    var row = S.rows.filter(function (x) { return x.r.seq === S.selected && x.r.action.kind !== "genesis"; })[0];
    if (!row) row = S.rows.filter(function (x) { return x.r.seq === S.target; })[0];
    S.target = row.r.seq; S.selected = row.r.seq; S.phase = "editing";
    renderAll();
    var n = $("dm-edit-name"); if (n) { n.focus(); n.select(); }
  }
  function saveEdit() {
    var row = S.rows.filter(function (x) { return x.r.seq === S.target; })[0];
    var name = $("dm-edit-name").value.trim() || row.r.action.name;
    row.r.action.name = name;
    row.r.outcome = $("dm-edit-outcome").value;
    row.edited = name !== row.orig.name || row.r.outcome !== row.orig.outcome;
    S.phase = row.edited ? "edited" : "ready";
    renderAll();
  }
  function cancelEdit() { S.phase = S.rows.some(function (x) { return x.edited; }) ? "edited" : "ready"; renderAll(); }

  // The verifier's checks, receipt by receipt (FORMAT.md section 6): the fingerprint, the signature over it, the link to the receipt before.
  function verify() {
    var token = ++runId, rows = S.rows;
    S.phase = "verifying"; S.verdict = null;
    rows.forEach(function (x) { x.mark = "sealed"; x.now = null; });
    renderAll();
    var broken = null, i = 0, prevNow = GENESIS;
    function check(row) {
      var now = receiptHash(row.r);
      var fpOk = now === row.hash, linkOk = row.r.prev_hash === prevNow;
      prevNow = now;
      if (!S.key) return Promise.resolve({ now: now, fpOk: fpOk, sigOk: true, linkOk: linkOk });
      return subtle.verify("Ed25519", S.key.pub, unb64(row.r.sig), fromHex(now)).then(function (ok) { return { now: now, fpOk: fpOk, sigOk: ok, linkOk: linkOk }; });
    }
    function next() {
      if (token !== runId) return;
      if (i >= rows.length) {
        S.phase = "done";
        if (broken === null) S.verdict = { ok: true, sig: !!S.key };
        else {
          var bi = broken.i, after = rows[bi + 1];
          S.verdict = { ok: false, seq: rows[bi].r.seq, sealed: rows[bi].hash, now: broken.res.now, sig: !!S.key, key: rows[bi].r.key_id, next: after && after.r.prev_hash !== broken.res.now ? after.r.seq : null };
          S.selected = rows[bi].r.seq;
        }
        renderAll(); return;
      }
      var row = rows[i];
      if (broken !== null) { row.mark = "broken"; i++; renderAll(); later(next, 160); return; }
      check(row).then(function (res) {
        if (token !== runId) return;
        if (res.fpOk && res.sigOk && res.linkOk) row.mark = "ok";
        else { row.mark = "bad"; row.now = res.now; broken = { i: i, res: res }; }
        i++; renderAll(); later(next, 380);
      });
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

  root.addEventListener("click", function (e) {
    var t = e.target;
    var tab = t.closest(".dm-tab");
    if (tab) { idle(tab.getAttribute("data-sc")); return; }
    var card = t.closest("button.dm-rc");
    if (card && S && S.phase !== "recording" && S.phase !== "verifying") {
      S.selected = Number(card.getAttribute("data-seq"));
      if (S.phase === "editing") S.phase = "ready";
      if (S.phase === "ready" && S.selected !== 0) S.target = S.selected;
      renderAll(); return;
    }
    if (t.closest("#dm-edit-cancel")) { cancelEdit(); return; }
    if (t.closest("#dm-reset")) { idle(S.sc.key); return; }
    if (t.closest("#dm-go")) {
      var p = S.phase;
      if (p === "idle") record();
      else if (p === "ready") beginEdit();
      else if (p === "editing") saveEdit();
      else if (p === "edited") verify();
      else if (p === "done") openPack();
      return;
    }
    if (t.id === "dm-scrim" || t.closest("#dm-pack-close")) { $("dm-scrim").hidden = true; }
  });
  root.addEventListener("submit", function (e) {
    if (e.target.id !== "dm-edit") return;
    e.preventDefault(); saveEdit();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") $("dm-scrim").hidden = true; });

  // The page drew the chain at rest; the script takes it over and waits for the visitor to start the agent.
  root.classList.add("live");
  window.sigilloDemo = { state: function () { return S; }, receiptHash: receiptHash, canon: canon };
  idle(C.agents[0].key);
})();
`;
