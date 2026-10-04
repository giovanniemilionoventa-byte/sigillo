/**
 * The narration, scene by scene, in Italian and in English: the words of the voice-over and
 * the subtitles at once. Adapted from demo/selezione-cv/VIDEO.md to what the
 * recorded scenes actually show, with the same rule: no technical words in
 * what is said.
 *
 * Each part names the recorded clip it is spoken over; `pnpm tsx
 * video/registra.ts sottotitoli` spreads its lines over that clip's real
 * duration, so the subtitles follow the film even after a scene is redone.
 */
type Parte = { clip: string; lines: string[] };

const IT: Parte[] = [
  {
    clip: "scena-1",
    lines: [
      "La vostra azienda usa l'intelligenza artificiale per leggere curriculum, rispondere ai clienti, prendere piccole decisioni ogni giorno.",
      "Ma se un giorno qualcuno vi chiede: «Cosa ha fatto esattamente, e come lo dimostrate?», sapete rispondere?",
    ],
  },
  {
    clip: "scena-2",
    lines: [
      "Questa è sigillo. Ogni azione della vostra AI viene registrata in un modo che nessuno, nemmeno chi gestisce il sistema, può cambiare senza che si veda.",
      "A destra, un agente che valuta candidature per un posto da sviluppatore.",
      "A ogni curriculum, il registro a sinistra si aggiorna da solo.",
      "E in alto, la risposta alla prima domanda: tutto a posto, nessuna alterazione.",
    ],
  },
  {
    clip: "scena-3",
    lines: [
      "Nella cronologia, in frasi normali: cosa ha fatto l'agente, quando, e con quale esito.",
      "I dettagli tecnici ci sono, ma restano nascosti finché non li cercate.",
      "Ogni azione ha la sua impronta, ed è legata a quella che la precede: nessuna può sparire o cambiare senza rompere la catena.",
      "E potete guardare solo gli strumenti che l'agente ha usato.",
    ],
  },
  {
    clip: "scena-4",
    lines: [
      "Più volte al giorno il registro viene sigillato, e un ente esterno e indipendente ci appone la sua marca temporale.",
      "È la prova che quelle azioni esistevano già a quell'ora: nessuno può riscriverle dopo.",
    ],
  },
  {
    clip: "scena-5a",
    lines: ["Quando un ispettore, un revisore o un cliente chiede le prove, basta un clic: sigillo prepara il fascicolo."],
  },
  {
    clip: "scena-5b",
    lines: [
      "E chiunque può controllarlo, con uno strumento gratuito e pubblico che non appartiene a chi vende sigillo.",
      "Il controllo riesce: il fascicolo è integro.",
      "Ora cambiamo un solo carattere in una copia: l'orario della valutazione di un candidato, spostato di un secondo.",
      "Il controllo fallisce, e dice esattamente dove.",
    ],
  },
  {
    clip: "scena-5c",
    lines: [
      "Lo stesso vale per i documenti. Un candidato contesta la selezione: caricate il suo curriculum. Il documento non lascia il vostro computer.",
      "Sì: è esattamente quello che l'AI ha letto. Non uno simile: esattamente quello.",
      "Basta un carattere diverso, e sigillo non lo riconosce più.",
    ],
  },
  {
    clip: "scena-6a",
    lines: [
      "Il regolamento europeo sull'intelligenza artificiale chiede alle aziende di poter dimostrare cosa hanno fatto i loro sistemi.",
    ],
  },
  {
    clip: "scena-6b",
    lines: [
      "Sigillo non vi dice se la vostra AI ha fatto la cosa giusta: vi dà le prove per verificarlo da soli.",
      "Il pilota è gratuito: get-sigillo.eu.",
    ],
  },
];

/** The same narration in English, for the English video (SIGILLO_VIDEO_LANG=en). */
const EN: Parte[] = [
  {
    clip: "scena-1",
    lines: [
      "Your company uses artificial intelligence to read CVs, answer customers and make small decisions every day.",
      "But if one day someone asks you: \u201cWhat exactly did it do, and how can you prove it?\u201d, could you answer?",
    ],
  },
  {
    clip: "scena-2",
    lines: [
      "This is sigillo. Every action your AI takes is recorded in a way that nobody, not even whoever runs the system, can change without it showing.",
      "On the right, an agent screening applications for a developer job.",
      "With every CV, the ledger on the left updates by itself.",
      "And at the top, the answer to the first question: all good, no tampering.",
    ],
  },
  {
    clip: "scena-3",
    lines: [
      "The history, in plain sentences: what the agent did, when, and how it turned out.",
      "The technical details are there, but they stay out of sight until you look for them.",
      "Every action has its own fingerprint, linked to the one before it: none can vanish or change without breaking the chain.",
      "And you can look at just the tools the agent used.",
    ],
  },
  {
    clip: "scena-4",
    lines: [
      "Several times a day the ledger is sealed, and an external, independent authority adds its timestamp.",
      "It proves those actions already existed at that time: nobody can rewrite them afterwards.",
    ],
  },
  {
    clip: "scena-5a",
    lines: ["When an inspector, an auditor or a customer asks for evidence, one click is enough: sigillo prepares the evidence pack."],
  },
  {
    clip: "scena-5b",
    lines: [
      "And anyone can check it, with a free, public tool that does not belong to whoever sells sigillo.",
      "The check passes: the evidence pack is intact.",
      "Now let's change a single character in a copy: the time of a candidate's evaluation, moved by one second.",
      "The check fails, and says exactly where.",
    ],
  },
  {
    clip: "scena-5c",
    lines: [
      "The same goes for documents. A candidate disputes the selection: upload their CV. The document never leaves your computer.",
      "Yes: it is exactly the one the AI read. Not a similar one: exactly that one.",
      "One different character, and sigillo no longer recognises it.",
    ],
  },
  {
    clip: "scena-6a",
    lines: ["The European AI Act asks companies to be able to show what their systems have done."],
  },
  {
    clip: "scena-6b",
    lines: [
      "Sigillo does not tell you whether your AI did the right thing: it gives you the evidence to check for yourself.",
      "The pilot is free: get-sigillo.eu.",
    ],
  },
];

export const PARLATO: Record<"it" | "en", Parte[]> = { it: IT, en: EN };
