import { escape } from "./layout.js";
import type { Language } from "./locale.js";

/**
 * The body of /privacy: a technical page for developers and security
 * reviewers, with the legal basics (controller, cookies, rights) at the end.
 * Every row names something the software does today; the sources are the
 * repository's docs (FORMAT.md, SECURITY.md, DATA-INVENTORY.md,
 * STORAGE-INVENTORY.md, DATA-PROTECTION.md). When the code changes what is
 * stored, kept or sent, this page changes in the same commit.
 */

type Row = readonly [string, string];

interface Texts {
  title: string;
  onThisPage: string;
  sources: string;
  sections: {
    summary: string;
    flow: string;
    receipt: string;
    crypto: string;
    keys: string;
    inventory: string;
    egress: string;
    erasure: string;
    limits: string;
    verify: string;
    legal: string;
  };
  intro: Record<keyof Texts["sections"], string>;
  facts: readonly Row[];
  flowBoxes: { customer: string; customerNote: string; server: string; serverBoxes: readonly Row[]; database: Row; outside: readonly Row[]; https: string };
  paths: { head: readonly [string, string, string]; rows: readonly (readonly [string, string, string])[] };
  receipt: { legendClear: string; legendDigest: string; legendNone: string; eraseTitle: string; erase: string };
  crypto: readonly Row[];
  keys: readonly Row[];
  inventory: { head: readonly [string, string, string, string]; rows: readonly (readonly [string, string, string, string])[] };
  egress: readonly Row[];
  erasure: { comments: readonly [string, string, string]; open: string; openText: string };
  limits: readonly Row[];
  verify: { comments: readonly [string, string, string]; cards: readonly Row[] };
  contact: string;
}

