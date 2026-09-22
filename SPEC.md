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

## Fase 2

> Le sottosezioni 1–6 che seguono sono copia integrale delle sezioni 1–6 del prompt che ha avviato la fase 2, ricevuto dal committente il 2026-09-22. Le milestone della sua sezione 7 e il fuori-ambito della sua sezione 8 sono in `PROGRESS.md`, come chiesto dal prompt stesso. Vale la stessa regola della sezione precedente: non va modificata se non per riflettere una decisione esplicita del committente.

### 1. Obiettivo della fase 2

La prima fase ha dimostrato che la matematica funziona. Questa fase deve rendere sigillo **comprensibile e utile per una persona non tecnica**: un responsabile compliance, un DPO, un ispettore.

Quattro risultati:
1. **Verifica di un documento**: carichi un file o incolli un testo, sigillo dice se è esattamente quello usato dall'AI, quando e in quale azione.
2. **Identità del modello** in ogni ricevuta: quale modello, e per i modelli locali quale file esatto.
3. **Interfaccia nuova** costruita attorno alle tre domande del responsabile compliance.
4. **Demo realistica**: un agente di selezione CV su modello locale, con uno scenario di ispezione simulata.

### 2. Formato della ricevuta, versione 2

Aggiungi due campi **opzionali**. Incrementa `v` a 2. Le ricevute `v: 1` devono restare verificabili senza modifiche: il verificatore applica le regole della versione indicata in ogni ricevuta. Aggiorna `docs/FORMAT.md` e i vettori di test (aggiungi vettori v2, non toccare quelli v1).

**`artifacts`** — elenco dei documenti coinvolti nell'azione, solo come impronta:
```
[{ "role": "input" | "output",
   "label": string,            // es. "curriculum", "email di risposta"
   "media_type": string,       // es. "application/pdf", "text/plain"
   "sha256": string hex }]     // SHA-256 dei byte grezzi del documento
```
- L'impronta è calcolata sui **byte esatti** del documento, senza canonicalizzazione (i documenti non sono JSON).
- Per i testi: byte UTF-8 esatti. Documenta chiaramente che uno spazio o un a capo in più cambiano l'impronta.
- Nessun contenuto e nessun nome di file che possa contenere dati personali: il `label` è una categoria scelta dallo sviluppatore, non il nome del file.

**`model`** — identità del modello per le azioni `llm_call`:
```
{ "name": string,              // es. "qwen2.5:3b", "gpt-4o"
  "provider": string | null,   // es. "ollama", "openai", "vllm"
  "digest": string | null }    // impronta del file del modello, se disponibile
```
- Ricava `name` e `provider` dagli attributi degli span: `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.provider.name` / `gen_ai.system` (OpenTelemetry) e `llm.model_name`, `llm.provider` (OpenInference). Tollera nomi alternativi come nella prima fase.

### 3. SDK Python

- **`sigillo.artifact(data, role, label, media_type=None)`**: accetta `bytes`, `str` o un percorso di file. Calcola SHA-256 **sul client** e allega l'impronta allo span corrente come evento `sigillo.artifact`. **Il documento non lascia mai la macchina del cliente.** L'adattatore del server trasforma questi eventi nel campo `artifacts`.
- **Digest dei modelli Ollama**: opzione `sigillo.init(..., ollama_url="http://localhost:11434")`. All'avvio e poi con cache, l'SDK legge l'elenco dei modelli da `GET /api/tags` e aggiunge agli span LLM l'attributo `sigillo.model.digest` con il digest del modello usato. Se Ollama non risponde, prosegue senza digest e lo registra nei log dell'SDK.
- **Estensione OpenAI**: aggiungi `"openai"` ai valori ammessi di `instrument`, usando `openinference-instrumentation-openai`. Serve per le aziende che chiamano direttamente un server compatibile OpenAI (Ollama, vLLM, llama.cpp) senza framework.
- Test: impronta calcolata sul client coincide con quella nella ricevuta; nessun byte del documento compare nel traffico verso il server (controllalo intercettando il payload OTLP nei test).

### 4. Verifica di un documento

**Nella pagina web**
- Pagina "Verifica un documento": carica un file oppure incolla un testo.
- **L'impronta si calcola nel browser** con Web Crypto (`crypto.subtle.digest('SHA-256', ...)`), e al server arriva solo l'impronta. Il documento non viene mai inviato. Questa è l'unica pagina in cui è ammesso JavaScript: uno script inline piccolo, senza librerie, senza build step. Scrivilo sulla pagina in una frase chiara: *"Il documento non lascia il tuo computer: calcoliamo solo la sua impronta."*
- Risultato trovato: *"✓ Questo documento è esattamente quello usato da [sistema] il [data] alle [ora], come [label], nell'azione [descrizione leggibile]. Non è stato modificato."* più il collegamento alla ricevuta e lo stato della marca temporale del checkpoint che la copre.
- Più corrispondenze: elencale tutte in ordine di tempo.
- Nessuna corrispondenza: *"Nessuna azione registrata ha usato questo documento. Se ne hai una versione diversa, anche un solo carattere cambia il risultato."*
- Indice su `sha256` degli artifacts per rendere la ricerca istantanea.

**Nel verificatore offline**
- Nuovo sottocomando: `sigillo-verify doc <fascicolo> <file>` che cerca il documento dentro il fascicolo e stampa lo stesso esito, senza server.
- Il fascicolo include un file `artifacts-index.jsonl` (impronta → ricevuta) e il verificatore controlla che l'indice sia coerente con le ricevute.
- Il PDF del fascicolo spiega in una sezione come un ispettore può verificare un documento con il verificatore.

