import { escape, languageSwitch } from "./layout.js";
import { STYLE_V2 } from "./style-v2.js";
import { SEAL_SVG, STATE_ICONS } from "./style.js";
import { PROOF_ICONS } from "./style-v2.js";
import type { Language } from "./locale.js";

/**
 * The redesigned public home (SIGILLO_SITE_V2): one page with anchors, drawn
 * with the console's own tokens, marks and signs, so that whoever signs in
 * stays in the same product. It shows what is bought (the evidence pack as the
 * inspector sees it) before the mechanism, says what it proves and what it
 * does not, and offers one invitation. Everything is server-rendered: the only
 * script is the copy button's (/site.js), as on the site as it was.
 *
 * Facts the owner has not given (company name, VAT number, address, the
 * server's country) are bracketed placeholders, never invented.
 */

interface Copy {
  nav: { how: string; deliver: string; aiAct: string; pricing: string; blog: string; verify: string; signIn: string; start: string };
  title: string;
  description: string;
  hero: { eyebrow: string; h1: string; lead: string; primary: string; secondary: string; facts: [string, string][] };
  card: { verdict: string; line: string; key: string; matches: string; title: string; rows: [string, string][]; sealed: string };
  problem: { eyebrow: string; h2: string; body: string; more: string; video: string; subtitles: string };
  disputes: { eyebrow: string; h2: string; body: string; more: string };
  fit: { eyebrow: string; h2: string; lead: string; forTitle: string; forLead: string; forItems: [string, string][]; notTitle: string; notLead: string; notItems: [string, string][] };
  steps: { eyebrow: string; h2: string; items: [string, string][] };
  how: { h2: string; questions: { q: string; a: string; kind: "ok" | "action" | "proof" }[] };
  deliver: { h2: string; story: string[]; contents: string[]; sample: string; verify: string };
  proves: { h2: string; yes: string; no: string; yesLines: string[]; noLines: string[]; see: string; seeText: string; facts: [string, string][] };
  aiAct: { h2: string; rows: { art: string; what: string; how: string }[]; honest: string };
  connect: { eyebrow: string; h2: string; lead: string; steps: [string, string][]; or: string; where: string; copy: string; copied: string };
  faq: { eyebrow: string; h2: string; lead: string };
  pricing: { h2: string; plans: { name: string; price: string; lines: string[]; cta: string; note?: string }[]; unit: string; faq: { q: string; a: string }[] };
  contact: { h2: string; button: string; address: string };
  footer: { product: string; receivers: string; company: string; format: string; privacy: string; about: string; legal: string };
}