const EN: Texts = {
  title: "What Sigillo stores, how it is protected, and how to check.",
  onThisPage: "On this page",
  sources: "Source documents",
  sections: {
    summary: "Summary",
    flow: "Data flow",
    receipt: "What a receipt holds",
    crypto: "Cryptography",
    keys: "Keys and secrets",
    inventory: "Storage inventory",
    egress: "Network egress",
    erasure: "Retention and erasure",
    limits: "Known limits",
    verify: "Verify it yourself",
    legal: "Controller, cookies and your rights",
  },
  intro: {
    summary:
      "Sigillo stores fingerprints of what an agent did, and signs them. It does not store prompts, answers, tool arguments or documents. Each statement here names the part of the software that makes it true.",
    flow: "By default, content is turned into a fingerprint inside the customer's own process. Only the fingerprint travels.",
    receipt: "One JSON object per action. It has no member that can hold text.",
    crypto: "Specified in FORMAT.md so that a second implementation can verify a log without reading Sigillo's code.",
    keys: "Where each secret lives, and who can reach it.",
    inventory: "Every class of data, how long it is kept, and whether it can be erased.",
    egress: "The server opens connections only to these destinations.",
    erasure: "A single receipt cannot be deleted: a chain with a hole stops verifying, which is the point of it.",
    limits: "Said plainly, so you do not have to find them.",
    verify: "Do not take our word for it.",
    legal: "",
  },
  facts: [
    ["Prompt and answer text stored", "none"],
    ["Digest", "SHA-256, salted"],
    ["Signature", "Ed25519 (RFC 8032)"],
    ["Canonical JSON", "RFC 8785"],
    ["Timestamp", "RFC 3161"],
    ["Hosting", "EU (Aruba)"],
  ],
  flowBoxes: {
    customer: "Customer machine",
    customerNote: "AI agent + Python SDK",
    server: "Sigillo server, EU",
    serverBoxes: [
      ["Caddy", "TLS, the only public ports"],
      ["Server", "receipts, console, export"],
      ["Signer", "no network, Unix socket"],
    ],
    database: ["SQLite", "digests, labels, times, account email"],
    outside: [
      ["Timestamp authority", "receives a checkpoint hash"],
      ["Google Drive", "age-encrypted daily backup"],
      ["Firebase (optional)", "sign-in tokens"],
      ["Model provider (optional)", "only through the gateway"],
    ],
    https: "HTTPS",
  },
  paths: {
    head: ["#", "Path", "What travels, and what is written"],
    rows: [
      ["1", "SDK with customer_key", "Salted digests and labels. The key and the nonce are not sent. A signed receipt, with nothing that unlocks the digest."],
      ["2", "Other OpenTelemetry source, or redact_content=False", "Raw text is hashed while the request is read, then discarded together with every other payload attribute."],
      ["3", "Optional model gateway (/llm/…)", "Full prompt in, full answer back. The text exists only in server memory for the length of the call; salted digests are stored."],
      ["4", "Server to off-site backup", "The whole database, encrypted on the server with a public key (age) before upload. The private key is held offline."],
    ],
  },
  receipt: {
    legendClear: "in clear: agent, action, time. Labels only: do not put personal data in names.",
    legendDigest: "a digest or a token: unreadable without the nonce or the link table.",
    legendNone: "There is no member for text. A receipt with an unknown member is invalid.",
    eraseTitle: "Erasing a person",
    erase: "Delete the row that links the pseudonym to the person. Every receipt stays valid and verifiable, and none leads to anyone.",
  },
  crypto: [
    ["Canonical form", "RFC 8785 (JSON Canonicalization Scheme), UTF-8. The signature member is left out."],
    ["receipt_hash", "SHA-256 of the canonical form."],
    ["Signature", "Ed25519 (RFC 8032) over the canonical form, in strict canonical base64."],
    ["Chain", "prev_hash is the hash of the previous receipt; seq has no gaps. Each system is one chain."],
    ["Checkpoint tree", "Merkle tree as in RFC 6962: leaf = SHA-256(0x00 ‖ receipt_hash), node = SHA-256(0x01 ‖ left ‖ right)."],
    ["Timestamp", "RFC 3161 token over the checkpoint root. Today from FreeTSA, which is not an eIDAS qualified provider."],
    ["Salted digest", "SHA-256(nonce[32] ‖ UTF-8(RFC8785(value)))."],
    ["Customer nonce", "HMAC-SHA256(customer_key, \"sigillo-nonce-v1\\n\" ‖ trace_id ‖ \"\\n\" ‖ span_id ‖ \"\\n\" ‖ role). Never sent."],
  ],
  keys: [
    ["Signing key", "One Ed25519 key in a file only the signer can read (mode 0600); the signer refuses a key others can read. The server has no code that loads a key: a lint check and a test enforce it."],
    ["Signer process", "network_mode: none. Talks over a Unix socket; four strict requests (PUBKEY, SIGN_RECEIPT, CHECKPOINT, GET_HEAD). Keeps its own record of every chain's head."],
    ["API keys", "Stored only as scrypt hashes."],
    ["Model keys (gateway only)", "AES-256-GCM, with a key held in a file outside the database and outside the backups. The console shows the last 4 characters."],
    ["Backups", "Encrypted with an age public key on the server before upload. The private key is offline: not on the server, not on Drive."],
    ["Sessions and sign-in", "Secure, HttpOnly cookies. Sign-in attempts are rate-limited. New sign-ups are approved by hand."],
  ],
  inventory: {
    head: ["Data", "Form", "Kept", "Erasable"],
    rows: [
      ["Receipts, checkpoints, timestamps", "digests and labels", "contract duration", "whole only"],
      ["Link from pseudonym to person", "table row", "until erased", "yes"],
      ["Digest nonces (openings)", "32 bytes each", "until erased", "yes"],
      ["Account: email, company name, sign-in id", "clear", "contract duration", "yes"],
      ["Administrative log", "append-only", "permanent", "no"],
      ["Daily exports (if switched on)", "zip", "30 days", "automatic"],
      ["Backups on the server", "database copy", "2 hours", "automatic"],
      ["Off-site backups", "age-encrypted", "30 days", "automatic"],
    ],
  },
  egress: [
    ["Timestamp authority", "TSA_URL. The SHA-256 of a checkpoint root."],
    ["Firebase / Google identity", "Only when SIGILLO_FIREBASE_* is set. Sign-in checks."],
    ["Model providers", "Only for gateway calls, with the customer's own key."],
    ["Backup destination", "A cron job on the host, not the application."],
    ["Everything else", "Nothing. No telemetry, analytics or call to the licensor. A firewall that allows only the rows above proves it."],
  ],
  erasure: {
    comments: ["end of contract: hand over the export, then erase within 30 days", "a person asks to be erased (GDPR art. 17)", "make a digest impossible to match to any content"],
    open: "Open item.",
    openText: "There is no automatic retention period yet: data is kept until the end of the contract unless erased. The administrative log keeps the sign-up email and company name after an erasure.",
  },
  limits: [
    ["Model gateway", "Prompt text and the model key pass through server memory during a call. They are not stored, but \"we never see them\" would be untrue. Using only the SDK avoids this."],
    ["Server access", "Whoever has the server login could read the database: labels and emails, never content. Labels are not encrypted per customer yet."],
    ["Assurance", "No external audit or certification (ISO 27001, SOC 2), and no second factor on the administrator login yet. Both are planned."],
    ["Scope of the proof", "Sigillo proves what an agent sent, in what order, and that it was not changed since. It does not prove that everything was sent or that the content is true, and it does not make you compliant with GDPR or the AI Act by itself."],
  ],
  verify: {
    comments: ["check the chain, signatures, checkpoints and timestamps, offline", "prove that a digest belongs to a given content", "does this file match a receipt?"],
    cards: [
      ["Confirm that no content is stored", "Capture your agent's traffic to Sigillo, or search an export for text your agent handled."],
      ["Write your own verifier", "FORMAT.md specifies every check, with test vectors you can reproduce with a shell and openssl."],
    ],
  },
  contact: "Questions about your data",
};

