import type { Language } from "./locale.js";

/**
 * The words of the public site (site.ts), in English and Italian. Kept apart
 * from the web view's strings: the site is read by people who have not
 * signed in, and its text is marketing copy that changes on its own.
 */

export interface SiteTexts {
  nav: { pricing: string; connect: string };
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
  privacy: {
    title: string;
    sections: readonly { heading: string; paragraphs: readonly string[] }[];
    updated: string;
  };
  notFound: { title: string; back: string };
}

const EN: SiteTexts = {
  nav: { pricing: "Pricing", connect: "How to connect" },
  signIn: "Sign in",
  start: "Start free pilot",
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
  nav: { pricing: "Prezzi", connect: "Come si collega" },
  signIn: "Entra",
  start: "Inizia il pilota gratuito",
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