const IT: Copy = {
  nav: { how: "Come funziona", deliver: "Cosa consegni", aiAct: "AI Act", pricing: "Prezzi", blog: "Blog", verify: "Verifica un fascicolo", signIn: "Accedi", start: "Richiedi un pilota gratuito" },
  title: "sigillo · le prove di cosa ha fatto la tua AI",
  description: "sigillo registra ogni azione dei tuoi agenti AI in un registro firmato e sigillato ogni ora. Quando arriva un reclamo o un'ispezione, consegni un fascicolo che chiunque controlla da solo, nel browser.",
  hero: {
    eyebrow: "Se un tuo agente AI venisse contestato domani, potresti verificare cosa ha fatto?",
    h1: "Dimostra cosa ha fatto la tua AI. Quando conta di più.",
    lead: "sigillo crea registri firmati e con marca temporale delle azioni dei tuoi agenti AI, che chiunque può verificare in modo indipendente, senza esporre i dati riservati della tua azienda.",
    primary: "Richiedi un pilota gratuito",
    secondary: "Verifica un fascicolo d'esempio",
    facts: [["Solo impronte", "Prompt e risposte restano da te."], ["Verifichi da solo", "Strumento a riga di comando, anche senza rete."], ["Pilota gratuito", "Nessun dato di pagamento."]],
  },
  card: {
    verdict: "Integro",
    line: "4 ricevute di Selezione CV — backend junior, 13 ottobre 2026, firmate e in ordine.",
    key: "Codice della chiave",
    matches: "Corrisponde",
    title: "Selezione CV — backend junior",
    rows: [["16:58", "Ha usato «leggi_curriculum»"], ["16:58", "Risposta da «llama3.1:8b»"], ["16:59", "Decisione «scarta_candidato»"], ["17:00", "Sigillata, con marca temporale"]],
    sealed: "Fascicolo pronto da consegnare. Dati d'esempio.",
  },
  problem: {
    eyebrow: "Il problema",
    h2: "Se domani dovessi giustificare le azioni della tua AI, avresti le prove?",
    body: "Gli agenti AI prendono decisioni e compiono azioni con conseguenze reali. Quando vengono contestate, serve più del ricordo di come sono andate le cose. sigillo conserva registri verificabili che mostrano cosa è successo e rendono rilevabili le alterazioni successive.",
    more: "Cosa prova, cosa no",
    video: "Demo di sigillo, 3 minuti",
    subtitles: "Italiano",
  },
  disputes: {
    eyebrow: "Le decisioni della tua AI possono essere contestate. Le tue prove devono essere verificabili.",
    h2: "Quando nasce una contestazione, non basta la tua parola.",
    body: "I log ordinari dicono cosa hanno registrato i tuoi sistemi. sigillo aggiunge una prova firmata e con marca temporale, che si controlla in modo indipendente: mostra cosa è stato registrato e se è stato alterato.",
    more: "Cosa consegni",
  },
  fit: {
    eyebrow: "sigillo fa per te?",
    h2: "Pensato per chi deve dimostrare cosa ha fatto la sua AI.",
    lead: "Non ogni flusso di lavoro con l'AI ha bisogno di prove verificabili. La domanda è se puoi permetterti di non averle.",
    forTitle: "Per chi è",
    forLead: "Team in cui le azioni dell'AI devono essere attribuibili e verificabili da altri.",
    forItems: [["Chi sviluppa agenti AI", "Agenti che compiono azioni importanti in sistemi reali."], ["Compliance e rischio", "Chi deve spiegare o indagare cosa ha fatto un sistema AI."], ["Organizzazioni attente alla sicurezza", "Che vogliono prove verificabili senza esporre i dati."]],
    notTitle: "Per chi non è",
    notLead: "Team che hanno bisogno solo di monitoraggio di base o di AI conversazionale.",
    notItems: [["Usi semplici dell'AI", "Scrivere bozze, fare brainstorming, assistenza quotidiana."], ["Chi si accontenta dei log ordinari", "Senza bisogno di far verificare le azioni a un terzo."], ["Chi cerca una piattaforma AI completa", "Hosting di modelli, orchestrazione o osservabilità completa."]],
  },
  steps: {
    eyebrow: "Come funziona",
    h2: "Dall'azione alla prova verificabile.",
    items: [["L'agente agisce", "Il tuo agente compie un'azione nei tuoi sistemi. sigillo riceve l'impronta, non il contenuto."], ["Registro firmato, con marca temporale", "Ogni azione è firmata, legata alla precedente e sigillata ogni ora."], ["Verifica indipendente", "Consegni un fascicolo: chiunque lo controlla da solo, senza accedere ai tuoi dati."]],
  },
  how: {
    h2: "Tre domande, tre risposte",
    questions: [
      { q: "È tutto a posto?", a: "Nessuna alterazione. I 3 sistemi registrano.", kind: "ok" },
      { q: "Cosa ha fatto l'AI?", a: "L'agente «screener» ha usato lo strumento «leggi_curriculum» alle 16:58.", kind: "action" },
      { q: "Mi prepari le prove?", a: "4 azioni, sigillate alle 17:00, con marca temporale.", kind: "proof" },
    ],
  },
  deliver: {
    h2: "Il fascicolo, visto da chi lo riceve",
    story: ["Il candidato n. 7 chiede cosa ha fatto l'AI con il suo curriculum.", "In due clic trovi l'esecuzione: 4 azioni, alle 16:58.", "Consegni il fascicolo: lo controlla da solo, nel browser."],
    contents: ["report.pdf, in italiano", "le ricevute firmate", "i sigilli con marca temporale", "le istruzioni per chi controlla"],
    sample: "Il fascicolo d'esempio",
    verify: "Controllalo su /verify",
  },
  proves: {
    h2: "Cosa prova, cosa no",
    yes: "Prova",
    no: "Non prova",
    yesLines: ["Che l'azione è avvenuta, con quell'esito", "Su quel documento, byte per byte", "Entro quell'ora, attestata da un'autorità esterna", "Che nessuno l'ha cambiata dopo"],
    noLines: ["Che l'agente abbia registrato tutto", "Che le decisioni siano giuste", "Cosa c'era scritto"],
    see: "Cosa vediamo, cosa no",
    seeText: "Vediamo il nome dello strumento o del modello, l'ora, l'esito e le impronte. Non vediamo prompt, risposte, documenti né nomi: restano da te.",
    facts: [["Server", "[fornitore, paese]"], ["Marca temporale", "freetsa.org, non qualificata eIDAS"], ["Verificatore", "open source"]],
  },
  aiAct: {
    h2: "Cosa chiede l'AI Act, e cosa fa sigillo",
    rows: [
      { art: "Art. 12", what: "Registrazione degli eventi", how: "Ricevute firmate e sigillate." },
      { art: "Art. 14", what: "Sorveglianza umana", how: "Ogni azione in una frase, con l'esito e il filtro «Problemi»." },
      { art: "Art. 26", what: "Obblighi di chi usa il sistema", how: "Conservazione, fascicoli automatici e fascicolo su richiesta." },
    ],
    honest: "Da solo non rende conforme un sistema: dipende da cosa fa la tua AI e da come la usi.",
  },
  connect: {
    eyebrow: "Collegare l'agente",
    h2: "Un file, nessun lavoro in più",
    lead: "Non cambi il codice del tuo agente: la console aggiunge le righe di sigillo al file.",
    steps: [["Carica", "Il file .py del tuo agente, nella console."], ["Riscarica", "Il file è lo stesso, con sigillo già dentro."], ["Avvia", "Dove gira di solito: da quel momento ogni azione ha la sua ricevuta."]],
    or: "Preferisci a mano?",
    where: "Sul server dove gira l'agente",
    copy: "Copia",
    copied: "Copiato",
  },
  pricing: {
    h2: "Prezzi",
    plans: [
      { name: "Pilota", price: "Gratis", lines: ["Sistemi per provare", "10.000 ricevute al mese", "Fascicolo e verifica", "Marca temporale", "Supporto diretto"], cta: "Richiedi l'accesso", note: "Attivazione entro [un giorno lavorativo]" },
      { name: "Standard", price: "190 € al mese + IVA", lines: ["Tutto del Pilota, più:", "100.000 ricevute al mese", "Sistemi illimitati", "Fascicoli automatici", "Copia di sicurezza esterna"], cta: "Contattaci" },
      { name: "Su misura", price: "Su richiesta", lines: ["Server dedicato", "Marca temporale qualificata eIDAS", "Contratto e SLA"], cta: "Contattaci" },
    ],
    unit: "1 ricevuta = 1 azione registrata",
    faq: [
      { q: "Cos'è la fase pilota?", a: "I primi mesi di sigillo, con i primi clienti: funziona tutto, non paghi niente e ci dici cosa migliorare." },
      { q: "Cosa succede alla fine del pilota?", a: "Ti avvisiamo prima. Le ricevute restano tue." },
      { q: "Dove stanno i dati?", a: "Sul server indicato qui sopra. Conserviamo nomi, orari, esiti e impronte, mai i contenuti." },
      { q: "Posso verificare senza fidarmi di voi?", a: "Sì: il fascicolo si controlla nel tuo browser, con il verificatore open source." },
    ],
  },
  faq: { eyebrow: "Domande frequenti", h2: "Prima di scriverci", lead: "Le risposte brevi. Per il resto, scrivici." },
  contact: { h2: "Domande, un pilota, una demo per il tuo team?", button: "Contattaci", address: "scrivi a" },
  footer: { product: "Prodotto", receivers: "Per chi riceve un fascicolo", company: "Azienda", format: "Formato delle ricevute", privacy: "Privacy", about: "Chi siamo", legal: "© 2026 [Ragione sociale] · P.IVA [P.IVA] · [Sede]" },
};