const IT: Texts = {
  title: "Cosa conserva Sigillo, come è protetto e come controllarlo.",
  onThisPage: "In questa pagina",
  sources: "Documenti di riferimento",
  sections: {
    summary: "In breve",
    flow: "Percorso dei dati",
    receipt: "Cosa contiene una ricevuta",
    crypto: "Crittografia",
    keys: "Chiavi e segreti",
    inventory: "Inventario di ciò che si conserva",
    egress: "Connessioni in uscita",
    erasure: "Conservazione e cancellazione",
    limits: "Limiti noti",
    verify: "Verificalo da solo",
    legal: "Titolare, cookie e diritti",
  },
  intro: {
    summary:
      "Sigillo conserva le impronte di ciò che un agente ha fatto e le firma. Non conserva prompt, risposte, argomenti degli strumenti né documenti. Ogni frase indica la parte del software che la rende vera.",
    flow: "Di norma il contenuto diventa un'impronta dentro il processo del cliente. Viaggia solo l'impronta.",
    receipt: "Un oggetto JSON per ogni azione. Non ha nessun campo che possa contenere testo.",
    crypto: "Descritta in FORMAT.md, così una seconda implementazione può verificare un registro senza leggere il codice di Sigillo.",
    keys: "Dove sta ogni segreto e chi può raggiungerlo.",
    inventory: "Ogni tipo di dato, per quanto tempo si conserva e se si può cancellare.",
    egress: "Il server apre connessioni solo verso queste destinazioni.",
    erasure: "Una singola ricevuta non si può cancellare: una catena con un buco non si verifica più, ed è lo scopo.",
    limits: "Dichiarati chiaramente, così non devi cercarli.",
    verify: "Non fidarti della nostra parola.",
    legal: "",
  },
  facts: [
    ["Testo di prompt e risposte conservato", "nessuno"],
    ["Impronta", "SHA-256, con sale"],
    ["Firma", "Ed25519 (RFC 8032)"],
    ["JSON canonico", "RFC 8785"],
    ["Marca temporale", "RFC 3161"],
    ["Hosting", "UE (Aruba)"],
  ],
  flowBoxes: {
    customer: "Computer del cliente",
    customerNote: "Agente AI + SDK Python",
    server: "Server di Sigillo, UE",
    serverBoxes: [
      ["Caddy", "TLS, le uniche porte pubbliche"],
      ["Server", "ricevute, console, esportazione"],
      ["Signer", "senza rete, socket Unix"],
    ],
    database: ["SQLite", "impronte, etichette, orari, email dell'account"],
    outside: [
      ["Autorità di marca temporale", "riceve l'impronta di un checkpoint"],
      ["Google Drive", "copia giornaliera cifrata (age)"],
      ["Firebase (facoltativo)", "token di accesso"],
      ["Fornitore del modello (facoltativo)", "solo tramite il gateway"],
    ],
    https: "HTTPS",
  },
  paths: {
    head: ["#", "Percorso", "Cosa viaggia e cosa viene scritto"],
    rows: [
      ["1", "SDK con customer_key", "Impronte con sale ed etichette. La chiave e il nonce non vengono inviati. Una ricevuta firmata, senza nulla che sblocchi l'impronta."],
      ["2", "Altra fonte OpenTelemetry, o redact_content=False", "Il testo grezzo viene trasformato in impronta mentre si legge la richiesta, poi scartato insieme a ogni altro attributo del contenuto."],
      ["3", "Gateway dei modelli, facoltativo (/llm/…)", "Il prompt intero in andata, la risposta intera in ritorno. Il testo esiste solo nella memoria del server per la durata della chiamata; si conservano le impronte con sale."],
      ["4", "Dal server alla copia fuori sede", "Tutto il database, cifrato sul server con una chiave pubblica (age) prima di essere caricato. La chiave privata è tenuta offline."],
    ],
  },
  receipt: {
    legendClear: "in chiaro: agente, azione, ora. Solo etichette: non scrivere dati personali nei nomi.",
    legendDigest: "un'impronta o un gettone: illeggibile senza il nonce o la tabella dei collegamenti.",
    legendNone: "Non esiste un campo per il testo. Una ricevuta con un campo sconosciuto non è valida.",
    eraseTitle: "Cancellare una persona",
    erase: "Si cancella la riga che collega lo pseudonimo alla persona. Ogni ricevuta resta valida e verificabile, e nessuna porta più a qualcuno.",
  },
  crypto: [
    ["Forma canonica", "RFC 8785 (JSON Canonicalization Scheme), UTF-8. Il campo della firma è escluso."],
    ["receipt_hash", "SHA-256 della forma canonica."],
    ["Firma", "Ed25519 (RFC 8032) sulla forma canonica, in base64 canonico rigoroso."],
    ["Catena", "prev_hash è l'hash della ricevuta precedente; seq non ha buchi. Ogni sistema è una catena."],
    ["Albero dei checkpoint", "Albero di Merkle come in RFC 6962: foglia = SHA-256(0x00 ‖ receipt_hash), nodo = SHA-256(0x01 ‖ sinistra ‖ destra)."],
    ["Marca temporale", "Token RFC 3161 sulla radice del checkpoint. Oggi da FreeTSA, che non è un fornitore qualificato eIDAS."],
    ["Impronta con sale", "SHA-256(nonce[32] ‖ UTF-8(RFC8785(valore)))."],
    ["Nonce del cliente", "HMAC-SHA256(customer_key, \"sigillo-nonce-v1\\n\" ‖ trace_id ‖ \"\\n\" ‖ span_id ‖ \"\\n\" ‖ ruolo). Non viene mai inviato."],
  ],
  keys: [
    ["Chiave di firma", "Una chiave Ed25519 in un file leggibile solo dal signer (modo 0600); il signer rifiuta una chiave leggibile da altri. Il server non ha codice che carichi una chiave: lo garantiscono un controllo di lint e un test."],
    ["Processo signer", "network_mode: none. Parla tramite un socket Unix; quattro richieste rigorose (PUBKEY, SIGN_RECEIPT, CHECKPOINT, GET_HEAD). Tiene un proprio registro della testa di ogni catena."],
    ["Chiavi API", "Conservate solo come hash scrypt."],
    ["Chiavi dei modelli (solo gateway)", "AES-256-GCM, con una chiave in un file fuori dal database e fuori dalle copie. La console mostra solo gli ultimi 4 caratteri."],
    ["Copie di sicurezza", "Cifrate con una chiave pubblica age sul server prima del caricamento. La chiave privata è offline: non sul server, non su Drive."],
    ["Sessioni e accesso", "Cookie sicuri e HttpOnly. I tentativi di accesso hanno un limite. Le nuove iscrizioni sono approvate a mano."],
  ],
  inventory: {
    head: ["Dato", "Forma", "Conservato", "Cancellabile"],
    rows: [
      ["Ricevute, checkpoint, marche temporali", "impronte ed etichette", "durata del contratto", "solo per intero"],
      ["Collegamento da pseudonimo a persona", "riga di tabella", "fino alla cancellazione", "sì"],
      ["Nonce delle impronte (openings)", "32 byte ciascuno", "fino alla cancellazione", "sì"],
      ["Account: email, nome azienda, id di accesso", "in chiaro", "durata del contratto", "sì"],
      ["Registro amministrativo", "solo aggiunte", "permanente", "no"],
      ["Esportazioni giornaliere (se attive)", "zip", "30 giorni", "automatica"],
      ["Copie sul server", "copia del database", "2 ore", "automatica"],
      ["Copie fuori sede", "cifrate con age", "30 giorni", "automatica"],
    ],
  },
  egress: [
    ["Autorità di marca temporale", "TSA_URL. L'SHA-256 della radice di un checkpoint."],
    ["Firebase / identità Google", "Solo se SIGILLO_FIREBASE_* è impostato. Controlli di accesso."],
    ["Fornitori di modelli", "Solo per le chiamate del gateway, con la chiave del cliente."],
    ["Destinazione della copia", "Un lavoro cron sul server, non l'applicazione."],
    ["Tutto il resto", "Niente. Nessuna telemetria, statistica o chiamata al licenziante. Un firewall che consente solo le righe sopra lo dimostra."],
  ],
  erasure: {
    comments: ["fine contratto: consegna dell'esportazione, poi cancellazione entro 30 giorni", "una persona chiede di essere cancellata (GDPR art. 17)", "rende un'impronta impossibile da collegare a un contenuto"],
    open: "Punto aperto.",
    openText: "Non c'è ancora un periodo di conservazione automatico: i dati restano fino alla fine del contratto, salvo cancellazione. Il registro amministrativo conserva l'email e il nome dell'azienda dati all'iscrizione anche dopo una cancellazione.",
  },
  limits: [
    ["Gateway dei modelli", "Il testo del prompt e la chiave del modello passano nella memoria del server durante una chiamata. Non vengono conservati, ma dire «non lo vediamo mai» sarebbe falso. Usando solo l'SDK si evita."],
    ["Accesso al server", "Chi ha l'accesso al server potrebbe leggere il database: etichette ed email, mai il contenuto. Le etichette non sono ancora cifrate per cliente."],
    ["Garanzie esterne", "Nessun audit o certificazione esterna (ISO 27001, SOC 2) e ancora nessun secondo fattore per l'accesso dell'amministratore. Entrambi sono previsti."],
    ["Portata della prova", "Sigillo prova cosa ha inviato un agente, in che ordine, e che da allora non è stato modificato. Non prova che sia stato inviato tutto né che il contenuto sia vero, e da solo non rende conformi a GDPR o AI Act."],
  ],
  verify: {
    comments: ["controlla catena, firme, checkpoint e marche temporali, offline", "prova che un'impronta appartiene a un dato contenuto", "questo file corrisponde a una ricevuta?"],
    cards: [
      ["Verifica che non si conservi contenuto", "Cattura il traffico del tuo agente verso Sigillo, o cerca in un'esportazione il testo che il tuo agente ha trattato."],
      ["Scrivi un tuo verificatore", "FORMAT.md descrive ogni controllo, con vettori di prova riproducibili con una shell e openssl."],
    ],
  },
  contact: "Domande sui tuoi dati",
};

