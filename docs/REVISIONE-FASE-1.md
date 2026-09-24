# Revisione tecnica pre-produzione — Fase 1

Data: 2026-09-24 · Base: `main` @ `80b750b` · Nessuna modifica al codice in questa fase.

Questo documento è il rapporto della Fase 1 del piano "dalla repository attuale al
primo pilot". È scritto per il committente; i riferimenti a file e righe sono allo
stato di `80b750b`.

## Come è stata fatta

- Lettura integrale di `packages/core`, `packages/verifier`, `apps/server`,
  `apps/signer`, `sdk-python`, `demo/selezione-cv/agent.py`, `deploy/`, `docs/`,
  CI e `scripts/lint.mjs`.
- Esecuzione di tutti i controlli esistenti (risultati in fondo).
- **Ogni problema indicato come "riprodotto" è stato dimostrato con uno script
  eseguito contro il codice compilato (`dist/`)**, con Ed25519 e SQLite reali,
  senza mock. Lo script è rimasto fuori dal repository: nelle fasi di correzione
  ogni riproduzione diventerà un test che fallisce prima della correzione
  (regola 1 di `CLAUDE.md`).
- `pnpm audit`, `pnpm outdated`, `pip-audit` sulle dipendenze.
- `docker compose config` sui file di deploy. **Docker non è stato eseguito**: in
  questo ambiente il demone non è disponibile. Il deploy resta non verificato.

## Riepilogo

| # | Problema | Gravità | Stato |
|---|---|---|---|
| 1 | Firma sbagliata salvata per sempre dopo un timeout del signer | **ALTA** | riprodotto |
| 2 | La revoca di una API key da CLI non ha effetto sul server in esecuzione | **ALTA** | riprodotto |
| 3 | La documentazione promette più di quanto la verifica garantisca | **ALTA** | riprodotto |
| 4 | Gli export per intervallo di date non legano le marche temporali alle ricevute | **ALTA** | riprodotto |
| 5 | Prompt, output e documenti arrivano in chiaro al server (non sono salvati) | **ALTA** (privacy) | verificato nel codice |
| 6 | Un batch OTLP a metà fallito lascia ricevute scritte e i retry le duplicano | MEDIA | riprodotto |
| 7 | Rotazione o perdita della chiave: le ricevute vecchie diventano non verificabili | MEDIA | verificato nel codice |
| 8 | L'ora vera della marca temporale (genTime) non viene mai mostrata | MEDIA | verificato nel codice |
| 9 | Export per data: con l'orologio che torna indietro l'archivio ha un buco | MEDIA | riprodotto |
| 10 | Nessun limite ai tentativi (login e ingest); scrypt blocca il processo | MEDIA | riprodotto |
| 11 | Il server non si riconnette al signer riavviato; `/healthz` dice "ok" | MEDIA | verificato nel codice |
| 12 | Cookie di sessione senza `Secure`, non revocabile; pagine senza `no-store` | MEDIA | verificato nel codice |
| 13 | Scritture fuori dalla coda di scrittura (marche temporali, API key) | MEDIA-BASSA | verificato nel codice |
| 14 | Nessun controllo automatico delle dipendenze; dipendenze Python non bloccate | MEDIA | verificato |
| 15 | Hardening dei container incompleto; backup sullo stesso host; chiave senza backup | MEDIA | verificato nei file |
| 16 | Variabili numeriche non validate (`NaN` → checkpoint ogni millisecondo) | BASSA-MEDIA | verificato nel codice |
| 17 | Lettore ZIP del verificatore: niente limite di decompressione, nomi duplicati | BASSA | verificato nel codice |
| 18 | Campi testuali: dati personali in chiaro, firmati e non cancellabili | da decidere (Fase 4) | verificato nel codice |
| 19 | Impronte di valori a bassa entropia ricostruibili per tentativi | da decidere (Fase 4) | verificato nel codice |
| 20 | Minori (errori HTTP, log con query string, CSRF, surrogati UTF-16) | BASSA | verificato nel codice |

## Cosa funziona ed è stato verificato

Da non riscrivere. Tutto quanto segue è stato letto e, dove indicato, rieseguito.