const EN: Copy = {
  nav: { how: "How it works", deliver: "What you hand over", aiAct: "AI Act", pricing: "Pricing", blog: "Blog", verify: "Verify an evidence pack", signIn: "Sign in", start: "Request a free pilot" },
  title: "sigillo · the evidence of what your AI did",
  description: "sigillo records every action of your AI agents in a signed record, sealed every hour. When a complaint or an inspection comes, you hand over a pack anyone can check alone, in the browser.",
  hero: {
    eyebrow: "If your AI agent were challenged tomorrow, could you verify what it did?",
    h1: "Prove what your AI did. When it matters most.",
    lead: "sigillo creates signed, timestamped records of your AI agents' actions that can be independently verified, without exposing your company's sensitive data.",
    primary: "Request a free pilot",
    secondary: "Verify a sample pack",
    facts: [["Only fingerprints", "Prompts and answers stay with you."], ["Verify it yourself", "Command-line tool, works offline."], ["Free pilot", "No payment details."]],
  },
  card: {
    verdict: "Intact",
    line: "4 receipts of Selezione CV — backend junior, 13 October 2026, signed and in order.",
    key: "Key code",
    matches: "Matches",
    title: "Selezione CV — backend junior",
    rows: [["16:58", "Used «leggi_curriculum»"], ["16:58", "Answer from «llama3.1:8b»"], ["16:59", "Decision «scarta_candidato»"], ["17:00", "Sealed, with a timestamp"]],
    sealed: "Evidence pack ready to hand over. Example data.",
  },
  problem: {
    eyebrow: "The problem",
    h2: "If you had to justify your AI's actions tomorrow, would you have the evidence?",
    body: "AI agents make decisions and take actions that have real consequences. When those actions are challenged, you need more than a recollection of events. sigillo preserves verifiable records that show what happened and make later alterations detectable.",
    more: "What it proves, what it does not",
    video: "sigillo demo, 3 minutes",
    subtitles: "English",
  },
  disputes: {
    eyebrow: "Your AI decisions can be challenged. Your evidence should be verifiable.",
    h2: "When disputes arise, don't rely on your word alone.",
    body: "Ordinary logs tell you what your systems recorded. sigillo adds signed, timestamped evidence that can be checked independently, helping you demonstrate what was recorded and whether it has been altered.",
    more: "What you hand over",
  },
  fit: {
    eyebrow: "Is sigillo right for you?",
    h2: "Built for teams that need to prove what their AI did.",
    lead: "Not every AI workflow needs independently verifiable evidence. The important question is whether you can afford not to have it.",
    forTitle: "Who it's for",
    forLead: "Teams where AI actions need to be accountable and independently verifiable.",
    forItems: [["AI agent developers", "Building agents that take consequential actions in real systems."], ["Compliance and risk teams", "Preparing to explain or investigate what an AI system did."], ["Security-conscious organisations", "Wanting verifiable records without exposing sensitive underlying data."]],
    notTitle: "Who it's not for",
    notLead: "Teams that only need basic monitoring or conversational AI.",
    notItems: [["Simple AI use cases", "Using AI for drafting, brainstorming or everyday assistance."], ["Teams satisfied with ordinary logs", "With no requirement to independently verify recorded actions."], ["Teams looking for a full AI platform", "Needing model hosting, agent orchestration or a complete observability suite."]],
  },
  steps: {
    eyebrow: "How it works",
    h2: "From action to verifiable record.",
    items: [["Your agent acts", "Your agent performs an action in your systems. sigillo receives a fingerprint of it, not the content."], ["Signed, timestamped record", "Each action is signed, linked to the one before it and sealed every hour."], ["Independent verification", "You hand over a pack. Anyone can check it alone, without access to your data."]],
  },
  how: {
    h2: "Three questions, three answers",
    questions: [
      { q: "Is everything all right?", a: "No alteration. All 3 systems are recording.", kind: "ok" },
      { q: "What did the AI do?", a: "The agent «screener» used the tool «leggi_curriculum» at 16:58.", kind: "action" },
      { q: "Can you prepare the evidence?", a: "4 actions, sealed at 17:00, timestamped.", kind: "proof" },
    ],
  },
  deliver: {
    h2: "The evidence pack, as whoever receives it sees it",
    story: ["Candidate no. 7 asks what the AI did with their CV.", "In two clicks you find the run: 4 actions, at 16:58.", "You hand over the pack: they check it alone, in the browser."],
    contents: ["report.pdf, in Italian", "the signed receipts", "the seals with their timestamps", "the instructions for whoever checks"],
    sample: "The sample pack",
    verify: "Check it on /verify",
  },
  proves: {
    h2: "What it proves, what it does not",
    yes: "Proves",
    no: "Does not prove",
    yesLines: ["That the action happened, with that outcome", "On that document, byte for byte", "By that hour, attested by an outside authority", "That nobody changed it afterwards"],
    noLines: ["That the agent recorded everything", "That the decisions were right", "What was written"],
    see: "What we see, what we do not",
    seeText: "We see the name of the tool or model, the time, the outcome and the fingerprints. We do not see prompts, answers, documents or names: they stay with you.",
    facts: [["Server", "[provider, country]"], ["Timestamp", "freetsa.org, not eIDAS qualified"], ["Verifier", "open source"]],
  },
  aiAct: {
    h2: "What the AI Act asks, and what sigillo does",
    rows: [
      { art: "Art. 12", what: "Record-keeping", how: "Signed and sealed receipts." },
      { art: "Art. 14", what: "Human oversight", how: "Every action in a sentence, with its outcome and the «Problems» filter." },
      { art: "Art. 26", what: "Obligations of those who use the system", how: "Retention, daily evidence packs and a pack on request." },
    ],
    honest: "On its own it does not make a system compliant: that depends on what your AI does and how you use it.",
  },
  connect: {
    eyebrow: "Connecting the agent",
    h2: "One file, no extra work",
    lead: "You do not change your agent's code: the console adds the sigillo lines to the file.",
    steps: [["Upload", "Your agent's .py file, in the console."], ["Download", "The same file, with sigillo already inside."], ["Run", "Where it usually runs: from then on every action has its receipt."]],
    or: "Prefer to do it by hand?",
    where: "On the server where the agent runs",
    copy: "Copy",
    copied: "Copied",
  },
  pricing: {
    h2: "Pricing",
    plans: [
      { name: "Pilot", price: "Free", lines: ["Systems to try", "10,000 receipts a month", "Evidence pack and verification", "Timestamp", "Direct support"], cta: "Request access", note: "Activation within [one working day]" },
      { name: "Standard", price: "€190 a month + VAT", lines: ["Everything in Pilot, plus:", "100,000 receipts a month", "Unlimited systems", "Daily evidence packs", "Off-site backup"], cta: "Contact us" },
      { name: "Custom", price: "On request", lines: ["Dedicated server", "eIDAS-qualified timestamp", "Contract and SLA"], cta: "Contact us" },
    ],
    unit: "1 receipt = 1 recorded action",
    faq: [
      { q: "What is the pilot?", a: "sigillo's first months, with the first customers: everything works, you pay nothing and tell us what to improve." },
      { q: "What happens when the pilot ends?", a: "We tell you first. The receipts stay yours." },
      { q: "Where is the data?", a: "On the server named above. We keep names, times, outcomes and fingerprints, never contents." },
      { q: "Can I verify without trusting you?", a: "Yes: the pack is checked in your browser, with the open-source verifier." },
    ],
  },
  faq: { eyebrow: "FAQ", h2: "Before you write to us", lead: "The short answers. For the rest, write to us." },
  contact: { h2: "Questions, a pilot, a demo for your team?", button: "Contact us", address: "write to" },
  footer: { product: "Product", receivers: "For whoever receives a pack", company: "Company", format: "Receipt format", privacy: "Privacy", about: "About", legal: "© 2026 [Company name] · VAT [VAT no.] · [Address]" },
};