const TEXTS: Record<Language, Texts> = { en: EN, it: IT };

/** The example receipt: version 4's members, with every digest shortened. */
const RECEIPT = (clear: (text: string) => string, digest: (text: string) => string): string => `{
  "v": 4,
  "system_id": ${clear('"support-agent"')},
  "seq": 128,
  "ts_event": "2026-10-03T08:19:41.050Z",
  "ts_received": "2026-10-03T08:19:41.207Z",
  "actor": { "agent": ${clear('"support-agent"')}, "on_behalf_of": ${digest('"psn_9c1e…b04f"')} },
  "action": { "kind": "tool_call", "name": ${clear('"cerca_ordine"')} },
  "input_hash": ${digest('"7be2…a91c"')},
  "output_hash": ${digest('"41d0…03ee"')},
  "input_hash_scheme": "salted",
  "output_hash_scheme": "salted",
  "outcome": "ok",
  "source": { "type": "sdk", "trace_id": "4bf9…4736", "span_id": "00f0…02b7" },
  "prev_hash": ${digest('"c8f3…5d12"')},
  "key_id": "3f2a1c9d8e7b6a5f",
  "sig": ${digest('"…88 characters of base64"')}
}`;

const SOURCES: readonly string[] = ["FORMAT.md", "SECURITY.md", "DATA-INVENTORY.md", "STORAGE-INVENTORY.md", "DATA-PROTECTION.md"];