- **Canonicalizzazione RFC 8785** (`canonicalize`), impronta = SHA-256 della forma
  canonica senza `sig`, firma Ed25519 con `node:crypto`: corretti. Il cross-check
  Python indipendente rideriva i 20 vettori. Schemi zod `strict`, base64 canonico,
  timestamp ISO validati come istanti reali.
- **Merkle RFC 6962**: radice, prove di inclusione e ricostruzione (con controllo
  della lunghezza del percorso) sono corretti; test di proprietà presenti.
- **Catena e storage**: `seq` e `prev_hash` assegnati nella stessa transazione
  `IMMEDIATE`; `UNIQUE(system_id, seq)` e `UNIQUE(hash)`; trigger append-only su
  `receipts`, `checkpoints`, `timestamps`, `artifacts`; WAL con `synchronous=FULL`.
- **Signer**: chiave `0600` imposta e controllata al caricamento, `keygen` non
  sovrascrive, socket `0660`, richieste validate in modo stretto, righe limitate a
  4 KB. Il server non contiene codice capace di leggere una chiave (lint + test).
- **Web**: ogni valore che arriva nell'HTML passa da `escape()`; nessun HTML in
  `strings.ts`; CSP con hash dello script (in Caddy); `X-Frame-Options`,
  `nosniff`, HSTS; cookie `HttpOnly; SameSite=Strict`; confronto della password a
  tempo costante; password di almeno 12 caratteri.
- **Deploy (statico)**: solo Caddy pubblica porte (80/443); il server usa solo
  `expose`; il signer ha `network_mode: none`; entrambi girano come utente `node`.
- **Dipendenze di produzione**: nessuna vulnerabilità nota (`pnpm audit --prod`).

## Problemi trovati

Per ciascuno: file, cosa succede, modifica proposta, rischio della modifica,
test necessari.

### 1. Firma sbagliata salvata per sempre dopo un timeout del signer — ALTA

**File.** `apps/server/src/signer/client.ts:179-192` (timeout), `:140-167`
(abbinamento delle risposte); `apps/server/src/storage/store.ts:518-521` (ricevute)
e `:434-435` (checkpoint).

**Cosa succede.** Le risposte del signer sono abbinate alle richieste in ordine.
Dopo 5 secondi senza risposta il client fa fallire le richieste in attesa ma
**non chiude la connessione**. Se il signer si era solo bloccato (pausa, swap,
host sovraccarico), la sua risposta in ritardo arriva dopo, e il client la
consegna **alla richiesta successiva**. Lo store poi non verifica la firma:
controlla solo che abbia la forma giusta. La ricevuta viene salvata con una firma
calcolata sull'impronta di un'altra ricevuta. Le tabelle sono append-only, quindi
l'errore è permanente, e **ogni export di quella catena fallisce la verifica da
quel punto in poi**.

**Riproduzione.** Signer finto che risponde in ordine, come quello vero, e si
blocca una volta per 5,5 s: `sign(d1)` va in timeout; `sign(d2)` riceve una firma
valida su `d1` e non su `d2`. In un secondo scenario, uno store a cui viene data
una firma sbagliata la salva senza obiezioni.

**Modifica proposta.** (a) Al timeout il client chiude la connessione e si
considera rotto: nessuna risposta tardiva potrà più essere abbinata. (b) Prima del
`COMMIT` lo store verifica la firma con la chiave pubblica del signer, già nota
dall'handshake; se non è valida annulla la transazione. La (b) è la difesa vera: è
indipendente da qualunque errore di protocollo e costa circa 0,1 ms a ricevuta.

**Rischio.** Basso. Il formato delle ricevute non cambia; cambia solo cosa il
server accetta di salvare.

**Test.** Signer bloccato che risponde in ordine → nessuna ricevuta con firma non
valida viene salvata; store con firma non valida → la scrittura fallisce e la
catena non avanza; test esistenti verdi.

### 2. La revoca di una API key da CLI non ha effetto sul server in esecuzione — ALTA

**File.** `apps/server/src/auth/api-keys.ts:64` e `:128-131` (cache),
`apps/server/src/cli.ts:211-227` (`key revoke`), `docs/API.md:24-25`.

