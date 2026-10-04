import type { Language } from "./locale.js";

/**
 * The words of the public site (site.ts), in English and Italian. Kept apart
 * from the web view's strings: the site is read by people who have not
 * signed in, and its text is marketing copy that changes on its own.
 */

/** A heading and a sentence under it. */
interface Point {
  title: string;
  text: string;
}

export interface SiteTexts {
  nav: { pricing: string; connect: string; verify: string };
  signIn: string;
  start: string;
  watch: string;
  switchTo: string;
  switchLabel: string;
  footer: { europe: string; privacy: string; contact: string };
  home: {
    title: string;
    heading: string;
    lead: string;
    videoLabel: string;
    subtitles: string;
    what: string;
    cards: readonly { title: string; text: string }[];
    connect: string;
    steps: readonly string[];
    allWays: string;
    pilot: string;
    pilotText: string;
    seePricing: string;
    why: {
      eyebrow: string;
      title: string;
      lead: string;
      problemsTitle: string;
      problems: readonly Point[];
      audienceTitle: string;
      audience: readonly Point[];
      differenceTitle: string;
      difference: readonly Point[];
    };
    how: { title: string; items: readonly { title: string; text: string }[] };
    aiAct: { eyebrow: string; title: string; lead: string; articles: readonly (Point & { ref: string })[]; note: string };
    contact: { title: string; text: string; action: string };
  };
  pricing: {
    title: string;
    now: string;
    soon: string;
    perMonth: string;
    plans: readonly { name: string; price: string; features: readonly string[]; action: string }[];
    questions: string;
    faq: readonly { q: string; a: string }[];
  };
  connect: {
    title: string;
    ways: { python: string; otel: string; api: string };
    install: string;
    installWhere: string;
    inCode: string;
    inCodeWhere: string;
    copy: string;
    copied: string;
    otelNote: string;
    apiNote: string;
    keyNote: string;
  };
  verify: {
    title: string;
    drop: string;
    choose: string;
    private: string;
    checking: string;
    intact: string;
    /** {receipts} and {system} are filled in by the page's script. */
    intactLine: string;
    signatures: string;
    /** {n}: the number of receipts. */
    signaturesValue: string;
    chain: string;
    chainValue: string;
    seals: string;
    /** {last}: the time of the newest checkpoint; {n}: how many were checked. */
    sealsValue: string;
    noSeals: string;
    unsealed: string;
    timestamps: string;
    /** {n}: tokens in the pack. */
    timestampsValue: string;
    altered: string;
    alteredLine: string;
    notPack: string;
    notPackLine: string;
    oldBrowser: string;
    oldBrowserLine: string;
    details: string;
    /** Plain words for each check of evidence-check.ts that can fail. */
    reasons: Record<string, string>;
    cli: string;
  };
  privacy: {
    title: string;
    sections: readonly { heading: string; paragraphs: readonly string[] }[];
    updated: string;
  };
  notFound: { title: string; back: string };
}