const COPY: Record<Language, Copy> = { it: IT, en: EN };
const REPOSITORY = "https://github.com/giovanniemilionoventa-byte/sigillo";

const SITE_RULES = `
:root[data-theme="dark"] { --bg: #0b0b0d; --canvas: #0b0b0d; --surface: #121316; --fill: #1b1c20; --hover: #23252a; --separator: #26282e; --selection: #162044; }
body { background: var(--canvas); }
.s-wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.s-top { position: sticky; top: 0; z-index: 5; background: var(--surface); border-bottom: 1px solid var(--separator); }
.s-top .s-wrap { display: flex; align-items: center; gap: 28px; min-height: 64px; }
.s-top nav { display: flex; gap: 22px; flex: 1; min-width: 0; overflow: hidden; }
.s-top nav a { color: var(--text); font-weight: 500; white-space: nowrap; }
.s-top .s-right { display: flex; align-items: center; gap: 14px; flex: none; }
.s-signin { font-weight: 500; white-space: nowrap; }
.s-brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 17px; color: var(--text); }
.s-brand svg { width: 24px; height: 24px; }
.s-sec { padding: 80px 0; }
.s-sec.alt { background: var(--surface); border-block: 1px solid var(--separator); }
.s-sec h2 { font-size: 34px; line-height: 40px; font-weight: 700; letter-spacing: -0.01em; max-width: 28ch; margin: 0 0 20px; }
.s-hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 56px; align-items: start; padding: 64px 24px 40px; }
.s-hero .s-console { margin-top: 28px; }
.btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 20px; border-radius: 8px; border: 1px solid var(--separator); background: var(--surface); color: var(--text); font-weight: 600; text-decoration: none; }
.btn:hover { background: var(--fill); text-decoration: none; }
.btn.pri { background: var(--action); border-color: var(--action); color: var(--on-action); }
.btn.pri:hover { background: var(--action); filter: brightness(0.92); }
.btn.sm { min-height: 34px; padding: 0 12px; font-size: 13px; }
.s-eyebrow { font-size: 12px; line-height: 18px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--secondary); font-weight: 600; margin: 0 0 16px; max-width: 62ch; }
.s-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 28px; list-style: none; margin: 36px 0 0; padding: 24px 0 0; border-top: 1px solid var(--separator); }
.s-facts li { display: grid; gap: 2px; align-content: start; }
.s-facts b { font-size: 14px; }
.s-facts span { font-size: 13px; color: var(--secondary); }
.s-narrow > * { max-width: 760px; }
.s-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 56px; align-items: center; }
.s-split h2 { max-width: 22ch; }
.s-video { border-radius: 12px; overflow: hidden; background: #000; border: 1px solid var(--separator); aspect-ratio: 16 / 9; }
.s-video video { display: block; width: 100%; height: 100%; object-fit: cover; }
.s-dispute { padding: 48px; max-width: 820px; }
.s-dispute h2 { max-width: 24ch; }
.s-fit { margin-top: 32px; align-items: stretch; }
.s-fit ul { list-style: none; margin: 20px 0 0; padding: 0; display: grid; gap: 16px; }
.s-fit li { display: grid; gap: 2px; border-top: 1px solid var(--separator); padding-top: 14px; }
.s-fit li span { color: var(--secondary); font-size: 14px; }
.s-fith { font-size: 18px; margin: 0 0 6px; }
.s-yes-h::before { content: "✓  "; color: var(--ok); }
.s-no-h::before { content: "–  "; color: var(--secondary); }
.s-steps { list-style: none; padding: 0; margin: 32px 0 0; }
.s-steps li { display: grid; gap: 8px; align-content: start; }
.s-steps span:not(.num) { color: var(--secondary); }
.s-steps b { font-size: 18px; }
.s-console { padding: 0; overflow: hidden; }
.s-chead { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--separator); flex-wrap: wrap; }
.s-chain { list-style: none; margin: 0; padding: 8px 12px; }
.s-chain li { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 8px; padding: 9px 8px; border-radius: 6px; }
.s-chain li.on { background: var(--selection); }
.s-chain time { color: var(--secondary); }
.s-sealrow { display: flex; gap: 14px; align-items: center; margin: 4px 16px 16px; padding: 12px 14px; border: 1px solid var(--separator); border-radius: 8px; background: var(--canvas); }
.s-sealrow small { display: block; color: var(--secondary); font-size: 12px; }
.s-stamp { flex: none; width: 36px; height: 36px; }
.s-stamp svg { width: 36px; height: 36px; }
.s-hero h1 { font-size: 56px; line-height: 60px; font-weight: 700; letter-spacing: -0.025em; margin: 0 0 20px; max-width: 15ch; }
.s-lead { font-size: 20px; line-height: 32px; max-width: 58ch; margin: 0 0 24px; }
.s-btns { display: flex; gap: 12px; flex-wrap: wrap; }
.s-facts { margin-top: 20px; font-size: 13px; color: var(--secondary); font-weight: 500; }
.s-card { background: var(--surface); border: 1px solid var(--separator); border-radius: 10px; padding: 28px; }
.s-verdict { display: flex; gap: 16px; align-items: center; color: var(--ok); }
.s-verdict svg { width: 56px; height: 56px; }
.s-verdict b { font-size: 24px; line-height: 30px; }
.s-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.s-q { font-size: 20px; line-height: 28px; font-weight: 600; margin-bottom: 12px; }
.s-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px; align-items: start; }
.s-paper { background: #fff; color: #16191f; border: 1px solid var(--separator); border-radius: 4px; padding: 24px; box-shadow: 0 12px 32px rgba(16,19,24,.12); }
.s-price { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.s-plan { display: flex; flex-direction: column; gap: 12px; }
.s-plan b { font-size: 24px; line-height: 30px; }
.s-split.s-top { align-items: start; }
.s-flow { list-style: none; padding: 0; margin: 28px 0 0; display: grid; gap: 14px; }
.s-flow li { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 14px; align-items: start; }
.s-flow .num { width: 28px; height: 28px; border-radius: 999px; border: 1.5px solid var(--label); display: grid; place-items: center; font-size: 13px; font-weight: 600; }
.s-flow b { display: block; font-size: 17px; }
.s-flow span span { color: var(--secondary); }
.s-term { display: grid; gap: 12px; }
.s-term .t-meta { margin: 0; }
.s-code { position: relative; }
.s-code pre { margin: 0; padding: 18px 88px 18px 18px; background: var(--code); color: var(--on-code); border-radius: 10px; overflow-x: auto; }
.s-code .copy { position: absolute; top: 10px; right: 10px; }
.s-faq details { border-top: 1px solid var(--separator); padding: 14px 0; }
.s-faq details:last-child { border-bottom: 1px solid var(--separator); }
.s-faq summary { cursor: pointer; font-weight: 600; }
.s-band { background: var(--action); color: var(--on-action); padding: 56px 0; text-align: center; }
.s-band h2 { margin: 0 auto 20px; color: inherit; }
.s-band .btn { background: var(--surface); color: var(--text); border-color: var(--surface); }
.s-foot { padding: 40px 0; font-size: 13px; color: var(--secondary); }
.s-foot .s-wrap > div { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; margin-bottom: 24px; }
.s-foot h4 { margin: 0 0 8px; color: var(--text); font-size: 13px; }
.s-foot ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.s-yes li::before { content: "✓  "; color: var(--ok); font-weight: 700; }
.s-no li::before { content: "–  "; color: var(--secondary); }
@media (max-width: 1000px) { .s-top nav { display: none; } .s-top .s-right { margin-left: auto; } }
@media (max-width: 900px) {
  .s-split { grid-template-columns: minmax(0, 1fr); gap: 32px; }
  .s-facts { grid-template-columns: minmax(0, 1fr); }
  .s-hero, .s-two { grid-template-columns: minmax(0, 1fr); }
  .s-three, .s-price { grid-template-columns: minmax(0, 1fr); }
  .s-hero h1 { font-size: 36px; line-height: 42px; }
  .s-sec { padding: 56px 0; }
  .s-foot .s-wrap > div { grid-template-columns: minmax(0, 1fr); }
}
`;