**Cosa succede.** Il server tiene in memoria i token già verificati. La revoca
svuota quella cache **solo nel processo che revoca**. Ma `sigillo-server key
revoke` è un processo separato (con Docker: `docker compose exec`), quindi il
server in esecuzione continua ad accettare il token revocato fino al riavvio.
`docs/API.md` dice invece che la revoca "stops working immediately".

**Riproduzione.** Il server verifica il token (risultato: `sys`), un secondo
processo lo revoca (`true`), il server lo verifica di nuovo e ottiene ancora
`sys`. Un processo nuovo ottiene invece `null`.

**Modifica proposta.** Tenere in cache solo il risultato dello scrypt e rileggere
`revoked_at` dal database a ogni richiesta: una `SELECT` su chiave primaria,
senza scrypt.

**Rischio.** Basso: una query indicizzata in più per richiesta.

**Test.** Due istanze di `ApiKeyStore` sullo stesso file: la revoca in una fa
rifiutare il token dall'altra, anche con il token già in cache.

### 3. La documentazione promette più di quanto la verifica garantisca — ALTA

**File.** `docs/SECURITY.md:46-49`, `docs/FORMAT.md:611-613`,
`apps/server/src/export/verify-instructions.ts:25` e `:151-154`,
`apps/server/src/export/report.ts:75-76`, `packages/verifier/src/cli.ts`.

**Cosa succede.** Tre affermazioni sono false, e due di queste le dimostro qui:

