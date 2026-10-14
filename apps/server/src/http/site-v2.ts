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
  hero: { h1: string; lead: string; primary: string; secondary: string; doors: [string, string, string]; facts: string };
  card: { verdict: string; line: string; key: string; matches: string };
  how: { h2: string; questions: { q: string; a: string; kind: "ok" | "action" | "proof" }[]; flow: string[] };
  deliver: { h2: string; story: string[]; contents: string[]; sample: string; verify: string };
  proves: { h2: string; yes: string; no: string; yesLines: string[]; noLines: string[]; see: string; seeText: string; facts: [string, string][] };
  aiAct: { h2: string; rows: { art: string; what: string; how: string }[]; honest: string };
  connect: { h2: string; steps: string[]; or: string; where: string; copy: string; copied: string };
  pricing: { h2: string; plans: { name: string; price: string; lines: string[]; cta: string; note?: string }[]; unit: string; faq: { q: string; a: string }[] };
  contact: { h2: string; button: string; address: string };
  footer: { product: string; receivers: string; company: string; format: string; privacy: string; about: string; legal: string };
}

const IT: Copy = {
  nav: { how: "Come funziona", deliver: "Cosa consegni", aiAct: "AI Act", pricing: "Prezzi", blog: "Blog", verify: "Verifica un fascicolo", signIn: "Accedi", start: "Richiedi l'accesso" },
  title: "sigillo · le prove di cosa ha fatto la tua AI",
  description: "sigillo registra ogni azione dei tuoi agenti AI in un registro firmato e sigillato ogni ora. Quando arriva un reclamo o un'ispezione, consegni un fascicolo che chiunque controlla da solo, nel browser.",
  hero: {
    h1: "Cosa ha fatto la tua AI? Rispondi con le prove.",
    lead: "sigillo registra ogni azione dei tuoi agenti in un registro firmato e sigillato ogni ora. Quando arriva un reclamo o un'ispezione, consegni un fascicolo che chiunque controlla da solo, nel browser.",
    primary: "Richiedi l'accesso",
    secondary: "Verifica un fascicolo d'esempio",
    doors: ["Rispondi dell'AI in azienda", "Colleghi l'agente", "Hai ricevuto un fascicolo?"],
    facts: "Pilota gratuito · server in [paese] · verificatore open source",
  },
  card: { verdict: "Integro", line: "4 ricevute di Selezione CV — backend junior, 13 ottobre 2026, firmate e in ordine.", key: "Codice della chiave", matches: "Corrisponde" },
  how: {
    h2: "Tre domande, tre risposte",
    questions: [
      { q: "È tutto a posto?", a: "Nessuna alterazione. I 3 sistemi registrano.", kind: "ok" },
      { q: "Cosa ha fatto l'AI?", a: "L'agente «screener» ha usato lo strumento «leggi_curriculum» alle 16:58.", kind: "action" },
      { q: "Mi prepari le prove?", a: "4 azioni, sigillate alle 17:00, con marca temporale.", kind: "proof" },
    ],
    flow: ["L'agente lavora come sempre", "Ogni azione è firmata e legata alla precedente, come le pagine numerate di un libro", "Ogni ora un sigillo con marca temporale", "Chiunque può controllare"],
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
    h2: "Collegare l'agente: un file",
    steps: ["Carica il file .py del tuo agente nella console", "Riscaricalo: sigillo è già dentro", "Avvialo dove gira di solito"],
    or: "oppure, a mano",
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
  contact: { h2: "Domande, un pilota, una demo per il tuo team?", button: "Contattaci", address: "scrivi a" },
  footer: { product: "Prodotto", receivers: "Per chi riceve un fascicolo", company: "Azienda", format: "Formato delle ricevute", privacy: "Privacy", about: "Chi siamo", legal: "© 2026 [Ragione sociale] · P.IVA [P.IVA] · [Sede]" },
};

const EN: Copy = {
  nav: { how: "How it works", deliver: "What you hand over", aiAct: "AI Act", pricing: "Pricing", blog: "Blog", verify: "Verify an evidence pack", signIn: "Sign in", start: "Request access" },
  title: "sigillo · the evidence of what your AI did",
  description: "sigillo records every action of your AI agents in a signed record, sealed every hour. When a complaint or an inspection comes, you hand over a pack anyone can check alone, in the browser.",
  hero: {
    h1: "What did your AI do? Answer with the evidence.",
    lead: "sigillo records every action of your agents in a signed record, sealed every hour. When a complaint or an inspection comes, you hand over a pack anyone can check alone, in the browser.",
    primary: "Request access",
    secondary: "Verify a sample pack",
    doors: ["Answer for the AI at work", "Connect the agent", "Received an evidence pack?"],
    facts: "Free pilot · server in [country] · open-source verifier",
  },
  card: { verdict: "Intact", line: "4 receipts of Selezione CV — backend junior, 13 October 2026, signed and in order.", key: "Key code", matches: "Matches" },
  how: {
    h2: "Three questions, three answers",
    questions: [
      { q: "Is everything all right?", a: "No alteration. All 3 systems are recording.", kind: "ok" },
      { q: "What did the AI do?", a: "The agent «screener» used the tool «leggi_curriculum» at 16:58.", kind: "action" },
      { q: "Can you prepare the evidence?", a: "4 actions, sealed at 17:00, timestamped.", kind: "proof" },
    ],
    flow: ["The agent works as usual", "Each action is signed and linked to the one before, like the numbered pages of a book", "Every hour a seal with a timestamp", "Anyone can check"],
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
    h2: "Connecting the agent: one file",
    steps: ["Upload your agent's .py file in the console", "Download it again: sigillo is already inside", "Run it where it usually runs"],
    or: "or, by hand",
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
  contact: { h2: "Questions, a pilot, a demo for your team?", button: "Contact us", address: "write to" },
  footer: { product: "Product", receivers: "For whoever receives a pack", company: "Company", format: "Receipt format", privacy: "Privacy", about: "About", legal: "© 2026 [Company name] · VAT [VAT no.] · [Address]" },
};

const COPY: Record<Language, Copy> = { it: IT, en: EN };
const REPOSITORY = "https://github.com/giovanniemilionoventa-byte/sigillo";

const SITE_RULES = `
body { background: var(--canvas); }
.s-wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.s-top { position: sticky; top: 0; z-index: 5; background: var(--surface); border-bottom: 1px solid var(--separator); }
.s-top .s-wrap { display: flex; align-items: center; gap: 20px; min-height: 64px; flex-wrap: wrap; }
.s-top nav { display: flex; gap: 18px; flex: 1; flex-wrap: wrap; }
.s-top nav a { color: var(--text); font-weight: 500; }
.s-top .s-right { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.s-brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 17px; color: var(--text); }
.s-brand svg { width: 24px; height: 24px; }
.s-sec { padding: 88px 0; }
.s-sec.alt { background: var(--surface); border-block: 1px solid var(--separator); }
.s-sec h2 { font-size: 30px; line-height: 36px; font-weight: 600; letter-spacing: -0.01em; max-width: 28ch; margin: 0 0 28px; }
.s-hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 48px; align-items: center; padding: 72px 0 56px; }
.s-hero h1 { font-size: 52px; line-height: 56px; font-weight: 600; letter-spacing: -0.025em; margin: 0 0 20px; max-width: 16ch; }
.s-lead { font-size: 20px; line-height: 32px; max-width: 58ch; margin: 0 0 24px; }
.s-btns { display: flex; gap: 12px; flex-wrap: wrap; }
.s-doors { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 20px; font-weight: 600; }
.s-facts { margin-top: 20px; font-size: 13px; color: var(--secondary); font-weight: 500; }
.s-card { background: var(--surface); border: 1px solid var(--separator); border-radius: 10px; padding: 24px; }
.s-verdict { display: flex; gap: 16px; align-items: center; color: var(--ok); }
.s-verdict svg { width: 56px; height: 56px; }
.s-verdict b { font-size: 24px; line-height: 30px; }
.s-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.s-q { font-size: 20px; line-height: 28px; font-weight: 600; margin-bottom: 12px; }
.s-flow { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin-top: 32px; counter-reset: f; }
.s-flow li { border-top: 2px solid var(--label); padding-top: 12px; }
.s-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 32px; align-items: start; }
.s-paper { background: #fff; color: #16191f; border: 1px solid var(--separator); border-radius: 4px; padding: 24px; box-shadow: 0 12px 32px rgba(16,19,24,.12); }
.s-price { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.s-plan { display: flex; flex-direction: column; gap: 12px; }
.s-plan b { font-size: 24px; line-height: 30px; }
.s-faq details { border-top: 1px solid var(--separator); padding: 14px 0; }
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
@media (max-width: 900px) {
  .s-hero, .s-two { grid-template-columns: minmax(0, 1fr); }
  .s-three, .s-price, .s-flow { grid-template-columns: minmax(0, 1fr); }
  .s-hero h1 { font-size: 36px; line-height: 42px; }
  .s-sec { padding: 56px 0; }
  .s-foot .s-wrap > div { grid-template-columns: minmax(0, 1fr); }
}
`;

/** The redesigned home, as a whole document. */
export function siteV2Page(view: { language: Language; contactEmail?: string; back: string; theme: "light" | "dark" | "system"; hasBlog: boolean; endpoint: string }): string {
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
  const code = (text: string): string => `<pre class="mono" style="margin:0;padding:16px;background:var(--code);color:var(--on-code);border-radius:10px;overflow-x:auto">${escape(text)}</pre><button type="button" class="copy button" hidden data-copied="${escape(c.connect.copied)}">${escape(c.connect.copy)}</button>`;
  const body = `<header class="s-top"><div class="s-wrap">
<a class="s-brand" href="/">${SEAL_SVG}<span>sigillo</span></a>
<nav aria-label="${escape(c.nav.how)}"><a href="#come-funziona">${escape(c.nav.how)}</a><a href="#cosa-consegni">${escape(c.nav.deliver)}</a><a href="#ai-act">${escape(c.nav.aiAct)}</a><a href="#prezzi">${escape(c.nav.pricing)}</a>${view.hasBlog ? `<a href="/blog">${escape(c.nav.blog)}</a>` : ""}</nav>
<div class="s-right">${languageSwitch("seg", view.back)}<a class="btn sm" href="/verify">${escape(c.nav.verify)}</a><a href="/ui/login">${escape(c.nav.signIn)}</a>${start}</div>
</div></header>
<main>
<section class="s-wrap s-hero" id="inizio"><div>
<h1>${escape(c.hero.h1)}</h1><p class="s-lead">${escape(c.hero.lead)}</p>
<div class="s-btns">${start}<a class="btn" href="/verify">${escape(c.hero.secondary)}</a></div>
<div class="s-doors"><a href="#cosa-consegni">${escape(c.hero.doors[0])} ›</a><a href="#collega">${escape(c.hero.doors[1])} ›</a><a href="/verify">${escape(c.hero.doors[2])} ›</a></div>
<p class="s-facts">${escape(c.hero.facts)}</p></div>
<div class="s-card" aria-hidden="true"><div class="s-verdict">${PROOF_ICONS.full}<div><b>${escape(c.card.verdict)}</b><br><span style="color:var(--text)">${escape(c.card.line)}</span></div></div>
<hr style="border:0;border-top:1px solid var(--separator);margin:18px 0"><p class="t-meta" style="margin:0 0 6px">${escape(c.card.key)}</p><p class="mono" style="margin:0 0 6px"><b>9685 533e aa64 29c4</b></p><span class="sign green">${STATE_ICONS.ok}<span>${escape(c.card.matches)}</span></span></div>
</section>

<section class="s-sec alt" id="come-funziona"><div class="s-wrap"><h2>${escape(c.how.h2)}</h2>
<div class="s-three">${c.how.questions.map((q) => `<div class="s-card"><p class="s-q">${escape(q.q)}</p>${cardFor(q.kind, q.a)}</div>`).join("")}</div>
<ol class="s-flow" style="list-style:none;padding:0">${c.how.flow.map((step) => `<li>${escape(step)}</li>`).join("")}</ol></div></section>

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

<section class="s-sec alt" id="collega"><div class="s-wrap"><h2>${escape(c.connect.h2)}</h2>
<ol class="steps-v2">${c.connect.steps.map((line, i) => `<li><span class="num">${i + 1}</span><span>${escape(line)}</span></li>`).join("")}</ol>
<p class="t-meta">${escape(c.connect.or)} · ${escape(c.connect.where)}</p>
${code("pip install sigillo")}
${code(`import sigillo\nsigillo.init(\n    endpoint="${view.endpoint}",\n    api_key="<…>",\n    system_id="selezione-cv",\n)`)}</div></section>

<section class="s-sec" id="prezzi"><div class="s-wrap"><h2>${escape(c.pricing.h2)}</h2>
<div class="s-price">${c.pricing.plans.map((p, i) => `<div class="s-card s-plan"><span class="t-meta">${escape(p.name)}</span><b>${escape(p.price)}</b><ul class="s-yes" style="list-style:none;padding:0;display:grid;gap:6px">${p.lines.map((l) => `<li>${escape(l)}</li>`).join("")}</ul>${i === 0 ? start : `<a class="btn" href="${escape(mail)}" rel="noopener">${escape(p.cta)}</a>`}${p.note === undefined ? "" : `<span class="t-meta">${escape(p.note)}</span>`}</div>`).join("")}</div>
<p class="t-meta">${escape(c.pricing.unit)}</p>
<div class="s-faq">${c.pricing.faq.map((f, i) => `<details${i === 1 ? " open" : ""}><summary>${escape(f.q)}</summary><p>${escape(f.a)}</p></details>`).join("")}</div></div></section>
</main>
<section class="s-band" id="contatti"><div class="s-wrap"><h2>${escape(c.contact.h2)}</h2><a class="btn" href="${escape(mail)}" rel="noopener">${escape(c.contact.button)}</a>${view.contactEmail === undefined ? "" : `<p>${escape(c.contact.address)} ${escape(view.contactEmail)}</p>`}</div></section>
<footer class="s-foot"><div class="s-wrap"><div>
<section><h4>${escape(c.footer.product)}</h4><ul><li><a href="#come-funziona">${escape(c.nav.how)}</a></li><li><a href="#cosa-consegni">${escape(c.nav.deliver)}</a></li><li><a href="#prezzi">${escape(c.nav.pricing)}</a></li></ul></section>
<section><h4>${escape(c.footer.receivers)}</h4><ul><li><a href="/verify">${escape(c.nav.verify)}</a></li><li><a href="${REPOSITORY}/tree/main/packages/verifier" target="_blank" rel="noopener">Open source</a></li><li><a href="${REPOSITORY}/blob/main/docs/FORMAT.md" target="_blank" rel="noopener">${escape(c.footer.format)}</a></li></ul></section>
<section><h4>${escape(c.footer.company)}</h4><ul><li><a href="/privacy">${escape(c.footer.privacy)}</a></li>${view.hasBlog ? `<li><a href="/blog">${escape(c.nav.blog)}</a></li>` : ""}<li><a href="/ui/login">${escape(c.nav.signIn)}</a></li></ul></section></div>
<p>${escape(c.footer.legal)}</p></div></footer>`;

  const theme = view.theme === "system" ? "" : ` data-theme="${view.theme}"`;
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

