# sigillo — SPEC

> Questo documento è copia integrale delle sezioni 1–9 del prompt di progetto. È la fonte di verità del progetto. Non va modificato se non per riflettere una decisione esplicita del committente su una correzione della SPEC stessa.

## 1. Obiettivo del prodotto

sigillo produce **registri probatori delle azioni degli agenti AI**, pensati per gli obblighi di registrazione del Regolamento UE 2024/1689 (AI Act, artt. 12, 14, 26).

Ogni azione di un agente diventa una **ricevuta** firmata e concatenata alle precedenti. Nessuno può modificare, cancellare o riordinare le ricevute senza che un verificatore indipendente se ne accorga. Periodicamente lo stato del registro viene ancorato con una marca temporale RFC 3161 (in produzione, un fornitore qualificato eIDAS). Su richiesta, il sistema esporta un **fascicolo** leggibile da un revisore umano e verificabile a macchina.

sigillo **non** cattura direttamente gli eventi: li riceve da strumentazione esistente (OpenTelemetry / OpenInference) o dall'SDK. Il suo valore è firma, catena, ancoraggio ed export.

Fuori ambito per questa versione: verifica incrociata tra più fonti, cancellazione automatica per retention, HSM/KMS, multi-tenant, dashboard analitiche.

## 2. Architettura

Monorepo pnpm:

```
packages/core       libreria pura: schema, canonicalizzazione, hash, catena, firma, Merkle
                    NESSUN accesso a rete, disco o orologio: tutto passato come parametro
packages/verifier   CLI open source, dipende solo da core (+ openssl di sistema per RFC 3161)
apps/signer         processo separato che custodisce la chiave privata
apps/server         ingest, scrittura, checkpoint, marche temporali, export, UI minima
sdk-python/         pacchetto Python sottile (cartella separata, non workspace pnpm)
deploy/             Dockerfile, docker-compose.yml, Caddyfile
docs/               FORMAT.md, SECURITY.md, API.md
```

Principio chiave: **tutta la logica crittografica vive in `core`**. Server e verificatore usano esattamente lo stesso codice. Un revisore deve poter controllare ciò che conta leggendo solo `core` e `verifier`.

## 3. Stack e dipendenze consentite

- Node.js 22 LTS, TypeScript strict, pnpm workspaces, ESM
- Crittografia: solo `node:crypto` (SHA-256, Ed25519, scrypt)
- Dipendenze runtime consentite: `fastify`, `better-sqlite3`, `canonicalize` (RFC 8785), `zod`, `protobufjs`, `pdfkit`, `commander`
- Dipendenze di sviluppo consentite: `typescript`, `tsx`, `vitest`, `fast-check`, `@types/*`
- Python: `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http`; come extra opzionali `openinference-instrumentation-langchain`, `openinference-instrumentation-crewai`
- Qualsiasi altra dipendenza: chiedi prima.

## 4. Formato della ricevuta

Campi (tutti obbligatori salvo indicazione):

| campo | tipo | note |
|---|---|---|
| `v` | int | versione dello schema, parte da 1 |
| `system_id` | string | sistema AI a cui appartiene la catena |
| `seq` | int | progressivo per catena, parte da 0, senza buchi |
| `ts_event` | string ISO-8601 UTC | ora dichiarata dalla sorgente (non fidata) |
| `ts_received` | string ISO-8601 UTC | ora del server alla ricezione |
| `actor` | object | `{ agent: string, on_behalf_of?: string }` |
| `action` | object | `{ kind: "tool_call" \| "llm_call" \| "agent_step" \| "decision" \| "genesis", name: string }` |
| `input_hash` | string hex \| null | SHA-256 degli input canonicalizzati, se disponibili |
| `output_hash` | string hex \| null | SHA-256 dell'output canonicalizzato, se disponibile |
| `outcome` | `"ok" \| "error" \| "blocked" \| "unknown"` | |
| `source` | object | `{ type: "otlp" \| "sdk" \| "api", trace_id?: string, span_id?: string }` |
| `prev_hash` | string hex | impronta della ricevuta precedente; 64 zeri per la genesi |
| `key_id` | string | primi 16 caratteri hex di SHA-256 della chiave pubblica raw |
| `sig` | string base64 | firma Ed25519 dell'impronta della ricevuta |