/** The redesigned home, as a whole document. */
export function siteV2Page(view: { language: Language; contactEmail?: string; back: string; theme: "light" | "dark" | "system"; hasBlog: boolean; endpoint: string; media?: ReadonlySet<string> }): string {
  const c = COPY[view.language];
  const mail =
    view.contactEmail === undefined
      ? "#contatti"
      : `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(view.contactEmail)}&su=${encodeURIComponent("sigillo")}`;
  const start = `<a class="btn pri" href="/ui/registrati">${escape(c.nav.start)}</a>`;
  const cardFor = (kind: "ok" | "action" | "proof", answer: string): string =>
    kind === "ok"
      ? `<span class="sign green">${STATE_ICONS.ok}<span>${escape(answer)}</span></span>`
      : kind === "proof"
        ? `<span class="sign ink">${PROOF_ICONS.full}<span>${escape(answer)}</span></span>`
        : `<span>${escape(answer)}</span>`;
  const code = (text: string): string => `<div class="s-code"><pre class="mono">${escape(text)}</pre><button type="button" class="copy button sm" hidden data-copied="${escape(c.connect.copied)}">${escape(c.connect.copy)}</button></div>`;
  const demo =
    view.media?.has(`demo-${view.language}.mp4`) === true
      ? `<div class="s-video"><video controls preload="none" poster="/media/poster-${view.language}.jpg" aria-label="${escape(c.problem.video)}"><source src="/media/demo-${view.language}.mp4" type="video/mp4">${
          view.media.has(`demo-${view.language}.vtt`) ? `<track kind="subtitles" src="/media/demo-${view.language}.vtt" srclang="${view.language}" label="${escape(c.problem.subtitles)}">` : ""
        }</video></div>`
      : "";
  const body = `<header class="s-top"><div class="s-wrap">
<a class="s-brand" href="/">${SEAL_SVG}<span>sigillo</span></a>
<nav aria-label="${escape(c.nav.how)}"><a href="#come-funziona">${escape(c.nav.how)}</a><a href="#cosa-consegni">${escape(c.nav.deliver)}</a><a href="#ai-act">${escape(c.nav.aiAct)}</a><a href="#prezzi">${escape(c.nav.pricing)}</a>${view.hasBlog ? `<a href="/blog">${escape(c.nav.blog)}</a>` : ""}</nav>
<div class="s-right">${languageSwitch("seg", view.back)}<a class="s-signin" href="/ui/login">${escape(c.nav.signIn)}</a>${start}</div>
</div></header>
<main>
<section class="s-wrap s-hero" id="inizio"><div>
<p class="s-eyebrow">${escape(c.hero.eyebrow)}</p>
<h1>${escape(c.hero.h1)}</h1><p class="s-lead">${escape(c.hero.lead)}</p>
<div class="s-btns">${start}<a class="btn" href="/verify">${escape(c.hero.secondary)}</a></div>
<ul class="s-facts">${c.hero.facts.map(([title, line]) => `<li><b>${escape(title)}</b><span>${escape(line)}</span></li>`).join("")}</ul></div>
<div class="s-card s-console" aria-hidden="true"><div class="s-chead"><b>${escape(c.card.title)}</b><span class="sign green">${STATE_ICONS.ok}<span>${escape(c.card.verdict)}</span></span></div>
<ul class="s-chain">${c.card.rows.map(([time, what], i) => `<li${i === 0 ? ' class="on"' : ""}><time class="mono">${escape(time)}</time><span>${escape(what)}</span></li>`).join("")}</ul>
<div class="s-sealrow"><span class="s-stamp">${SEAL_SVG}</span><div><b>${escape(c.card.matches)}</b><small class="mono">9685 533e aa64 29c4</small><small>${escape(c.card.sealed)}</small></div></div></div>
</section>

<section class="s-sec" id="problema"><div class="s-wrap${demo === "" ? " s-narrow" : " s-split"}"><div><p class="s-eyebrow">${escape(c.problem.eyebrow)}</p><h2>${escape(c.problem.h2)}</h2><p class="s-lead">${escape(c.problem.body)}</p><a class="btn" href="#cosa-prova">${escape(c.problem.more)}</a></div>${demo}</div></section>

<section class="s-sec alt" id="contestazioni"><div class="s-wrap"><div class="s-card s-dispute"><p class="s-eyebrow">${escape(c.disputes.eyebrow)}</p><h2>${escape(c.disputes.h2)}</h2><p class="s-lead">${escape(c.disputes.body)}</p><a class="btn" href="#cosa-consegni">${escape(c.disputes.more)}</a></div></div></section>

<section class="s-sec" id="per-chi"><div class="s-wrap"><p class="s-eyebrow">${escape(c.fit.eyebrow)}</p><h2>${escape(c.fit.h2)}</h2><p class="s-lead">${escape(c.fit.lead)}</p>
<div class="s-two s-fit"><div class="s-card"><h3 class="s-fith s-yes-h">${escape(c.fit.forTitle)}</h3><p class="t-sec">${escape(c.fit.forLead)}</p><ul>${c.fit.forItems.map(([t, d]) => `<li><b>${escape(t)}</b><span>${escape(d)}</span></li>`).join("")}</ul></div>
<div class="s-card"><h3 class="s-fith s-no-h">${escape(c.fit.notTitle)}</h3><p class="t-sec">${escape(c.fit.notLead)}</p><ul>${c.fit.notItems.map(([t, d]) => `<li><b>${escape(t)}</b><span>${escape(d)}</span></li>`).join("")}</ul></div></div></div></section>

<section class="s-sec alt" id="come-funziona"><div class="s-wrap"><p class="s-eyebrow">${escape(c.steps.eyebrow)}</p><h2>${escape(c.steps.h2)}</h2>
<ol class="s-three s-steps">${c.steps.items.map(([t, d], i) => `<li class="s-card"><span class="num">${i + 1}</span><b>${escape(t)}</b><span>${escape(d)}</span></li>`).join("")}</ol>
<h3 class="t-sec" style="margin:40px 0 16px">${escape(c.how.h2)}</h3>
<div class="s-three">${c.how.questions.map((q) => `<div class="s-card"><p class="s-q">${escape(q.q)}</p>${cardFor(q.kind, q.a)}</div>`).join("")}</div></div></section>

<section class="s-sec" id="cosa-consegni"><div class="s-wrap"><h2>${escape(c.deliver.h2)}</h2>
<div class="s-two"><div><ol class="steps-v2">${c.deliver.story.map((line, i) => `<li><span class="num">${i + 1}</span><span>${escape(line)}</span></li>`).join("")}</ol>
<ul class="s-yes" style="list-style:none;padding:0;display:grid;gap:6px">${c.deliver.contents.map((line) => `<li>${escape(line)}</li>`).join("")}</ul>
<p><a class="btn" href="/verify">${escape(c.deliver.verify)} ›</a></p></div>
<div class="s-paper" aria-hidden="true"><p style="margin:0;font-weight:700">${escape(c.deliver.sample)}</p><p class="mono" style="margin:8px 0">Selezione CV — backend junior · 13/10/2026</p><p style="margin:0"><b>${escape(c.card.verdict)}</b> · 9685 533e aa64 29c4</p><hr style="border:0;border-top:1px solid #dce0e6"><ul style="list-style:none;padding:0;margin:0;display:grid;gap:4px;font-size:13px"><li>16:58 · leggi_curriculum</li><li>16:58 · valuta_candidato</li><li>16:58 · qwen2.5:3b</li><li>16:59 · invia_email</li></ul></div></div></div></section>

<section class="s-sec alt" id="cosa-prova"><div class="s-wrap"><h2>${escape(c.proves.h2)}</h2>
<div class="s-two"><div class="s-card"><h3 class="t-sec">${escape(c.proves.yes)}</h3><ul class="s-yes" style="list-style:none;padding:0;display:grid;gap:8px">${c.proves.yesLines.map((l) => `<li>${escape(l)}</li>`).join("")}</ul></div>
<div class="s-card"><h3 class="t-sec">${escape(c.proves.no)}</h3><ul class="s-no" style="list-style:none;padding:0;display:grid;gap:8px">${c.proves.noLines.map((l) => `<li>${escape(l)}</li>`).join("")}</ul></div></div>
<h3 class="t-sec" style="margin-top:28px">${escape(c.proves.see)}</h3><p style="max-width:66ch">${escape(c.proves.seeText)}</p>
<div class="s-three">${c.proves.facts.map(([k, v]) => `<div class="s-card"><p class="t-meta" style="margin:0">${escape(k)}</p><b>${escape(v)}</b></div>`).join("")}</div></div></section>

<section class="s-sec" id="ai-act"><div class="s-wrap"><h2>${escape(c.aiAct.h2)}</h2>
<div class="vlines">${c.aiAct.rows.map((r) => `<div class="vline"><span><span class="chip">${escape(r.art)}</span></span><span><b>${escape(r.what)}</b></span><span>${escape(r.how)}</span></div>`).join("")}</div>
<p class="notice" style="margin-top:20px">${STATE_ICONS.warn}<span>${escape(c.aiAct.honest)}</span></p></div></section>

<section class="s-sec alt" id="collega"><div class="s-wrap s-split"><div><p class="s-eyebrow">${escape(c.connect.eyebrow)}</p><h2>${escape(c.connect.h2)}</h2><p class="s-lead">${escape(c.connect.lead)}</p>
<ol class="s-flow">${c.connect.steps.map(([t, d], i) => `<li><span class="num">${i + 1}</span><span><b>${escape(t)}</b><span>${escape(d)}</span></span></li>`).join("")}</ol></div>
<div class="s-term"><p class="t-meta">${escape(c.connect.or)} · ${escape(c.connect.where)}</p>
${code("pip install sigillo")}
${code(`import sigillo\nsigillo.init(\n    endpoint="${view.endpoint}",\n    api_key="<…>",\n    system_id="selezione-cv",\n)`)}</div></div></section>

<section class="s-sec" id="prezzi"><div class="s-wrap"><h2>${escape(c.pricing.h2)}</h2>
<div class="s-price">${c.pricing.plans.map((p, i) => `<div class="s-card s-plan"><span class="t-meta">${escape(p.name)}</span><b>${escape(p.price)}</b><ul class="s-yes" style="list-style:none;padding:0;display:grid;gap:6px">${p.lines.map((l) => `<li>${escape(l)}</li>`).join("")}</ul>${i === 0 ? start : `<a class="btn" href="${escape(mail)}" rel="noopener">${escape(p.cta)}</a>`}${p.note === undefined ? "" : `<span class="t-meta">${escape(p.note)}</span>`}</div>`).join("")}</div>
<p class="t-meta">${escape(c.pricing.unit)}</p>
</div></section>

<section class="s-sec alt" id="faq"><div class="s-wrap s-split s-top"><div><p class="s-eyebrow">${escape(c.faq.eyebrow)}</p><h2>${escape(c.faq.h2)}</h2><p class="s-lead">${escape(c.faq.lead)}</p><a class="btn" href="${escape(mail)}" rel="noopener">${escape(c.contact.button)}</a></div>
<div class="s-faq">${c.pricing.faq.map((f, i) => `<details${i === 0 ? " open" : ""}><summary>${escape(f.q)}</summary><p>${escape(f.a)}</p></details>`).join("")}</div></div></section>
</main>
<section class="s-band" id="contatti"><div class="s-wrap"><h2>${escape(c.contact.h2)}</h2><a class="btn" href="${escape(mail)}" rel="noopener">${escape(c.contact.button)}</a>${view.contactEmail === undefined ? "" : `<p>${escape(c.contact.address)} ${escape(view.contactEmail)}</p>`}</div></section>
<footer class="s-foot"><div class="s-wrap"><div>
<section><h4>${escape(c.footer.product)}</h4><ul><li><a href="#come-funziona">${escape(c.nav.how)}</a></li><li><a href="#cosa-consegni">${escape(c.nav.deliver)}</a></li><li><a href="#prezzi">${escape(c.nav.pricing)}</a></li></ul></section>
<section><h4>${escape(c.footer.receivers)}</h4><ul><li><a href="/verify">${escape(c.nav.verify)}</a></li><li><a href="${REPOSITORY}/tree/main/packages/verifier" target="_blank" rel="noopener">Open source</a></li><li><a href="${REPOSITORY}/blob/main/docs/FORMAT.md" target="_blank" rel="noopener">${escape(c.footer.format)}</a></li></ul></section>
<section><h4>${escape(c.footer.company)}</h4><ul><li><a href="/privacy">${escape(c.footer.privacy)}</a></li>${view.hasBlog ? `<li><a href="/blog">${escape(c.nav.blog)}</a></li>` : ""}<li><a href="/ui/login">${escape(c.nav.signIn)}</a></li></ul></section></div>
<p>${escape(c.footer.legal)}</p></div></footer>`;

  // Dark unless the reader chose light: the proposed design is drawn dark first.
  const theme = ` data-theme="${view.theme === "light" ? "light" : "dark"}"`;
  return `<!doctype html>
<html lang="${view.language}"${theme}><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(c.title)}</title><meta name="description" content="${escape(c.description)}">
<style>${STYLE_V2}${SITE_RULES}</style>
</head><body>
${body}
<script src="/site.js" defer></script>
</body></html>`;
}

