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
  nav: { registro: "registro", sistemi: "sistemi", verificaDocumento: "verifica documento", esci: "esci" },
  brand: {
    tagline: "registro delle azioni AI",
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
  },
  home: {
    title: "sigillo",
    heading: "Il registro",
    eyebrow: "le tre domande",
    q1: "È tutto a posto?",
    q2: "Cosa ha fatto l'AI?",
    q3: "Mi prepari le prove?",
    noSystems: "Nessun sistema ancora. Creane uno nella pagina «sistemi».",
    recentActivity: "Ultime azioni",
    seeHistory: "vedi tutta la cronologia",
    chooseSystem: "Sistema",
    fromDate: "Dal",
    toDate: "Al",
    wholeChain: "Lascia vuoto per l'intero registro.",
    generate: "Genera fascicolo",
    generateHint: "Uno .zip con le ricevute, i checkpoint, le marche temporali e il rapporto.",
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
    createTitle: "Crea un nuovo sistema",
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
      "Rinomine, archiviazioni ed eliminazioni di sistemi: chi, quando, cosa. È fuori dalle catene, e come loro non si modifica.",
    adminLogEmpty: "Nessuna operazione ancora.",
  },
  manage: {
    eyebrow: "gestisci il sistema",
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
    eyebrow: "cronologia",
    technicalDetails: "Dettagli tecnici",
    noMatches: "Nessuna ricevuta corrisponde ai filtri scelti.",
    searchButton: "Cerca",
    searchTitle: "Cerca e filtra",
    fromLabel: "dal (ricevuto)",
    toLabel: "al",
    kindLabel: "tipo",
    kindAny: "qualsiasi",
    nameLabel: "nome azione",
  },
  checkpoints: {
    title: "checkpoint",
    none: "Nessun checkpoint ancora.",
    explain:
      "Ogni checkpoint sigilla tutte le ricevute scritte fino a quel momento; la marca temporale di un'autorità esterna dice quando esistevano.",
    waiting: "in attesa di marca temporale",
    genTimeUnreadable: "ora attestata non leggibile dal token",
    receivedAt: "ricevuta dal server il",
  },
  verifyDocument: {
    title: "verifica un documento",
    heading: "Verifica un documento",
    eyebrow: "è quello che ha usato l'AI?",
    privacyNote: "Il documento non lascia il tuo computer: calcoliamo solo la sua impronta.",
    fileLabel: "File",
    textLabel: "oppure incolla il testo",
    // A browser reads a textarea back with LF line endings whatever was
    // pasted (HTML's newline normalisation), so text from a file saved with
    // Windows line endings can never match from here (session 5).
    textNote:
      "Attenzione: il browser legge il testo incollato con gli a capo di Mac e Linux. Se il documento è un file salvato su Windows, caricalo invece di incollarlo.",
    submit: "Verifica",
    // Shown until the page's script runs, and so left on screen when the
    // browser does not run it (a CSP that no longer matches, say): the button
    // stays disabled then, instead of doing nothing without a word (session 6).
    scriptInactive:
      "Il calcolo dell'impronta non è attivo in questa pagina: il browser non ha eseguito lo script che lo fa, quindi il pulsante Verifica è disattivato. Ricarica la pagina; se il messaggio resta, chi gestisce sigillo deve riavviare Caddy dopo l'ultimo aggiornamento (docs/DEPLOY-PRODUZIONE.md, 6.3).",
    computeFailed:
      "Non è stato possibile calcolare l'impronta del documento scelto. Il risultato che era sulla pagina è stato tolto, perché riguardava un tentativo precedente e non questo documento. Se il file è stato modificato, spostato o salvato di nuovo dopo averlo scelto, sceglilo di nuovo e premi Verifica.",
    browserError: "Errore del browser",
    resultTitle: "Risultato",
    searchedFingerprint: "Impronta cercata (SHA-256)",
    fromFile: "Calcolata dal browser sul file scelto.",
    fromText: "Calcolata dal browser sul testo incollato nella casella.",
    noMatch:
      "Nessuna azione registrata ha usato questo documento. Se ne hai una versione diversa, anche un solo carattere cambia il risultato.",
    lineEndingsHint:
      "Conta anche il modo di andare a capo: lo stesso testo salvato su Windows (a capo CRLF) e su Mac o Linux (a capo LF) ha due impronte diverse, e il testo incollato nella casella viene sempre letto con gli a capo LF. Se il documento è un file, carica il file originale invece di incollarne il testo, e confronta l'impronta qui sopra con quella del file (Get-FileHash su Windows, sha256sum su Linux, shasum -a 256 su Mac).",
    seeReceipt: "vedi la ricevuta",
    notModified: "Non è stato modificato",
  },
} as const;

/** The one sentence the "verifica un documento" page shows for a match. */
export function describeDocumentMatch(match: {
  system_id: string;
  display_name?: string | null;
  ts_received: string;
  label: string;
  action_name: string;
  role: string;
}): string {
  const who =
    match.display_name === undefined || match.display_name === null
      ? match.system_id
      : `«${match.display_name}» (sistema ${match.system_id})`;
  return (
    `✓ Questo documento è esattamente quello usato da ${who} il ${formatTs(match.ts_received)}, ` +
    `come «${match.label}», nell'azione ${match.action_name} (${match.role}). ${UI.verifyDocument.notModified}.`
  );
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
  const model = receipt.v === 2 ? receipt.model : undefined;

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

/** A readable label for an artifact, e.g. "curriculum (usato in input)". */
export function describeArtifact(role: "input" | "output", label: string): string {
  return `${label} (${role === "input" ? "usato in input" : "prodotto in output"})`;
}

export function actionKindLabel(kind: Receipt["action"]["kind"]): string {
  return KIND_LABELS[kind];
}
