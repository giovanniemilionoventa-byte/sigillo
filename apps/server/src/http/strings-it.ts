import type { Receipt } from "@sigillo/core";

/**
 * Every piece of Italian text the web view shows, in one place: the fixed
 * strings (`ui`) and the sentence templates that turn a receipt, a match or a
 * log entry into words. strings-en.ts is the same in English, checked against
 * this file's shape by the compiler; strings.ts picks one for each request.
 */

const ui = {
  nav: {
    registro: "Registro",
    sistemi: "Sistemi",
    clienti: "Clienti",
    verificaDocumento: "Verifica documento",
    impostazioni: "Impostazioni",
    esci: "Esci",
    label: "Sezioni",
    allSystems: "Tutti i sistemi",
    tools: "Strumenti",
    menu: "Menu",
    close: "Chiudi",
    newSystem: "Nuovo sistema",
  },
  brand: {
    skip: "Vai al contenuto",
  },
  // The operator's own way in, at /ui/admin when customers have accounts.
  login: {
    title: "Accedi a sigillo",
    adminTitle: "Accesso amministratore",
    label: "Password amministratore",
    placeholder: "Password",
    submit: "Accedi",
    // The same words for a wrong password and for a lockout, on purpose: see
    // the login handler in ui.ts.
    wrong: "Password non corretta. Dopo troppi tentativi l'accesso resta sospeso per qualche minuto.",
  },
  // Signing in, signing up and the rest of a customer's account (auth/firebase.ts).
  account: {
    google: "Continua con Google",
    or: "oppure",
    email: "Indirizzo email",
    password: "Password",
    passwordNew: "Password (almeno 10 caratteri)",
    passwordRepeat: "Ripeti la password",
    continueEmail: "Continua con email",
    passwordTitle: "Inserisci la password",
    change: "Cambia",
    signIn: "Accedi",
    toSignUp: "Crea un account",
    haveAccount: "Hai già un account?",
    toReset: "Password dimenticata?",
    toLogin: "Torna all'accesso",
    toAdmin: "Entra come amministratore",
    wrong: "Email o password non corrette. Dopo troppi tentativi l'accesso resta sospeso per qualche minuto.",
    unavailable: "Il servizio di accesso non risponde. Riprova tra qualche minuto.",
    googleFailed: "L'accesso con Google non è riuscito. Riprova.",
    disabled: "Questo account è stato disattivato.",
    tooMany: "Troppi tentativi da questo indirizzo. Riprova tra qualche minuto.",
    unverifiedTitle: "Conferma l'indirizzo",
    unverified: (email: string) => `Ti abbiamo mandato di nuovo il link a ${email}. Aprilo, poi accedi.`,
    signUpTitle: "Crea un account",
    signUpSubmit: "Crea account",
    passwordShort: "La password deve avere almeno 10 caratteri.",
    passwordMismatch: "Le due password non coincidono.",
    emailInvalid: "Questo indirizzo email non sembra valido.",
    emailExists: "Esiste già un account con questa email: accedi, oppure recupera la password.",
    checkMailTitle: "Controlla la posta",
    signedUp: (email: string) => `Abbiamo mandato un link a ${email}. Aprilo per confermare l'indirizzo.`,
    resetTitle: "Nuova password",
    resetSubmit: "Mandami il link",
    resetSent: "Se l'indirizzo ha un account, il link è in arrivo. Controlla anche la posta indesiderata.",
    companyTitle: "Come si chiama la tua azienda?",
    companyLabel: "Nome dell'azienda",
    companySubmit: "Continua",
    expired: "La richiesta è scaduta: accedi di nuovo.",
    continueTitle: "Accesso in corso",
    continueLink: "Continua",
    waitingTitle: "Quasi fatto",
    waiting: (name: string) => `Lo spazio di ${name} è in attesa di approvazione. Ti scriviamo appena è pronto.`,
  },
  organizations: {
    title: "Clienti",
    heading: "Clienti",
    none: "Nessun cliente ancora.",
    columns: { name: "Azienda", state: "Stato", systems: "Sistemi" },
    waiting: "In attesa",
    active: "Attivo",
    since: (when: string): string => `dal ${when}`,
    approve: "Approva",
    people: (count: number): string => `${count} ${count === 1 ? "persona" : "persone"}`,
    noMembers: "Creato dall'amministratore",
    approved: (name: string) => `${name} è approvato: le sue persone possono entrare.`,
  },
  home: {
    heading: "Registro",
    welcome: "Benvenuto in sigillo",
    steps: {
      account: "Account creato",
      create: "Crea il primo sistema",
      connect: "Collega il tuo agente",
      receive: "Ricevi la prima ricevuta",
      done: "Fatto",
      createButton: "Crea sistema",
      connectButton: "Collega",
    },
    // The one line at the top of the main page: the situation, by the worst state shown.
    summary: {
      green: "Tutto a posto. Nessuna alterazione.",
      yellow: (count: number): string =>
        `Nessuna alterazione. ${count === 1 ? "Un sistema da controllare" : `${count} sistemi da controllare`}.`,
      red: (count: number): string =>
        count === 1 ? "Un registro non supera la verifica." : `${count} registri non superano la verifica.`,
      why: "Perché?",
      open: "Apri",
    },
    tiles: { today: "Azioni oggi", blocked: "Bloccate", failed: "Fallite", lastSeal: "Ultimo sigillo" },
    systems: "Sistemi",
    recent: "Ultime azioni",
    noActions: "Nessuna azione ancora.",
    evidence: "Fascicolo delle prove",
    chooseSystem: "Sistema",
    fromDate: "Dal",
    toDate: "Al",
    generate: "Scarica fascicolo",
    disclose: {
      summary: "Includi nomi o contenuti",
      hint:
        "Di norma il fascicolo non nomina nessuno e non apre nessuna impronta. Compila questi campi solo se chi lo riceve deve sapere di più.",
      subjectsLabel: "Persone da nominare (psn_…, separati da spazi)",
      openingsLabel: "Ricevute di cui includere i nonce (per esempio 4 7-9)",
    },
    checkpointNow: "Sigilla adesso",
    checkpointDone: "Fatto: ogni sistema con azioni nuove è stato sigillato.",
    archivedGroup: "Archiviati",
    archivedBadge: "Archiviato",
    archivedRed: "la verifica è fallita",
    archivedActive: "ha ricevuto azioni dopo l'archiviazione",
    quotaFull: (limit: string, resume: string): string =>
      `Limite di ${limit} ricevute raggiunto: le nuove azioni non vengono registrate fino al ${resume}.`,
    quotaNear: (used: string, limit: string): string => `Hai usato ${used} ricevute su ${limit} questo mese.`,
  },
  // A system's chain in three words: the main page, the systems, a system's header.
  chain: {
    green: "Integro",
    yellow: "Da controllare",
    red: "Verifica fallita",
  },
  system: {
    tabsLabel: "Sezioni del sistema",
    evidence: "Fascicolo",
  },
  exportSheet: {
    title: (name: string): string => `Fascicolo di ${name}`,
    cancel: "Annulla",
    submit: "Scarica .zip",
  },
  notFound: {
    title: "Pagina non trovata",
    heading: "Pagina non trovata",
    back: "Torna al registro",
  },
  systemsPage: {
    title: "Sistemi",
    heading: "Sistemi",
    views: { attivi: "Attivi", archiviati: "Archiviati", tutti: "Tutti" },
    noneInView: {
      attivi: "Nessun sistema attivo.",
      archiviati: "Nessun sistema archiviato.",
      tutti: "Nessun sistema ancora.",
    },
    columns: { system: "Sistema", state: "Stato", receipts: "Ricevute", last: "Ultima azione", archived: "Archiviato" },
    archivedBadge: "Archiviato",
    // How the latest action reached sigillo, from the receipt's source.type.
    connection: {
      sdk: "SDK Python",
      otlp: "OpenTelemetry",
      api: "API HTTP",
      none: "Non ancora collegato",
      // The SDK heartbeat's state (connection/watch.ts), when there is one.
      open: "SDK Python · collegato",
      lost: (since: string): string => `SDK Python · scollegato dal ${since}`,
      closed: (since: string): string => `SDK Python · chiuso il ${since}`,
    },
    newTitle: "Nuovo sistema",
    displayNameLabel: "Nome",
    displayNamePlaceholder: "Assistente vendite",
    nameLabel: "Identificativo",
    namePlaceholder: "assistente-vendite",
    submit: "Crea sistema",
    nameRequired: "Scrivi un nome o un identificativo.",
    exists: "Esiste già un sistema con questo identificativo.",
    deleted: (systemId: string): string => `${systemId} è stato eliminato.`,
  },
  // A new system's key, or a new key for one, and the three ways to connect an agent.
  connect: {
    ready: (name: string): string => `${name} è pronto`,
    newKey: (name: string): string => `Nuova chiave per ${name}`,
    heading: "Collega il tuo agente",
    title: (name: string): string => `Collega ${name}`,
    ways: { python: "SDK Python", model: "Modello AI" },
    modelStep1: "Salva la chiave OpenAI, Anthropic o Gemini in Gestisci, nel blocco “Modello AI”.",
    modelStep2: "Collega il modello dell'agente a sigillo, con la chiave del sistema:",
    pasteAtTop: "Incolla questo all'inizio del file Python del tuo agente:",
    keyPlaceholder: "<la-chiave-del-sistema>",
    waiting: "In attesa della prima ricevuta…",
    check: "Controlla",
    arrived: (when: string): string => `Prima ricevuta arrivata: ${when}`,
    goToSystem: "Vai al sistema",
    upload: {
      drop: "Carica il file .py del tuo agente",
      done: "{file} scaricato, con sigillo già dentro. Avvia l'agente come sempre: la prima volta installa da solo quello che serve.",
      doneNoFramework:
        "{file} scaricato, con sigillo già dentro, che la prima volta si installa da solo. Non usa LangChain, CrewAI né OpenAI: sigillo registra quando è collegato e le azioni che registri tu.",
      already: "{file} usa già sigillo: non c'è niente da aggiungere.",
      notPython: "Scegli il file Python dell'agente (.py, fino a 1 MB).",
      or: "oppure",
    },
  },
  manage: {
    nameTitle: "Nome",
    nameLabel: "Nome mostrato",
    nameSubmit: "Salva",
    renamed: "Nome salvato.",
    idTitle: "Identificativo",
    keyTitle: "Chiave",
    keyLabel: "Chiave attuale",
    noKey: "Nessuna chiave attiva",
    newKey: "Nuova chiave",
    newKeyConfirm: "La chiave attuale smette di funzionare subito.",
    newKeySubmit: "Crea nuova chiave",
    connect: "Come collegare l'agente",
    modelTitle: "Modello AI",
    modelProvider: "Fornitore",
    modelKeyLabel: "Chiave API del fornitore",
    modelKeyInvalid: "Questa non sembra una chiave API: niente è stato salvato.",
    modelSave: "Salva",
    modelRemove: "Rimuovi",
    modelSaved: "Chiave del modello salvata.",
    modelRemoved: "Chiave del modello rimossa.",
    archiveTitle: "Archivia",
    archiveSubmit: "Archivia sistema",
    archived: "Sistema archiviato.",
    archivedOn: (when: string): string => `Archiviato il ${when}.`,
    unarchiveSubmit: "Riattiva",
    unarchived: "Sistema riattivato.",
    deleteTitle: "Elimina",
    deleteConfirmLabel: (systemId: string): string => `Scrivi ${systemId} per confermare`,
    deleteSubmit: "Elimina definitivamente",
    deleteRefused: (receipts: number): string =>
      `Contiene ${receipts - 1} ${receipts - 1 === 1 ? "azione registrata" : "azioni registrate"}: si può solo archiviare.`,
    confirmMismatch: "Il testo scritto non corrisponde all'identificativo del sistema: niente è stato eliminato.",
  },
  settings: {
    title: "Impostazioni",
    heading: "Impostazioni",
    account: "Account",
    operator: "Amministratore",
    operatorDetail: "Accesso con la password dell'installazione",
    organization: "Organizzazione",
    systems: (count: number): string => `${count} ${count === 1 ? "sistema" : "sistemi"}`,
    quota: (used: string, limit: string): string => `${used} di ${limit} ricevute questo mese`,
    noLimit: (used: string): string => `${used} ricevute questo mese`,
    appearance: "Aspetto",
    themes: { light: "Chiaro", dark: "Scuro", system: "Automatico" },
    themeLabel: "Tema",
    adminLog: "Registro amministrativo",
    adminLogAll: "Vedi tutto",
    adminLogEmpty: "Nessuna operazione ancora.",
    signingKey: "Chiave di firma",
    dailyExport: {
      heading: "Esportazione giornaliera",
      on: "Attiva",
      off: "Spenta",
      stateOn: "Ogni giorno alle 23:59",
      stateOff: "Spenta.",
      empty: "Nessun file ancora.",
      download: "Scarica",
      size: (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`),
    },
  },
  history: {
    anchored: "Sigillata",
    anchorPending: "In attesa",
    noMatches: "Nessuna ricevuta.",
    searchButton: "Cerca",
    searchTitle: "Cerca",
    fromLabel: "Dal",
    toLabel: "Al",
    nameLabel: "Nome azione",
    // The filter by kind, one segment each, with "Tutte" first.
    filterLabel: "Filtra per tipo",
    allKinds: "Tutte",
    kinds: {
      tool_call: "Strumenti",
      llm_call: "Modelli",
      agent_step: "Passi",
      decision: "Decisioni",
      genesis: "Apertura",
    },
    listLabel: "Ricevute",
    clearFilters: "Togli i filtri",
    capped: "Le 200 più recenti",
    back: "Cronologia",
  },
  // The inspector: the receipt chosen in the history, in full.
  inspector: {
    label: "Dettaglio della ricevuta",
    receiptNo: (seq: number): string => `Ricevuta n. ${seq}`,
    genesisNote: "La prima ricevuta: da qui parte la catena.",
    agent: "Agente",
    onBehalfOf: "Per conto di",
    model: "Modello",
    when: "Quando",
    source: "Arrivata da",
    sources: {
      sdk: "SDK Python",
      otlp: "OpenTelemetry",
      api: "API HTTP",
      genesis: "sigillo",
    },
    files: "File",
    verifyFile: "Verifica",
    seal: "Sigillo",
    sealedAt: (when: string): string => `Sigillata ${when}`,
    sealWaiting: "In attesa",
    technical: "Dettagli tecnici",
    fingerprint: "Impronta",
    linkedTo: (seq: number): string => `Collegata alla ricevuta n. ${seq}`,
    first: "Prima ricevuta: nessuna precedente",
    signature: "Firma",
    key: "Chiave",
    timestamp: "Marca temporale",
    inputHash: "Impronta input",
    outputHash: "Impronta output",
    promptHash: "Impronta del prompt",
    replyHash: "Impronta della risposta",
    receivedIso: "Ricevuta (UTC)",
    eventIso: "Avvenuta (UTC, dichiarato dall'agente)",
    version: "Versione del formato",
  },
  // Where a receipt stands with its anchoring, in words (the inspector, the verify page).
  anchoring: {
    notCovered: "Non ancora sigillata",
    waiting: "Sigillata, marca temporale in attesa",
    unreadable: "Con marca temporale (ora non leggibile dal token)",
    at: (when: string): string => `Marca temporale del ${when}`,
  },
  checkpoints: {
    title: "Sigilli",
    none: "Nessun sigillo ancora.",
    sealed: (count: number): string => `${count} ${count === 1 ? "ricevuta sigillata" : "ricevute sigillate"}`,
    stamped: "Marca temporale",
    waiting: "In attesa",
    written: "Scritto",
    root: "Radice Merkle",
    attested: "Ora attestata dall'autorità",
    authority: "Autorità",
    genTimeUnreadable: "non leggibile dal token",
  },
  verifyDocument: {
    title: "Verifica documento",
    heading: "Verifica documento",
    textLabel: "oppure incolla il testo",
    submit: "Verifica",
    // Shown until the page's script runs, and so left on screen when the
    // browser does not run it (a CSP that no longer matches, say): the button
    // stays disabled then, instead of doing nothing without a word (session 6).
    scriptInactive:
      "Il browser non ha eseguito il calcolo dell'impronta, quindi Verifica è disattivato. Ricarica la pagina; se resta così, chi gestisce sigillo deve aggiornare con deploy/update.sh.",
    computeFailed: "Non è stato possibile leggere il documento scelto. Sceglilo di nuovo e premi Verifica.",
    browserError: "Errore del browser",
    resultTitle: "Risultato",
    placeholder: "Il risultato apparirà qui.",
    searchedFingerprint: "Impronta esatta (SHA-256)",
    textFingerprint: "Impronta del testo (sigillo-text/1)",
    noTextFingerprint: "nessuna: non è un testo in UTF-8",
    fromFile: "Calcolate dal browser sul file scelto.",
    fromText: "Calcolate dal browser sul testo incollato.",
    noMatch: "Nessuna azione registrata ha usato questo documento.",
    noMatchHint:
      "Un testo registrato prima della versione 3 si trova solo se coincide byte per byte, a meno del modo di andare a capo. Per un PDF o un'immagine conta ogni byte. Puoi confrontare l'impronta esatta con quella del file: Get-FileHash su Windows, sha256sum su Linux, shasum -a 256 su Mac.",
    match: {
      bytes: "Identico",
      text: "Stesso testo",
      lines: "Identico, a capo a parte",
      json: "Stesso contenuto",
      "json-lines": "Stesso contenuto, a capo a parte",
    },
    usedBy: (system: string, when: string, action: string): string => `Usato da ${system} ${when}, nell'azione ${action}.`,
    seeReceipt: "Vedi la ricevuta",
    found: "Trovato nel registro",
    notFound: "Non trovato",
    technical: "Dettagli tecnici",
    documentLabel: "Documento da verificare",
    dropTitle: "Trascina qui un file",
    dropHint: "oppure sceglilo",
    notModified: "Non è stato modificato",
  },
  // The words inside the connection snippets that are not code.
  // The two languages, each always named in its own words.
  languages: { en: "English", it: "Italiano" },
  languageLabel: "Lingua",
};

export type Strings = typeof ui;

/** Ollama, vLLM and llama.cpp run on the caller's own machine; the rest do not. */
const LOCAL_PROVIDERS = new Set(["ollama", "vllm", "llama.cpp", "llamacpp"]);

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider.toLowerCase());
}