export interface PrivacyView {
  language: Language;
  /** The legal basics (controller, cookies, rights), as the site's strings give them. */
  legal: readonly { heading: string; paragraphs: readonly string[] }[];
  updated: string;
  /** Where the repository's docs are, without a trailing slash. */
  docs: string;
  contactHref?: string;
  contactLabel?: string;
}

const SECTION_ORDER = ["summary", "flow", "receipt", "crypto", "keys", "inventory", "egress", "erasure", "limits", "verify", "legal"] as const;

/** Rules of this page only: it sits in the site's frame, so they use that frame's tokens. */
const RULES = `
.pv { --pv-line: var(--separator, var(--line, #e4e6e9)); --pv-text: var(--text, var(--ink, #0b0c0e)); --pv-muted: var(--secondary, #5c6169); --pv-fill: var(--surface, var(--band, #fff)); --pv-accent: var(--link, var(--blue, #0062e0)); --pv-ok: var(--ok, var(--green, #1a7f37)); --pv-warn: var(--warn, #8a5200); }
.pv { max-width: 1120px; margin: 0 auto; padding: 56px 24px 72px; }
.pv-mono, .pv code, .pv pre, .pv .pv-k { font-family: var(--mono, ui-monospace, Menlo, Consolas, monospace); }
.pv-k { font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--pv-muted); margin: 0 0 10px; }
.pv h1 { font-size: 40px; line-height: 46px; letter-spacing: -0.02em; font-weight: 600; margin: 0 0 28px; max-width: 760px; text-align: left; }
.pv-layout > div { min-width: 0; }
.pv-layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 48px; align-items: start; }
.pv-toc { position: sticky; top: 24px; font-size: 13px; }
.pv-toc a { display: block; padding: 6px 0 6px 12px; color: var(--pv-muted); border-left: 2px solid var(--pv-line); text-decoration: none; }
.pv-toc a:hover { color: var(--pv-text); border-left-color: var(--pv-accent); }
.pv-toc .n { font-family: var(--mono, ui-monospace, monospace); margin-right: 6px; }
.pv-toc .src { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--pv-line); }
.pv-toc .src a { border: 0; padding: 3px 0; font-family: var(--mono, ui-monospace, monospace); font-size: 12px; }
.pv .pv-sec { margin: 0 0 56px; scroll-margin-top: 24px; }
.pv h2 { font-size: 26px; line-height: 32px; letter-spacing: -0.01em; font-weight: 600; margin: 0 0 6px; text-align: left; }
.pv .lead { color: var(--pv-muted); font-size: 14.5px; margin: 0 0 20px; max-width: 680px; }
.pv-box { border: 1px solid var(--pv-line); border-radius: 6px; background: var(--pv-fill); }
.pv-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.pv-fact { padding: 14px 16px; }
.pv-fact b { display: block; font-family: var(--mono, ui-monospace, monospace); font-size: 15px; font-weight: 500; }
.pv-rows > div { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 2.4fr); gap: 16px; padding: 11px 18px; border-top: 1px solid var(--pv-line); font-size: 13.5px; }
.pv-rows > div:first-child { border-top: 0; }
.pv-rows.cols4 > div { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, .8fr); }
.pv-rows.paths > div { grid-template-columns: 28px minmax(0, 1.4fr) minmax(0, 2.4fr); }
.pv-rows .h { font-family: var(--mono, ui-monospace, monospace); font-size: 11.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--pv-muted); }
.pv-rows .name { font-family: var(--mono, ui-monospace, monospace); font-size: 13px; }
.pv-rows .dim { color: var(--pv-muted); }
.pv-diagram { padding: 20px; }
.pv-top { display: grid; grid-template-columns: minmax(0, 1fr) 36px minmax(0, 1.3fr); align-items: stretch; }
.pv-sub { border: 1px solid var(--pv-line); border-radius: 5px; padding: 10px 12px; font-size: 13px; }
.pv-sub b { display: block; }
.pv-sub span { color: var(--pv-muted); font-size: 12px; }
.pv-sub.pv-you { border-color: var(--pv-accent); }
.pv-sub.pv-sign { border-color: var(--pv-ok); }
.pv-arrow { display: flex; align-items: center; justify-content: center; font-family: var(--mono, ui-monospace, monospace); font-size: 11px; color: var(--pv-muted); writing-mode: vertical-rl; }
.pv-inner { border: 1px solid var(--pv-line); border-radius: 5px; padding: 12px; }
.pv-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 8px; }
.pv-four { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.pv-receipt { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.pv pre { margin: 0; max-width: 100%; padding: 16px 18px; font-size: 12.5px; line-height: 1.65; overflow-x: auto; white-space: pre; }
.pv .c { color: var(--pv-ok); } .pv .d { color: var(--pv-warn); }
.pv-legend { padding: 0 !important; }
.pv-legend > div { padding: 11px 16px; border-top: 1px solid var(--pv-line); font-size: 13px; }
.pv-legend > div:first-child { border-top: 0; }
.pv-erase { padding: 14px 16px; font-size: 13px; margin-top: 12px; }
.pv-erase b { display: block; margin-bottom: 4px; }
.pv-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.pv-two > div { padding: 14px 18px; font-size: 13.5px; }
.pv-two b { display: block; margin-bottom: 4px; }
.pv-note { padding: 14px 18px; font-size: 13.5px; margin-top: 12px; color: var(--pv-muted); }
.pv-note b { color: var(--pv-warn); }
.pv-prose h3 { font-size: 17px; margin: 22px 0 6px; }
.pv-prose p { margin: 0 0 12px; max-width: 720px; }
@media (max-width: 900px) {
  .pv-layout { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .pv-toc { position: static; }
  .pv-facts, .pv-three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pv-four, .pv-two, .pv-receipt { grid-template-columns: minmax(0, 1fr); }
  .pv-top { grid-template-columns: minmax(0, 1fr); }
  .pv-arrow { writing-mode: horizontal-tb; padding: 8px 0; }
  .pv-rows > div, .pv-rows.cols4 > div, .pv-rows.paths > div { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .pv h1 { font-size: 30px; line-height: 36px; }
}
`;

