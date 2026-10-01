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
    registro: "registro",
    sistemi: "sistemi",
    persone: "persone",
    verificaDocumento: "verifica documento",
    esci: "esci",
    label: "sezioni",
    allSystems: "Tutti i sistemi",
    tools: "Strumenti",
    menu: "Menu",
    close: "Chiudi",
  },
  brand: {
    tagline: "registro probatorio per agenti AI",
    skip: "Vai al contenuto",
    signingKey: "Ricevute e sigilli firmati con la chiave",
  },
  login: {
    label: "Password amministratore",
    submit: "Accedi",
    // The same words for a wrong password and for a lockout, on purpose: see
    // the login handler in ui.ts.
    wrong:
      "Accesso non riuscito. Controlla la password; dopo troppi tentativi sbagliati l'accesso resta sospeso per qualche minuto.",
    lead: "Inserisci la password amministratore per aprire il registro.",
    restricted: "Accesso riservato all'amministratore di questa installazione.",
    pitch: "Tre domande, una risposta sola: il registro.",
    // The three questions (UI.home.q1-q3) as the login page explains them.
    points: {
      q1: "Ogni registro viene verificato: integro, da controllare o non supera la verifica.",
      q2: "Strumenti, modelli, passi e decisioni, una ricevuta firmata per azione.",
      q3: "Un fascicolo .zip con ricevute, checkpoint e marche temporali.",
    },
  },
  home: {
    title: "sigillo",
    heading: "Il registro",
    q1: "È tutto a posto?",
    q2: "Cosa ha fatto l'AI?",
    q3: "Mi prepari le prove?",
    noSystems: "Nessun sistema ancora. Creane uno nella pagina «sistemi».",
    recentActivity: "Ultime azioni",
    // The main page's title: the situation in one sentence, by the worst state shown.
    summary: {
      none: "Nessun sistema scrive ancora in questo registro.",
      green: (count: number): string => (count === 1 ? "Il registro è integro." : `Tutti i ${count} registri sono integri.`),
      yellow: (count: number): string =>
        `Nessuna alterazione trovata; ${count === 1 ? "un sistema è" : `${count} sistemi sono`} da controllare.`,
      red: (count: number): string =>
        count === 1 ? "Un registro non supera la verifica." : `${count} registri non superano la verifica.`,
      lead: (count: number): string =>
        `Tre domande su ${count === 1 ? "un sistema" : `${count} sistemi`}: se il registro è intatto, cosa ha fatto l'AI, e come preparare le prove.`,
    },
    systemsCount: (count: number): string => `${count} ${count === 1 ? "sistema" : "sistemi"}`,
    actionsCount: (count: number): string => `${count} ${count === 1 ? "azione" : "azioni"}`,
    chooseSystem: "Sistema",
    fromDate: "Dal",
    toDate: "Al",
    wholeChain: "Lascia vuoto per l'intero registro.",
    generate: "Genera fascicolo",
    generateHint: "Uno .zip con le ricevute, i checkpoint, le marche temporali e il rapporto.",
    disclose: {
      summary: "Divulgazioni facoltative",
      hint:
        "Di norma il fascicolo non nomina nessuno e non apre nessuna impronta: le ricevute portano solo pseudonimi e impronte con sale. Compila questi campi solo se chi lo riceve deve sapere di più, e solo per ciò che serve.",
      subjectsLabel: "Nomina le persone dietro questi pseudonimi (psn_…, separati da spazi)",
      openingsLabel: "Includi i nonce delle impronte di queste ricevute (numeri, per esempio 4 7-9)",
      openingsHint:
        "Con un nonce, chi ha il contenuto può dimostrare che l'impronta è sua; ma chi ha il fascicolo può anche provare a indovinare un contenuto breve, come un punteggio o un esito.",
    },
    checkpointNow: "Sigilla adesso",
    checkpointHint:
      "Normalmente non serve: ogni sistema viene sigillato da solo a intervalli regolari. " +
      "Usa questo se non vuoi aspettare.",
    archivedHidden: (count: number): string =>
      `${count === 1 ? "Un sistema archiviato non è mostrato" : `${count} sistemi archiviati non sono mostrati`} qui: li trovi nella pagina «sistemi».`,
    archivedShownBecause: "archiviato, ma mostrato qui perché",
    archivedRed: "la verifica è fallita",
    archivedActive: "ha ricevuto azioni dopo l'archiviazione",
    archivedGroup: "archiviati",
    checkpointDone:
      "Fatto: ogni sistema con azioni nuove è stato sigillato. Se uno resta giallo, il sigillo " +
      "è scritto ma la marca temporale non è ancora arrivata — riprova tra poco.",
  },
  status: {
    green: "verde",
    yellow: "giallo",
    red: "rosso",
  },
  // A system's chain, in the header of its pages: the same check as the
  // traffic lights of the main page, in three words.
  chain: {
    green: "Registro integro",
    yellow: "Da controllare",
    red: "Verifica fallita",
  },
  system: {
    tabsLabel: "Sezioni del sistema",
    receipts: (count: number): string => `${count} ${count === 1 ? "ricevuta" : "ricevute"}`,
  },
  exportSheet: {
    title: (name: string): string => `Genera il fascicolo di ${name}`,
    period: "Periodo",
    cancel: "Annulla",
  },
  notFound: {
    title: "non trovato",
    heading: "Non trovato",
    system: (systemId: string): string => `Nessun sistema chiamato ${systemId}.`,
  },
  systemsPage: {
    title: "sistemi",
    heading: "Sistemi",
    eyebrow: "chi scrive nel registro",
    existing: "Sistemi esistenti",
    views: { attivi: "attivi", archiviati: "archiviati", tutti: "tutti" },
    noneInView: {
      attivi: "Nessun sistema attivo.",
      archiviati: "Nessun sistema archiviato.",
      tutti: "Nessun sistema ancora.",
    },
    archivedBadge: "archiviato",
    receipts: (count: number): string => `${count} ${count === 1 ? "ricevuta" : "ricevute"}`,
    onlyGenesis: "solo l'apertura del registro",
    lastActivity: "ultima attività",
    history: "cronologia",
    manage: "gestisci",
    columns: { system: "Sistema", state: "Stato", receipts: "Ricevute", last: "Ultima ricevuta", manage: "Gestisci" },
    active: "attivo",
    // How the latest action reached sigillo, from the receipt's source.type.
    connection: {
      sdk: "collegato con l'SDK",
      otlp: "collegato con OpenTelemetry",
      api: "collegato con l'API nativa",
      none: "nessuna azione ancora",
    },
    createTitle: "Crea un nuovo sistema",
    newSystem: "Nuovo sistema",
    nameLabel: "Identificativo del sistema",
    namePlaceholder: "acme-support-bot",
    displayNameLabel: "Nome mostrato (facoltativo)",
    idHint:
      "L'identificativo entra in ogni ricevuta, chiave ed export e non cambierà mai. Il nome mostrato si potrà scegliere e cambiare dopo, in «gestisci».",
    submit: "Crea sistema e chiave",
    createdTitle: "Sistema creato",
    tokenWarning:
      "Questo è l'unico momento in cui la chiave viene mostrata. Copiala ora: non potrà essere recuperata di nuovo.",
    howToConnect: "Come collegare un chatbot o un agente",
    howToConnectIntro:
      "Tre modi reali per mandare qui le azioni di un agente. Usa quello più comodo per il tuo codice: non serve usarli tutti e tre.",
    connectPython: {
      title: "1. SDK Python",
      hint:
        "La via più rapida per un agente già scritto con LangChain, CrewAI, o un client OpenAI diretto (anche verso un server compatibile locale, come Ollama o vLLM). instrument accetta 'langchain', 'crewai' e 'openai': ciascuno richiede il proprio pacchetto opzionale (pip install -e 'sdk-python[langchain,crewai,openai]'); quello mancante viene saltato con un avviso, non un errore. Dettagli in sdk-python/README.md.",
    },
    connectOtlp: {
      title: "2. Endpoint OTLP diretto",
      hint:
        "Per chi emette già tracce OpenTelemetry, in qualsiasi linguaggio: punta il suo esportatore OTLP/HTTP a questo indirizzo, con la chiave come intestazione Bearer. Non serve nessuna libreria di sigillo. Esempio minimo con curl, senza nessuna libreria OpenTelemetry, solo per mostrare il formato:",
    },
    connectNative: {
      title: "3. Endpoint nativo per ricevute",
      hint:
        "Per codice senza OpenTelemetry: una richiesta JSON per ogni ricevuta, in qualsiasi linguaggio che sappia fare una chiamata HTTP.",
    },
    connectMore: "Tutti e tre i modi sono documentati con altri esempi in docs/API.md.",
    deleted: (systemId: string): string =>
      `Il sistema ${systemId} è stato eliminato. L'operazione è scritta nel registro amministrativo.`,
    adminLogTitle: "Registro amministrativo",
    adminLogHint:
      "Rinomine, archiviazioni ed eliminazioni di sistemi, cancellazioni di interessati e di nonce: chi, quando, cosa. È fuori dalle catene, e come loro non si modifica.",
    adminLogEmpty: "Nessuna operazione ancora.",
  },
  people: {
    title: "persone",
    heading: "Persone",
    eyebrow: "per conto di chi ha agito l'AI",
    intro:
      "Le ricevute non contengono nomi: al posto di chi ha ordinato un'azione c'è uno pseudonimo (psn_…). Quale persona c'è dietro ciascuno è scritto in una tabella a parte, fuori dal registro, che si può cancellare.",
    searchLabel: "Identificativo della persona",
    searchSubmit: "Cerca",
    notFound:
      "Nessuno pseudonimo per questo identificativo: la persona non compare in nessuna ricevuta, oppure è già stata cancellata.",
    tokenLabel: "Pseudonimo",
    receipts: (count: number): string =>
      count === 0
        ? "Nessuna ricevuta con questo pseudonimo."
        : `${count} ${count === 1 ? "ricevuta" : "ricevute"} con questo pseudonimo, dalla più recente`,
    eraseTitle: "Cancella l'interessato",
    eraseHint:
      "Elimina la corrispondenza tra questa persona e il suo pseudonimo. Le ricevute restano valide e verificabili, ma nessuno potrà più collegarle a lei; se tornasse, avrebbe uno pseudonimo nuovo. Nel registro amministrativo resta solo lo pseudonimo. L'operazione non si annulla. I backup fatti prima conservano la corrispondenza finché non vengono sostituiti.",
    eraseConfirm: (token: string): string => `Per confermare, scrivi lo pseudonimo esatto: ${token}`,
    eraseSubmit: "Cancella definitivamente",
    erased: (token: string): string =>
      `Fatto: le ricevute con lo pseudonimo ${token} non sono più collegabili a nessuna persona. L'operazione è nel registro amministrativo.`,
    confirmMismatch: "Il testo scritto non corrisponde allo pseudonimo: niente è stato cancellato.",
  },
  manage: {
    nameTitle: "Nome mostrato",
    nameLabel: "Nome",
    nameHint: (systemId: string): string =>
      `È solo un'etichetta per questa interfaccia. L'identificativo ${systemId} resta lo stesso in ricevute, chiavi ed export, e un fascicolo già esportato conserva il nome che aveva. Lascia vuoto per mostrare l'identificativo.`,
    nameSubmit: "Salva il nome",
    renamed: "Nome salvato.",
    archiveTitle: "Archiviazione",
    archiveHint:
      "Un sistema archiviato esce dalla pagina principale e dall'elenco dei sistemi attivi. Il suo registro resta intero: consultabile, esportabile e verificabile. Le sue chiavi API smettono di funzionare, quindi l'agente non può scrivere nuove ricevute; si può riattivare in ogni momento, senza rigenerare le chiavi.",
    archiveSubmit: "Archivia",
    archived: "Sistema archiviato.",
    archivedOn: "Archiviato il",
    unarchiveSubmit: "Riattiva",
    unarchived: "Sistema riattivato.",
    deleteTitle: "Eliminazione",
    deleteAllowed:
      "Questo sistema ha solo la ricevuta di apertura del registro: nessuna azione è mai stata registrata. Si può eliminare per davvero, con i suoi sigilli e le sue chiavi API. L'operazione non si annulla, viene scritta nel registro amministrativo, e l'identificativo non potrà essere riusato.",
    deleteConfirmLabel: (systemId: string): string => `Per confermare, scrivi l'identificativo esatto: ${systemId}`,
    deleteSubmit: "Elimina definitivamente",
    deleteRefused: (receipts: number): string =>
      `Questo sistema non si può eliminare: il suo registro contiene ${receipts - 1} ${receipts - 1 === 1 ? "azione registrata" : "azioni registrate"} oltre all'apertura. Le prove registrate non si cancellano, da nessuna parte e con nessuna conferma. Se non serve più, archivialo.`,
    confirmMismatch:
      "Il testo scritto non corrisponde all'identificativo del sistema: niente è stato eliminato.",
  },
  history: {
    anchored: "Ancorata",
    anchorPending: "In attesa",
    noMatches: "Nessuna ricevuta corrisponde ai filtri scelti.",
    searchButton: "Cerca",
    searchTitle: "Cerca e filtra",
    fromLabel: "dal (ricevuto)",
    toLabel: "al",
    nameLabel: "nome azione",
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
    shown: (count: number, capped: boolean): string =>
      `${count} ricevut${count === 1 ? "a" : "e"}${capped ? " (le 200 più recenti)" : ""}`,
    listLabel: "Ricevute",
    clearFilters: "Togli i filtri",
    noMatchesHint: "Prova un altro tipo o togli il periodo.",
    dayUtc: (day: string): string => `${day} · ore UTC`,
    back: "Torna all'elenco",
  },
  // The inspector: the receipt chosen in the history, in full.
  inspector: {
    label: "Dettaglio della ricevuta",
    receiptNo: (seq: number): string => `Ricevuta n. ${seq}`,
    genesisNote:
      "È la prima ricevuta del registro: da qui parte la catena. Non c'è una ricevuta precedente, quindi l'impronta precedente è tutta a zeri.",
    whoWhen: "Chi e quando",
    kind: "Tipo",
    agent: "Agente",
    onBehalfOf: "Per conto di",
    model: "Modello",
    received: "Ricevuta il",
    source: "Arrivata da",
    sources: {
      sdk: "SDK",
      otlp: "OpenTelemetry (OTLP)",
      api: "API nativa",
      genesis: "sigillo, alla creazione del sistema",
    },
    files: "File",
    verifyFile: "Verifica",
    chain: "Catena",
    fingerprint: "Impronta",
    linkedTo: "Collegata a",
    first: "Nessuna: è la prima",
    anchoring: "Ancoraggio",
    anchoredNote: "Sigillata in un checkpoint con marca temporale.",
    seeCheckpoints: "Vedi checkpoint",
    showTechnical: "Mostra firma, chiave e impronte complete",
    hideTechnical: "Nascondi i dettagli tecnici",
    signature: "Firma",
    key: "Chiave",
    inputHash: "Impronta input",
    outputHash: "Impronta output",
    promptHash: "Impronta del prompt",
    replyHash: "Impronta della risposta",
    receivedIso: "Ricevuto (ISO)",
    eventIso: "Avvenuto (ISO, dichiarato dall'agente)",
    version: "Versione del formato",
  },
  // Where a receipt stands with its anchoring, in words (also on the verify page).
  anchoring: {
    notCovered: "non ancora coperto da un checkpoint",
    waiting: "checkpoint scritto, marca temporale in attesa",
    unreadable: "con marca temporale (ora attestata non leggibile dal token)",
    at: (when: string): string => `con marca temporale del ${when}`,
  },
  checkpoints: {
    title: "checkpoint",
    none: "Nessun checkpoint ancora.",
    explain:
      "Ogni checkpoint sigilla tutte le ricevute scritte fino a quel momento; la marca temporale di un'autorità esterna dice quando esistevano.",
    waiting: "in attesa di marca temporale",
    genTimeUnreadable: "ora attestata non leggibile dal token",
    receivedAt: "ricevuta dal server il",
    covered: "ricevute coperte",
    written: "Scritto il",
    root: "Radice Merkle",
    stamped: "Marca temporale ricevuta",
    attested: "Ora attestata dall'autorità",
  },
  verifyDocument: {
    title: "verifica un documento",
    heading: "Verifica un documento",
    eyebrow: "è quello che ha usato l'AI?",
    privacyNote: "Il documento non lascia il tuo computer: calcoliamo solo le sue impronte.",
    textLabel: "oppure incolla il testo",
    textNote:
      "Per un testo contano le parole, non l'impaginazione: spazi, a capo e caratteri invisibili in più o in meno non cambiano il risultato. Per un PDF o un'immagine carica il file: lì conta ogni byte.",
    submit: "Verifica",
    // Shown until the page's script runs, and so left on screen when the
    // browser does not run it (a CSP that no longer matches, say): the button
    // stays disabled then, instead of doing nothing without a word (session 6).
    scriptInactive:
      "Il calcolo dell'impronta non è attivo in questa pagina: il browser non ha eseguito lo script che lo fa, quindi il pulsante Verifica è disattivato. Ricarica la pagina; se il messaggio resta, chi gestisce sigillo deve aggiornare con deploy/update.sh, che riavvia anche Caddy (docs/DEPLOY-PRODUZIONE.md, 6.3).",
    computeFailed:
      "Non è stato possibile calcolare l'impronta del documento scelto. Il risultato che era sulla pagina è stato tolto, perché riguardava un tentativo precedente e non questo documento. Se il file è stato modificato, spostato o salvato di nuovo dopo averlo scelto, sceglilo di nuovo e premi Verifica.",
    browserError: "Errore del browser",
    resultTitle: "Risultato",
    searchedFingerprint: "Impronta esatta (SHA-256)",
    textFingerprint: "Impronta del testo (sigillo-text/1)",
    noTextFingerprint: "nessuna: non è un testo in UTF-8",
    fromFile: "Calcolate dal browser sul file scelto.",
    fromText: "Calcolate dal browser sul testo incollato nella casella.",
    noMatch:
      "Nessuna azione registrata ha usato questo documento, né una sua copia che differisca solo per spazi o a capo.",
    noMatchHint:
      "Un testo registrato prima di questa versione di sigillo si trova solo se coincide byte per byte, a meno del modo di andare a capo. Per un PDF o un'immagine conta ogni byte. Puoi confrontare l'impronta esatta qui sopra con quella del file: Get-FileHash su Windows, sha256sum su Linux, shasum -a 256 su Mac.",
    seeReceipt: "vedi la ricevuta",
    found: "Trovato nel registro",
    notFound: "Non trovato nel registro",
    documentLabel: "Documento da verificare",
    dropTitle: "Trascina qui un file",
    dropHint: "oppure sceglilo dal computer",
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
 * A server timestamp as a person reads it, still in UTC and to the second:
 * "29 mar 2026, 14:35:01 UTC". The exact ISO form stays in the technical
 * details. Anything that does not parse is shown as it is.
 */
export function formatTs(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (match === null) return iso;
  const [, year, month, day, hours, minutes, seconds] = match;
  const monthName = MONTHS[Number(month) - 1];
  if (monthName === undefined) return iso;
  return `${Number(day)} ${monthName} ${year}, ${hours}:${minutes}:${seconds} UTC`;
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
};

/** One line of the administrative log, for the systems page. */
export function describeAdminEntry(entry: {
  ts: string;
  action: string;
  system_id: string;
  actor: string;
  detail: Record<string, unknown>;
}): string {
  const what = ADMIN_ACTIONS[entry.action] ?? entry.action;
  let extra = "";
  if (entry.action === "system.rename") {
    const name = (value: unknown): string => (typeof value === "string" ? `«${value}»` : "nessun nome");
    extra = `: da ${name(entry.detail["from"])} a ${name(entry.detail["to"])}`;
  }
  if (entry.action === "subject.erase") {
    return `${formatTs(entry.ts)} — ${what}: pseudonimo ${String(entry.detail["token"])} (${entry.actor})`;
  }
  if (entry.action === "openings.erase") {
    const seqs = Array.isArray(entry.detail["seqs"]) ? entry.detail["seqs"].join(", ") : "";
    extra = ` per le ricevute ${seqs} (${String(entry.detail["erased"])})`;
  }
  return `${formatTs(entry.ts)} — ${entry.system_id} ${what}${extra} (${entry.actor})`;
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

/** The day of a server timestamp, in UTC, as a heading of the history: "martedì 29 settembre 2026". */
export function formatDay(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  if (match === null) return iso;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const weekday = WEEKDAYS[date.getUTCDay()];
  const monthName = MONTH_NAMES[Number(month) - 1];
  if (weekday === undefined || monthName === undefined) return iso;
  return `${weekday} ${Number(day)} ${monthName} ${year}`;
}

/** The time of a server timestamp, in UTC, to the second: "12:40:13". */
export function formatTime(iso: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return match?.[1] ?? iso;
}

/** The one word for an outcome, as the receipt sentences already use it. */
export function outcomeWord(outcome: Receipt["outcome"]): string {
  return OUTCOME_WORDS[outcome];
}

export function actionKindLabel(kind: Receipt["action"]["kind"]): string {
  return KIND_LABELS[kind];
}