const EN: SiteTexts = {
  nav: { pricing: "Pricing", connect: "How to connect", verify: "Verify" },
  signIn: "Sign in",
  start: "Create an account",
  watch: "Watch the demo",
  switchTo: "IT",
  switchLabel: "Italiano",
  footer: { europe: "Server in Europe", privacy: "Privacy", contact: "Contact" },
  home: {
    title: "Sigillo: the tamper-proof ledger for your AI agents",
    heading: "The tamper-proof ledger for your AI agents",
    lead: "Every action becomes a signed receipt. Ready for the EU AI Act.",
    videoLabel: "Sigillo demo, 3 minutes",
    subtitles: "English",
    what: "What it does",
    cards: [
      { title: "Signs every action", text: "Tools, models and decisions of your agent become signed receipts." },
      { title: "Nobody can change them", text: "Receipts are chained and timestamped. Any edit shows at once." },
      { title: "Evidence pack for the auditor", text: "One file to hand over, which anyone can check." },
    ],
    connect: "Connects in three steps",
    steps: ["Create an account", "Add your system", "Paste a few lines"],
    allWays: "All the ways to connect",
    pilot: "Start free",
    pilotText: "While Sigillo is in its pilot phase, it is free for up to 10,000 receipts a month. No card needed.",
    seePricing: "See pricing",
    why: {
      eyebrow: "Why Sigillo exists",
      title: "When an AI agent acts, someone must be able to prove what it did",
      lead: "Agents now read CVs, answer customers and move money on their own. Sigillo gives each of those actions a record that nobody can quietly change.",
      problemsTitle: "The problem",
      problems: [
        { title: "Logs can be rewritten", text: "Whoever runs the server can edit or delete an ordinary log, and nobody can tell." },
        { title: "Auditors ask for proof", text: "After an incident, a complaint or an inspection, “trust us” is not an answer." },
        { title: "The rules are arriving", text: "The EU AI Act requires records of what high-risk AI systems do (Articles 12, 14 and 26)." },
      ],
      audienceTitle: "Who it is for",
      audience: [
        { title: "Companies using AI agents", text: "Teams whose agents take decisions about people or money: hiring, credit, support, logistics." },
        { title: "Consultants and auditors", text: "Anyone who has to vouch for an AI system and needs evidence they can check themselves." },
        { title: "Teams building agents", text: "Providers who build agents for clients and want to show what the agent did, and did not do." },
      ],
      differenceTitle: "What makes it different",
      difference: [
        { title: "Signed apart", text: "A separate process with no network access holds the key. The server never sees it." },
        { title: "Chained and sealed", text: "Each receipt is linked to the one before, and the ledger is timestamped by an independent authority." },
        { title: "Checkable without us", text: "The verifier is open source. An auditor needs neither your trust nor ours." },
        { title: "No content stored", text: "Only fingerprints of what the agent read and wrote. Prompts and answers stay with you." },
      ],
    },
    how: {
      title: "How it works",
      items: [
        { title: "Your agent works as usual", text: "A few lines in your code send Sigillo a fingerprint of every action: which tool, when, with what outcome. The text itself, prompts and answers, never leaves your server." },
        { title: "Each action becomes a signed receipt", text: "Sigillo signs it with a key held by a separate process, and links it to the one before, like numbered pages in a book." },
        { title: "Seals fix the ledger in time", text: "The ledger is sealed regularly and timestamped by an independent authority, so nobody can say later that it was written afterwards." },
        { title: "Anyone can check it", text: "You download an evidence pack. The open-source verifier, or the Verify page on this site, confirms signatures, order and seals without asking Sigillo." },
      ],
    },
    aiAct: {
      eyebrow: "EU AI Act",
      title: "What the AI Act asks, and where Sigillo helps",
      lead: "The Regulation (EU) 2024/1689 sets duties for high-risk AI systems. Three articles concern records.",
      articles: [
        { ref: "Article 12", title: "Record-keeping", text: "High-risk systems must log their events automatically. Sigillo turns each action into a signed receipt." },
        { ref: "Article 14", title: "Human oversight", text: "People must be able to follow what the system does. The console shows each action in plain words." },
        { ref: "Article 26", title: "Duties of deployers", text: "Companies using such systems must keep the logs for a set period. Sigillo keeps them and exports them on request." },
      ],
      note: "Sigillo makes the records tamper-evident. It does not make a system compliant by itself: that depends on what your AI does and how you use it.",
    },
    contact: { title: "Contact", text: "Questions, a pilot, a demo for your team? Write to Giovanni Noventa.", action: "Contact us" },
  },
  pricing: {
    title: "Pricing",
    now: "Now",
    soon: "Coming soon",
    perMonth: "/ month",
    plans: [
      { name: "Pilot phase", price: "Free", features: ["10,000 receipts a month", "Evidence pack and verifier", "Timestamps", "Direct support"], action: "Start" },
      { name: "Standard", price: "190 €", features: ["100,000 receipts a month", "Unlimited systems", "Unlimited people", "Off-site backup"], action: "Notify me" },
      { name: "Custom", price: "On request", features: ["High volumes", "Dedicated server", "eIDAS qualified timestamps", "Contract and SLA"], action: "Contact us" },
    ],
    questions: "Questions",
    faq: [
      { q: "What is the pilot phase?", a: "The first months of Sigillo, with its first customers: everything works, nothing is charged, and we ask you what to improve." },
      { q: "What happens when the pilot ends?", a: "We tell you first. Your receipts stay yours, and you can export them at any time." },
      { q: "Where is the data?", a: "On a server in Europe. Sigillo keeps fingerprints of what your agent reads and writes, never the text itself." },
      { q: "Can I check the ledger without you?", a: "Yes. The verifier is open source and works without any connection to Sigillo." },
    ],
  },
  connect: {
    title: "How to connect",
    ways: { python: "Python", otel: "OpenTelemetry", api: "HTTP API" },
    install: "1. Install",
    installWhere: "On the server or computer where your AI agent runs, not on the computer you use to read the console.",
    inCode: "2. Add to your agent",
    inCodeWhere: "In your agent's code, where it starts. From then on every action it takes is sent to Sigillo as a fingerprint.",
    copy: "Copy",
    copied: "Copied",
    otelNote: "If your agent already sends OpenTelemetry traces: three settings on that server, nothing to install.",
    apiNote: "From any language: one HTTP request per action.",
    keyNote: "You get the key when you add a system in the console.",
  },
  verify: {
    title: "Verify an evidence pack",
    drop: "Drop the evidence pack here",
    choose: "Choose file",
    private: "The file is checked in your browser. It is never uploaded.",
    checking: "Checking…",
    intact: "Intact",
    intactLine: "{receipts} receipts of {system}, signed and in order.",
    signatures: "Signatures",
    signaturesValue: "{n} of {n}",
    chain: "Chain",
    chainValue: "No gaps, nothing changed",
    seals: "Seals",
    sealsValue: "The last on {last}, {n} in all",
    noSeals: "None yet",
    unsealed: "Not sealed yet",
    timestamps: "Timestamps",
    timestampsValue: "{n} in the pack, checked by the command-line verifier",
    altered: "Altered",
    alteredLine: "Something in this pack was changed after it was signed.",
    notPack: "Not an evidence pack",
    notPackLine: "This file is not a Sigillo evidence pack. It is the .zip you download from the console.",
    oldBrowser: "This browser cannot check it",
    oldBrowserLine: "It cannot check Ed25519 signatures. Use a recent Chrome, Edge, Firefox or Safari, or the command-line verifier.",
    details: "Technical details",
    reasons: {
      sequence: "A receipt is missing, repeated or out of order.",
      "chain-link": "A receipt was changed.",
      signature: "A signature does not match its receipt.",
      key: "A signing key does not match.",
      genesis: "The first receipt is not the start of the chain.",
      system: "The pack mixes receipts of different systems.",
      range: "The pack's summary does not match what it holds.",
      manifest: "The pack's summary is damaged.",
      "checkpoint-signature": "A seal does not match.",
      "merkle-root": "A seal does not match the receipts.",
      "inclusion-proof": "A seal does not match the receipts.",
      "artifacts-index": "The document index does not match the receipts.",
      "receipt-json": "A receipt is damaged.",
      "receipt-schema": "A receipt is damaged.",
      "checkpoint-json": "A seal is damaged.",
      "checkpoint-schema": "A seal is damaged.",
    },
    cli: "Full check, timestamps included: the command-line verifier",
  },
  privacy: {
    title: "Privacy",
    sections: [
      {
        heading: "Who we are",
        paragraphs: ["Sigillo is run by Giovanni Noventa, who is responsible for the personal data described here."],
      },
      {
        heading: "What we keep",
        paragraphs: [
          "For each person who signs in: the email address, the company name given at sign-up, and when the account was approved. Sign-in goes through Google's Firebase Authentication, which holds the account and its password; no password reaches our server.",
          "For each action your agents send: the receipt, which holds fingerprints (SHA-256) of inputs and outputs, never their text, together with the names of tools and models and the time. Who an action was for is replaced by a pseudonym.",
        ],
      },
      {
        heading: "Why",
        paragraphs: ["Only to run the service you signed up for: to sign you in, to keep your ledger and to give you its evidence. Nothing is sold or shared for advertising."],
      },
      {
        heading: "Where",
        paragraphs: ["On a server in Europe. Firebase Authentication is a Google service and may process sign-in data outside the European Union."],
      },
      {
        heading: "Cookies",
        paragraphs: ["Only technical ones: they keep you signed in during and after sign-in, and remember your language and your light or dark theme. No tracking, no analytics."],
      },
      {
        heading: "Your rights",
        paragraphs: [
          "You can ask to see, correct or delete your account data, and export your receipts at any time. Receipts already signed cannot be changed, which is the point of the ledger, but a pseudonym can be unlinked from the person it stood for.",
          "You can also complain to your data protection authority.",
        ],
      },
    ],
    updated: "Last updated 4 October 2026.",
  },
  notFound: { title: "Page not found", back: "Back to the home page" },
};

