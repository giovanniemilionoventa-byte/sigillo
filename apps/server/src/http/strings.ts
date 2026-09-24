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
  nav: { sistemi: "sistemi", verificaDocumento: "verifica documento", esci: "esci" },
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
    existing: "Sistemi esistenti",
    createTitle: "Crea un nuovo sistema",
    nameLabel: "Nome del sistema",
    namePlaceholder: "acme-support-bot",
    submit: "Crea sistema e chiave",
    createdTitle: "Sistema creato",
    tokenWarning:
      "Questo è l'unico momento in cui la chiave viene mostrata. Copiala ora: non potrà essere recuperata di nuovo.",
    howToConnect: "Come collegare un chatbot o un agente",
  },
  history: {
    technicalDetails: "Dettagli tecnici",
    noMatches: "Nessuna ricevuta corrisponde ai filtri scelti.",
    searchButton: "Cerca",
    fromLabel: "dal (ricevuto)",
    toLabel: "al",
    kindLabel: "tipo",
    kindAny: "qualsiasi",
    nameLabel: "nome azione",
  },
  checkpoints: {
    title: "checkpoint",
    none: "Nessun checkpoint ancora.",
    waiting: "in attesa di marca temporale",
    genTimeUnreadable: "ora attestata non leggibile dal token",
    receivedAt: "ricevuta dal server il",
  },
  verifyDocument: {
    title: "verifica un documento",
    privacyNote: "Il documento non lascia il tuo computer: calcoliamo solo la sua impronta.",
    fileLabel: "File",
    textLabel: "oppure incolla il testo",
    submit: "Verifica",
    resultTitle: "Risultato",
    noMatch:
      "Nessuna azione registrata ha usato questo documento. Se ne hai una versione diversa, anche un solo carattere cambia il risultato.",
    seeReceipt: "vedi la ricevuta",
    notModified: "Non è stato modificato",
  },
} as const;

/** The one sentence the "verifica un documento" page shows for a match. */
export function describeDocumentMatch(match: {
  system_id: string;
  ts_received: string;
  label: string;
  action_name: string;
  role: string;
}): string {
  return (
    `✓ Questo documento è esattamente quello usato da ${match.system_id} il ${match.ts_received}, ` +
    `come «${match.label}», nell'azione ${match.action_name} (${match.role}). ${UI.verifyDocument.notModified}.`
  );
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
