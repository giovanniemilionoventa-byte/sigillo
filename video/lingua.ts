/**
 * The language the video is recorded in: SIGILLO_VIDEO_LANG=it (the default)
 * or en. The console picks its language from the browser's Accept-Language,
 * so this sets the browser's locale; everything else that reads on screen
 * and is the video's own (the system's display name, the terminal's
 * window titles and folder, the one-character tool's name and messages, the
 * title cards, the narration) follows it. The labels below are the console's
 * own words (apps/server/src/http/strings-*.ts), used to find what to point at.
 *
 * What stays Italian in the English video, because it is the demo's data or
 * a real program's output, not the video's: the CVs, and the lines the
 * selezione-cv agent prints.
 */
export type Lingua = "it" | "en";

const raw = process.env["SIGILLO_VIDEO_LANG"] ?? "it";
if (raw !== "it" && raw !== "en") throw new Error(`SIGILLO_VIDEO_LANG must be "it" or "en", not "${raw}"`);
export const LINGUA: Lingua = raw;

const TEXT = {
  it: {
    locale: "it-IT",
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
    downloads: "Scaricati",
    agentTerminal: "Terminale — l'agente di selezione",
    downloadsTerminal: "Terminale — Scaricati",
    changeTool: "cambia-un-carattere",
    copyZip: "copia.zip",
    copyCv: "candidato-07-copia.txt",
    openingTitle: "Il registro a prova di manomissione<br>per i tuoi agenti AI",
    closingTitle: "Pilota gratuito · get-sigillo.eu",
  },
  en: {
    locale: "en-GB",
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
    downloads: "Downloads",
    agentTerminal: "Terminal — the screening agent",
    downloadsTerminal: "Terminal — Downloads",
    changeTool: "change-one-character",
    copyZip: "copy.zip",
    copyCv: "candidato-07-copy.txt",
    openingTitle: "The tamper-proof ledger<br>for your AI agents",
    closingTitle: "Free pilot · get-sigillo.eu",
  },
} as const;

export const T = TEXT[LINGUA];