Regole:
- **Impronta** della ricevuta = SHA-256 dei byte UTF-8 di `canonicalize(ricevuta senza il campo sig)`.
- **Firma** = Ed25519 su i 32 byte dell'impronta (`crypto.sign(null, hashBytes, privateKey)`).
- **Mai contenuti in chiaro** di prompt, argomenti o risultati: solo le loro impronte.
- La ricevuta di **genesi** (`seq = 0`, `action.kind = "genesis"`) contiene nel campo `action.name` il nome del sistema.
- Consulta la bozza IETF `draft-sharif-agent-audit-trail`. Se è raggiungibile, annota in `docs/FORMAT.md` le differenze con questo schema e proponimi eventuali allineamenti; se non lo è, procedi con lo schema qui sopra.
- `docs/FORMAT.md` documenta il formato in modo che chiunque possa reimplementare il verificatore senza leggere il nostro codice.

## 5. Catena e storage

- **Una catena per ogni `system_id`.**
- Scrittore unico: `seq` e `prev_hash` vanno assegnati **nella stessa transazione SQLite `IMMEDIATE`** in cui si inserisce la ricevuta. Mai in due passi.
- Tabella `receipts` con vincolo `UNIQUE(system_id, seq)`.
- Trigger `BEFORE UPDATE` e `BEFORE DELETE` su `receipts` che fanno `RAISE(ABORT, 'append-only')`. Stesso trattamento per le tabelle `checkpoints` e `timestamps`.
- SQLite in modalità WAL.

## 6. Firmatario separato (`apps/signer`)

- Processo autonomo in ascolto su un **socket Unix** locale. Protocollo JSON a righe.
- Metodi: `pubkey` → `{ key_id, public_key_base64 }`; `sign` → accetta solo esattamente 32 byte hex, restituisce la firma. Rifiuta qualsiasi altro input.
- Comando `signer keygen` che genera la chiave in un file con permessi `0600`.
- Il server **non** ha mai accesso al file della chiave. In Docker il volume della chiave è montato solo nel container del firmatario.

## 7. Checkpoint Merkle e marca temporale

- Ogni N minuti (default 60, configurabile) per ogni catena con ricevute nuove: costruisci un **albero di Merkle secondo RFC 6962** su tutte le impronte da `seq 0` fino all'ultima.
  - foglia = SHA-256(`0x00` ‖ impronta)
  - nodo interno = SHA-256(`0x01` ‖ sinistro ‖ destro)
  - per `n` foglie non potenza di 2, dividi al massimo `k` potenza di 2 con `k < n`, come da RFC 6962 §2.1
- Il **checkpoint** contiene `system_id`, `tree_size`, `root_hash`, `ts`, ed è firmato dal firmatario (impronta canonicalizzata come per le ricevute).
- **Prova di inclusione** RFC 6962 per qualsiasi ricevuta rispetto a qualsiasi checkpoint successivo.
- **Marca temporale RFC 3161** sulla `root_hash` di ogni checkpoint:
  - la richiesta `TimeStampReq` si costruisce con `openssl ts -query -sha256 -digest <hash> -cert -no_nonce`
  - invio via HTTP POST con `Content-Type: application/timestamp-query`
  - il token di risposta si salva così com'è (DER, base64 nel DB)
  - URL del fornitore via variabile d'ambiente `TSA_URL` (+ eventuali credenziali). In sviluppo e nei test usa `https://freetsa.org/tsr` (non qualificato). In produzione andrà un fornitore qualificato eIDAS: **quando arrivi qui fermati e chiedimi le credenziali**.
  - se la TSA non risponde, il checkpoint si salva comunque e la marca viene ritentata con backoff.

## 8. Ingest, SDK, export, UI, deploy

