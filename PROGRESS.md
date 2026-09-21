# PROGRESS.md — stato del progetto sigillo

Legenda stato: `todo` · `in corso` · `fatto`

## Milestone

| # | Nome | Stato | Note |
|---|------|-------|------|
| M1 | Formato e impronta | fatto | 14 vettori, 91 test verdi, cross-check Python indipendente in CI |
| M2 | Catena e storage | fatto | Trigger append-only, transazione IMMEDIATE, 1000 append concorrenti senza buchi |
| M3 | Firmatario | todo | Processo signer su socket Unix, keygen, protocollo |
| M4 | Verificatore v1 | todo | Export minimale + CLI verifica, test di manomissione |
| M5 | Ingest OTLP e API nativa | todo | `/v1/traces` protobuf+JSON, adattatore due dialetti, API key |
| M6 | SDK Python | todo | Pacchetto `sigillo`, esempio LangGraph, test e2e |
| M7 | Merkle e marca temporale | todo | RFC 6962, checkpoint firmati, RFC 3161 con retry |
| M8 | Fascicolo completo e verificatore v2 | todo | Export zip completo, tutti i controlli del verificatore |
| M9 | UI, deploy, documentazione | todo | UI minima, docker-compose, backup, doc finali |

## Note di sessione

### Sessione 1 — 2026-09-21
- Repository clonato vuoto (nessun commit precedente), branch di lavoro `claude/sigillo-project-setup-zx80r8`.
- Creati `SPEC.md` (copia integrale sezioni 1–9 del prompt), `CLAUDE.md` (regole permanenti sezione 10 + struttura repo), `PROGRESS.md` (questo file).
- Ambiente disponibile: Node v22.22.2, pnpm 10.33.0, Python 3.11.15, OpenSSL 3.0.13.
- Piano approvato dal committente, avviata M1.

#### M1 — Formato e impronta (fatto)

Struttura creata: monorepo pnpm (`packages/core`), TypeScript strict/ESM, vitest,
CI GitHub Actions, script di lint senza dipendenze.

Cosa è stato fatto:
- `packages/core/src/canonical.ts` — canonicalizzazione RFC 8785, SHA-256, hex, `hashCanonicalJson`.
- `packages/core/src/receipt.ts` — schema zod della ricevuta v1 (strict: campi sconosciuti rifiutati),
  `canonicalReceiptBytes`, `receiptHash`, `receiptHashHex`, `parseReceipt`/`safeParseReceipt` con
  messaggi che nominano il campo in errore.
- `packages/core/test/vectors.json` — 14 vettori (richiesti: almeno 10), con forma canonica e impronta.
- `docs/FORMAT.md` — specifica del formato sufficiente a reimplementare il verificatore, esempio
  riproducibile con `openssl`, e confronto con la bozza IETF.

Verifiche eseguite:
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` → 91 test verdi.
- `scripts/crosscheck_vectors.py` → i 14 vettori sono ri-derivati da un'implementazione JCS
  indipendente in Python (solo libreria standard, nessun codice sigillo). Gira in CI come job separato.
- I due vettori di riferimento sono stati calcolati **a mano** dalla RFC 8785 e con
  `hashlib`/`openssl` *prima* di scrivere il codice, quindi l'implementazione è stata verificata
  contro un valore esterno, non contro sé stessa.
- Test di manomissione manuale: un solo carattere alterato in `vectors.json` viene rilevato sia dai
  test Node sia dal cross-check Python, con indicazione del vettore esatto.
- `scripts/smoke-dist.mjs` → il pacchetto compilato dà gli stessi hash sotto Node puro.

Decisioni prese (da confermare se non condivise):
- **Timestamp in forma unica**: `YYYY-MM-DDTHH:MM:SS.sssZ`, esattamente 3 decimali. Due grafie
  diverse dello stesso istante darebbero impronte diverse; imporre una sola forma elimina il problema.
  Il server normalizzerà i timestamp delle sorgenti in M5.
- **Lunghezze massime** sui campi di testo (`system_id` 128, `agent`/`on_behalf_of`/`action.name` 256):
  impediscono di infilare un prompt in chiaro dentro un campo "nome".
- **Schema strict**: una ricevuta con un campo sconosciuto viene rifiutata.
- **Niente eslint/prettier** (fuori dalla lista dipendenze consentite): `pnpm lint` è uno script senza
  dipendenze che verifica invarianti reali — purezza di `core`, allowlist delle dipendenze, assenza di
  `.only()`, assenza di `any`, nessun file di chiave nel repository.

Note sulla bozza IETF `draft-sharif-agent-audit-trail`:
- È raggiungibile, revisione più recente **-04** (letta il 2026-09-21). Confronto completo in
  `docs/FORMAT.md` §9.
- Differenza sostanziale: nella bozza `prev_hash` copre la ricevuta precedente **inclusa la firma**;
  in sigillo copre la ricevuta **senza** firma. La nostra scelta è deliberata: permette di assegnare
  `seq`/`prev_hash` dentro la transazione SQLite e di firmare dopo, senza che la catena dipenda dal
  firmatario. Documentato.
- Tre allineamenti proposti in `docs/FORMAT.md` §9, **da decidere insieme** (nessuno implementato):
  tabella di corrispondenza tra i vocabolari di `outcome`; `record_phase` (pre/post esecuzione), utile
  per l'art. 14 ma richiede `v = 2`; limite di dimensione del record.

Note operative:
- `https://freetsa.org/tsr` risponde 403 a una GET dall'ambiente cloud. Non è di per sé un problema
  (la TSA vuole una POST con `Content-Type: application/timestamp-query`), ma va verificato in M7:
  se il blocco è del proxy lo segnalo invece di aggirarlo.
