# Sigillo: complete overview for AI analysts and new contributors

> **For AI assistants and analysts:** this is the single, self-contained overview of Sigillo (what it is, architecture, receipt format, what it records and does not, privacy, security, legal/business context, open items). It is written in Italian for the project owner; every important claim is labelled **[CODICE]** (verified in code), **[DOCUMENTI]** (from documents/decisions) or **[NON VERIFICATO]** (unverified). Start here, then read `docs/FORMAT.md`, `docs/SECURITY.md`, `docs/API.md`, `CLAUDE.md`. Snapshot of 2026-11-09 (`main` after PR #147); it can drift, so the code wins.

# SIGILLO: tutto quello che c'è da sapere

Scritto il 2026-11-09 leggendo da capo la repo GitHub `giovanniemilionoventa-byte/sigillo` (ramo `main` dopo la PR #147, commit `989f47a`), i documenti in `docs/`, la storia in `PROGRESS.md`, i file condivisi del progetto e la memoria del vecchio progetto.

Questo file è pensato per essere allegato a un nuovo progetto Claude e bastare da solo. Non contiene password, chiavi o token.

## 0. Come leggere questo file

Ogni affermazione importante ha una di queste tre etichette.

- **[CODICE]** l'ho letto nel codice o nei file di configurazione della repo il 2026-11-09. È il livello più sicuro.
- **[DOCUMENTI]** viene da documenti della repo, dalla memoria del progetto o dai file condivisi. È quello che è stato scritto o deciso, ma non l'ho potuto controllare nel codice (per esempio decisioni commerciali, o cose che stanno sul server).
- **[NON VERIFICATO]** non lo so con certezza. Va controllato prima di dirlo a un cliente o a un partner.

Regola per chi usa questo file: sui fatti importanti (privacy, cosa viene registrato, dati, server, prezzi, legale) rispondere solo se questo file o il codice lo confermano. Se non è certo, dire "non lo so con certezza" e controllare nella repo.

Una cosa che da qui non si può mai vedere: **cosa gira davvero sul server di produzione** (quale versione, quale file `.env`, se i backup sono partiti). La sessione cloud non raggiunge `get-sigillo.eu`. Tutto quello che riguarda il server vivo è [DOCUMENTI] o [NON VERIFICATO].

---

## 1. Come lavorare con Giovanni

[DOCUMENTI] Regole date da Giovanni (proprietario del progetto, non tecnico, italiano).

1. Aggiornamenti e risposte a lui in **italiano**, semplici e brevi. Codice, commenti, commit e documentazione tecnica in **inglese**.
2. Niente piani lunghi in file `.md` salvo che li chieda lui. Si spiega in chat in poche righe cosa c'è da fare, e si implementa dopo il suo OK. Se ha già detto di procedere, si procede.
3. Passi da copiare e incollare, piccoli, divisi per sistema operativo.
4. Le modifiche e le nuove funzioni vanno **direttamente a tutti gli account** (la regola "prima solo all'amministratore" è sospesa dal 2026-10-20, finché non ci sono i primi clienti). Gli interruttori hanno valore predefinito `all`.
5. Dopo ogni merge è lui che riavvia lo stack sul server (e ricarica Caddy se cambia il Caddyfile).
6. Niente esce verso l'esterno senza il suo OK esplicito: email, pubblicazione su PyPI o crates.io, nuove dipendenze fuori dalla lista approvata.
7. Testi per clienti e partner in **inglese**. Legge di riferimento europea (GDPR, AI Act).
8. Regola "memoria certa" (2026-11-09): mai rispondere a memoria o inventare sui fatti importanti.
9. Parole da usare: "tamper-evident", "independently verifiable". Parole da non usare mai: "tamper-proof", "compliant", "AI Act ready", "certified". Sigillo dà prove, non conformità.
10. Giovanni ha rifiutato qualsiasi "test" o canarino mostrato ai clienti dentro la console ("sembra truccato"). Non riproporlo. La prova è la documentazione e il progetto stesso.
11. La cassaforte delle chiavi (key vault) è sospesa: non riproporla se non la chiede lui.

---

## 2. Che cos'è Sigillo

Sigillo è un **registro di prove per agenti AI**. Ogni azione che un agente compie (chiamata a un modello, uso di uno strumento, passo dell'agente, decisione) diventa una **ricevuta firmata**, legata alla precedente come anelli di una catena. Periodicamente la catena viene sigillata con un **checkpoint** e con una **marca temporale** di un ente esterno. Il cliente può scaricare un **pacchetto di prove** (uno zip) e chiunque può controllarlo con un programma di verifica indipendente, senza fidarsi di Sigillo.

Frase del sito (inglese): "Prove what your AI did. When it matters most." [CODICE]

A chi serve [DOCUMENTI]: software house e consulenti che costruiscono agenti in Python per finanza, assicurazioni, risorse umane. Prima Italia e Spagna.

Il nome di lavoro della grafica della console è "Il filo e il sigillo". Dominio: `get-sigillo.eu`. Contatto sul sito: `team@get-sigillo.eu` [CODICE].

### Cosa dimostra e cosa no

Dimostra [CODICE + docs/SECURITY.md]:

- che una ricevuta non è stata modificata dopo la firma;
- che nessuna ricevuta è stata tolta, aggiunta o riordinata in mezzo alla catena;
- che la catena esisteva in quello stato a una certa ora (marca temporale esterna);
- che un documento o un testo corrisponde all'impronta registrata (comando `open` / `doc` del verificatore).

Non dimostra (limiti onesti, da dire sempre):

- **che la registrazione sia completa.** Un agente che non passa dal gateway, o che modifica l'SDK dentro il proprio processo, non viene registrato, e il battito può restare verde.
- **che quello che l'agente dichiara sia vero.** Chi ha una chiave valida può far firmare azioni inventate.
- **l'esito reale di un'azione esterna.** Si vede solo quello che l'agente riporta.
- **l'ora dell'evento dichiarata dall'agente** (`ts_event`): non è fidata. È fidata l'ora di ricezione, entro i limiti delle marche temporali.
- le marche temporali (FreeTSA e DigiCert) **non sono qualificate eIDAS**.
- se il server non è raggiungibile per più di circa 10 secondi, le azioni di quel periodo si perdono: non c'è una coda locale. Misurato: 60 secondi di interruzione a 20 azioni al secondo hanno perso tutte le 1192 azioni.
- una coda di catena tagliata alla fine si scopre solo confrontando con un pacchetto precedente (`--previous`).
- di chi è la chiave di firma si sa solo se si passa al verificatore il codice atteso (`--key-id`).
- un server compromesso può aggiungere ricevute false in fondo o aprire catene nuove, ma non può riscrivere quelle passate.

---

## 3. Architettura

### 3.1 La repo [CODICE]

Monorepo pnpm, Node 22, pnpm 10, TypeScript. 502 file tracciati, circa 132 file di test. Tutti i pacchetti Node sono alla versione 0.1.0.

```
packages/core            libreria pura: schema, forma canonica, hash, catena, firma, Merkle,
                         checkpoint, ancoraggio, export, manifest, zip, testo, privacy, chiavi.
                         Vietati rete, disco, orologio, variabili d'ambiente: tutto arriva come parametro.
packages/verifier        programma di verifica da riga di comando (sigillo-verify). Dipende solo da core
                         più openssl di sistema per le marche RFC 3161.
packages/sdk-typescript  SDK TypeScript/Node (@sigillo/sdk 0.1.0, zero dipendenze, privato)
apps/signer              processo separato che tiene la chiave privata e un suo registro di ogni catena
apps/keyholder           processo separato che tiene la chiave che apre le chiavi dei modelli
apps/server              ingresso dati, archivio, checkpoint, marche temporali, export, console, sito, gateway
sdk-python/              SDK Python (versione 0.12.0), cartella a parte, non nel workspace pnpm
deploy/                  Dockerfile, docker-compose.yml, Caddyfile, script di aggiornamento e backup
demo/                    agenti di esempio (selezione-cv, cv-screening)
video/                   script per registrare i video dalla console vera
design/                  materiali grafici
docs/                    API, FORMAT, SECURITY, DATA-INVENTORY, STORAGE-INVENTORY, DATA-PROTECTION,
                         DEPENDENCY-AUDIT, DEPLOY-PRODUZIONE, PROJECT-KNOWLEDGE, PROPOSTA-CONSERVAZIONE,
                         REVISIONE-FASE-1
SPEC.md, PROGRESS.md (4418 righe: cercare, non leggere tutto), CLAUDE.md, DEPLOY.md, PROVA-LOCALE.md
```

Tecnologie del server: Fastify, better-sqlite3 (SQLite), zod, protobufjs, pdfkit, canonicalize (RFC 8785), commander. Crittografia solo con `node:crypto`.

### 3.2 I quattro contenitori in produzione [CODICE: deploy/docker-compose.yml]

| contenitore | cosa fa | note |
|---|---|---|
| `signer` | tiene la chiave privata Ed25519 e firma | **nessuna rete** (`network_mode: none`), parla solo via socket Unix, 128 MB |
| `keyholder` | tiene la chiave RSA-3072 che apre le chiavi dei modelli dei clienti | volume e socket propri, 192 MB, il suo volume non entra nei backup |
| `server` | tutto il resto | 512 MB, espone solo la porta 8080 verso Caddy |
| `caddy` | HTTPS, porte 80/443, intestazioni di sicurezza | immagine 2.11.4-alpine |

Tutti in sola lettura, senza privilegi (`cap_drop: ALL`, `no-new-privileges`). Volumi: signer-key, signer-socket, keyholder-key, keyholder-socket, sigillo-data, backups, caddy-data, caddy-config. La password dell'amministratore arriva come file segreto.

Attenzione: i vecchi riassunti (SIGILLO-TUTTO.md, SIGILLO-CONOSCENZA-BREVE.md) parlano di tre contenitori. Dopo la PR #145 sono quattro.

### 3.3 Il firmatario (signer) [CODICE + docs/SECURITY.md]

- Chiave in un file con permessi 0600. Protocollo versione 2 con le richieste PUBKEY, SIGN_RECEIPT, CHECKPOINT, GET_HEAD, GET_RECEIPTS.
- Tiene un proprio stato e un proprio giornale per ogni catena, e **firma solo la ricevuta successiva** a quella che conosce. Per questo un server compromesso non può far riscrivere il passato.
- Tolleranza sull'orologio 300 secondi.
- Comando `init-from-db` per ricostruire lo stato dal database. Eventi `signer.recovered` e `signer.divergence`.
- Una sola chiave di firma per tutte le organizzazioni. Niente HSM o KMS.

### 3.4 Il custode delle chiavi (keyholder) [CODICE]

Aggiunto con la PR #145. Espone via socket: `GET /public-key`, `POST /adopt`, `ANY /call/<provider>/<percorso>`. Le chiavi dei modelli sono chiuse con AES-256-GCM, e la chiave AES è avvolta con RSA-OAEP-SHA256 (formato `box1`). Al primo avvio il server consegna al custode il vecchio file `llm-gateway.key` e lo cancella. Con `SIGILLO_KEY_VAULT=on` il custode non viene usato.

---

## 4. La ricevuta e la crittografia [CODICE + docs/FORMAT.md]

### 4.1 Campi della ricevuta

- `v` versione dello schema (da 1 a 4; oggi si scrive la 4)
- `system_id` (1-128 caratteri), `seq` numero progressivo
- `ts_event` ora dichiarata dall'agente (non fidata), `ts_received` ora di ricezione
- `actor` { `agent`, `on_behalf_of` }
- `action` { `kind`: `tool_call` | `llm_call` | `agent_step` | `decision` | `genesis`, `name` fino a 256 caratteri }
- `input_hash`, `output_hash` impronte di ingresso e uscita
- `outcome`: `ok` | `error` | `blocked` | `unknown`
- `source` { `type`: `otlp` | `sdk` | `api`, `trace_id`, `span_id` }
- `prev_hash` impronta della ricevuta precedente
- `key_id` primi 16 caratteri esadecimali dello SHA-256 della chiave pubblica
- `sig` firma (88 caratteri base64)
- dalla v2: `artifacts` e `model`; la v3 aggiunge il testo `sigillo-text/1`
- dalla v4: `input_hash_scheme` / `output_hash_scheme` = `plain` | `salted`

### 4.2 Come si firma

1. La ricevuta viene messa in forma canonica JSON (RFC 8785).
2. Se ne calcola lo SHA-256.
3. Si firma con Ed25519 sui 32 byte grezzi dell'impronta.

La catena parte dalla ricevuta `genesis` con `seq` 0 e `prev_hash` di 64 zeri.

### 4.3 Versione 4 (2026-10-01): privacy

- `on_behalf_of` è uno pseudonimo `psn_` + 32 caratteri esadecimali, non un nome in chiaro.
- Impronta salata: SHA-256(nonce di 32 byte ‖ forma canonica del valore). Senza il nonce non si può indovinare il contenuto per tentativi.
- Con la **chiave del cliente** (`customer_key`), il nonce è HMAC-SHA256(chiave, "sigillo-nonce-v1\n" + trace_id + "\n" + span_id + "\n" + ruolo). La chiave resta dal cliente; al server arriva solo la parola `customer`.
- Le ricevute v1-v3 possono contenere nomi di persone in chiaro. Nel database di produzione al 2026-10-02 ce n'erano 160, tutte di prova [DOCUMENTI].

### 4.4 Checkpoint e marche temporali

- Checkpoint: { `v`: 1, `system_id`, `tree_size`, `root_hash`, `ts`, `key_id`, `sig` }. Albero di Merkle secondo RFC 6962: foglia = SHA-256(0x00 ‖ hash), nodo = SHA-256(0x01 ‖ sinistra ‖ destra).
- Marca temporale RFC 3161 sulla radice. Richiesta: `openssl ts -query -sha256 -digest <radice> -cert -no_nonce`.
- Due enti [CODICE: docker-compose.yml]: `TSA_URL` predefinito `https://freetsa.org/tsr`, `TSA_URL_2` predefinito `http://timestamp.digicert.com`. Nessuno dei due è qualificato eIDAS.

### 4.5 Il pacchetto di prove (export)

Zip deterministico con: `receipts.jsonl`, `checkpoints.jsonl`, `artifacts-index.jsonl`, `timestamps/*.tsr`, `manifest.json`, facoltativi `openings.jsonl` e `subjects.jsonl`, `report.pdf`, `VERIFY.md`.

### 4.6 Il verificatore (`sigillo-verify`) [CODICE]

File principali: `cli.ts` (586 righe), `verify.ts` (780 righe), `timestamps.ts`. Fa 14 controlli: manifest, versioni, system_id, sequenza, genesis, prev_hash, firme, indice degli artefatti, aperture, firme dei checkpoint, radici Merkle, prove di inclusione, intervalli e conteggi, marche RFC 3161 via openssl, tempi di ancoraggio.

- Ancoraggio: errore se l'ora differisce di più di 5 minuti, errore se l'ordine è sbagliato, avviso se il ritardo supera 60 minuti.
- Opzioni: `--key-id`, `--previous`, `--strict`, `--tsa-ca`, `--clock-tolerance`, `--max-anchor-delay`.
- Comandi `doc` e `open`: rispondono MATCH o NO MATCH per un documento o un testo.
- Si scarica dal sito (`/sigillo-verify.zip`) e, dalla PR #145, anche dalle release GitHub (release "verifier", con SHA-256). Confrontare lo SHA-256 con quello su GitHub protegge dal caso "verificatore servito da un server compromesso".
- Dimensione: obiettivo iniziale meno di 1000 righe; il proprietario ha accettato la dimensione reale il 2026-09-21 (1792 righe). Regola attuale: leggibilità prima di tutto e nessuna crescita senza motivo.
- 18 scenari di manomissione provati in `apps/server/test/tamper.test.ts`.
- La sezione 12 di FORMAT.md confronta il formato con la bozza IETF `draft-sharif-agent-audit-trail`.

---

## 5. Come si collega un agente

### 5.1 Tre ingressi tecnici [CODICE + docs/API.md]

1. **SDK** (Python o TypeScript).
2. `POST /v1/traces`: OTLP (protobuf o JSON), dialetti GenAI e OpenInference.
3. `POST /api/v1/receipts`: API nativa.

La console da ottobre 2026 propone solo l'SDK, perché è l'unico con il battito (heartbeat). La risposta dell'ingresso contiene `sigillo{accepted, duplicates, ignored, unknown, rawContentHashed}`.

### 5.2 SDK Python 0.12.0 [CODICE: sdk-python/src/sigillo/]

```python
sigillo.init(endpoint, api_key, system_id, instrument=None, ollama_url=None,
             redact_content=True, salt_content=True, customer_key=None,
             heartbeat_seconds=60.0, show_sent=False, strict=False,
             on_halt=None, local_model=False)
```

- Funzioni pubbliche: `init`, `artifact`, `current_span_from_callbacks`, `pseudonym` (HMAC, `p:` + 32 esadecimali), `nonce_for`, e l'oggetto `Tracing` con `flush`, `shutdown`, `tool()`.
- Strumenta LangChain, CrewAI, OpenAI (tramite OpenInference) e la libreria standard ("stdlib": urllib, requests, httpx, scritture di file con pathlib/open). Non strumenta aiohttp né subprocess. Nella modalità stdlib la risposta del modello non viene registrata.
- Invio in secondo piano (BatchSpanProcessor): l'agente non aspetta Sigillo.
- **Il contenuto non parte mai in chiaro**: gli attributi di contenuto diventano impronte, passa solo una lista di attributi permessi, le eccezioni viaggiano solo come nome della classe.
- File: `__init__.py`, `_gateway.py` (indirizza i client verso il gateway, compreso mistralai), `_stdlib.py`, `_text.py`, `_watchdog.py`, `door.py`.
- **Non è su PyPI.** Si installa dallo zip della repo o dal pacchetto servito dal server.
- Dipendenze dichiarate: opentelemetry-sdk, opentelemetry-exporter-otlp-proto-http; facoltative le tre di OpenInference. Licenza dichiarata in `pyproject.toml`: Apache-2.0.

### 5.3 SDK TypeScript [CODICE]

`init({endpoint, apiKey, systemId})`, `SigilloSpanExporter`, supporto Vercel AI SDK, `tool()`, `artifact`, `pseudonym`, `customerKey` / `nonceFor`, battito e guardiano, modalità strict. Non ha la porta per i modelli locali né la strumentazione stdlib. Il server lo serve come `/sigillo-sdk.tgz`.

### 5.4 "Carica il tuo agente" nella console [CODICE: http/agent-setup.ts, agent-detect.ts]

Tutto avviene **nel browser**: il file dell'agente non viene caricato sul server. La pagina riconosce il linguaggio, inserisce la riga `sigillo.init(...)` e fa riscaricare il file modificato. Genera nel browser una chiave del cliente (32 byte casuali). Con la protezione attiva mette `strict=True`.

- Accetta: `.py, .ts, .mts, .cts, .tsx, .js, .mjs, .cjs, .jsx`.
- Python e Node/TypeScript sono **attivi nel codice**.
- Java e .NET sono sospesi: rispondono "coming soon" (interruttore `data-other-languages`, mai acceso).

**Discrepanza:** `docs/PROJECT-KNOWLEDGE.md` dice che anche il caricamento TypeScript è spento. Il codice di oggi dice di no: per i file Node/TS produce il file modificato. Vale il codice, e il documento è da correggere.

Nota di sicurezza: la chiave Sigillo del sistema finisce in chiaro dentro il file dell'agente. Vedi audit, punto 2.

### 5.5 Battito e guardiano [CODICE]

- L'SDK manda un battito ogni 60 secondi a `POST /api/v1/heartbeat` { sessione di 32 esadecimali, evento `start|beat|stop|ended|ping|gap`, più eventuale allarme }.
- Un **guardiano** (`_watchdog.py`) gira come processo separato (interprete avviato con `-I`). Segnala se l'agente è finito, se il computer è andato in sospensione o offline, o è stato riavviato.
- Il server scrive nella catena ricevute riservate: `sigillo.connection.start`, `.stop`, `.lost` (dopo 3 minuti senza battito), `.ended`, `.sleep`, `.offline`, `.power_off`, `.restored`, `.script_changed`.
- **Modalità strict:** il guardiano ricalcola l'impronta dello script, del pacchetto SDK e delle librerie OpenTelemetry/OpenInference; se cambiano ferma l'agente. L'agente esce con codice 70 se lo script cambia o dopo 3 battiti mancati.
- Limiti: 60 nuove sessioni l'ora, 24 "gap" l'ora.
- Limite noto [DOCUMENTI]: Ctrl-C viene registrato come `lost`. Dalla 0.11 "ended" e "lost" sono distinti; il caso preciso di Ctrl-C oggi è [NON VERIFICATO].
- I prefissi `sigillo.` e `model_requested.` sono riservati al server: un agente non può scrivere ricevute con quei nomi (PR #145).

---

## 6. Il gateway dei modelli ("More security")

[CODICE: apps/server/src/gateway/llm.ts, catalog.ts]

L'agente chiama il modello passando da Sigillo: `/llm/<provider>/<percorso>`. Così ogni chiamata viene registrata dal server, non da quello che l'agente dichiara.

**18 fornitori:** openai, anthropic, gemini, mistral, groq, openrouter, deepseek, xai, together, fireworks, perplexity, cohere, cerebras, moonshot, qwen, zai, nvidia, sambanova.

**Esclusi:** Azure OpenAI, AWS Bedrock, Google Vertex, Hugging Face, la libreria google-generativeai, xai_sdk (gRPC).

Come funziona:

- La chiave Sigillo si passa come Bearer, `x-api-key`, `x-goog-api-key` o `?key=`. Intestazione facoltativa `x-sigillo-agent`.
- Ogni POST (e ogni GET tranne l'elenco dei modelli) produce una ricevuta `llm_call`: nome = percorso del fornitore, modello, impronte salate di richiesta e risposta, sorgente `api`.
- La risposta normale torna all'agente **solo dopo** che la ricevuta è stata scritta; se non si riesce a scrivere, errore 503. La risposta in streaming passa subito e viene registrata alla fine. Una chiamata fallita o interrotta è registrata con esito `unknown`.
- Percorsi chiusi (403): realtime, client_secrets, sessions, auth_tokens, ephemeral, organization(s), admin_api_keys, api_keys, keys, projects, invites, users, credentials. Serve a non far uscire chiavi temporanee usabili fuori dal gateway.
- Quando il modello chiede uno strumento, il server scrive `model_requested.<strumento>` (`tool_call`, esito `unknown`).
- La chiave del fornitore viene controllata al salvataggio.
- **Il traffico del gateway attraversa la memoria del server in chiaro** (prompt e risposta). Non viene scritto su disco né nei log, ma passa. È l'unico punto in cui Sigillo "vede" il contenuto.
- Aggiunta di latenza misurata [DOCUMENTI]: circa 5-6 ms per chiamata non in streaming.
- Errori: 401, 403, 404, 409, 423, 415, 502, 503, 429.

### Chiavi dei modelli dei clienti

Salvate con AES-256-GCM (nonce 12 byte, dato associato = id del sistema + fornitore), visibili solo le ultime 4 cifre. Il server deve poterle aprire per chiamare il modello, quindi **"invisibili anche al server" non è vero** e non va promesso.

### Riconciliazione degli strumenti [CODICE: check/tool-reconcile.ts]

Ogni 60 secondi il server confronta gli strumenti che il modello ha chiesto (visti dal gateway) con quelli che l'agente ha registrato. Dopo 10 minuti di tolleranza scrive un allarme `sigillo.check.tool_unrecorded.<strumento>` (`agent_step`, esito `error`). Limiti: massimo 20 allarmi per sistema a giro; solo per i sistemi che dall'avvio del processo hanno registrato almeno uno strumento proprio; al riavvio i 10 minuti precedenti non vengono controllati; il confronto dei nomi è largo.

### Incoerenza nei documenti

`docs/API.md` dice ancora che il gateway "non è offerto nella console dal 2026-10-07" ed elenca solo 3 fornitori. Il codice e il compose dicono: gateway acceso per tutti (`all`) e 18 fornitori. Vale il codice.

---

## 7. La porta per i modelli locali (door)

[CODICE: sdk-python/src/sigillo/door.py]

Per chi usa un modello sul proprio computer (Ollama, LM Studio, llama.cpp, vLLM, Jan).

```
python -m sigillo.door --endpoint ... --system-id ... --upstream ... --port ... [--serve] [--with-parent]
```

- La porta ascolta sull'indirizzo abituale del modello: 127.0.0.1:11434 (Ollama), 1234 (LM Studio), 8080 (llama.cpp), 8000 (vLLM), 1337 (Jan).
- Controlla il token (confronto a tempo costante) e inoltra al modello, che viene spostato sulla porta successiva (per Ollama 11435).
- Solo Ollama può essere avviato automaticamente. Se Ollama è già aperto, la porta si apre accanto su una porta libera e viene registrato `sigillo.local_model.open`.
- Si attiva con `sigillo.init(local_model=True)`.

**Limite serio (audit, punto 1, non corretto):** la porta spostata (11435) **non ha autenticazione**. Un processo sulla stessa macchina può chiamare il modello direttamente o avviarne uno suo. La correzione proposta (porta casuale più allarme sull'uso estraneo) aspetta l'OK di Giovanni. Una garanzia forte richiede isolamento a livello di sistema operativo. **Non dire che la guardia è ermetica.**

---

## 8. Dati, privacy, cancellazione

### 8.1 Regola di base

Sigillo **non salva mai il testo** di prompt, argomenti degli strumenti o risposte. Salva solo le loro impronte SHA-256 (regola permanente n. 2 di CLAUDE.md).

### 8.2 Cosa vede e conserva [CODICE + docs/DATA-PROTECTION.md, DATA-INVENTORY.md, STORAGE-INVENTORY.md]

- Etichette: nomi di strumenti, agenti, modelli.
- Tipo di azione, esito, orari.
- Email dell'account e nome dell'azienda.
- Pseudonimi (`psn_...`).
- Impronte dei documenti: SHA-256 semplice, **non** protette dalla chiave del cliente. Chi ha il documento può confermare che è quello.
- Con il gateway: prompt e risposta passano in memoria, non restano.
- Il registro dell'amministratore conserva per sempre email e azienda di chi si è registrato.

Tabelle del database: systems, organizations, users, api_keys, transfer_links, receipts, checkpoints, timestamps, artifacts, signing_keys, export_register, connections, provider_keys, vaults, vault_schedule, admin_log, subjects, openings.

Log: una riga JSON per richiesta, senza query, intestazioni o corpo. Caddy cancella dai log `X-Api-Key` e `X-Goog-Api-Key`. Log Docker limitati a 10 MB per 5 file.

Comandi di controllo: `sigillo-server privacy inventory` (cosa conserva un'installazione) e `privacy scan` (cerca una frase in database, log e backup).

### 8.3 Come dirlo ("non conserviamo niente")

[DOCUMENTI] Versione ospitata: "non conserviamo mai il contenuto" (vero per progetto). "Non conserviamo niente del tutto" si può dire solo per un'installazione gestita dal partner o dal cliente.

### 8.4 Cancellazione [CODICE + docs/SECURITY.md]

- Un sistema con ricevute oltre la genesis **non si può cancellare**, solo archiviare (le chiavi archiviate vengono rifiutate con 401).
- Un sistema vuoto si cancella scrivendone l'id, con traccia nel registro amministratore.
- L'operatore può cancellare i propri sistemi di prova.
- Fine contratto: `sigillo-server org erase <id> --confirm <id>`.
- Una persona: `subject erase`, `openings erase` (con secure_delete).
- Le tabelle sono in sola aggiunta grazie a trigger, che però non fermano un DROP TABLE o la sostituzione del file.
- I backup conservano i dati cancellati fino alla rotazione (2 copie orarie locali, 30 fuori sede).
- **Non esiste conservazione automatica con scadenza.** Proposta in `docs/PROPOSTA-CONSERVAZIONE.md`: 6 mesi per il pilota, 12 per Standard. Non costruita, aspetta l'OK. Stime: circa 2 KB a ricevuta; 40 GB bastano per circa 10-12 anni-cliente Standard.

### 8.5 Separazione tra clienti

Applicata in `auth/tenancy.ts`, chiusa per impostazione predefinita. Però: una sola chiave di firma per tutte le organizzazioni, e chi è root sul server può leggere il database.

---

## 9. Accessi e sicurezza dell'applicazione [CODICE + docs/SECURITY.md]

- **Chiavi API Sigillo:** formato `sigillo_<16 esadecimali id>_<64 esadecimali segreto>`. Dal 2026-11-07 salvate come SHA-256 (le vecchie in scrypt migrano al primo uso). `docs/API.md` e `STORAGE-INVENTORY.md` dicono ancora "scrypt": testo vecchio. Blocco dopo 20 chiavi sbagliate al minuto.
- **Amministratore:** password di almeno 12 caratteri letta da file; 5 errori in 15 minuti bloccano per 5 minuti, raddoppiando fino a 60; limite globale; **secondo fattore facoltativo** a sei cifre (TOTP: `sigillo-server admin-code`, file `admin-code.key`). Se in produzione sia stato attivato è [NON VERIFICATO].
- **Sessione:** cookie HMAC, HttpOnly, SameSite=Strict; il segreto cambia a ogni riavvio (quindi un riavvio disconnette tutti, apposta). Protezione CSRF con Sec-Fetch-Site/Origin.
- **Account dei clienti:** Firebase, chiamato dal server (niente JavaScript di Firebase nel browser), accesso con email o Google, password di almeno 10 caratteri, email non verificata non entra, i nuovi aspettano l'approvazione dell'operatore (pagina "Clienti" o `org approve`).
- **Quote:** 10.000 ricevute al mese per organizzazione (`SIGILLO_ORG_MONTHLY_RECEIPTS`, poi 429), operatore senza limite; 3000 ricevute al minuto per sistema; massimo 100 sistemi per organizzazione.
- **Caddy:** CSP stretta (`default-src 'none'`, script solo propri più un hash, `frame-src` solo youtube-nocookie), HSTS, X-Frame-Options DENY, Referrer-Policy no-referrer, corpo massimo 16 MB, niente compressione su `/llm/*`.
- Piccolo difetto noto: `img-src 'self'` blocca la grana di sfondo (SVG `data:`).

### Audit di sicurezza del 2026-11-07

[DOCUMENTI] Audit statico "da attaccante" (nessuna prova sul server vivo). Corretto tutto ciò che era solo codice nella **PR #145, unita il 2026-11-07**:

custode delle chiavi in contenitore separato; zod aggiornato; verificatore pubblicato su GitHub con SHA-256; seconda marca temporale; il guardiano controlla anche le librerie OTel/OpenInference; allarme `tool_unrecorded`; limite globale e TOTP facoltativo per l'operatore; chiavi API in SHA-256; nomi riservati; limite di ricevute al minuto per sistema; percorsi del gateway chiusi.

**Ancora aperto:**

1. Porta del modello locale senza autenticazione (punto 1). Aspetta l'OK di Giovanni.
2. Una sola chiave Sigillo per sistema serve per ingresso, battito, gateway e porta, ed è in chiaro nel file dell'agente: l'AI può leggerla, falsificare battiti, consumare la quota. Mitigato in parte dai nomi riservati.
3. Modifica dell'SDK dentro il processo: la registrazione si spegne e il battito resta verde. Mitigato in parte dalla riconciliazione degli strumenti.
4. Cose che deve fare Giovanni sul server: SSH solo con chiave (oggi root anche con password: da chiudere), togliere l'aggiornamento automatico come root, rendere le copie fuori sede non cancellabili (oggi il token rclone può cancellarle).
5. Una chiave Sigillo di prova sta in chiaro in un file locale dell'agente di audit (fuori dalla repo): va revocata dalla console.

Verifiche esterne mai fatte [DOCUMENTI]: revisione indipendente del trattamento dati (2-4 giorni di un revisore), penetration test (3-5 giorni). Le tracce sono nel pacchetto per il partner.

---

## 10. Console e sito [CODICE]

### Sito pubblico

Pagine: `/` (home), `/verify`, `/privacy`, `/terms`, `/dpa`, `/blog` (10 articoli in inglese), `/sitemap.xml`, `/robots.txt`, `/sigillo-verify.zip`, `/healthz`.

- Solo inglese, salvo `SIGILLO_ITALIAN`. Tema scuro predefinito. Menu: How it works, Pricing, Verify, Privacy, Blog.
- Video YouTube `lTTV6yQlZd8` incorporato nella home.
- **Zona demo** separata con tre agenti di esempio (assistenza, fatture, selezione CV) e tutorial in 4 passi (PR #147). Dati finti, gira nel browser.
- Sezione AI Act: tabella con articoli 12, 14, 26, titoli ufficiali e riga della fonte (PR #146).
- Fatti dichiarati sul sito: "Server: Aruba, Italy", "Timestamp: freetsa.org, not eIDAS qualified", "Verifier: open source".

### Console (`/ui`)

Tre viste principali: **Stato** (`/ui`), **Azioni** (`/ui/actions`), **Prove** (`/ui/evidence`, con sigilli e modifiche). Poi: verifica di un pacchetto e di un documento, sistemi (collega, gestisci, checkpoint, chiave, chiave del modello, rinomina, trasferisci, archivia, elimina, esporta), impostazioni (tema, lingua, registro, esportazione giornaliera), clienti (approva, rifiuta, elimina), account, amministrazione (`/ui/admin`, servizio, sito), accesso e registrazione.

Trasferimento di un sistema: link valido 7 giorni, monouso.

### Interruttori [CODICE: apps/server/src/config.ts]

Valori `off | operator | all`. Nel codice il predefinito è `operator`, ma `docker-compose.yml` li mette tutti a `all`. Un valore nel file `.env` del server vince sul compose (cosa c'è nel `.env` di produzione: [NON VERIFICATO]).

`SIGILLO_LLM_GATEWAY`, `SIGILLO_LLM_TOOL_REQUESTS`, `SIGILLO_AGENT_UPLOAD`, `SIGILLO_SCRIPT_GUARD`, `SIGILLO_PLAIN_AGENTS`, `SIGILLO_AGENT_PROTECTION`, `SIGILLO_TRANSFER`, `SIGILLO_CONSOLE_V2`, `SIGILLO_RUNS`, `SIGILLO_EXTRA_KEYS`, `SIGILLO_EXPORT_REGISTER`, `SIGILLO_REPORT_LANGUAGE`, `SIGILLO_PACK_READER`, `SIGILLO_SITE_V2`.

`SIGILLO_KEY_VAULT` è `on | off`, predefinito `off` (cassaforte sospesa; con `off` gli indirizzi `/vault/*` rispondono 404).

Altre variabili: `SIGILLO_ITALIAN`, `SIGILLO_KEYHOLDER_SOCKET` / `_DIR`, `SIGILLO_SYSTEM_RECEIPTS_PER_MINUTE` (3000), `SIGILLO_ORG_MAX_SYSTEMS` (100), `SIGILLO_ORG_MONTHLY_RECEIPTS` (10000), `SIGILLO_BACKUP_KEEP` (2), `SIGILLO_OFFSITE_*`, `SIGILLO_AUTO_UPDATE_SCHEDULE`, `SIGILLO_ADMIN_CODE_FILE`, `TSA_URL`, `TSA_URL_2`.

### Comandi

- `sigillo-signer keygen | serve | init-from-db`
- `sigillo-server serve | system create/list/rename/archive/unarchive/delete | key create/list/revoke | admin-log | subject find/erase | openings erase | export (--subject, --open) | checkpoint | org create/approve/erase | privacy inventory/scan | signer check | admin-code`
- `sigillo-verify`

---

## 11. Server, aggiornamenti, backup

[DOCUMENTI: niente di questo è verificabile da qui]

- **Server:** VPS Aruba Cloud, 40 GB di disco, 4 GB di RAM, dominio `get-sigillo.eu`. Il sito dice "Aruba, Italy"; il data center esatto è [NON VERIFICATO].
- **Accesso:** SSH come utente `root` (il nome `ARU-...` è quello del pannello Aruba, non di SSH). Se SSH non va, c'è la console web di Aruba.
- **Dove sta la repo sul server:** `/root/sigillo/deploy` (non `/srv/sigillo` come dicono alcuni documenti).
- **Aggiornare:** `./update.sh` (fa git pull, ricostruisce, riavvia, ricarica Caddy, controlla l'hash della CSP, esegue `signer check`). **Mai `docker compose down -v`**: cancellerebbe i volumi, chiave di firma compresa.
- **Aggiornamento automatico** [CODICE: deploy/auto-update.sh]: un cron ogni minuto può tirare `main` ed eseguire `update.sh` come root. Segnalato come rischio alto. Se sia attivo in produzione è [NON VERIFICATO].
- **Backup locale** [CODICE: deploy/backup.sh]: ogni ora, tiene 2 copie.
- **Backup fuori sede** [CODICE: deploy/offsite-backup.sh]: ogni giorno alle 03:30, cifrato con `age` (chiave pubblica), spedito con `rclone`, tiene 30 copie, fallisce se la copia locale più recente ha più di 6 ore. La chiave di firma non è nel backup.
- Attivo dal 2026-10-18 [DOCUMENTI]: Google Drive di un account dedicato, rclone remoto `box`, cartella `sigillo-backup`, impostazioni in `/etc/sigillo-offsite.env`, log in `/srv/sigillo-offsite.log` e `/srv/sigillo-backup.log`.
- **La chiave privata `age` ce l'ha solo Giovanni** (gestore di password). Serve solo per ripristinare. Se si perde, i backup fuori sede sono inutilizzabili.
- Un token rclone è stato una volta incollato in una chat (rischio basso, account solo per i backup). Revocarlo ferma il backup finché non si rifà `rclone config reconnect`.
- **Mai fatto:** confermare che il cron sia partito nei giorni successivi; provare un ripristino vero su una macchina di riserva.
- Se lo stack sia stato riavviato dopo le PR #145, #146, #147 è [NON VERIFICATO]. Attenzione: la #145 aggiunge un contenitore (keyholder), quindi il primo aggiornamento dopo di essa è più delicato del solito.
- Guide: `docs/DEPLOY-PRODUZIONE.md` (backup al punto 6.1), `DEPLOY.md`, `PROVA-LOCALE.md`.

---

## 12. Legale e commerciale

### 12.1 Modello [DOCUMENTI]

- **Nessuna società, per ora.** Sigillo è software **dato in licenza a un partner**, che lo rivende in abbonamento. Catena: licenziante (Giovanni) → partner → clienti.
- Si cerca ancora un partner con una società. Si è parlato di una divisione dei ricavi intorno al 50%, da decidere dopo i piloti.
- Il partner diventa responsabile verso i suoi clienti, quindi vuole prove solide che Sigillo non conservi dati dei clienti.
- Due modi possibili (da `mercato-europeo/COSA-MANCA-PER-VENDERE.md`): A, ospitato da Giovanni; B, gestito dal partner.

### 12.2 Polina [DOCUMENTI]

Contatto partner: vendite, non tecnica, parla inglese. Fa ricerca di mercato e trova clienti. Per lei sono state preparate schede di risposta (PDF del 9 novembre 2026: domande generali con una sezione sanità, e la riunione con **Comet**, l'azienda che fa Opik). Intervista con Polina fissata per **domenica 2026-11-15**. Com'è andata la riunione con Comet e cosa è stato deciso: [NON VERIFICATO].

Nelle schede restano punti segnati "[TO CONFIRM]": licenza, latenza misurata, data center esatto, durata del pilota, piano di continuità, ragionamento sul prezzo, trasferimento dati di Firebase, parere sul regolamento dispositivi medici.

### 12.3 Prezzi (provvisori)

| piano | prezzo | cosa comprende |
|---|---|---|
| Pilot | gratis | 10.000 ricevute al mese; "pagato" con un caso di studio, feedback e un contatto |
| Standard | 190 € al mese + IVA | 100.000 ricevute, sistemi illimitati, pacchetti di prove giornalieri, backup cifrato fuori sede 30 giorni |
| Custom | su richiesta (da circa 490 € al mese) | server dedicato, ente di marca temporale a scelta, contratto e SLA |

Pilot e Standard sono [CODICE] (testo del sito). Il "da 490 €" è [DOCUMENTI]. Nota: il codice applica oggi una sola quota (10.000 al mese per organizzazione); il limite di 100.000 del piano Standard e la fatturazione **non sono costruiti**.

### 12.4 Termini, DPA, privacy [CODICE: http/site-legal.ts, site-privacy.ts]

`/terms` e `/dpa`: "Version 1.0, 2 November 2026", **provvisori**. Catena Licensor → Partner → Customer; responsabilità limitata ai compensi di 12 mesi; preavviso 30 giorni; legge italiana ed europea; notifica di violazione al partner entro 48 ore; cancellazione entro 30 giorni più altri 30 per i backup. Sub-responsabili elencati: Aruba (Italia), Google Drive (file cifrato), accesso Google, FreeTSA.

Incoerenze da correggere:

- I Termini dicono che il database viene copiato "ogni due ore"; lo script lo copia ogni ora e tiene 2 copie.
- Il DPA elenca solo FreeTSA; dalla PR #145 c'è anche DigiCert come secondo ente.
- Il sito dice "Verifier: open source" e "open-source verifier" in circa 6 punti, ma **nella repo non c'è un file LICENSE** (solo le licenze dei font). Solo l'SDK Python dichiara Apache-2.0. Senza licenza, legalmente non è open source.
- Se la repo sia pubblica o privata oggi è [NON VERIFICATO]: PROGRESS.md e SIGILLO-TUTTO dicono pubblica, il pacchetto per il partner dice "disponibile per revisione su richiesta".

Il DPA va fatto vedere a un avvocato. Non c'è ancora il contratto di licenza con il partner. Non risulta una casella di accettazione dei termini alla registrazione [NON VERIFICATO fino in fondo].

### 12.5 AI Act ed eIDAS [DOCUMENTI]

- Sigillo dà **prove**, utili per gli obblighi di registrazione (art. 12), sorveglianza umana (art. 14) e obblighi di chi usa il sistema (art. 26). Non rende "conformi".
- Sanzioni AI Act per questi obblighi: fino a 15 milioni di euro o 3% del fatturato.
- Il "Digital Omnibus" potrebbe spostare gli obblighi per l'alto rischio al 2 dicembre 2027 e al 2 agosto 2028. Il vecchio riassunto cita "Reg. 2026/1744": numero e date sono [NON VERIFICATO], da ricontrollare su fonte ufficiale prima di usarli.
- Il rischio più vicino per i clienti è il GDPR.
- **eIDAS:** le marche non sono qualificate. Una marca qualificata o un sigillo elettronico aziendale richiede una società. Decisione del 2026-09-21: aspettare. Prezzi raccolti a ottobre [NON VERIFICATO oggi]: InfoCert tramite Openapi circa 0,07-0,10 € a marca; SK ID circa 36 € al mese per 1000.

### 12.6 Mercato e concorrenti [DOCUMENTI, dati di ottobre 2026]

- Concorrenti che vendono anche loro ricevute firmate: Elydora, Agnys, Sigill.ai.
- Vantaggio di Sigillo: registra l'agente così com'è, l'agente non può tenere la chiave né zittire il registratore, guardia sia per modelli cloud sia locali, collegamento in un passo, taglio europeo.
- Uso dell'AI nelle imprese 2025 (Eurostat): UE 20,0%, Italia 16,4%, Spagna 20,3%. Stima del mercato raggiungibile: 500-1.500 aziende. Scenari economici a 150k/300k/450k giudicati deboli.
- Email inviate il 2 ottobre a We Will, Impesud, Algoretico, ControlIA. Video di presentazione preparati per HiLabs, Anomity, Aibound, Murmu. Esiti: [NON VERIFICATO].
- Raccomandazione scritta: restare un prodotto solo, "la prova", non allargarsi al "controllo" (`mercato-europeo/PRODOTTO-SINGOLO-O-ECOSISTEMA.md`).
- Reddit (r/AgentsOfAI), risposte in `reddit/RISPOSTA-POLINA.md`: firma circa 0,06 ms; percorso di una ricevuta circa 6 ms (mediana), 10 ms (p95); 150-230 ricevute al secondo per sistema; nessuna integrazione SIEM.

### 12.7 Cosa manca per vendere [DOCUMENTI]

Fatto nel frattempo: pagine Termini e DPA, email di contatto, secondo fattore (facoltativo).

Ancora da fare: contratto di licenza, avvocato e commercialista, casella di accettazione alla registrazione, file LICENSE, rapporto d'uso e fatturazione, livello "partner" nella console, marchio bianco, campo del codice chiave nella pagina pubblica `/verify`, convenzione per le approvazioni umane (`approval.requested / granted / denied`, non costruita), coda locale, pubblicazione su PyPI, conservazione automatica, prodotto self-hosted.

Self-hosted (`self-hosted/PROPOSTA-SELF-HOSTED.md`): A istanza dedicata 3-5 giorni, B pacchetto Docker 2-3 settimane, C "testimone" 4-6 settimane. Decisione: non costruire ora.

---

## 13. Storia in breve [DOCUMENTI: PROGRESS.md]

- Tappe M1-M9, N1-N6, D1, S1, A1, P1, V1, B, R1, D2 tutte "fatto". Fasi pilota 1-11 fatte.
- 2026-09-21: formato v1 definitivo, marca qualificata rimandata, dimensione del verificatore accettata.
- 2026-10-01: formato v4 (pseudonimi e impronte salate).
- Ottobre: strumentazione stdlib (SDK 0.3-0.4), link di trasferimento, porta per modelli locali (0.5), prove d'attacco sul gateway (18 test), 18 fornitori (0.6), blog, nuova console (Stato/Azioni/Prove), amministratore e utenti equiparati e connettore Claude Code rimosso (PR #87), backup fuori sede con un comando, porta per tutti i server locali (0.7), nuova home per tutti (20 ottobre), cassaforte costruita (PR #102, #107) e sospesa il 23 ottobre (PR #112), pacchetto per il partner e comandi privacy (PR #103), chiave del cliente (0.9, PR #105), guardiano che distingue "finito" da "perso" (0.11), SDK TypeScript (31 ottobre).
- Novembre: demo dal vivo nella home (PR #135, #141; la #139 annullata), Termini e DPA (2 novembre), correzioni dell'audit (PR #145, 7 novembre), sezione AI Act (PR #146), zona demo (PR #147).
- Ultimo conteggio dei test annotato: 1270 test Node. Non rieseguiti oggi [NON VERIFICATO].

### Pull request

- **Unite di recente:** #145, #146, #147. `main` è al commit `989f47a`.
- **Aperte oggi (controllato su GitHub il 2026-11-09):**
  - #144 "Add offline call simulator for partner call practice": in attesa di decisione.
  - #129 "Update zod to 4.6.6": **non serve più**, l'aggiornamento è già dentro la #145. Si può chiudere.
- **Chiuse senza unirle (i rami restano):** #127, #122, #121, #117 (SDK Rust; dipendenze ureq, ring, unicode-normalization mai approvate; ramo `claude/project-thread-6olagu`), #109, #93, #91, #88.

### Discussioni del vecchio progetto in attesa di Giovanni

"Audit di sicurezza come hacker" (punto 1), "Semplificare scarico prove per agente", "Rendere la demo una zona a sé", "Ricostruire la memoria di Sigillo dai file".

---

## 14. Elenco delle cose aperte

Decisioni che aspettano Giovanni:

1. Porta del modello locale: porta casuale più allarme (audit punto 1).
2. Conservazione automatica a 6 o 12 mesi.
3. Campo del codice chiave nella pagina pubblica `/verify`.
4. PR #144 (simulatore di chiamata): unire o chiudere. PR #129: chiudere.
5. Quale licenza mettere nella repo, oppure togliere "open source" dal sito.

Cose che solo Giovanni può fare:

1. Revocare la chiave di prova dell'agente di audit.
2. SSH solo con chiave.
3. Togliere o limitare l'aggiornamento automatico come root.
4. Copie fuori sede non cancellabili.
5. Provare un ripristino del backup e controllare che il cron giri.
6. Avvocato per DPA e contratto di licenza.

Sospese (non riproporre): cassaforte delle chiavi, SDK Rust, caricamento Java/.NET, test mostrati ai clienti nella console, prodotto self-hosted, marca qualificata eIDAS.

Documenti da riallineare al codice: `docs/API.md` (gateway, 3 fornitori, scrypt), `docs/STORAGE-INVENTORY.md` (scrypt), `docs/PROJECT-KNOWLEDGE.md` (caricamento TypeScript, zod, secondo fattore), Termini (backup "ogni due ore"), DPA (manca DigiCert), sito ("open source").

---

## 15. Regole della repo (CLAUDE.md) [CODICE]

1. Codice crittografico: prima il test che fallisce, poi l'implementazione. Mai simulare le primitive crittografiche nei test.
2. Mai salvare in chiaro prompt, argomenti o risposte: solo SHA-256.
3. Mai cambiare il formato della ricevuta senza aumentare `v`; le versioni vecchie restano verificabili.
4. `packages/core` resta puro.
5. Il verificatore resta piccolo e leggibile. Una modifica che aggiunge più di circa 100 righe va annotata in PROGRESS.md.
6. Nessuna dipendenza fuori dalla lista approvata senza chiedere.
7. Inglese per codice e documenti tecnici, italiano per gli aggiornamenti al proprietario.
8. A fine tappa: test verdi, PROGRESS.md aggiornato, commit e push.
9. Mai fermarsi con lavoro non salvato: push e pull request verso `main`.
10. Mai push diretto su `main`.
11. "Prima all'amministratore": sospesa dal 2026-10-20.

**Dipendenze approvate.** Node: fastify, better-sqlite3, canonicalize, zod, protobufjs, pdfkit, commander. Sviluppo: typescript, tsx, vitest, fast-check, @types/*, playwright-core. Solo CI: pip-audit. Python: opentelemetry-sdk, opentelemetry-exporter-otlp-proto-http, facoltative openinference-instrumentation-langchain / -crewai / -openai.

**Comandi** (dalla radice della repo):

| comando | cosa fa |
|---|---|
| `pnpm install` | installa |
| `pnpm lint` | regole di architettura (purezza di core, lista dipendenze, niente `.only`, niente `any`, niente chiavi nell'albero) |
| `pnpm typecheck` / `pnpm build` / `pnpm test` | controllo tipi, compilazione, test |
| `pnpm check` | tutti e quattro in fila |
| `node scripts/smoke-dist.mjs` | prova il pacchetto compilato |
| `python3 scripts/crosscheck_vectors.py` | ricalcola i vettori di prova con un'implementazione Python indipendente |
| `pnpm tsx scripts/gen-vectors.ts` | rigenera i vettori |
| `pnpm tsx scripts/screenshots.ts` | rigenera le schermate |
| `pnpm tsx video/registra.ts tutto && video/monta.sh` | registra il video dimostrativo |
| `pnpm audit:deps` | controllo vulnerabilità note |

CI: `ci.yml` (lint, tipi, build, test, prova del compilato, controllo Python), `dependency-audit.yml` (a ogni push e ogni lunedì), `verifier-release.yml` (pubblica `sigillo-verify.zip` con SHA-256).

---

## 16. Materiali fuori dalla repo [DOCUMENTI]

File condivisi del vecchio progetto (`/mnt/project-files/`). Se il vecchio progetto viene cancellato, **questi file vanno salvati prima**, perché non sono nella repo:

- `SIGILLO-TUTTO.md` (16 ottobre) e `SIGILLO-CONOSCENZA-BREVE.md`: vecchi riassunti, in parte superati (3 contenitori, SDK 0.6, "nessun secondo fattore", PR #129 aperta). Questo file li sostituisce.
- `Polina-cheat-sheet-questions-answers.pdf`, `Polina-cheat-sheet-Comet-meeting.pdf`
- `partner-assurance/` (pacchetto di garanzie per il partner, con elenco dei sub-responsabili e domande per l'avvocato), `partner-call-kit/`
- `mercato-europeo/`, `reddit/`, `privacy-contratti/`, `self-hosted/`, `sigillo-eventi-approvazioni/`, `cifratura/`, `rust/`
- `formazione/` (corso in italiano, 50 minuti, 102 diapositive), `video-sito/`, `demo-interattiva/`, `demo-documenti/`, `design-landing/`, `prova-ollama/` (prova su Windows)
- `audit-agent/` (agente di audit locale; **contiene la chiave da revocare**)

Google Drive:

- Due cartelle (preparazione partner, video email): gli id sono nella memoria del progetto, non qui.

Il kit per le chiamate e il corso sono del 27 ottobre e 2 novembre: alcuni fatti dentro possono essere superati.

---

## 17. Riepilogo di ciò che NON è verificato

1. Quale versione gira su `get-sigillo.eu` e cosa c'è nel suo `.env`.
2. Se lo stack è stato riavviato dopo le PR #145-#147.
3. Se cron, backup locale e backup fuori sede girano; nessun ripristino è mai stato provato.
4. Se l'aggiornamento automatico è attivo sul server.
5. Se il secondo fattore dell'amministratore è stato attivato.
6. Se tutti i test passano oggi (ultimo numero annotato: 1270).
7. Se la repo GitHub è pubblica o privata.
8. Data center esatto di Aruba.
9. Esito degli incontri con Polina e con Comet, e delle email e dei video inviati.
10. Numero e date del regolamento "Digital Omnibus"; prezzi delle marche qualificate.
11. Dati sui concorrenti (sono di ottobre 2026).
12. Se alla registrazione c'è un'accettazione dei termini.
13. Come viene registrato oggi un Ctrl-C.

---

## 18. Piccolo glossario

- **Ricevuta:** la registrazione firmata di una singola azione.
- **Catena:** le ricevute di un sistema, ognuna legata alla precedente.
- **Sistema:** un agente (o un gruppo) con la sua catena e la sua chiave Sigillo.
- **Checkpoint / sigillo:** la firma periodica sull'intera catena fino a quel punto.
- **Marca temporale:** la prova, data da un ente esterno, che il checkpoint esisteva a quell'ora.
- **Pacchetto di prove:** lo zip che si scarica e si verifica.
- **Verificatore:** il programma indipendente che controlla il pacchetto.
- **Gateway:** il passaggio obbligato delle chiamate ai modelli cloud.
- **Porta (door):** lo stesso, per i modelli locali.
- **Battito / guardiano:** i segnali che dicono se l'agente è ancora collegato.
- **Chiave del cliente:** il segreto che resta dal cliente e rende le impronte non indovinabili.
- **Operatore / amministratore:** l'account di Giovanni, senza organizzazione.
