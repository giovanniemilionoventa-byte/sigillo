import type { Receipt } from "@sigillo/core";

/**
 * Every piece of Italian text the web view shows, in one place, so that
 * adding a second language later means adding a second file like this one,
 * not hunting through every page.
 *
 * The two functions here (`describeReceipt`, `describeArtifact`) are text
 * too — sentence templates rather than fixed strings — and belong here for
 * the same reason: they are what a reader without a technical background
 * sees instead of raw fields.
 */

export const UI = {
  nav: {
    registro: "Registro",
    sistemi: "Sistemi",
    persone: "Persone",
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
    keyLabel: "Chiave del sistema",
    keyNote: "La vedi solo ora: copiala e conservala.",
    heading: "Collega il tuo agente",
    title: (name: string): string => `Collega ${name}`,
    ways: { python: "SDK Python", otel: "OpenTelemetry", api: "API HTTP" },
    recommended: "Consigliato",
    keyPlaceholder: "<la-chiave-del-sistema>",
    waiting: "In attesa della prima ricevuta…",
    check: "Controlla",
    arrived: (when: string): string => `Prima ricevuta arrivata: ${when}`,
    goToSystem: "Vai al sistema",
  },
  people: {
    title: "Persone",
    heading: "Persone",
    searchLabel: "Identificativo della persona",
    searchPlaceholder: "cliente-4821",
    searchSubmit: "Cerca",
    notFound: "Nessuna ricevuta per questa persona.",
    receipts: (count: number): string => `${count} ${count === 1 ? "ricevuta" : "ricevute"}`,
    eraseTitle: "Cancella la persona",
    eraseHint: "Le ricevute restano valide, ma non si potranno più collegare a lei.",
    eraseConfirm: (token: string): string => `Scrivi ${token} per confermare`,
    eraseSubmit: "Cancella definitivamente",
    erased: (token: string): string => `Fatto: ${token} non è più collegabile a nessuna persona.`,
    confirmMismatch: "Il testo scritto non corrisponde allo pseudonimo: niente è stato cancellato.",
    legacy: (count: number): string =>
      `${count} ${count === 1 ? "ricevuta scritta" : "ricevute scritte"} prima di ottobre 2026 ${count === 1 ? "contiene" : "contengono"} questo identificativo in chiaro, e nessuna cancellazione le raggiunge.`,
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
    privacyNote: "Il documento non lascia il tuo computer.",
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
} as const;

/** The kinds of match the store reports, strongest first (store.ts, DocumentMatchKind). */
type MatchKind = "bytes" | "text" | "lines" | "json" | "json-lines";

/** The one sentence the "verifica un documento" page shows for a match, by its kind. */
export function describeDocumentMatch(match: {
  kind: MatchKind;
  system_id: string;
  display_name?: string | null;
  ts_received: string;
  label: string | null;
  action_name: string;
  role: string;
  text_canon?: string | null;
}): string {
  const who =
    match.display_name === undefined || match.display_name === null
      ? match.system_id
      : `«${match.display_name}» (sistema ${match.system_id})`;
  const when = formatTs(match.ts_received);
  const used = `da ${who} il ${when}, come «${match.label ?? ""}», nell'azione ${match.action_name} (${match.role})`;
  const lineEndings = "a meno del modo di andare a capo (Windows o Mac e Linux), dell'a capo finale o del segno BOM iniziale";
  switch (match.kind) {
    case "bytes":
      return `✓ Questo documento è esattamente quello usato ${used}. ${UI.verifyDocument.notModified}.`;
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
}

const MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];

/**
 * The time zone every time on the web view is shown in. The server stores and
 * signs UTC, and the receipts, the exports and the technical details keep it;
 * only what a person reads on the page is turned into Italian time, so that a
 * receipt written at 19:55 in Rome does not read 17:55.
 */
export const DISPLAY_TIME_ZONE = "Europe/Rome";

const LOCAL_PARTS = new Intl.DateTimeFormat("it-IT", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

interface LocalTime {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  /** 0 (Sunday) to 6, as Date.getUTCDay counts. */
  weekday: number;
  time: string;
  /** "CEST" or "CET". */
  zone: string;
}

/** A server timestamp in DISPLAY_TIME_ZONE, or null for one that is not a full ISO time. */
function localTime(iso: string): LocalTime | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(iso)) return null;
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return null;
  const parts = new Map(LOCAL_PARTS.formatToParts(instant).map((part) => [part.type, part.value]));
  const year = Number(parts.get("year"));
  const month = Number(parts.get("month"));
  const day = Number(parts.get("day"));
  return {
    year,
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    time: `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`,
    zone: parts.get("timeZoneName") ?? DISPLAY_TIME_ZONE,
  };
}