- La libreria `canonicalize` pubblica tipi TypeScript errati (dichiara un default ESM in un pacchetto
  CommonJS). Aggirato con un cast circoscritto e documentato in `canonical.ts`; i test fissano i byte
  di output, quindi una regressione della libreria verrebbe rilevata subito.

#### M2 — Catena e storage (fatto)

- `apps/server/src/storage/schema.ts` — tabelle `receipts`, `checkpoints`, `timestamps` (SQLite STRICT),
  `UNIQUE(system_id, seq)`, indici per ricerca, e trigger `BEFORE UPDATE`/`BEFORE DELETE` su tutte e tre
  che fanno `RAISE(ABORT, 'append-only: ...')`.
- `apps/server/src/storage/store.ts` — `ReceiptStore`: `seq` e `prev_hash` letti e scritti dentro **una sola**
  transazione `BEGIN IMMEDIATE`, mai in due passi. WAL attivo, `synchronous = FULL`.
- `packages/core/src/keys.ts` — derivazione del `key_id` (primi 16 hex di SHA-256 della chiave pubblica raw),
  verificata contro il vettore RFC 8032 TEST 1 calcolato a parte con `hashlib` e `openssl`.

Verifiche eseguite (117 test verdi):
- UPDATE e DELETE su `receipts`, `checkpoints`, `timestamps` falliscono **da una seconda connessione**,
  cioè il vincolo protegge il file, non solo la nostra API.
- 1000 append concorrenti sulla stessa catena → `seq` 0..999 contigui, ogni `prev_hash` corretto,
  1000 hash distinti, nessun nome d'azione perso o duplicato.
- Controprova: disattivando la serializzazione delle scritture i due test di concorrenza falliscono.
  Il test ha mordente, non passa per caso.
- Catene di sistemi diversi restano indipendenti sotto append interlacciati.
- Riapertura del database da un nuovo processo: la catena prosegue dal tip memorizzato, non biforca.
- Le firme sono **vere firme Ed25519** generate con `node:crypto` e verificate con la chiave pubblica:
  nessuna primitiva crittografica è mockata.

Decisioni prese:
- **Due connessioni**: scritture su una connessione, letture su una connessione read-only, così una query
  non può mai vedere righe di una transazione di scrittura ancora aperta.
- **Scrittore unico per processo**: le scritture sono serializzate in-process; il firmatario viene chiamato
  mentre la transazione è aperta, quindi due scrittori nello stesso processo si bloccherebbero a vicenda.
  È coerente con la SPEC ("scrittore unico") ed è documentato nel codice.
- La ricevuta viene validata **prima** di chiedere la firma (non si fa firmare una ricevuta malformata)
  **e di nuovo dopo**, perché ciò che torna dal firmatario non è preso per buono.
- In tabella si salva la forma canonica esatta che è stata firmata, non una ri-serializzazione.

Limite noto, da scrivere in `SECURITY.md` (M9): i trigger fermano UPDATE/DELETE via SQL, non un
`DROP TABLE` né la sostituzione del file. Contro quello valgono firme, catena e marche temporali.

## Checklist di verifica finale M9 (da eseguire fuori dalla sessione cloud)

Da completare quando si arriverà a M9 — placeholder, verrà sostituito con i comandi esatti.