**Ingest (`apps/server`)**
- `POST /v1/traces` — OTLP/HTTP, **sia protobuf** (`application/x-protobuf`) **sia JSON** (`application/json`). Il protobuf serve: l'esportatore OTLP ufficiale Python manda solo protobuf. Decodifica con `protobufjs` usando i file `.proto` ufficiali di `opentelemetry-proto`, copiati nel repository in `apps/server/proto/` con licenza e versione annotate.
- **Adattatore a due dialetti**, isolato in un unico modulo con i suoi test:
  - OpenTelemetry GenAI: attributi `gen_ai.*` (`gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.agent.name`, `gen_ai.provider.name` oppure il vecchio `gen_ai.system`). Queste convenzioni non sono stabili: tollera nomi alternativi e registra quelli sconosciuti.
  - OpenInference: `openinference.span.kind` (`TOOL`, `LLM`, `AGENT`, `CHAIN`), `tool.name`, `input.value`, `output.value`.
  - Mappatura in ricevute: kind, name, input/output hashati (mai salvati in chiaro), outcome dallo status dello span, trace_id/span_id in `source`.
  - Span non riconducibili a un'azione AI vengono ignorati e contati.
- `POST /api/v1/receipts` — API nativa JSON validata con zod.
- **Autenticazione ingest**: una API key per `system_id`, salvata solo come hash scrypt. Header `Authorization: Bearer <key>`.
- Comandi di amministrazione CLI del server: creare un sistema, generare/revocare una API key.

**SDK Python (`sdk-python/`)**
- Pacchetto `sigillo` con una sola funzione pubblica: `sigillo.init(endpoint, api_key, system_id, instrument=["langchain", "crewai"])`.
- Configura `TracerProvider` + `OTLPSpanExporter` HTTP verso il server e attiva le instrumentazioni OpenInference richieste se installate.
- Esempio funzionante in `sdk-python/examples/` con un agente LangGraph minimo che usa un tool finto (niente chiamate a modelli reali nei test: usa un modello fittizio).

**Export (il fascicolo)**
- `POST /api/v1/exports` con `system_id` e intervallo → genera un archivio `.zip` contenente:
  - `receipts.jsonl` — una ricevuta per riga
  - `checkpoints.jsonl` — checkpoint dell'intervallo, con prove di inclusione della prima e dell'ultima ricevuta
  - `timestamps/` — token RFC 3161 grezzi
  - `manifest.json` — chiavi pubbliche, intervallo, conteggi, versione dello schema, versione di sigillo
  - `report.pdf` — generato con `pdfkit`: sistema, periodo, numero di azioni, esito della verifica, elenco dei checkpoint con marca temporale, istruzioni per la verifica indipendente, riferimento alle tre finalità dell'art. 12(2) AI Act
  - `VERIFY.md` — come verificare l'archivio con il verificatore open source e con `openssl ts -verify`

**Verificatore (`packages/verifier`)**
- `sigillo-verify <archivio.zip | cartella>`
- Controlli, in quest'ordine: schema valido; `seq` senza buchi e senza duplicati; ogni `prev_hash` corretto; ogni firma valida; ogni `key_id` presente nel manifest; ogni checkpoint firmato correttamente; radici Merkle ricalcolate coincidenti; prove di inclusione valide; token RFC 3161 validi per l'impronta attesa (via `openssl ts -verify`, se openssl è disponibile, altrimenti avviso esplicito).
- Al primo errore: indica **quale ricevuta o checkpoint** e **quale controllo**. Codice di uscita diverso da zero.
- Obiettivo di dimensione: meno di 1000 righe tra verifier e la parte di core che usa.

**UI web minima**
- HTML renderizzato dal server, niente framework frontend, niente build step.
- Pagine: elenco sistemi con stato della catena; ricerca ricevute per sistema/intervallo/azione; elenco checkpoint con stato della marca temporale; pulsante "genera fascicolo".
- Accesso con una singola password amministratore da variabile d'ambiente.