/** The kinds of match the store reports, strongest first (store.ts, DocumentMatchKind). */
export type MatchKind = "bytes" | "text" | "lines" | "json" | "json-lines";

/** A match of the "verifica un documento" page, with its time already in words. */
export interface DocumentMatch {
  kind: MatchKind;
  system_id: string;
  display_name?: string | null;
  when: string;
  label: string | null;
  action_name: string;
  role: string;
  text_canon?: string | null;
}

/** One entry of the administrative log, without its time or who did it. */
export interface AdminAction {
  action: string;
  system_id: string;
  detail: Record<string, unknown>;
}

const ADMIN_ACTIONS: Record<string, string> = {
  "system.rename": "nome cambiato",
  "system.archive": "archiviato",
  "system.unarchive": "riattivato",
  "system.delete": "eliminato",
  "signer.init": "registrato nello stato del firmatario",
  "signer.recovered": "ricevuta recuperata dal firmatario",
  "signer.divergence": "in disaccordo con il firmatario",
  "subject.erase": "interessato cancellato",
  "openings.erase": "nonce cancellati",
  "organization.create": "organizzazione creata",
  "organization.approve": "organizzazione approvata",
  "user.register": "nuova registrazione",
  "system.assign": "assegnato a un'organizzazione",
};

/** The server's own receipts for the SDK heartbeat (connection/watch.ts): a title and a sentence each. */
const CONNECTION_TEXTS: Record<string, { title: string; sentence: string }> = {
  "sigillo.connection.start": { title: "Agente collegato", sentence: "L'agente si è collegato a sigillo e manda il segnale di vita." },
  "sigillo.connection.stop": { title: "Agente chiuso normalmente", sentence: "Il programma dell'agente è stato chiuso normalmente." },
  "sigillo.connection.lost": {
    title: "Collegamento interrotto",
    sentence:
      "L'agente ha smesso di mandare il segnale di vita senza chiudersi: codice di sigillo rimosso, programma interrotto, " +
      "computer spento o rete assente. L'ora dell'evento è quella dell'ultimo segnale ricevuto.",
  },
  "sigillo.connection.restored": { title: "Collegamento ripreso", sentence: "L'agente ha ripreso a mandare il segnale di vita dopo un'interruzione." },
};