const IT: SiteTexts = {
  nav: { pricing: "Prezzi", connect: "Come si collega", verify: "Verifica" },
  signIn: "Accedi",
  start: "Crea un account",
  watch: "Guarda la demo",
  switchTo: "EN",
  switchLabel: "English",
  footer: { europe: "Server in Europa", privacy: "Privacy", contact: "Contatti" },
  home: {
    title: "Sigillo: il registro a prova di manomissione per i tuoi agenti AI",
    heading: "Il registro a prova di manomissione per i tuoi agenti AI",
    lead: "Ogni azione diventa una ricevuta firmata. Pronto per l'AI Act.",
    videoLabel: "Demo di Sigillo, 3 minuti",
    subtitles: "Italiano",
    what: "Cosa fa",
    cards: [
      { title: "Firma ogni azione", text: "Strumenti, modelli e decisioni dell'agente diventano ricevute firmate." },
      { title: "Nessuno può cambiarle", text: "Le ricevute sono concatenate e marcate nel tempo. Una modifica si vede subito." },
      { title: "Fascicolo per il revisore", text: "Un file da consegnare all'auditor, verificabile da chiunque." },
    ],
    connect: "Si collega in tre passi",
    steps: ["Crea un account", "Aggiungi il tuo sistema", "Incolla poche righe"],
    allWays: "Tutti i modi per collegarsi",
    pilot: "Inizia gratis",
    pilotText: "Finché Sigillo è nella fase pilota è gratuito, fino a 10.000 ricevute al mese. Senza carta di credito.",
    seePricing: "Vedi i prezzi",
    why: {
      eyebrow: "Perché esiste Sigillo",
      title: "Quando un agente AI agisce, qualcuno deve poter provare cosa ha fatto",
      lead: "Gli agenti ormai leggono CV, rispondono ai clienti e muovono denaro da soli. Sigillo dà a ognuna di quelle azioni una registrazione che nessuno può cambiare di nascosto.",
      problemsTitle: "Il problema",
      problems: [
        { title: "I log si possono riscrivere", text: "Chi gestisce il server può modificare o cancellare un log normale, e nessuno se ne accorge." },
        { title: "I revisori chiedono prove", text: "Dopo un incidente, un reclamo o un'ispezione, “fidatevi” non è una risposta." },
        { title: "Le regole stanno arrivando", text: "L'AI Act europeo richiede la registrazione di ciò che fanno i sistemi AI ad alto rischio (articoli 12, 14 e 26)." },
      ],
      audienceTitle: "Per chi è",
      audience: [
        { title: "Aziende che usano agenti AI", text: "Team i cui agenti prendono decisioni su persone o denaro: selezione, credito, assistenza, logistica." },
        { title: "Consulenti e revisori", text: "Chi deve garantire per un sistema AI e ha bisogno di prove che può controllare da solo." },
        { title: "Chi costruisce agenti", text: "Fornitori che sviluppano agenti per i clienti e vogliono mostrare cosa ha fatto l'agente, e cosa no." },
      ],
      differenceTitle: "Cosa lo rende diverso",
      difference: [
        { title: "Firmato a parte", text: "Un processo separato, senza accesso alla rete, custodisce la chiave. Il server non la vede mai." },
        { title: "Concatenato e sigillato", text: "Ogni ricevuta è legata alla precedente e il registro è marcato nel tempo da un'autorità indipendente." },
        { title: "Controllabile senza di noi", text: "Il verificatore è open source. Un revisore non ha bisogno né della tua fiducia né della nostra." },
        { title: "Nessun contenuto salvato", text: "Solo le impronte di ciò che l'agente legge e scrive. Richieste e risposte restano da te." },
      ],
    },
    how: {
      title: "Come funziona",
      items: [
        { title: "Il tuo agente lavora come sempre", text: "Poche righe nel tuo codice mandano a Sigillo l'impronta di ogni azione: quale strumento, quando, con quale esito. Il testo, cioè richieste e risposte, non lascia mai il tuo server." },
        { title: "Ogni azione diventa una ricevuta firmata", text: "Sigillo la firma con una chiave custodita da un processo separato e la lega alla precedente, come le pagine numerate di un libro." },
        { title: "I sigilli fissano il registro nel tempo", text: "Il registro viene sigillato a intervalli regolari e marcato da un'autorità indipendente, così nessuno può dire che sia stato scritto dopo." },
        { title: "Chiunque può controllarlo", text: "Scarichi un fascicolo delle prove. Il verificatore open source, o la pagina Verifica di questo sito, controlla firme, ordine e sigilli senza chiedere a Sigillo." },
      ],
    },
    aiAct: {
      eyebrow: "AI Act europeo",
      title: "Cosa chiede l'AI Act e dove aiuta Sigillo",
      lead: "Il Regolamento (UE) 2024/1689 fissa obblighi per i sistemi AI ad alto rischio. Tre articoli riguardano le registrazioni.",
      articles: [
        { ref: "Articolo 12", title: "Registrazione degli eventi", text: "I sistemi ad alto rischio devono registrare automaticamente i propri eventi. Sigillo trasforma ogni azione in una ricevuta firmata." },
        { ref: "Articolo 14", title: "Sorveglianza umana", text: "Le persone devono poter seguire ciò che fa il sistema. La console mostra ogni azione in parole semplici." },
        { ref: "Articolo 26", title: "Obblighi di chi lo usa", text: "Le aziende che usano questi sistemi devono conservare i log per un periodo stabilito. Sigillo li conserva e li esporta su richiesta." },
      ],
      note: "Sigillo rende le registrazioni a prova di manomissione. Da solo non rende conforme un sistema: dipende da cosa fa la tua AI e da come la usi.",
    },
    contact: { title: "Contatti", text: "Domande, un pilota, una demo per il tuo team? Scrivi a Giovanni Noventa.", action: "Contattaci" },
  },
  pricing: {
    title: "Prezzi",
    now: "Adesso",
    soon: "In arrivo",
    perMonth: "/ mese",
    plans: [
      { name: "Fase pilota", price: "Gratis", features: ["10.000 ricevute al mese", "Fascicolo e verificatore", "Marca temporale", "Supporto diretto"], action: "Inizia" },
      { name: "Standard", price: "190 €", features: ["100.000 ricevute al mese", "Sistemi illimitati", "Persone illimitate", "Copia di sicurezza esterna"], action: "Avvisami" },
      { name: "Su misura", price: "Su richiesta", features: ["Volumi alti", "Server dedicato", "Marca temporale qualificata eIDAS", "Contratto e SLA"], action: "Contattaci" },
    ],
    questions: "Domande",
    faq: [
      { q: "Cos'è la fase pilota?", a: "I primi mesi di Sigillo, con i primi clienti: funziona tutto, non si paga niente e ti chiediamo cosa migliorare." },
      { q: "Cosa succede alla fine del pilota?", a: "Ti avvisiamo prima. Le ricevute restano tue e puoi esportarle in qualsiasi momento." },
      { q: "Dove stanno i dati?", a: "Su un server in Europa. Sigillo conserva le impronte di quello che l'agente legge e scrive, mai il testo." },
      { q: "Posso verificare il registro senza di voi?", a: "Sì. Il verificatore è open source e funziona senza connessione a Sigillo." },
    ],
  },
  connect: {
    title: "Come si collega",
    ways: { python: "Python", otel: "OpenTelemetry", api: "API HTTP" },
    install: "1. Installa",
    installWhere: "Sul server o sul computer dove gira il tuo agente AI, non sul computer da cui guardi la console.",
    inCode: "2. Aggiungi al tuo agente",
    inCodeWhere: "Nel codice del tuo agente, dove parte. Da lì in poi ogni sua azione arriva a Sigillo come impronta.",
    copy: "Copia",
    copied: "Copiato",
    otelNote: "Se il tuo agente manda già tracce OpenTelemetry: tre impostazioni su quel server, niente da installare.",
    apiNote: "Da qualsiasi linguaggio: una richiesta HTTP per ogni azione.",
    keyNote: "La chiave te la dà la console quando aggiungi un sistema.",
  },
  verify: {
    title: "Verifica un fascicolo",
    drop: "Trascina qui il fascicolo",
    choose: "Scegli il file",
    private: "Il file viene controllato nel tuo browser. Non viene mai caricato.",
    checking: "Controllo in corso…",
    intact: "Integro",
    intactLine: "{receipts} ricevute di {system}, firmate e in ordine.",
    signatures: "Firme",
    signaturesValue: "{n} su {n}",
    chain: "Catena",
    chainValue: "Nessun buco, niente modificato",
    seals: "Sigilli",
    sealsValue: "L'ultimo il {last}, {n} in tutto",
    noSeals: "Ancora nessuno",
    unsealed: "Non ancora sigillate",
    timestamps: "Marche temporali",
    timestampsValue: "{n} nel fascicolo, si controllano con il verificatore da riga di comando",
    altered: "Alterato",
    alteredLine: "Qualcosa in questo fascicolo è stato cambiato dopo la firma.",
    notPack: "Non è un fascicolo",
    notPackLine: "Questo file non è un fascicolo di Sigillo. È lo .zip che scarichi dalla console.",
    oldBrowser: "Questo browser non può controllarlo",
    oldBrowserLine: "Non sa verificare le firme Ed25519. Usa un Chrome, Edge, Firefox o Safari recente, oppure il verificatore da riga di comando.",
    details: "Dettagli tecnici",
    reasons: {
      sequence: "Una ricevuta manca, è ripetuta o fuori ordine.",
      "chain-link": "Una ricevuta è stata modificata.",
      signature: "Una firma non corrisponde alla sua ricevuta.",
      key: "Una chiave di firma non corrisponde.",
      genesis: "La prima ricevuta non è l'inizio della catena.",
      system: "Il fascicolo mescola ricevute di sistemi diversi.",
      range: "Il riepilogo del fascicolo non corrisponde al contenuto.",
      manifest: "Il riepilogo del fascicolo è danneggiato.",
      "checkpoint-signature": "Un sigillo non corrisponde.",
      "merkle-root": "Un sigillo non corrisponde alle ricevute.",
      "inclusion-proof": "Un sigillo non corrisponde alle ricevute.",
      "artifacts-index": "L'indice dei documenti non corrisponde alle ricevute.",
      "receipt-json": "Una ricevuta è danneggiata.",
      "receipt-schema": "Una ricevuta è danneggiata.",
      "checkpoint-json": "Un sigillo è danneggiato.",
      "checkpoint-schema": "Un sigillo è danneggiato.",
    },
    cli: "Controllo completo, marche temporali comprese: il verificatore da riga di comando",
  },
  privacy: {
    title: "Privacy",
    sections: [
      {
        heading: "Chi siamo",
        paragraphs: ["Sigillo è gestito da Giovanni Noventa, titolare del trattamento dei dati personali descritti qui."],
      },
      {
        heading: "Cosa conserviamo",
        paragraphs: [
          "Per ogni persona che entra: l'indirizzo email, il nome dell'azienda dato alla registrazione e quando l'account è stato approvato. L'accesso passa da Firebase Authentication di Google, che custodisce l'account e la password; nessuna password arriva al nostro server.",
          "Per ogni azione che i tuoi agenti inviano: la ricevuta, con le impronte (SHA-256) di ingressi e uscite, mai il loro testo, insieme ai nomi di strumenti e modelli e all'ora. La persona per cui è stata fatta un'azione è sostituita da uno pseudonimo.",
        ],
      },
      {
        heading: "Perché",
        paragraphs: ["Solo per far funzionare il servizio a cui ti sei iscritto: farti entrare, tenere il tuo registro e darti le prove. Niente viene venduto o condiviso per pubblicità."],
      },
      {
        heading: "Dove",
        paragraphs: ["Su un server in Europa. Firebase Authentication è un servizio di Google e può trattare i dati di accesso fuori dall'Unione Europea."],
      },
      {
        heading: "Cookie",
        paragraphs: ["Solo tecnici: servono a farti entrare e restare dentro, e a ricordare la lingua e il tema chiaro o scuro. Nessun tracciamento, nessuna statistica."],
      },
      {
        heading: "I tuoi diritti",
        paragraphs: [
          "Puoi chiedere di vedere, correggere o cancellare i dati del tuo account, ed esportare le tue ricevute in qualsiasi momento. Le ricevute già firmate non si possono cambiare, ed è lo scopo del registro, ma uno pseudonimo si può scollegare dalla persona che indicava.",
          "Puoi anche rivolgerti al Garante per la protezione dei dati personali.",
        ],
      },
    ],
    updated: "Ultimo aggiornamento 4 ottobre 2026.",
  },
  notFound: { title: "Pagina non trovata", back: "Torna alla pagina iniziale" },
};

export const SITE_TEXTS: Record<Language, SiteTexts> = { en: EN, it: IT };