a. **"Re-signing a forged chain requires the key, which is not in that process"**
   (`SECURITY.md:49`). Nello scenario che la pagina stessa ipotizza (attaccante
   in controllo del server), l'attaccante può usare il socket del signer, che
   firma qualsiasi impronta di 32 byte. Può quindi riscrivere e rifirmare
   un'intera catena. L'isolamento del signer impedisce di *portare via* la chiave
   (finito l'attacco, non si firma più), non di usarla durante l'attacco. Ciò che
   protegge davvero la storia già scritta sono le marche temporali dei checkpoint
   precedenti (il loro `genTime` non si può falsificare) e gli export già
   consegnati a terzi.

b. **La cancellazione delle ultime ricevute non viene rilevata.** `SECURITY.md:46-48`
   e `FORMAT.md:611` sostengono che il manifest la rivela; `VERIFY.md` dice che
   "any removal … breaks a hash or a signature"; il PDF dice che nulla può essere
   "removed … without this file failing to verify". Ma il manifest non è firmato.
   **Riprodotto:** tolte le ultime 3 ricevute su 10 e il checkpoint, e aggiornati
   `to_seq` e i conteggi nel manifest, il verificatore risponde OK.

c. **"Nothing here asks you to trust the system that produced it"** (`VERIFY.md`).
   Le chiavi pubbliche arrivano dal manifest dell'archivio stesso, e il
   verificatore non ha un'opzione per indicare quale chiave ci si aspetta.
   **Riprodotto:** un archivio interamente falso, firmato con una chiave nuova,
   passa la verifica con OK (stampa la chiave, ma nessuno è invitato a
   confrontarla con una fonte indipendente).

**Modifica proposta.** (1) Correggere i testi: `SECURITY.md`, `FORMAT.md`, il
generatore di `VERIFY.md` e il PDF. È la Fase 6, dove questo limite va scritto
esplicitamente. (2) Aggiungere al verificatore un'opzione `--key-id <id>`: con
questa, fallisce se una ricevuta o un checkpoint è firmato da una chiave diversa.
`VERIFY.md` spiegherà di confrontare il `key_id` con quello pubblicato dal gestore
per un canale indipendente. (3) Vedi il n. 8 (mostrare `genTime`).

**Rischio.** Basso. L'opzione è aggiuntiva e il formato non cambia; il verificatore
cresce di poche decine di righe (regola 5).

**Test.** Test di manomissione: coda troncata con manifest corretto (documenta che
passa, e che fallisce se si fornisce un checkpoint esterno); archivio falso con
`--key-id` → fallisce; archivio vero con `--key-id` giusto → passa.

### 4. Gli export per intervallo di date non legano le marche temporali alle ricevute — ALTA

**File.** `apps/server/src/export/archive.ts:104-120`,
`apps/server/src/http/ui.ts:424-441` (`sendArchive`),
`packages/core/src/export.ts:10-12` (commento), `packages/verifier/src/verify.ts:319-381`.

**Cosa succede.** La SPEC (§8) chiede che ogni checkpoint porti le prove di
inclusione della prima e dell'ultima ricevuta. In un export che non parte da
`seq 0` (è il caso normale quando nella UI, alla domanda "mi prepari le prove?",
si scelgono delle date), `buildArchive` non costruisce **nessuna** prova: i
checkpoint e le loro marche temporali entrano nell'archivio senza nulla che li
colleghi alle ricevute esportate. Il verificatore lo accetta, perché non richiede
che un checkpoint sia collegato a qualcosa, e il PDF li elenca come "anchored".
Anche il commento in `core/export.ts` dà per fatto ciò che il codice non fa.

**Riproduzione.** Export delle ricevute 4..7 di una catena di 10 con un
checkpoint: verifica OK, 0 prove nell'archivio, 0 prove controllate.

**Modifica proposta.** (1) Passare a `buildArchive` tutte le impronte della catena
fino al `tree_size` del checkpoint (esiste già `store.readReceiptHashes`), così le
prove si possono costruire anche per una finestra. Il formato dell'archivio non
cambia: `proofs` passa da vuoto a pieno. (2) Includere solo i checkpoint che
coprono almeno una ricevuta esportata. (3) Nel verificatore, segnalare in modo
visibile un checkpoint senza alcun legame con le ricevute presenti (vedi le
decisioni: avviso o errore).

**Rischio.** Medio-basso: tocca l'export. Gli archivi già prodotti restano
verificabili se il legame mancante produce un avviso e non un errore.

**Test.** Export di una finestra → ogni checkpoint pertinente ha le prove della
prima e dell'ultima ricevuta della finestra, che il verificatore controlla;
checkpoint non pertinenti esclusi; prova alterata → fallisce.

### 5. Prompt, output e documenti arrivano in chiaro al server — ALTA (privacy)

**File.** `sdk-python/src/sigillo/__init__.py:231-248`,
`demo/selezione-cv/agent.py:196-203`, `apps/server/src/ingest/adapter.ts:189-190`
e `:220-221`, `docs/SECURITY.md:73-78`.

**Cosa succede.** La regola "mai salvare contenuti in chiaro" è rispettata: il
server riduce `input.value` e `output.value` a impronte e scarta tutto il resto.
Però l'SDK esporta gli span OpenInference così come sono. Il testo di prompt e
output, gli argomenti dei tool (e attributi come `llm.input_messages`) viaggiano
**in chiaro fino al server sigillo** e restano nella sua memoria durante
l'elaborazione. Nella demo CV, `leggi_curriculum` restituisce l'intero testo del
curriculum, nome del candidato compreso, che arriva quindi al server come
`output.value` del tool. `SECURITY.md` dice che il documento "never" viene
trasmesso: è vero solo per l'impronta calcolata da `sigillo.artifact()`, non per
il contenuto che la strumentazione invia comunque.

**Conseguenza.** Chi gestisce il server sigillo riceve dati personali. Se il server
è gestito da un soggetto diverso da chi usa l'agente, quel soggetto diventa un
destinatario dei dati.

**Modifica proposta (da decidere, Fase 4/8).** Uno `SpanProcessor` nell'SDK che
sostituisce gli attributi con contenuto (`input.value`, `output.value`,
`llm.*_messages`, …) con le loro impronte **prima dell'invio**, e un adattatore
server che accetta l'impronta già calcolata. Il risultato sarebbe identico:
stessa funzione (`hashCanonicalJson` su una stringa), stesso formato di ricevuta.

**Rischio.** Medio: le impronte calcolate lato client devono coincidere byte per
byte con quelle calcolate dal server (servono vettori condivisi Python/TS).

**Test.** E2E con un server che registra i corpi ricevuti: nessuna stringa del CV
compare nel traffico; le impronte coincidono con quelle calcolate dal server.

### 6. Batch OTLP a metà fallito: ricevute scritte e duplicate dai retry — MEDIA

**File.** `apps/server/src/http/server.ts:155-174`,
`apps/server/src/ingest/adapter.ts:126-127`.

**Cosa succede.** Gli span di un batch vengono scritti uno per volta. Se uno dei
successivi è rifiutato (per esempio perché `gen_ai.provider.name` o
`sigillo.model.digest` superano i 256 caratteri: l'adattatore tronca il nome del
modello ma non questi due campi), il server risponde `500` dopo aver già scritto i
precedenti. L'esportatore OTLP Python ritenta sugli errori 5xx e riscrive gli
stessi span. Le ricevute duplicate non si possono togliere.

**Riproduzione.** Batch con uno span valido e uno con provider di 300 caratteri:
primo invio → `500`, catena da 1 a 2; secondo invio → `500`, catena a 3.

**Modifica proposta.** Validare tutte le azioni del batch prima di scriverne una;
troncare anche `provider` e `digest`; rispondere `400` (non ritentabile) ai dati
non validi. Da decidere: scartare uno span già registrato (stessi `system_id`,
`trace_id`, `span_id`).

**Rischio.** Basso per la validazione preventiva; la deduplicazione è una scelta
di prodotto.

**Test.** Batch misto → nessuna ricevuta scritta e risposta `400`; nuovo invio
dello stesso batch valido → nessun duplicato (se la deduplicazione viene
approvata).

### 7. Rotazione o perdita della chiave: ricevute vecchie non più verificabili — MEDIA

**File.** `apps/server/src/cli.ts:314`, `apps/server/src/http/ui.ts:441`,
`apps/server/src/health/chain-health.ts`, `deploy/docker-compose.yml`.

**Cosa succede.** Il manifest di ogni export pubblica solo la chiave che il signer
usa **in quel momento**, e il monitor della UI verifica solo con quella. Se la
chiave cambia (volume perso, sostituzione), ogni export delle ricevute vecchie
fallisce ("key not published") e il semaforo diventa rosso. In più, il volume
della chiave non ha nessuna procedura di backup, e i backup del database stanno
in un volume sullo stesso host.

**Modifica proposta.** Una tabella append-only con le chiavi pubbliche viste dal
server, tutte pubblicate nel manifest (che le supporta già) e usate dal monitor.
Documentare il backup della chiave (fuori dall'host, cifrato).

**Rischio.** Basso: il formato non cambia, perché il manifest ha già una lista di
chiavi.

**Test.** Catena firmata da due chiavi in sequenza → export verificabile; monitor
verde.

### 8. L'ora vera della marca temporale non viene mai mostrata — MEDIA

**File.** `packages/verifier/src/timestamps.ts`, `apps/server/src/export/report.ts:139`,
`apps/server/src/http/ui.ts:176-183`, `verify-instructions.ts:144`.

**Cosa succede.** UI, PDF e `VERIFY.md` presentano come ora della marca
`obtained_at`, cioè l'orologio del server, mentre l'ora attestata dall'autorità
(`genTime`, dentro il token) non viene mai estratta né stampata. Visto il n. 3a,
`genTime` è la prova del "quando": un archivio riscritto oggi avrebbe solo marche
di oggi, e oggi nessuno lo vedrebbe.

**Modifica proposta.** Il verificatore legge `genTime` da `openssl ts -reply -text`
(riga `Time stamp:`), lo stampa e segnala uno scarto grande rispetto a
`checkpoint.ts`; UI e PDF mostrano `genTime`.

**Rischio.** Basso.

**Test.** Token FreeTSA reale (già presente nei test) → `genTime` estratto e
stampato; confronto con `checkpoint.ts`.

### 9. Export per data con orologio all'indietro: archivio con un buco — MEDIA

**File.** `apps/server/src/storage/store.ts:236-251`.

**Cosa succede.** La finestra di un export viene scelta filtrando per
`ts_received`. Se l'orologio del server è tornato indietro (correzione NTP), le
ricevute selezionate possono non essere consecutive, e l'archivio prodotto fallisce
la verifica ("sequence").

**Riproduzione.** `ts_received` 10:00:05, 09:59:58, 10:00:06 → per la finestra
10:00:00-10:00:10 vengono selezionati i `seq` 1 e 3.

**Modifica proposta.** Ricavare dalle date il primo e l'ultimo `seq`, poi
esportare l'intervallo continuo di `seq`.

**Rischio.** Basso. **Test.** Il caso sopra produce 1..3 e verifica.

### 10. Nessun limite ai tentativi; scrypt blocca il processo — MEDIA

**File.** `apps/server/src/http/ui.ts:269-290` (login),
`apps/server/src/auth/api-keys.ts:127-152`, `apps/server/src/http/server.ts:94`.

**Cosa succede.** Né il login né l'ingest limitano i tentativi (è la Fase 2). In
più, un token con un `key_id` esistente e un segreto sbagliato costa uno scrypt
sincrono: misurati **circa 55 ms di blocco del processo per tentativo** (20
tentativi = 1,1 s), quindi circa 20 richieste al secondo bastano a bloccare il
server. Per limitare per IP dietro Caddy serve `trustProxy`, che oggi non è
configurato: l'IP visto dal server è sempre quello di Caddy.

**Modifica proposta.** Fase 2: limitatore in memoria (niente Redis), per IP reale
(`trustProxy` limitato alla rete di Caddy), sia per il login sia per i token
falliti; scrypt asincrono.

**Rischio.** Basso, se il limite non tocca gli utenti legittimi (test richiesti
dalla Fase 2).

### 11. Il server non si riconnette al signer riavviato; `/healthz` dice "ok" — MEDIA

**File.** `apps/server/src/signer/client.ts:39-44` e `:179-192`,
`apps/server/src/http/server.ts:108`.

**Cosa succede.** Se il container del signer si riavvia, il client non si
riconnette. Ogni scrittura fallisce finché non si riavvia anche il server, ma
`/healthz` continua a rispondere `ok`, quindi Docker non se ne accorge.

**Modifica proposta.** Riconnessione alla richiesta successiva (oppure uscita del
processo, lasciando a Docker il riavvio), e `/healthz` che controlla il signer.
Va fatta insieme al n. 1.

**Rischio.** Basso. **Test.** Signer chiuso e riaperto → la scrittura successiva
riesce; `/healthz` è `503` mentre il signer è giù.

### 12. Sessione web — MEDIA

**File.** `apps/server/src/http/ui.ts:283-296`, `:567-585`.

**Cosa succede.**
- Il cookie non ha `Secure`.
- Il logout cancella il cookie solo nel browser: un cookie copiato resta valido
  per 12 ore.
- Le pagine autenticate, compresa quella che mostra una API key appena emessa, non
  hanno `Cache-Control: no-store`.
- Non c'è un controllo di `Origin` sui POST (`SameSite=Strict` copre i browser
  moderni) e il logout è un GET.

**Modifica proposta.** Aggiungere `Secure` (configurabile per la prova locale in
HTTP), `no-store`, controllo di `Origin` e logout in POST; sessioni revocabili (un
contatore di "epoca" nel segreto HMAC).

**Rischio.** Basso. **Test.** Intestazioni presenti; POST cross-origin rifiutato;
cookie dopo il logout rifiutato.

### 13. Scritture fuori dalla coda di scrittura — MEDIA-BASSA

**File.** `apps/server/src/storage/store.ts:298-315`,
`apps/server/src/auth/api-keys.ts:68-75`, `apps/server/src/http/ui.ts:330-349`.

**Cosa succede.** Mentre una ricevuta attende la firma dentro `BEGIN IMMEDIATE`,
possono accadere due cose:
- `recordTimestamp` scrive sulla stessa connessione ed entra in quella
  transazione. Se questa viene annullata, la marca va persa (sarà ripresa al giro
  successivo).
- `ApiKeyStore.issue` (creazione di un sistema dalla UI) usa un'altra connessione
  e aspetta il lock in modo *sincrono* fino a 5 s. Blocca così l'intero processo,
  compresa la lettura della risposta del signer, e può far scattare il timeout del
  n. 1.

**Modifica proposta.** Far passare `recordTimestamp` dalla coda `enqueue`, ed
eseguire l'emissione delle chiavi sulla connessione di scrittura, anch'essa in
coda.

**Rischio.** Basso. **Test.** Una marca registrata durante un `append` il cui
signer fallisce resta salvata.

### 14. Dipendenze — MEDIA (Fase 3)

- `pnpm audit`: **7 avvisi (1 critico, 1 alto, 5 moderati), tutti nella catena di
  sviluppo** `vitest 2.1.9` → `vite`, `esbuild`, `@vitest/mocker`. Le immagini di
  produzione usano `--prod` e non li contengono: `pnpm audit --prod` non trova
  vulnerabilità. L'avviso critico riguarda la UI di Vitest, che il progetto non usa.
- Nessun controllo automatico in CI, nessun Dependabot.
- **Python**: le dipendenze sono vincolate solo con `>=` e senza lockfile, quindi
  CI e utenti installano sempre l'ultima versione (le build non sono
  riproducibili). `pip-audit` sull'ambiente installato: nessuna vulnerabilità nelle
  dipendenze del progetto (solo in `pip`/`setuptools` del venv).
