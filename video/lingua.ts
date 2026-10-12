/**
 * The language the video is recorded in: SIGILLO_VIDEO_LANG=it (the default)
 * or en. The console picks its language from the browser's Accept-Language,
 * so this sets the browser's locale; everything else that reads on screen
 * and is the video's own (the system's display name, the terminal's
 * window titles and folder, the one-character tool's name and messages, the
 * title cards, the narration) follows it. The labels below are the console's
 * own words (apps/server/src/http/strings-*.ts), used to find what to point at.
 *
 * The demo agent follows it too: the Italian video runs demo/selezione-cv
 * (tools leggi_curriculum, valuta_candidato, invia_email; candidato-XX.txt),
 * the English one demo/cv-screening, the same agent and CVs in English
 * (read_cv, evaluate_candidate, send_email; candidate-XX.txt).
 */
export type Lingua = "it" | "en";

const raw = process.env["SIGILLO_VIDEO_LANG"] ?? "it";
if (raw !== "it" && raw !== "en") throw new Error(`SIGILLO_VIDEO_LANG must be "it" or "en", not "${raw}"`);
export const LINGUA: Lingua = raw;

const TEXT = {
  it: {
    locale: "it-IT",
    demo: "selezione-cv",
    systemId: "selezione-cv",
    cvPrefix: "candidato",
    evaluateTool: "valuta_candidato",
    sendTool: "invia_email",
    posixLocale: "it_IT.UTF-8",
    /** Appended to the output names: nothing for Italian, so the first video's paths stay as they were. */
    suffix: "",
    displayName: "Selezione CV — backend junior",
    label: {
      actionsToday: "Azioni oggi",
      intact: "Integro",
      tools: /^Strumenti/,
      seals: /^Sigilli$/,
      evidence: /^\s*Fascicolo\s*$/,
      ledger: "Registro",
      lastSeal: "Ultimo sigillo",
      attested: "Ora attestata",
      authority: "Autorità",
      when: "Quando",
      fingerprint: /^Impronta$/,
      linkedTo: /^Collegata alla ricevuta/,
    },
    agentFolder: "agente",
    downloads: "Scaricati",
    agentTerminal: "Terminale — l'agente di selezione",
    downloadsTerminal: "Terminale — Scaricati",
    changeTool: "cambia-un-carattere",
    copyZip: "copia.zip",
    copyCv: "candidato-07-copia.txt",
    openingTitle: "Il registro a prova di manomissione<br>per i tuoi agenti AI",
    closingTitle: "Pilota gratuito · get-sigillo.eu",
    connectName: "Assistente clienti",
    customerAgent: "assistente_clienti.py",
    customerData: "domande.json",
    customerTerminal: "Terminale — l'assistente clienti",
    customerFolder: "assistente",
  },
  en: {
    locale: "en-GB",
    demo: "cv-screening",
    systemId: "cv-screening",
    cvPrefix: "candidate",
    evaluateTool: "evaluate_candidate",
    sendTool: "send_email",
    posixLocale: "en_GB.UTF-8",
    suffix: "-en",
    displayName: "CV screening — junior backend",
    label: {
      actionsToday: "Actions today",
      intact: "Intact",
      tools: /^Tools/,
      seals: /^Seals$/,
      evidence: /^\s*Evidence pack\s*$/,
      ledger: "Ledger",
      lastSeal: "Last seal",
      attested: "Time attested",
      authority: "Authority",
      when: "When",
      fingerprint: /^Fingerprint$/,
      linkedTo: /^Linked to receipt/,
    },
    agentFolder: "agent",
    downloads: "Downloads",
    agentTerminal: "Terminal — the screening agent",
    downloadsTerminal: "Terminal — Downloads",
    changeTool: "change-one-character",
    copyZip: "copy.zip",
    copyCv: "candidate-07-copy.txt",
    openingTitle: "The tamper-proof ledger<br>for your AI agents",
    closingTitle: "Free pilot · get-sigillo.eu",
    connectName: "Customer assistant",
    customerAgent: "support_assistant.py",
    customerData: "questions.json",
    customerTerminal: "Terminal — the support assistant",
    customerFolder: "assistant",
  },
} as const;

export const T = TEXT[LINGUA];