### 5. Interfaccia nuova

Resta HTML generato dal server, senza framework e senza build step (eccezione: lo script della sezione 4). Un solo foglio di stile CSS scritto a mano, chiaro, leggibile, con tema chiaro e scuro, adatto anche al telefono. Interfaccia **in italiano**, con i testi raccolti in un unico file per poter aggiungere l'inglese in seguito.

La pagina principale risponde a tre domande, in quest'ordine.

**1. "È tutto a posto?"**
- Un semaforo per ogni sistema:
  - **verde**: catena verificata e ultimo checkpoint con marca temporale valida;
  - **giallo**: marca temporale in attesa, oppure nessuna attività da un periodo configurabile;
  - **rosso**: verifica fallita.
- Accanto, in parole normali: *"Registro integro. Ultimo sigillo 12 minuti fa. 1.243 azioni registrate questo mese."*
- Per mantenere il semaforo aggiornato: un controllo periodico in background che verifica la catena a partire dall'ultimo punto verificato (non da zero ogni volta).

**2. "Cosa ha fatto l'AI?"**
- Cronologia per sistema e per giorno, con ricerca per data e per tipo di azione.
- Ogni ricevuta mostrata come **frase leggibile**, generata da modelli di frase per tipo di azione. Esempi:
  - *"L'agente selezione-cv ha usato lo strumento leggi_curriculum per conto di m.rossi — completato."*
  - *"Il modello qwen2.5:3b (locale) ha generato una risposta — completato."*
  - *"L'agente ha tentato invia_email — bloccato."*
- Gli artifacts compaiono come etichette leggibili ("curriculum", "email di risposta").
- Tutto ciò che è tecnico (impronte, numero progressivo, firma, chiave, prova di inclusione) sta dentro un blocco `<details>` "Dettagli tecnici", chiuso di default.

**3. "Mi prepari le prove?"**
- Scelta del sistema e del periodo con un calendario, un pulsante "Genera fascicolo", e una spiegazione di una riga su cosa contiene.

Altre pagine: "Verifica un documento" (sezione 4); "Sistemi" (creazione di un sistema e della chiave d'accesso con spiegazione passo passo di come collegare un chatbot o un agente, incluso un esempio di codice copiabile).

Accessibilità di base: contrasto sufficiente, testi alternativi, navigazione da tastiera, nessuna informazione trasmessa solo con il colore (il semaforo ha anche la parola).

### 6. Demo: agente di selezione CV

Cartella `demo/selezione-cv/`, in Python, con la sua lista di dipendenze separata. Dipendenze ammesse per la demo: `langgraph`, `langchain-core`, `langchain-ollama`, più l'SDK sigillo.

**Scenario**
- 20 curriculum **inventati**, file di testo, in italiano, con nomi di fantasia, per una posizione di "sviluppatore backend junior".
- **Regole di punteggio neutre e dichiarate**: solo competenze ed esperienza pertinenti. Nessun uso di età, genere, provenienza, foto o altri attributi protetti. Scrivilo nel README della demo: una demo di selezione che discrimina sarebbe l'opposto di ciò che vendiamo.
- Tre strumenti:
  - `leggi_curriculum` — legge il file e lo allega come artifact `input` con label "curriculum";
  - `valuta_candidato` — produce punteggio e motivazione breve;
  - `invia_email` — scrive la mail di risposta in una cartella `outbox/` (niente invii reali) e la allega come artifact `output` con label "email di risposta".
- L'agente lavora "per conto di" un selezionatore di fantasia.

**Modello**
- Se `OLLAMA_URL` è impostato e raggiungibile: usa un modello piccolo via Ollama (es. `qwen2.5:3b` o equivalente leggero), con digest registrato.
- Altrimenti: **modello fittizio deterministico** con le stesse interfacce, così la demo gira ovunque, anche in CI.
- Nell'ambiente cloud prova a installare Ollama e scaricare il modello piccolo. Se non è possibile, usa il modello fittizio e scrivi in `PROGRESS.md` i comandi esatti che eseguirò io su un computer per la versione con modello reale.

**Script**
- `run_demo.sh` (e `run_demo.ps1` per Windows): crea il sistema in sigillo, esegue l'agente sui 20 curriculum, forza un checkpoint, stampa un riepilogo.

**Ispezione simulata** — file `demo/selezione-cv/ISPEZIONE.md`
- La storia: *"Il candidato n. 7 sostiene di essere stato scartato ingiustamente. L'ispettore chiede di dimostrare cosa ha fatto l'AI."*
- I passi, nella nuova interfaccia: trovare le azioni sul candidato n. 7 nella cronologia; caricare il suo curriculum in "Verifica un documento" e ottenere la conferma; caricare la mail ricevuta e ottenere la conferma; generare il fascicolo del giorno; verificarlo con il verificatore offline; modificare un carattere del curriculum e mostrare che la verifica non lo riconosce più.
- Deve poterlo seguire una persona che non ha mai visto sigillo.

**Copione video** — file `demo/selezione-cv/VIDEO.md`
- Un copione di circa 3 minuti per un video dimostrativo destinato a DPO e responsabili compliance: cosa si vede sullo schermo e cosa si dice, scena per scena. Zero parole tecniche nel parlato.