- Versioni maggiori indietro: `zod` 3→4, `better-sqlite3` 11→13, `pdfkit`
  0.15→0.20, `commander` 12→15, `protobufjs` 7→8, `canonicalize` 2→5. **Non vanno
  aggiornate alla cieca**: `canonicalize` e `zod` stanno sul percorso crittografico
  e di validazione; un aggiornamento deve passare i vettori e il cross-check.

### 15. Hardening dei container, backup e chiave — MEDIA (Fase 5)

Verificato su `docker compose config`:
- Mancano `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
  `read_only: true` con `tmpfs` dove serve, rotazione dei log (il driver
  `json-file` di default cresce senza limite), limiti di memoria.
- Immagini con tag mobile (`caddy:2-alpine`, `node:22-bookworm-slim`), senza
  digest.
- Backup del database in un volume sullo stesso host; **nessuna procedura per la
  chiave del signer**.
- `.env.example` dice che `SIGILLO_ADMIN_PASSWORD` si può lasciare vuota, ma
  `docker-compose.yml` la rende obbligatoria (`:?`).
- `SIGILLO_STALE_AFTER_MINUTES` non viene passata al container.

### 16. Variabili numeriche non validate — BASSA-MEDIA

**File.** `apps/server/src/cli.ts:106`, `:115`, `:153`.

`SIGILLO_CHECKPOINT_MINUTES=abc` diventa `NaN`, e Node esegue `setInterval(NaN)`
ogni millisecondo: il ciclo di checkpoint martellerebbe database e autorità di
marcatura. Stesso problema per la porta e per la soglia di inattività.
**Proposta:** validare all'avvio e rifiutarsi di partire con valori non validi.

### 17. Lettore ZIP del verificatore — BASSA

**File.** `packages/core/src/zip.ts:152-216`.

- La decompressione non ha limite di dimensione: un archivio malevolo può esaurire
  la memoria del verificatore.
- Nomi duplicati accettati (vince l'ultimo).
- Il nome nell'intestazione locale non viene confrontato con quello della
  directory centrale; i flag (cifratura, data descriptor) non vengono controllati.

**Proposta:** `inflateRawSync(…, { maxOutputLength })`, rifiutare duplicati, flag
non zero e nomi discordanti. Poche righe, dentro la regola 5.

### 18. Dati personali nei campi testuali — da decidere (Fase 4)

`actor.on_behalf_of` viene da `user.id`/`enduser.id` (nella demo:
`elena.rizzo`); `actor.agent` da `gen_ai.agent.name`/`service.name`;
`action.name` dal nome dello span. Sono in chiaro, firmati, e **non cancellabili
senza rompere la catena**. L'unico controllo è la lunghezza (256), e 256 caratteri
bastano per un nome, un'email o una frase: l'affermazione di `SECURITY.md:94` ("A
caller cannot smuggle a prompt into a name field") è troppo forte. La Fase 4
analizzerà le opzioni senza cancellazioni automatiche e senza dichiarazioni di
conformità.

### 19. Impronte di valori prevedibili — da decidere (Fase 4)

Un'impronta SHA-256 senza sale di un valore con poche possibilità (`"colloquio"` /
`"non_idoneo"`, un punteggio, una risposta breve) si ricostruisce provando le
alternative. Impronta ≠ anonimizzazione. Un sale o un HMAC cambierebbero il
formato (richiede una nuova `v`), quindi non lo propongo ora; va documentato.

### 20. Minori — BASSA

- Il gestore di errori predefinito di Fastify restituisce il `message` degli
  errori interni con il 500. `/api/v1/receipts` risponde `400` anche quando il
  signer non è raggiungibile (dovrebbe essere `503`).
- Caddy e Fastify registrano gli URL completi, con le query string (impronte di
  documenti cercati, termini di ricerca).
- `cap()` in `adapter.ts:72-74` può spezzare una coppia surrogata UTF-16. Ne
  risulta una stringa firmata che altre implementazioni di RFC 8785 potrebbero
  rifiutare.
- Il verificatore non controlla `range.from_ts`/`to_ts`. Stampa l'elenco
  "verified" anche quando le marche non sono state controllate (openssl assente)
  o quando non ci sono checkpoint.
- Nella ricerca, i caratteri jolly di `LIKE` non vengono neutralizzati (solo un
  effetto funzionale, non un'iniezione).

## Esecuzione dei controlli (stato di partenza)

| Comando | Risultato |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm lint` | ok (64 file sorgente, 5 manifest) |
| `pnpm typecheck` | ok |
| `pnpm build` | ok |
| `pnpm test` | **541 superati / 541** (21 file); i 2 "saltati" della volta scorsa sono i test FreeTSA dal vivo, che qui hanno avuto rete |
| `node scripts/smoke-dist.mjs` | ok, 20 vettori |
| `python3 scripts/crosscheck_vectors.py` | ok, 20 vettori rideriviati |
| SDK Python (`unittest`, venv con le dipendenze dell'esempio) | **26 superati / 26** |
| Demo selezione CV (`unittest`) | **17 superati / 17** |
| `pnpm audit` | 7 avvisi, tutti solo sviluppo; `--prod`: nessuno |
| `pip-audit` (ambiente SDK) | nessuna vulnerabilità nelle dipendenze del progetto |
| `docker compose config` | valido; solo Caddy pubblica 80/443 |
| Docker build/run | **non eseguito**: demone non disponibile in questo ambiente |

Nota: i test end-to-end Python avviano l'agente con `python`
(`sdk-python/tests/test_end_to_end.py:135`) o `python3`
(`demo/selezione-cv/tests/test_demo_e2e.py:134`) presi dal `PATH`, non con
`sys.executable`, quindi vanno eseguiti con il venv attivato. Fuori dal venv
falliscono per un modulo mancante, non per un difetto del codice. In CI non si
nota perché le dipendenze sono installate nell'interprete di sistema.

## Decisioni richieste al committente

1. **n. 4, verifica di un checkpoint non collegato**: in un archivio, un checkpoint
   senza alcuna prova che lo leghi alle ricevute deve far fallire la verifica
   (più severo, ma gli archivi per data già prodotti non passerebbero più) oppure
   produrre un avviso esplicito (compatibile)? Proposta: avviso.
2. **n. 5, contenuti in chiaro verso il server**: calcolare le impronte nell'SDK,
   prima dell'invio? Proposta: sì, come opzione predefinita dell'SDK, da
   progettare nella Fase 4 o 8.
3. **n. 6, deduplicazione**: uno span già registrato (stessi `trace_id` e
   `span_id` nello stesso sistema) va scartato quando arriva di nuovo? Proposta:
   sì, per le ricevute di origine OTLP.
4. **n. 7, backup della chiave**: dove si conserva la copia della chiave del
   signer (fuori dall'host, cifrata), e chi può accedervi.
5. **Ordine delle correzioni.** I problemi 1, 2, 4 e 9 non rientrano in nessuna
   delle fasi 2-11 così come sono scritte; il 3 rientra in parte nella Fase 6.
   Proposta: correggere 1 e 2 subito, in una fase "1-bis" o dentro la Fase 2
   (che tocca l'autenticazione), e 4 e 9 nella Fase 7 (export).