const KIND_LABELS: Record<Receipt["action"]["kind"], string> = {
  tool_call: "strumento",
  llm_call: "modello",
  agent_step: "passo",
  decision: "decisione",
  genesis: "apertura registro",
};

const OUTCOME_WORDS: Record<Receipt["outcome"], string> = {
  ok: "completato",
  error: "fallito",
  blocked: "bloccato",
  unknown: "esito sconosciuto",
};

function modelLocale(provider: string | null): string {
  if (provider === null) return "";
  return isLocalProvider(provider) ? " (locale)" : ` (${provider})`;
}

function onBehalfOfClause(onBehalfOf: string | undefined): string {
  return onBehalfOf === undefined ? "" : ` per conto di «${onBehalfOf}»`;
}

function modelWhere(provider: string | null): string | null {
  if (provider === null) return null;
  return isLocalProvider(provider) ? `in locale, con ${provider}` : provider;
}

/** A whole number of minutes as a person says it: "90 minuti", "1 ora", "24 ore", "2 giorni". */
function durationWords(minutes: number): string {
  if (minutes >= 2880 && minutes % 1440 === 0) return `${minutes / 1440} giorni`;
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? "1 ora" : `${minutes / 60} ore`;
  return minutes === 1 ? "1 minuto" : `${minutes} minuti`;
}

