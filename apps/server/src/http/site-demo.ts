import { createHash } from "node:crypto";
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

interface Guide {
  t: string;
  p: string;
  todo: string;
  why: string;
}

interface DemoCopy {
  h2: string;
  lead: string;
  sub: string;
  choose: string;
  window: string;
  reset: string;
  steps: [string, string, string];
  guide: { step: string; done: string; other: string; idle: Guide; recording: Guide; ready: Guide; editing: Guide; edited: Guide };
  go: { verify: string; checking: string; pack: string };
  list: { title: string; count: string; day: string; waiting: string; rewrite: string };
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
  edit: { title: string; action: string; outcome: string; cancel: string; save: string; note: string };
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
  steps: ["Watch the agent work", "Edit the record", "Verify and find out"],
  guide: {
    step: "Step {n} of 3",
    done: "All done",
    other: "Try another sample agent",
    idle: { t: "An agent is about to start", p: "A sample agent works while you watch. Each action it takes becomes a receipt: signed, and linked to the one before.", todo: "Nothing to do yet: it starts by itself.", why: "Nothing you do here leaves your browser." },
    recording: { t: "Watch it work", p: "Each action gets a receipt as it happens. Every receipt holds the fingerprint of the one before it: that link is the chain.", todo: "Watch the receipts arrive in the list on the right.", why: "A tool's arguments are never stored, only their fingerprint." },
    ready: { t: "Now try to cheat", p: "Imagine you have access to the database and want the record to say something else. Open an action, then try to rewrite it.", todo: "Tap an action in the list, then press “Try to rewrite this receipt”.", why: "The seal is not updated: it is like erasing in pencil on a signed sheet." },
    editing: { t: "Rewrite the stored receipt", p: "Change the name of the action, or its outcome, the way someone with database access could.", todo: "Change a field, then press “Save change”.", why: "This edits the stored row directly. The signature stays the old one." },
    edited: { t: "Verify and find out", p: "The receipt now says something else, but its seal is still the old one. Ask sigillo to check the whole chain.", todo: "Press “Verify the chain”, at the top of the list.", why: "sigillo recomputes every fingerprint and checks every signature and link." },
  },
  go: { verify: "Verify the chain", checking: "Checking…", pack: "Prepare the evidence pack" },
  list: { title: "Recorded actions", count: "{n} receipts today", day: "Today · Wednesday 4 November", waiting: "The agent will start in a moment.", rewrite: "Try to rewrite this receipt" },
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
  edit: { title: "Rewrite the stored receipt", action: "Action", outcome: "Outcome", cancel: "Cancel", save: "Save change", note: "This edits the stored row directly, like someone with access to the database. The seal is not updated." },
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
  steps: ["Guarda l'agente lavorare", "Modifica il registro", "Verifica e scoprilo"],
  guide: {
    step: "Passo {n} di 3",
    done: "Fatto",
    other: "Prova un altro agente d'esempio",
    idle: { t: "Sta per partire un agente", p: "Un agente d'esempio lavora mentre guardi. Ogni azione che compie diventa una ricevuta: firmata e legata alla precedente.", todo: "Non devi fare ancora niente: parte da solo.", why: "Quello che fai qui non esce dal tuo browser." },
    recording: { t: "Guardalo lavorare", p: "Ogni azione riceve una ricevuta mentre accade. Ogni ricevuta contiene l'impronta della precedente: quel legame è la catena.", todo: "Guarda arrivare le ricevute nell'elenco a destra.", why: "Gli argomenti di uno strumento non si salvano mai, solo la loro impronta." },
    ready: { t: "Ora prova a barare", p: "Immagina di avere accesso al database e di volere che il registro dica un'altra cosa. Apri un'azione e prova a riscriverla.", todo: "Tocca un'azione dell'elenco, poi premi «Prova a riscrivere questa ricevuta».", why: "Il sigillo non viene aggiornato: è come cancellare a matita su un foglio firmato." },
    editing: { t: "Riscrivi la ricevuta salvata", p: "Cambia il nome dell'azione, o il suo esito, come potrebbe fare chi ha accesso al database.", todo: "Cambia un campo, poi premi «Salva la modifica».", why: "Modifica la riga salvata direttamente. La firma resta quella vecchia." },
    edited: { t: "Verifica e scoprilo", p: "La ricevuta ora dice altro, ma il suo sigillo è ancora quello vecchio. Chiedi a sigillo di controllare tutta la catena.", todo: "Premi «Verifica la catena», in alto sopra l'elenco.", why: "sigillo ricalcola ogni impronta e controlla ogni firma e ogni legame." },
  },
  go: { verify: "Verifica la catena", checking: "Controllo…", pack: "Prepara il fascicolo" },
  list: { title: "Azioni registrate", count: "{n} ricevute oggi", day: "Oggi · mercoledì 4 novembre", waiting: "L'agente parte tra un momento.", rewrite: "Prova a riscrivere questa ricevuta" },
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
  edit: { title: "Riscrivi la ricevuta salvata", action: "Azione", outcome: "Esito", cancel: "Annulla", save: "Salva la modifica", note: "Modifica la riga salvata direttamente, come farebbe chi ha accesso al database. Il sigillo non viene aggiornato." },
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

/** The short title a row uses for a receipt, from the copy's templates. */
function shortTitle(c: DemoCopy, step: DemoStep): string {
  const name = step.name ?? "";
  const template =
    step.kind === "genesis" ? c.short.genesis : step.kind === "tool_call" ? (step.blocked === true ? c.short.tool_fail : c.short.tool_ok) : step.kind === "llm_call" ? c.short.llm : c.short.decision;
  return template.replace("{name}", name);
}

/** The section, at rest: step 1 on the left, the first agent's actions (all sealed) on the right. /demo.js brings it to life. */
export function demoSection(language: Language): string {
  const c = COPY[language];
  const first = c.agents[0];
  if (first === undefined) return "";
  const icon = (name: string): string => ICON[name] ?? "";
  const chips = c.agents.map((a, i) => `<button class="dm-chip" type="button" data-sc="${escape(a.key)}" aria-pressed="${i === 0}">${escape(a.tab)}</button>`).join("");
  const steps = c.steps.map((label, i) => `<li class="dm-st${i === 0 ? " now" : ""}"><i>${i + 1}</i>${escape(label)}</li>`).join("");
  const g = c.guide.idle;
  const rows = first.steps
    .map(
      (s) =>
        `<div class="dm-row"><span class="dm-t">${escape(s.at)}</span><span class="dm-kind">${icon(s.kind)}</span><span class="dm-name">${escape(shortTitle(c, s))}</span>${
          s.blocked === true ? `<span class="dm-tag warn">⚠ ${escape(c.outcomes.blocked)}</span>` : ""
        }<span class="dm-sl">${escape(c.marks.sealed)}</span></div>`,
    )
    .join("");
  // The copy and the sample agents for /demo.js. "<" is written as < so
  // nothing in the data can close the script element.
  const data = JSON.stringify({ copy: c, icons: ICON }).replace(/</g, "\\u003c");
  return `<section class="s-sec dm" id="demo" aria-labelledby="dm-title"><div class="s-wrap">
<header class="dm-intro"><h2 id="dm-title">${escape(c.h2)}</h2><p class="s-lead">${escape(c.lead)}</p></header>
<div class="dm-grid" role="region" aria-label="${escape(c.window)}">
<aside class="dm-guide">
<span class="dm-k" id="dm-k">${escape(c.guide.step.replace("{n}", "1"))}</span>
<div class="dm-bar"><i id="dm-bar" style="width:33%"></i></div>
<div id="dm-gbody"><h3>${escape(g.t)}</h3><p>${escape(g.p)}</p><div class="dm-todo"><b>${escape(c.guide.step.replace("{n}", "1").toUpperCase())}</b>${escape(g.todo)}</div><p class="dm-why">${escape(g.why)}</p></div>
<div class="dm-other"><span>${escape(c.guide.other)}</span><div class="dm-chips" id="dm-chips" role="group" aria-label="${escape(c.choose)}">${chips}</div></div>
<ol class="dm-steps" id="dm-steps">${steps}</ol>
<button class="dm-btn dm-reset" id="dm-reset" type="button">${icon("replay")}${escape(c.reset)}</button>
</aside>
<div class="dm-sim">
<div class="dm-sh"><span class="dm-kind big">${icon("decision")}</span><b class="dm-sname" id="dm-name">${escape(first.name)}</b><span class="dm-id mono" id="dm-id">${escape(first.id)}</span><span class="dm-badge ok" id="dm-badge">${icon("ok")}${escape(c.badge.intact)}</span>
<span class="dm-sa"><button class="dm-btn pri" id="dm-verify" type="button" disabled>${icon("shield")}${escape(c.go.verify)}</button><button class="dm-btn" id="dm-pack" type="button" disabled>${icon("download")}${escape(c.go.pack)}</button></span></div>
<p class="dm-meta" id="dm-meta">${escape(c.list.count.replace("{n}", String(first.steps.length)))}</p>
<div class="dm-list" id="dm-list" role="listbox" aria-label="${escape(c.list.title)}"><div class="dm-day">${escape(c.list.day)}</div>${rows}</div>
</div>
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
.dm .s-wrap { display: grid; gap: 26px; }
.dm-intro { display: grid; justify-items: center; text-align: center; }
.dm-intro h2 { max-width: 22ch; margin: 0 auto 14px; text-wrap: balance; }
.dm-intro .s-lead { margin: 0 auto; text-wrap: balance; }
.dm-grid { position: relative; display: grid; grid-template-columns: 360px minmax(0, 1fr); border: 1px solid var(--separator); border-radius: 20px; overflow: hidden; background: var(--surface); }
.dm-guide { background: var(--sidebar); border-right: 1px solid var(--separator); padding: 26px 26px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.dm-k { font-size: 13px; color: var(--link); font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
.dm-bar { height: 6px; background: var(--fill); border-radius: 3px; overflow: hidden; }
.dm-bar i { display: block; height: 100%; background: var(--action); transition: width 0.3s; }
.dm-guide h3 { margin: 6px 0 10px; font-size: 24px; line-height: 1.2; letter-spacing: -0.01em; }
.dm-guide p { margin: 0; color: var(--label); font-size: 15px; line-height: 1.6; }
.dm-todo { margin-top: 16px; background: var(--selected); border: 1px solid var(--action); border-radius: 12px; padding: 14px 16px; font-size: 15px; line-height: 1.5; color: var(--text); }
.dm-todo b { display: block; font-size: 11.5px; letter-spacing: 0.08em; color: var(--link); margin-bottom: 5px; }
.dm-guide p.dm-why { margin-top: 14px; font-size: 13.5px; color: var(--secondary); border-left: 2px solid var(--separator); padding-left: 12px; }
.dm-other { display: grid; gap: 8px; font-size: 13px; color: var(--secondary); }
.dm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dm-chip { min-height: 34px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--separator); background: var(--surface); color: var(--label); font: inherit; font-size: 13.5px; font-weight: 500; cursor: pointer; }
.dm-chip:hover { background: var(--hover); }
.dm-chip[aria-pressed="true"] { background: var(--selected); border-color: var(--action); color: var(--text); }
.dm-steps { list-style: none; margin: auto 0 0; padding: 0; display: grid; gap: 2px; font-size: 14px; }
.dm-st { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; color: var(--secondary); }
.dm-st i { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-style: normal; font-size: 11px; font-weight: 700; background: var(--fill); flex: none; }
.dm-st.done { color: var(--label); }
.dm-st.done i { background: var(--ok-fill); color: var(--ok); }
.dm-st.now { background: var(--fill); color: var(--text); font-weight: 600; }
.dm-st.now i { background: var(--action); color: var(--on-action); }
.dm-reset { justify-content: center; }
.dm-sim { padding: 22px 26px 24px; min-width: 0; display: flex; flex-direction: column; min-height: 640px; }
.dm-sh { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.dm-sname { font-size: 20px; letter-spacing: -0.01em; }
.dm-id { font-size: 13px; color: var(--secondary); }
.dm-sa { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
.dm-meta { margin: 8px 0 14px; font-size: 13.5px; color: var(--secondary); }
.dm-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; background: var(--fill); color: var(--label); }
.dm-badge svg { width: 13px; height: 13px; }
.dm-badge.ok { background: var(--ok-fill); color: var(--ok); }
.dm-badge.bad { background: var(--bad-fill); color: var(--bad); }
.dm-badge.warn { background: var(--warn-fill); color: var(--warn); }
.dm-list { flex: 1; }
.dm-day { margin: 2px 12px 8px; font-size: 12.5px; color: var(--secondary); font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; }
.dm-row { width: 100%; display: grid; grid-template-columns: 44px 30px minmax(0, 1fr) auto auto; align-items: center; gap: 12px; min-height: 52px; padding: 0 12px; border: 1px solid transparent; border-radius: 10px; background: none; color: var(--text); text-align: left; font: inherit; font-size: 15px; }
button.dm-row { cursor: pointer; }
button.dm-row:hover { background: var(--hover); }
.dm-row.new { animation: dm-in 0.35s ease-out both; }
.dm-row[aria-selected="true"] { background: var(--selected); border-color: var(--action); box-shadow: 0 0 0 4px color-mix(in srgb, var(--action) 18%, transparent); font-weight: 600; }
.dm-row.is-bad { background: var(--bad-fill); border-color: var(--bad); }
.dm-row.is-broken { opacity: 0.5; }
.dm-list.editing .dm-row:not([aria-selected="true"]) { opacity: 0.4; }
.dm-t { color: var(--secondary); font-variant-numeric: tabular-nums; font-size: 13px; font-weight: 400; }
.dm-kind { width: 30px; height: 30px; border-radius: 8px; background: var(--fill); display: grid; place-items: center; color: var(--label); flex: none; }
.dm-kind.big { width: 34px; height: 34px; }
.dm-kind svg { width: 16px; height: 16px; }
.dm-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dm-name em { font-style: normal; color: var(--warn); font-size: 12px; margin-left: 8px; font-weight: 600; }
.dm-tag { font-size: 12px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--fill); color: var(--label); white-space: nowrap; }
.dm-tag.ok { background: var(--ok-fill); color: var(--ok); }
.dm-tag.bad { background: var(--bad-fill); color: var(--bad); }
.dm-tag.warn { background: var(--warn-fill); color: var(--warn); }
.dm-sl { font-size: 12.5px; font-weight: 600; color: var(--ok); white-space: nowrap; font-weight: 600; }
.dm-sl.sealing { color: var(--secondary); }
.dm-sl.bad { color: var(--bad); }
.dm-sl.broken { color: var(--warn); }
.dm-open { margin: 6px 0 10px 56px; border: 1px solid var(--separator); border-radius: 14px; background: var(--canvas); padding: 18px 20px; display: grid; gap: 12px; animation: dm-in 0.25s ease-out both; }
.dm-rp-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.dm-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.dm-title { margin: 0; font-size: 17px; line-height: 1.4; font-weight: 600; overflow-wrap: anywhere; }
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
.dm-edit input, .dm-edit select { min-height: 40px; border-radius: 8px; border: 1px solid var(--separator); background: var(--fill); color: var(--text); padding: 0 10px; font: inherit; font-size: 15px; width: 100%; }
.dm-edit input:focus, .dm-edit select:focus { outline: 2px solid var(--focus); outline-offset: 1px; }
.dm-edit-btns { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dm-note { margin: 0; font-size: 12.5px; color: var(--secondary); }
.dm-warn { margin: 0; font-size: 13px; color: var(--warn); background: var(--warn-fill); border-radius: 8px; padding: 9px 12px; }
.dm-link { border: 0; background: none; color: var(--link); padding: 0; font: inherit; font-size: 14.5px; font-weight: 600; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; justify-self: start; }
.dm-link svg { width: 14px; height: 14px; }
.dm-waiting { margin: 60px 12px; text-align: center; color: var(--secondary); font-size: 14.5px; }
.dm-verdict { border-radius: 12px; padding: 16px 18px; display: grid; gap: 8px; animation: dm-in 0.3s ease-out both; }
.dm-verdict .k { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.dm-verdict h3 { margin: 0; font-size: 18px; line-height: 1.3; }
.dm-verdict.bad { background: var(--bad-fill); border: 1px solid color-mix(in srgb, var(--bad) 40%, transparent); }
.dm-verdict.bad .k { color: var(--bad); }
.dm-verdict.ok { background: var(--ok-fill); border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent); }
.dm-verdict.ok .k { color: var(--ok); }
.dm-guide .dm-verdict p { font-size: 14px; }
.dm-checks { list-style: none; margin: 2px 0 0; padding: 0; display: grid; gap: 9px; font-size: 14px; line-height: 1.4; color: var(--text); }
.dm-checks li { display: flex; gap: 10px; align-items: flex-start; }
.dm-checks i { flex: none; width: 20px; height: 20px; margin-top: 1px; border-radius: 50%; display: grid; place-items: center; font-style: normal; font-size: 11px; font-weight: 700; }
.dm-verdict.bad .dm-checks i { color: var(--bad); box-shadow: 0 0 0 1px var(--bad); }
.dm-verdict.ok .dm-checks i { color: var(--ok); box-shadow: 0 0 0 1px var(--ok); }
.dm-checks .mono { font-size: 12px; color: var(--secondary); display: block; margin-top: 2px; overflow-wrap: anywhere; }
.dm-btn { display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid var(--separator); background: var(--fill); color: var(--text); font: inherit; font-size: 14.5px; font-weight: 600; cursor: pointer; }
.dm-btn:hover:not(:disabled) { background: var(--hover); }
.dm-btn:disabled { opacity: 0.45; }
.dm-btn.pri { background: var(--action); border-color: var(--action); color: var(--on-action); }
.dm-btn.pri:hover:not(:disabled) { background: var(--action); filter: brightness(1.1); }
.dm-btn.pulse:not(:disabled) { animation: dm-ring 1.8s ease-in-out infinite; }
.dm-btn svg { width: 15px; height: 15px; }
.dm:not(.live) .dm-other, .dm:not(.live) .dm-reset { display: none; }
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
@media (max-width: 900px) {
  .dm-grid { grid-template-columns: minmax(0, 1fr); }
  .dm-guide { border-right: 0; border-bottom: 1px solid var(--separator); padding: 18px 16px; }
  .dm-steps, .dm-guide p.dm-why { display: none; }
  .dm-guide h3 { font-size: 20px; }
  .dm-sim { min-height: 0; padding: 16px 12px 18px; }
  .dm-open { margin-left: 0; }
}
@media (max-width: 760px) {
  .s-sec.dm { padding: 36px 0; }
  .dm-grid { border-radius: 16px; }
  .dm-row { grid-template-columns: 40px 28px minmax(0, 1fr) auto; gap: 8px; padding: 0 8px; }
  .dm-row .dm-tag, .dm-row .dm-ph { display: none; }
  .dm-sa { margin-left: 0; width: 100%; }
  .dm-sa .dm-btn { flex: 1 1 auto; justify-content: center; }
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
        if (i >= rows.length) { S.phase = "ready"; renderAll(); return; }
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
  function rowTitle(r) {
    var k = r.action.kind, s = C.short;
    if (k === "genesis") return s.genesis;
    var tpl = k === "tool_call" ? (r.outcome === "blocked" ? s.tool_fail : s.tool_ok) : k === "llm_call" ? s.llm : s.decision;
    return fill(tpl, { name: r.action.name });
  }

  // The three steps of the guide: 1 watch the agent work, 2 edit the record, 3 verify.
  function step() {
    return { idle: 1, recording: 1, ready: 2, editing: 2, edited: 3, verifying: 3, done: 4 }[S.phase];
  }
  function renderAll() { renderGuide(); renderHead(); renderList(); }
  function renderGuide() {
    var n = step(), total = C.steps.length, finished = n > total;
    $("dm-k").textContent = finished ? C.guide.done : fill(C.guide.step, { n: n });
    $("dm-bar").style.width = (finished ? 100 : Math.round(n * 100 / total)) + "%";
    Array.prototype.forEach.call($("dm-chips").children, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-sc") === S.sc.key)); });
    $("dm-steps").innerHTML = C.steps.map(function (label, i) {
      var cls = i + 1 < n ? " done" : i + 1 === n ? " now" : "";
      return '<li class="dm-st' + cls + '"><i>' + (i + 1 < n ? "✓" : i + 1) + "</i>" + esc(label) + "</li>";
    }).join("");
    var body = $("dm-gbody"), v = S.verdict;
    if (S.phase === "done" && v) {
      var items;
      if (v.ok) {
        items = C.ok.checks.map(function (t, i) { return "<li><i>" + (i === 1 && !v.sig ? "–" : "✓") + "</i><span>" + esc(t) + "</span></li>"; }).join("");
        body.innerHTML = '<div class="dm-verdict ok" role="status"><span class="k">' + esc(C.ok.tag) + "</span><h3>" + esc(fill(C.ok.title, { n: S.rows.length })) + "</h3><p>" + esc(C.ok.body) + '</p><ul class="dm-checks">' + items + "</ul>" + (v.sig ? "" : '<p class="dm-note">' + esc(C.ok.nosig) + "</p>") + "</div>";
      } else {
        items = '<li><i>✕</i><span>' + esc(C.bad.checks.fp) + '<span class="mono">' + short(v.sealed) + " → " + short(v.now) + "</span></span></li>" +
          (v.sig ? '<li><i>✕</i><span>' + esc(fill(C.bad.checks.sig, { key: short(v.key) })) + "</span></li>" : "") +
          (v.next === null ? "" : '<li><i>✕</i><span>' + esc(fill(C.bad.checks.link, { next: v.next })) + "</span></li>");
        body.innerHTML = '<div class="dm-verdict bad" role="status"><span class="k">' + esc(C.bad.tag) + "</span><h3>" + esc(fill(C.bad.title, { seq: v.seq })) + '</h3><ul class="dm-checks">' + items + '</ul><p class="dm-note">' + esc(C.bad.note) + "</p></div>";
      }
      return;
    }
    var g = C.guide[S.phase === "verifying" ? "edited" : S.phase];
    body.innerHTML = "<h3>" + esc(g.t) + "</h3><p>" + esc(g.p) + '</p><div class="dm-todo"><b>' + esc(fill(C.guide.step, { n: n }).toUpperCase()) + "</b>" + esc(g.todo) + '</div><p class="dm-why">' + esc(g.why) + "</p>";
  }
  function renderHead() {
    $("dm-name").textContent = S.sc.name;
    $("dm-id").textContent = S.sc.id;
    $("dm-meta").textContent = fill(C.list.count, { n: S.sc.steps.length });
    var b = $("dm-badge"), p = S.phase;
    if (p === "idle") { b.className = "dm-badge"; b.textContent = C.badge.idle; }
    else if (p === "recording") { b.className = "dm-badge"; b.textContent = C.badge.recording; }
    else if (p === "verifying") { b.className = "dm-badge"; b.textContent = C.badge.checking; }
    else if (S.verdict && S.verdict.ok === false) { b.className = "dm-badge bad"; b.innerHTML = ICON.bad + esc(C.badge.tampered); }
    else if (p === "edited" || (p === "editing" && S.rows.some(function (x) { return x.edited; }))) { b.className = "dm-badge warn"; b.textContent = C.badge.edited; }
    else { b.className = "dm-badge ok"; b.innerHTML = ICON.ok + esc(C.badge.intact); }
    var v = $("dm-verify"), canVerify = p === "ready" || p === "edited" || p === "done";
    v.disabled = !canVerify;
    v.classList.toggle("pulse", p === "edited");
    v.lastChild.textContent = p === "verifying" ? C.go.checking : C.go.verify;
    $("dm-pack").disabled = !(p === "ready" || p === "edited" || p === "done");
  }
  function openPanel(row) {
    var r = row.r;
    var now = row.edited ? receiptHash(r) : null;
    var tags = (row.edited ? '<span class="dm-tag warn">' + esc(C.edited) + "</span>" : "") +
      '<span class="dm-tag ' + (r.outcome === "blocked" ? "warn" : "ok") + '">' + esc(r.outcome === "blocked" ? C.outcomes.blocked : C.outcomes.ok) + "</span>";
    var top = '<div class="dm-rp-top"><span class="dm-kind">' + ICON[r.action.kind === "genesis" ? "genesis" : r.action.kind] + '</span><span class="dm-tags">' + tags + "</span></div>";
    if (S.phase === "editing" && S.target === r.seq) {
      return '<div class="dm-open">' + top + '<h4 class="dm-title">' + esc(C.edit.title) + '</h4><form class="dm-edit" id="dm-edit">' +
        '<label for="dm-edit-name">' + esc(C.edit.action) + '<input id="dm-edit-name" maxlength="256" value="' + esc(r.action.name) + '" autocomplete="off"></label>' +
        '<label for="dm-edit-outcome">' + esc(C.edit.outcome) + '<select id="dm-edit-outcome"><option value="ok"' + (r.outcome === "ok" ? " selected" : "") + ">" + esc(C.outcomes.ok) + '</option><option value="blocked"' + (r.outcome === "blocked" ? " selected" : "") + ">" + esc(C.outcomes.blocked) + "</option></select></label>" +
        '<p class="dm-warn">' + esc(C.edit.note) + '</p><div class="dm-edit-btns"><button class="dm-btn" type="button" id="dm-edit-cancel">' + esc(C.edit.cancel) + '</button><button class="dm-btn pri pulse" type="submit">' + esc(C.edit.save) + "</button></div></form></div>";
    }
    var facts = (r.action.kind === "genesis" ? "" : '<div class="dm-kv"><span>' + esc(C.rp.agent) + "</span><span>" + esc(r.actor.agent) + "</span></div>") +
      '<div class="dm-kv"><span>' + esc(C.rp.when) + "</span><span>" + esc(C.date) + ", " + esc(row.at) + "</span></div>" +
      '<div class="dm-kv"><span>' + esc(C.rp.from) + "</span><span>" + esc(C.rp.sources[r.source.type] || "sigillo") + "</span></div>";
    var sealed = row.mark === "sealing" ? "<span>" + esc(C.rp.sealing) + "</span>" : '<span class="okv">' + esc(fill(C.rp.sealedAt, { date: C.date, time: S.sc.sealAt })) + "</span>";
    var tech = '<div class="dm-fp"><small>' + esc(C.rp.fp) + "</small><code>" + row.hash + "</code></div>" +
      (now ? '<div class="dm-fp"><small>' + esc(C.rp.fpNow) + '</small><code class="bad">' + now + "</code></div>" : "") +
      '<div class="dm-fp"><small>' + esc(r.seq === 0 ? C.rp.first : fill(C.rp.linked, { n: r.seq - 1 })) + "</small><code>" + r.prev_hash + "</code></div>" +
      '<div class="dm-fp"><small>' + esc(C.rp.sig) + "</small><code>" + (r.sig ? "Ed25519 · " + r.key_id + "<br>" + r.sig : "—") + "</code></div>" +
      (r.input_hash ? '<div class="dm-fp"><small>' + esc(C.rp.input) + "</small><code>" + r.input_hash + "</code></div>" : "") +
      '<div class="dm-fp"><small>' + esc(C.rp.version) + "</small><code>v" + r.v + "</code></div>";
    var canEdit = (S.phase === "ready" || S.phase === "edited") && r.action.kind !== "genesis";
    return '<div class="dm-open">' + top + '<h4 class="dm-title">' + esc(sentence(r)) + '</h4><div class="dm-tbl">' + facts + '</div><div class="dm-tbl"><div class="dm-kv"><span>' + esc(C.rp.seal) + "</span>" + sealed + "</div></div>" +
      '<details class="dm-det"' + (S.phase === "done" || row.edited ? " open" : "") + "><summary>" + esc(C.rp.details) + '</summary><div class="dm-tbl">' + tech + "</div></details>" +
      (canEdit ? '<button class="dm-link" type="button" id="dm-edit-open">' + ICON.pencil + esc(C.list.rewrite) + "</button>" : "") + "</div>";
  }
  function renderList() {
    var list = $("dm-list");
    var html = '<div class="dm-day">' + esc(C.list.day) + "</div>";
    if (S.phase === "idle") html += '<p class="dm-waiting">' + esc(C.list.waiting) + "</p>";
    S.rows.forEach(function (row) {
      var r = row.r, sel = S.selected === r.seq;
      var cls = "dm-row" + (row.fresh ? " new" : "") + (row.mark === "bad" ? " is-bad" : "") + (row.mark === "broken" ? " is-broken" : "");
      var mark = row.mark === "bad" ? "bad" : row.mark === "broken" ? "broken" : row.mark === "sealing" ? "sealing" : "";
      html += '<button class="' + cls + '" type="button" role="option" data-seq="' + r.seq + '" aria-selected="' + sel + '">' +
        '<span class="dm-t">' + esc(row.at) + '</span><span class="dm-kind">' + ICON[r.action.kind] + "</span>" +
        '<span class="dm-name">' + esc(rowTitle(r)) + (row.edited ? "<em>" + esc(C.edited) + "</em>" : "") + "</span>" +
        (r.outcome === "blocked" ? '<span class="dm-tag warn">⚠ ' + esc(C.outcomes.blocked) + "</span>" : '<span class="dm-ph"></span>') +
        '<span class="dm-sl ' + mark + '">' + esc(C.marks[row.mark]) + "</span></button>";
      if (sel) html += openPanel(row);
    });
    list.className = "dm-list" + (S.phase === "editing" ? " editing" : "");
    var keep = list.scrollTop;
    list.innerHTML = html;
    list.scrollTop = keep;
  }

  function beginEdit() {
    var row = S.rows.filter(function (x) { return x.r.seq === S.selected && x.r.action.kind !== "genesis"; })[0];
    if (!row) return;
    S.target = row.r.seq; S.phase = "editing";
    renderAll();
    var n = $("dm-edit-name"); if (n) { n.focus(); n.select(); }
  }
  function saveEdit() {
    var row = S.rows.filter(function (x) { return x.r.seq === S.target; })[0];
    var name = $("dm-edit-name").value.trim() || row.r.action.name;
    row.r.action.name = name;
    row.r.outcome = $("dm-edit-outcome").value;
    row.edited = name !== row.orig.name || row.r.outcome !== row.orig.outcome || row.edited;
    S.phase = S.rows.some(function (x) { return x.edited; }) ? "edited" : "ready";
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
    var chip = t.closest(".dm-chip");
    if (chip) { idle(chip.getAttribute("data-sc")); record(); return; }
    var row = t.closest("button.dm-row");
    if (row && S && S.phase !== "recording" && S.phase !== "verifying") {
      var seq = Number(row.getAttribute("data-seq"));
      if (S.phase === "editing") S.phase = S.rows.some(function (x) { return x.edited; }) ? "edited" : "ready";
      S.selected = S.selected === seq ? null : seq;
      renderAll(); return;
    }
    if (t.closest("#dm-edit-open")) { beginEdit(); return; }
    if (t.closest("#dm-edit-cancel")) { cancelEdit(); return; }
    if (t.closest("#dm-reset")) { idle(S.sc.key); record(); return; }
    if (t.closest("#dm-verify")) { verify(); return; }
    if (t.closest("#dm-pack")) { openPack(); return; }
    if (t.id === "dm-scrim" || t.closest("#dm-pack-close")) { $("dm-scrim").hidden = true; }
  });
  root.addEventListener("submit", function (e) {
    if (e.target.id !== "dm-edit") return;
    e.preventDefault(); saveEdit();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") $("dm-scrim").hidden = true; });

  // The page drew the first agent's actions at rest; the script takes it over. The first agent starts by itself the moment the demo comes into view.
  root.classList.add("live");
  window.sigilloDemo = { state: function () { return S; }, receiptHash: receiptHash, canon: canon };
  idle(C.agents[0].key);
  var grid = root.querySelector(".dm-grid");
  function autostart() { if (S.phase === "idle") record(); }
  if ("IntersectionObserver" in window && grid) {
    var seen = new IntersectionObserver(function (entries) {
      if (entries.some(function (en) { return en.isIntersecting; })) { seen.disconnect(); autostart(); }
    }, { threshold: 0.3 });
    seen.observe(grid);
  } else autostart();
})();
`;

/** The script's address carries a fingerprint of its text, so a browser that kept an older copy fetches the one that matches the page. */
export const DEMO_SCRIPT_URL = `/demo.js?v=${createHash("sha256").update(DEMO_SCRIPT).digest("hex").slice(0, 12)}`;