/**
 * A server timestamp as a person reads it, in Italian time and to the second,
 * the zone named: "2 ott 2026, 19:54:37 CEST". The exact ISO form, in UTC,
 * stays in the technical details. Anything that does not parse is shown as it is.
 */
export function formatTs(iso: string): string {
  const local = localTime(iso);
  if (local === null) return iso;
  return `${local.day} ${MONTHS[local.month - 1]} ${local.year}, ${local.time} ${local.zone}`;
}

/**
 * The instants a calendar day ("2026-10-02") spans in DISPLAY_TIME_ZONE, as
 * the store compares them: from its local midnight to the last millisecond
 * before the next one, so a day the clocks change on is 23 or 25 hours long.
 */
export function localDayRange(date: string): { from: string; to: string } {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return {
    from: new Date(localMidnight(year, month, day)).toISOString(),
    to: new Date(localMidnight(year, month, day + 1) - 1).toISOString(),
  };
}

/** The instant of local midnight on a day; Date.UTC carries a day past the month's end. */
function localMidnight(year: number, month: number, day: number): number {
  const utcMidnight = Date.UTC(year, month - 1, day);
  // The zone's offset is read at the guess, then again at the result, so a
  // change of clock between the two is still caught. Italy changes at 02:00
  // or 03:00, never at midnight, so two reads settle it.
  let instant = utcMidnight - offsetAt(utcMidnight);
  instant = utcMidnight - offsetAt(instant);
  return instant;
}