**Deploy (`deploy/`)**
- Dockerfile multi-stage per server e firmatario.
- `docker-compose.yml` con tre servizi: `server`, `signer`, `caddy`. Volume della chiave solo su `signer`. Volume condiviso solo per il socket. Database su volume persistente.
- `Caddyfile` con TLS automatico su dominio da variabile d'ambiente.
- Script di backup del database (copia consistente SQLite) verso una cartella configurabile.

**Documentazione (`docs/`)**
- `SECURITY.md` — una pagina: dove sta la chiave, cosa succede se il server viene compromesso, cosa il gestore del servizio può e non può vedere, limiti noti (sigillo certifica integrità, non completezza delle sorgenti).
- `API.md` — endpoint e formati.
- `README.md` nella root — cos'è, installazione in 5 minuti, esempio.

## 9. Milestone e criteri di accettazione

**M1 — Formato e impronta**
- Tipi e validazione zod della ricevuta in `core`.
- Funzioni `canonicalReceiptBytes`, `receiptHash`.
- File `packages/core/test/vectors.json` con almeno 10 ricevute e impronta attesa; test che le confronta.
- Test: chiavi in ordine diverso → stessa impronta; un carattere diverso → impronta diversa.

**M2 — Catena e storage**
- Storage SQLite append-only con trigger; inserimento transazionale.
- Test: tentativo di UPDATE/DELETE fallisce; 1000 inserimenti concorrenti sulla stessa catena producono `seq` 0..999 senza buchi né biforcazioni; catene di sistemi diversi indipendenti.

**M3 — Firmatario**
- Processo signer, keygen, protocollo socket, client in `core` o nel server.
- Test: firma verificabile con la chiave pubblica; input di lunghezza sbagliata rifiutato; il processo server non apre mai il file della chiave.

**M4 — Verificatore v1**
- Export minimale (`receipts.jsonl` + `manifest.json`) e CLI di verifica per catena e firme.
- **Test di manomissione**, ciascuno rilevato con messaggio preciso: byte modificato; ricevuta cancellata; due ricevute scambiate; ricevuta duplicata; firma con altra chiave; `key_id` assente dal manifest. Aggiungi test di proprietà con `fast-check`.

**M5 — Ingest OTLP e API nativa**
- `POST /v1/traces` protobuf + JSON, adattatore a due dialetti, API nativa, API key.
- Test con payload OTLP reali salvati come fixture (uno per dialetto, sia JSON sia protobuf).

**M6 — SDK Python**
- Pacchetto installabile in locale, esempio LangGraph con modello fittizio.
- Test end-to-end: server avviato, esempio eseguito, ricevute firmate presenti e catena verificabile.

**M7 — Merkle e marca temporale**
- Albero RFC 6962, checkpoint firmati, prove di inclusione, client RFC 3161 con retry.
- Test: vettori noti per radici Merkle di dimensioni 1..17; prova di inclusione valida per ogni foglia e invalida se alterata; token FreeTSA verificato con openssl (test marcato come "rete", saltabile offline).

**M8 — Fascicolo completo e verificatore v2**
- Archivio zip completo con PDF, checkpoint, token, `VERIFY.md`; il verificatore esegue tutti i controlli della sezione 8.
- Test: export → verifica OK; export manomesso in ciascun componente → verifica fallita con indicazione precisa.

**M9 — UI, deploy, documentazione**
- UI minima, docker-compose funzionante, backup, `SECURITY.md`, `API.md`, `FORMAT.md`, `README.md`.
- Criterio: da una macchina pulita, `docker compose up` + creazione di un sistema + esecuzione dell'esempio Python + export + verifica, in meno di un'ora seguendo solo il README.
- L'ambiente cloud potrebbe non permettere Docker. Prova; se non è disponibile, verifica tutto il percorso senza Docker (processi avviati direttamente), prepara comunque Dockerfile e `docker-compose.yml`, e scrivi in `PROGRESS.md` la checklist esatta dei comandi che eseguirò io su un computer o sul server per la verifica finale.

**Definizione di "finito"**: tutte le milestone in stato `fatto`, CI verde su GitHub Actions (lint, typecheck, test Node, test Python), e il percorso completo di M9 eseguito davvero almeno una volta, con l'output annotato in `PROGRESS.md`.