export function privacyPage(view: PrivacyView): string {
  const t = TEXTS[view.language];
  const rows = (items: readonly Row[]): string =>
    `<div class="pv-box pv-rows">${items.map(([name, text]) => `<div><span class="name">${escape(name)}</span><span class="dim">${escape(text)}</span></div>`).join("")}</div>`;
  const section = (key: keyof Texts["sections"], inner: string): string => {
    return `<div class="pv-sec" id="${key}"><h2>${escape(t.sections[key])}</h2>${t.intro[key] === "" ? "" : `<p class="lead">${escape(t.intro[key])}</p>`}${inner}</div>`;
  };
  const sub = (title: string, note: string, extra = ""): string => `<div class="pv-sub${extra}"><b>${escape(title)}</b><span>${escape(note)}</span></div>`;
  const f = t.flowBoxes;

  const summary = `<div class="pv-facts">${t.facts.map(([label, value]) => `<div class="pv-box pv-fact"><p class="pv-k">${escape(label)}</p><b>${escape(value)}</b></div>`).join("")}</div>`;
  const flow = `<div class="pv-box pv-diagram"><div class="pv-top">
${sub(f.customer, f.customerNote, " pv-you").replace("</div>", `<div class="pv-mono" style="margin-top:10px;font-size:12px">sha256(nonce ‖ content)</div></div>`)}
<div class="pv-arrow">${escape(f.https)}</div>
<div class="pv-inner"><div class="pv-three">${f.serverBoxes.map(([title, note], i) => sub(title, note, i === 2 ? " pv-sign" : "")).join("")}</div>${sub(f.database[0], f.database[1])}</div></div>
<div class="pv-four">${f.outside.map(([title, note]) => sub(title, note)).join("")}</div></div>
<div class="pv-box pv-rows paths" style="margin-top:14px"><div class="h"><span>${escape(t.paths.head[0])}</span><span>${escape(t.paths.head[1])}</span><span>${escape(t.paths.head[2])}</span></div>${t.paths.rows
    .map(([n, path, what]) => `<div><span class="name dim">${escape(n)}</span><span>${escape(path)}</span><span class="dim">${escape(what)}</span></div>`)
    .join("")}</div>`;
  const receipt = `<div class="pv-receipt"><pre class="pv-box">${RECEIPT(
    (text) => `<span class="c">${escape(text)}</span>`,
    (text) => `<span class="d">${escape(text)}</span>`,
  )}</pre>
<div class="pv-two" style="margin-top:0"><div class="pv-box pv-legend"><div><span class="c">■</span> ${escape(t.receipt.legendClear)}</div><div><span class="d">■</span> ${escape(t.receipt.legendDigest)}</div><div class="dim" style="color:var(--pv-muted)">${escape(t.receipt.legendNone)}</div></div>
<div class="pv-box pv-erase" style="margin-top:0"><b>${escape(t.receipt.eraseTitle)}</b>${escape(t.receipt.erase)}</div></div></div>`;
  const inventory = `<div class="pv-box pv-rows cols4"><div class="h">${t.inventory.head.map((h) => `<span>${escape(h)}</span>`).join("")}</div>${t.inventory.rows
    .map(([a, b, c, d]) => `<div><span>${escape(a)}</span><span class="dim">${escape(b)}</span><span class="dim">${escape(c)}</span><span>${escape(d)}</span></div>`)
    .join("")}</div>`;
  const [eraseOrg, eraseSubject, eraseOpenings] = t.erasure.comments;
  const erasure = `<pre class="pv-box"><span class="dim"># ${escape(eraseOrg)}</span>
sigillo-server org erase &lt;id&gt; --confirm &lt;id&gt;
<span class="dim"># ${escape(eraseSubject)}</span>
sigillo-server subject erase
<span class="dim"># ${escape(eraseOpenings)}</span>
sigillo-server openings erase</pre>
<div class="pv-box pv-note"><b>${escape(t.erasure.open)}</b> ${escape(t.erasure.openText)}</div>`;
  const [verifyAll, verifyOpen, verifyDoc] = t.verify.comments;
  const verify = `<pre class="pv-box"><span class="dim"># ${escape(verifyAll)}</span>
sigillo-verify ./evidence-pack
<span class="dim"># ${escape(verifyOpen)}</span>
sigillo-verify open ./evidence-pack 4 input --text 'score: 7' --nonce &lt;nonce&gt;
<span class="dim"># ${escape(verifyDoc)}</span>
sigillo-verify doc ./evidence-pack contract.pdf</pre>
<div class="pv-two">${t.verify.cards.map(([title, text]) => `<div class="pv-box"><b>${escape(title)}</b><span class="dim" style="color:var(--pv-muted)">${escape(text)}</span></div>`).join("")}</div>
${view.contactHref === undefined ? "" : `<p class="lead" style="margin-top:20px">${escape(t.contact)}: <a href="${escape(view.contactHref)}" target="_blank" rel="noopener">${escape(view.contactLabel ?? view.contactHref)}</a></p>`}`;
  const legal = `<div class="pv-prose">${view.legal
    .map((part) => `<h3>${escape(part.heading)}</h3>\n${part.paragraphs.map((text) => `<p>${escape(text)}</p>`).join("\n")}`)
    .join("\n")}<p class="lead">${escape(view.updated)}</p></div>`;

  const bodies: Record<keyof Texts["sections"], string> = {
    summary,
    flow,
    receipt,
    crypto: rows(t.crypto),
    keys: rows(t.keys),
    inventory,
    egress: rows(t.egress),
    erasure,
    limits: rows(t.limits),
    verify,
    legal,
  };
  const toc = `<div class="pv-toc" role="navigation" aria-label="${escape(t.onThisPage)}"><p class="pv-k">${escape(t.onThisPage)}</p>${SECTION_ORDER.map(
    (key, i) => `<a href="#${key}"><span class="n">${String(i + 1).padStart(2, "0")}</span>${escape(t.sections[key])}</a>`,
  ).join("")}<div class="src"><p class="pv-k">${escape(t.sources)}</p>${SOURCES.map((name) => `<a href="${escape(`${view.docs}/${name}`)}">${escape(name)}</a>`).join("")}</div></div>`;

  return `<style>${RULES}</style>
<div class="pv"><h1>${escape(t.title)}</h1>
<div class="pv-layout">${toc}<div>${SECTION_ORDER.map((key) => section(key, bodies[key])).join("\n")}</div></div></div>`;
}