const actions = (total: number): string => `${total} azion${total === 1 ? "e" : "i"}`;
const recorded = (total: number): string => `${actions(total)} registrat${total === 1 ? "a" : "e"}`;

export const IT = {
  ui,
  numberLocale: "it-IT",
  months: ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"],
  monthNames: [
    "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
    "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
  ],
  weekdays: ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"],
  today: "Oggi",
  yesterday: "Ieri",
  /** A time in the middle of a sentence: "oggi alle 14:44", "il 29 set 2026 alle 18:03". */
  inlineWhen: (relative: string | null, date: string, time: string): string =>
    relative !== null ? `${relative.toLowerCase()} alle ${time}` : `il ${date} alle ${time}`,
  kindLabels: KIND_LABELS,
  outcomeWords: OUTCOME_WORDS,
  modelWhere,
  durationWords,

  /**
   * The one sentence a non-technical reader sees for a receipt. Every action
   * kind has its own shape; every outcome changes the verb or the ending, never
   * just an appended code. Genesis is the one kind with no outcome clause: it
   * is definitionally the chain's own "completato".
   */
  describeReceipt(receipt: Receipt): string {
    const { action, actor, outcome } = receipt;
    const ok = outcome === "ok";
    const onBehalfOf = onBehalfOfClause(actor.on_behalf_of);
    const model = receipt.v !== 1 ? receipt.model : undefined;
    const connection = CONNECTION_TEXTS[action.name];
    if (connection !== undefined) return connection.sentence;

    if (action.kind === "genesis") {
      return `Il sistema «${action.name}» ha aperto il registro.`;
    }

    let sentence: string;
    switch (action.kind) {
      case "tool_call": {
        const verb = ok ? "ha usato lo strumento" : "ha tentato lo strumento";
        sentence = `L'agente «${actor.agent}» ${verb} «${action.name}»${onBehalfOf}`;
        break;
      }
      case "llm_call": {
        if (model !== undefined) {
          const verb = ok ? "ha generato una risposta" : "non ha portato a termine la richiesta";
          sentence = `Il modello «${model.name}»${modelLocale(model.provider)} ${verb}`;
        } else {
          const verb = ok ? "ha chiamato il modello" : "ha tentato di chiamare il modello";
          sentence = `L'agente «${actor.agent}» ${verb} «${action.name}»${onBehalfOf}`;
        }
        break;
      }
      case "decision": {
        const verb = ok ? "è stata presa" : "è stata tentata";
        sentence = `La decisione «${action.name}»${onBehalfOf} ${verb}`;
        break;
      }
      default: {
        // agent_step
        const verb = ok ? "ha eseguito il passo" : "ha tentato il passo";
        sentence = `L'agente «${actor.agent}» ${verb} «${action.name}»${onBehalfOf}`;
      }
    }

    return `${sentence} — ${OUTCOME_WORDS[outcome]}.`;
  },

  /** What a document was to the action: "usato in input" or "prodotto in output". */
  artifactRoleWords: (role: "input" | "output"): string => (role === "input" ? "usato in input" : "prodotto in output"),

  /**
   * The short title of a receipt in the history's list ("Ha usato «cerca_ordine»").
   * The full sentence is describeReceipt's, in the inspector; the outcome is
   * shown beside the title whenever it is not "completato".
   */
  receiptTitle(receipt: Receipt): string {
    const { action } = receipt;
    const connection = CONNECTION_TEXTS[action.name];
    if (connection !== undefined) return connection.title;
    const model = receipt.v !== 1 ? receipt.model : undefined;
    switch (action.kind) {
      case "genesis":
        return "Registro aperto";
      case "tool_call":
        return `${receipt.outcome === "ok" ? "Ha usato" : "Ha tentato"} «${action.name}»`;
      case "llm_call":
        return model !== undefined ? `Risposta da «${model.name}»` : `Chiamata a «${action.name}»`;
      case "decision":
        return `Decisione «${action.name}»`;
      default:
        return `Passo «${action.name}»`;
    }
  },

  /** The line under a receipt's title: the agent, where its model ran, on whose behalf, which files. */
  receiptSubtitle(receipt: Receipt): string {
    if (receipt.action.kind === "genesis") return `Apertura del registro di ${receipt.action.name}`;
    const parts = [receipt.actor.agent];
    const model = receipt.v !== 1 ? receipt.model : undefined;
    const where = model === undefined ? null : modelWhere(model.provider);
    if (where !== null) parts.push(`modello ${where}`);
    if (receipt.actor.on_behalf_of !== undefined) parts.push(`per conto di ${receipt.actor.on_behalf_of}`);
    if (receipt.v !== 1) for (const artifact of receipt.artifacts ?? []) parts.push(artifact.label);
    return parts.join(" · ");
  },

  /** The one sentence the "verifica un documento" page shows for a match, by its kind. */
  describeDocumentMatch(match: DocumentMatch): string {
    const who =
      match.display_name === undefined || match.display_name === null
        ? match.system_id
        : `«${match.display_name}» (sistema ${match.system_id})`;
    const when = match.when;
    const used = `da ${who} il ${when}, come «${match.label ?? ""}», nell'azione ${match.action_name} (${match.role})`;
    const lineEndings = "a meno del modo di andare a capo (Windows o Mac e Linux), dell'a capo finale o del segno BOM iniziale";
    switch (match.kind) {
      case "bytes":
        return `✓ Questo documento è esattamente quello usato ${used}. ${ui.verifyDocument.notModified}.`;
      case "text":
        return (
          `✓ Questo documento ha lo stesso testo di quello usato ${used}: i due differiscono al più per spazi, ` +
          `a capo e caratteri di formattazione invisibili (regola ${match.text_canon ?? "sigillo-text/1"}). I byte non sono identici.`
        );
      case "lines":
        return `✓ Questo documento è quello usato ${used}, ${lineEndings}. Tutto il resto è identico.`;
      case "json":
        return `✓ Il testo di questo documento è esattamente l'intero ${match.role} dell'azione ${match.action_name}, registrata da ${who} il ${when}.`;
      case "json-lines":
        return `✓ Il testo di questo documento è l'intero ${match.role} dell'azione ${match.action_name}, registrata da ${who} il ${when}, ${lineEndings}.`;
    }
  },

  /** What one entry of the administrative log did, without its time or who did it. */
  describeAdminAction(entry: AdminAction): string {
    const what = ADMIN_ACTIONS[entry.action] ?? entry.action;
    if (entry.action === "subject.erase") return `${what}: pseudonimo ${String(entry.detail["token"])}`;
    if (entry.action === "organization.create" || entry.action === "organization.approve" || entry.action === "user.register") {
      return `${what}: ${String(entry.detail["organization_id"])}`;
    }
    let extra = "";
    if (entry.action === "system.rename") {
      const name = (value: unknown): string => (typeof value === "string" ? `«${value}»` : "nessun nome");
      extra = `: da ${name(entry.detail["from"])} a ${name(entry.detail["to"])}`;
    }
    if (entry.action === "system.assign") {
      const whose = (value: unknown): string => (typeof value === "string" ? value : "solo l'operatore");
      extra = `: da ${whose(entry.detail["from"])} a ${whose(entry.detail["to"])}`;
    }
    if (entry.action === "openings.erase") {
      const seqs = Array.isArray(entry.detail["seqs"]) ? entry.detail["seqs"].join(", ") : "";
      extra = ` per le ricevute ${seqs} (${String(entry.detail["erased"])})`;
    }
    return `${entry.system_id} ${what}${extra}`;
  },

  // A chain's health in a sentence (health/chain-health.ts), the durations already in words.
  health: {
    linkBroken: (seq: number): string => `la ricevuta seq ${seq} non collega alla precedente`,
    signatureInvalid: (seq: number): string => `la firma della ricevuta seq ${seq} non è valida`,
    failed: (detail: string | null): string => `Verifica fallita: ${detail ?? "la catena non torna"}.`,
    signerDown:
      "Il firmatario non risponde: nessuna nuova azione può essere registrata finché non torna. " +
      "Le ricevute già scritte non cambiano.",
    divergence:
      "Il firmatario e il database non concordano su questo registro: nessuna correzione automatica, " +
      "il dettaglio è nel registro amministrativo.",
    noActions: "Nessuna azione registrata ancora.",
    firstComing: (total: number, within: string): string =>
      `Registro integro. ${recorded(total)}, primo sigillo in arrivo entro ${within}.`,
    sealed: (total: number, when: string, stampComing: boolean): string =>
      `Registro integro. ${recorded(total)}, ultimo sigillo del ${when}${stampComing ? ", marca temporale in arrivo" : ""}.`,
    notSealed: (over: string): string => `non è ancora stato sigillato, da oltre ${over}`,
    stampMissing: (over: string): string => `manca la marca temporale da oltre ${over}`,
    stampLate: (late: string, limit: string): string =>
      `l'ultima marca temporale è arrivata ${late} dopo il sigillo, oltre il limite di ${limit}`,
    idle: (over: string): string => `nessuna nuova azione da oltre ${over}`,
    disconnected: (since: string): string => `l'agente è scollegato dal ${since}`,
    attention: (total: number, reasons: string[]): string => `Registro integro (${actions(total)}), ma ${reasons.join(" e ")}.`,
  },
};

export type Texts = typeof IT;