/** How far DISPLAY_TIME_ZONE is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number): number {
  const local = localTime(new Date(instant).toISOString());
  if (local === null) return 0;
  const [hours, minutes, seconds] = local.time.split(":").map(Number) as [number, number, number];
  const asIfUtc = Date.UTC(local.year, local.month - 1, local.day, hours, minutes, seconds);
  return asIfUtc - Math.floor(instant / 1000) * 1000;
}

/** How a system is named for a reader: its label if it has one, else its system_id. */
export function systemTitle(system: { system_id: string; display_name: string | null }): string {
  return system.display_name ?? system.system_id;
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

/** What one entry of the administrative log did, without its time or who did it. */
export function describeAdminAction(entry: { action: string; system_id: string; detail: Record<string, unknown> }): string {
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
}

/** Who did it, as the log names them: "web <address>" or "web <email> (<organization>)" loses its "web ". */
export function adminActor(actor: string): string {
  return actor.replace(/^web /, "");
}

/** One line of the administrative log, whole: when, what, who. */
export function describeAdminEntry(entry: {
  ts: string;
  action: string;
  system_id: string;
  actor: string;
  detail: Record<string, unknown>;
}): string {
  return `${formatTs(entry.ts)} — ${describeAdminAction(entry)} (${entry.actor})`;
}

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

/** Ollama, vLLM and llama.cpp run on the caller's own machine; the rest do not. */
const LOCAL_PROVIDERS = new Set(["ollama", "vllm", "llama.cpp", "llamacpp"]);

function modelLocale(provider: string | null): string {
  if (provider === null) return "";
  return LOCAL_PROVIDERS.has(provider.toLowerCase()) ? " (locale)" : ` (${provider})`;
}

function onBehalfOfClause(onBehalfOf: string | undefined): string {
  return onBehalfOf === undefined ? "" : ` per conto di «${onBehalfOf}»`;
}

/**
 * The one sentence a non-technical reader sees for a receipt. Every action
 * kind has its own shape; every outcome changes the verb or the ending, never
 * just an appended code. Genesis is the one kind with no outcome clause: it
 * is definitionally the chain's own "completato".
 */
export function describeReceipt(receipt: Receipt): string {
  const { action, actor, outcome } = receipt;
  const ok = outcome === "ok";
  const onBehalfOf = onBehalfOfClause(actor.on_behalf_of);
  const model = receipt.v !== 1 ? receipt.model : undefined;

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
}

/** What a document was to the action: "usato in input" or "prodotto in output". */
export function artifactRoleWords(role: "input" | "output"): string {
  return role === "input" ? "usato in input" : "prodotto in output";
}

/** A readable label for an artifact, e.g. "curriculum (usato in input)". */
export function describeArtifact(role: "input" | "output", label: string): string {
  return `${label} (${artifactRoleWords(role)})`;
}

/** Where a model ran, for the history: "in locale, con ollama", or its provider; null when unknown. */
export function modelWhere(provider: string | null): string | null {
  if (provider === null) return null;
  return LOCAL_PROVIDERS.has(provider.toLowerCase()) ? `in locale, con ${provider}` : provider;
}

/**
 * The short title of a receipt in the history's list ("Ha usato «cerca_ordine»").
 * The full sentence is describeReceipt's, in the inspector; the outcome is
 * shown beside the title whenever it is not "completato".
 */
export function receiptTitle(receipt: Receipt): string {
  const { action } = receipt;
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
}

/** The line under a receipt's title: the agent, where its model ran, on whose behalf, which files. */
export function receiptSubtitle(receipt: Receipt): string {
  if (receipt.action.kind === "genesis") return `Apertura del registro di ${receipt.action.name}`;
  const parts = [receipt.actor.agent];
  const model = receipt.v !== 1 ? receipt.model : undefined;
  const where = model === undefined ? null : modelWhere(model.provider);
  if (where !== null) parts.push(`modello ${where}`);
  if (receipt.actor.on_behalf_of !== undefined) parts.push(`per conto di ${receipt.actor.on_behalf_of}`);
  if (receipt.v !== 1) for (const artifact of receipt.artifacts ?? []) parts.push(artifact.label);
  return parts.join(" · ");
}

const WEEKDAYS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const MONTH_NAMES = [
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
];

/** The day of a server timestamp, in Italian time, as a heading of the history: "martedì 29 settembre 2026". */
export function formatDay(iso: string): string {
  const local = localTime(iso);
  if (local === null) return iso;
  return `${WEEKDAYS[local.weekday]} ${local.day} ${MONTH_NAMES[local.month - 1]} ${local.year}`;
}

/** The time of a server timestamp, in Italian time, to the second: "12:40:13". */
export function formatTime(iso: string): string {
  return localTime(iso)?.time ?? iso;
}

/** The calendar day of an instant in Italian time, as "2026-10-01"; null for a time that does not parse. */
export function localDate(iso: string): string | null {
  const local = localTime(iso);
  if (local === null) return null;
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}

/** The calendar day before `date` ("2026-10-01" gives "2026-09-30"). */
function dayBefore(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** "Oggi", "Ieri", or null, for the day of `iso` seen from `now`, both in Italian time. */
function relativeDay(iso: string, now: Date): "Oggi" | "Ieri" | null {
  const day = localDate(iso);
  const today = localDate(now.toISOString());
  if (day === null || today === null) return null;
  if (day === today) return "Oggi";
  return day === dayBefore(today) ? "Ieri" : null;
}

/**
 * When something happened, as a person says it: "Oggi, 14:44", "Ieri,
 * 09:12", "29 set 2026, 18:03". Italian time, to the minute; the exact time
 * stays in the technical details.
 */
export function formatWhen(iso: string, now: Date): string {
  const local = localTime(iso);
  if (local === null) return iso;
  const time = local.time.slice(0, 5);
  const relative = relativeDay(iso, now);
  if (relative !== null) return `${relative}, ${time}`;
  return `${local.day} ${MONTHS[local.month - 1]} ${local.year}, ${time}`;
}

/** The same in the middle of a sentence: "oggi alle 14:44", "il 29 set 2026 alle 18:03". */
export function formatWhenInline(iso: string, now: Date): string {
  const local = localTime(iso);
  if (local === null) return iso;
  const time = local.time.slice(0, 5);
  const relative = relativeDay(iso, now);
  if (relative !== null) return `${relative.toLowerCase()} alle ${time}`;
  return `il ${local.day} ${MONTHS[local.month - 1]} ${local.year} alle ${time}`;
}

/** A day of the history, as its heading: "Oggi · giovedì 1 ottobre", "martedì 29 settembre 2026". */
export function formatDayHeading(iso: string, now: Date): string {
  const local = localTime(iso);
  if (local === null) return iso;
  const relative = relativeDay(iso, now);
  const day = `${WEEKDAYS[local.weekday]} ${local.day} ${MONTH_NAMES[local.month - 1]}`;
  return relative === null ? `${day} ${local.year}` : `${relative} · ${day}`;
}

/** A date alone, as "1 ott 2026". */
export function formatDate(iso: string): string {
  const local = localTime(iso);
  if (local === null) return iso;
  return `${local.day} ${MONTHS[local.month - 1]} ${local.year}`;
}

/** The time of an instant in Italian time, to the minute: "14:44". */
export function formatClock(iso: string): string {
  return localTime(iso)?.time.slice(0, 5) ?? iso;
}

const NUMBER = new Intl.NumberFormat("it-IT", { useGrouping: "always" });

/** A count as Italians write it: "10.000". */
export function formatCount(value: number): string {
  return NUMBER.format(value);
}

/** The one word for an outcome, as the receipt sentences already use it. */
export function outcomeWord(outcome: Receipt["outcome"]): string {
  return OUTCOME_WORDS[outcome];
}

export function actionKindLabel(kind: Receipt["action"]["kind"]): string {
  return KIND_LABELS[kind];
}
