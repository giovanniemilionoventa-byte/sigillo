/**
 * The Italian part of an evidence pack (SIGILLO_REPORT_LANGUAGE): a cover page
 * for report.pdf and a preamble for VERIFY.md, for the person who receives the
 * pack. The technical text after it stays as it is, in English, and is what the
 * verifier's output refers to. Nothing here is evidence: it is said in words
 * what manifest.json and the receipts already prove, and it claims nothing more.
 */

export interface ItalianSummary {
  /** The system's name, as the console showed it. */
  title: string;
  /** The key code of the signer, in groups of four, to check against what the sender said by phone. */
  keyCode: string;
  /** Where the pack is checked, without an account: for example get-sigillo.eu/verify. */
  verifyAddress: string;
  /** The actions of the pack, one sentence each, oldest first (describeReceipt). */
  sentences: readonly string[];
  /** The run's label, when the pack is of one run: said by whoever exported, not signed. */
  label?: string;
}

const NOT_PROVEN = [
  "Che l'agente abbia registrato tutto: dipende da come è collegato.",
  "Che le decisioni siano giuste o le ragioni per cui sono state prese.",
  "Cosa c'era scritto: sigillo conserva solo impronte, mai i contenuti.",
  "Le azioni avvenute dopo l'ultima di questo fascicolo.",
];

/** The lines of the report's Italian cover, for the PDF writer. */
export function italianCover(summary: ItalianSummary): { title: string; paragraphs: string[]; sentences: string[]; notProven: string[] } {
  return {
    title: "Fascicolo di prove",
    paragraphs: [
      `Questo fascicolo raccoglie le azioni registrate dal sistema «${summary.title}», firmate al momento in cui sono avvenute e legate una all'altra: nessuna ricevuta può essere cambiata, tolta dal mezzo o spostata senza che la verifica fallisca.`,
      ...(summary.label === undefined ? [] : [`Descrizione di chi ha preparato il fascicolo (non firmata): ${summary.label}.`]),
      `Come controllarlo: apri ${summary.verifyAddress}, scegli questo file e, nel campo «Codice ricevuto a parte», scrivi il codice della chiave che chi te l'ha mandato ti ha detto a parte: ${summary.keyCode}. Il file resta nel tuo browser.`,
      "Le pagine seguenti, in inglese, sono la parte tecnica: ricontrollano tutto senza fidarsi di questo riepilogo.",
    ],
    sentences: [...summary.sentences],
    notProven: NOT_PROVEN,
  };
}

/** The Italian preamble of VERIFY.md. */
export function italianVerifyPreamble(summary: ItalianSummary): string {
  return `# Come controllare questo fascicolo (in italiano)

Questo fascicolo contiene le azioni del sistema «${summary.title}», firmate e legate una all'altra.
Per controllarlo senza installare niente: ${summary.verifyAddress}, scegli il file, scrivi il codice
della chiave ricevuto a parte (${summary.keyCode}). Per il controllo completo c'è il verificatore
open source: \`sigillo-verify --key-id ${summary.keyCode.replaceAll(" ", "")} <fascicolo.zip>\`.

Cosa questo fascicolo **non** prova:

${NOT_PROVEN.map((line) => `- ${line}`).join("\n")}

La parte tecnica che segue è in inglese.

---

`;
}
