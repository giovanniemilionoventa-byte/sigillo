# PROGRESS.md — stato del progetto sigillo

Legenda stato: `todo` · `in corso` · `fatto`

## Milestone

| # | Nome | Stato | Note |
|---|------|-------|------|
| M1 | Formato e impronta | fatto | 14 vettori, 91 test verdi, cross-check Python indipendente in CI |
| M2 | Catena e storage | fatto | Trigger append-only, transazione IMMEDIATE, 1000 append concorrenti senza buchi |
| M3 | Firmatario | fatto | Processo separato su socket Unix, keygen 0600, e2e a due processi |
| M4 | Verificatore v1 | fatto | CLI `sigillo-verify`, 8 controlli, manomissioni + property test |
| M5 | Ingest OTLP e API nativa | fatto | protobuf+JSON, due dialetti, API key scrypt, CLI admin |
| M6 | SDK Python | fatto | `sigillo.init()`, esempio LangGraph, e2e a tre processi |
| M7 | Merkle e marca temporale | fatto | RFC 6962 (0..17), checkpoint firmati, RFC 3161 su FreeTSA |
| M8 | Fascicolo completo e verificatore v2 | fatto | Zip completo con PDF, 12 controlli, token FreeTSA verificato |
| M9 | UI, deploy, documentazione | fatto | UI senza JavaScript, compose a tre servizi, backup SQLite, 406 test verdi |
| N1 | Formato v2 | fatto | Campi `artifacts` e `model`, schema v1/v2 come union discriminata, 20 vettori (8 nuovi v2), 452 test verdi |
| N2 | SDK Python, fase 2 | fatto | `sigillo.artifact()`, digest Ollama, `instrument=["openai"]`, adattatore server; 465 test Node + 22 Python |
| N3 | Verifica di un documento | fatto | Hash nel browser, `sigillo-verify doc`, `artifacts-index.jsonl`; 485 test Node |
| N4 | Interfaccia nuova | fatto | Le tre domande in italiano, semaforo verde/giallo/rosso con parola, cronologia leggibile, pagina sistemi, tema chiaro/scuro/mobile; 537 test Node |
| N5 | Demo selezione CV | fatto | 20 curriculum, modello fittizio (Ollama scritto ma non eseguibile qui), ispezione simulata, e2e reale; bug corretto in `sigillo.artifact()` |
| N6 | Documentazione non tecnica | fatto | `ISPEZIONE.md` e `VIDEO.md` (in N5), `PROVA-LOCALE.md` corretto ed esteso alla fase 2 |

## Decisioni prese dal committente — 2026-09-21

Tutte e nove le milestone sono `fatto`. Le tre domande aperte sono state decise così:

1. **Il formato è confermato come v1, definitivo.** Nessun `v: 2`. La regola del base64 canonico
   (§5 di `docs/FORMAT.md`) resta dentro la versione 1, perché stringe soltanto e non invalida
   nessuna ricevuta mai prodotta da sigillo. `docs/FORMAT.md` lo dichiara ora esplicitamente, e
   dice anche cosa obbligherebbe invece a incrementare `v`: **una modifica sotto la quale una
   ricevuta prima valida possa fallire**.
2. **La marca temporale qualificata eIDAS: si aspetta.** Nessuna azione ora. Il codice resta
   pronto (`TSA_URL`, `TSA_USERNAME`, `TSA_PASSWORD`); il default resta FreeTSA, che **non è
   qualificata** e va bene solo per prove e sviluppo. Quando si deciderà il fornitore serviranno
   URL, eventuali credenziali e il certificato della sua CA per la verifica offline. Finché si
   aspetta, i fascicoli prodotti hanno marche non qualificate: provano *quando*, con un'autorità
   non riconosciuta eIDAS.
3. **La dimensione del verificatore va bene così.** L'obiettivo delle 1000 righe della SPEC è
   superato dalla decisione del committente; `CLAUDE.md` regola 5 riporta ora la regola operativa
   (leggibilità prima di tutto, nessuna crescita senza una ragione che un lettore accetterebbe, e
   una nota in questo file se il totale cresce di più di ~100 righe). Nessuna riga tolta: né gli
   ZIP né la verifica dei token sono stati amputati.

### Cosa resta da fare, e non posso farlo io

- **La pull request verso `main`.** `main` non esiste sul remote: il repository è stato creato
  vuoto e GitHub ha reso il branch di lavoro quello di default. Senza una base non si apre una PR.
  Il rimedio è un comando solo — `git push origin d87981a:refs/heads/main`, dove `d87981a` è il
  commit iniziale con solo SPEC/CLAUDE/PROGRESS e zero codice — ma crea un branch condiviso, e
  l'ambiente me l'ha bloccato. Serve il via libera del committente.
- **La verifica finale con Docker.** Docker non è disponibile nella sessione cloud: la checklist in
  fondo a questo file ha i comandi esatti da eseguire su una macchina vera.
- **La visibilità del repository.** È pubblico. Non c'è nulla di sensibile dentro (il lint rifiuta
  file `.key` e `.pem`, e non c'è materiale di chiave nell'albero), ma è una scelta da fare
  consapevolmente.

## Preparazione al primo pilot — fasi 1-11 (dal 2026-09-24)

Piano del committente: portare la base attuale a un pilot reale, una fase alla volta, fermandosi
dopo ogni fase in attesa di autorizzazione. Niente PostgreSQL, multi-tenancy, SaaS, HSM/KMS.

| Fase | Nome | Stato | Note |
|---|---|---|---|
| 1 | Revisione tecnica pre-produzione | fatto | Rapporto in `docs/REVISIONE-FASE-1.md`: 20 punti, 5 di gravità alta, i principali riprodotti con codice reale; nessuna modifica al codice |
| 2 | Correzione dell'associazione tra richiesta e firma (signer) | fatto | Punto 1 della revisione. Ogni richiesta al signer ha un `id` che il signer ripete nella risposta: una risposta arrivata dopo il timeout viene ignorata e non può più completare la richiesta successiva. Il server verifica ogni firma (ricevute e checkpoint) sui byte esatti prima di scrivere. Bug riprodotto con il signer reale congelato (SIGSTOP/SIGCONT); 24 test nuovi, 565 verdi |
| 3 | Controllo automatico delle dipendenze | fatto | `pnpm audit:deps` e workflow `dependency-audit.yml` (push, PR, ogni lunedì). Node: produzione bloccante a qualsiasi gravità, sviluppo da `high` in su; Python: `pip-audit` su SDK con tutti gli extra, esempio e demo. Guida in `docs/DEPENDENCY-AUDIT.md`. Il controllo ha trovato 7 avvisi nella catena di sviluppo (vitest 2.1.9 → vite/esbuild): vitest aggiornato a 4.1.11, ora 0 avvisi. Da confermare: `pip-audit` come strumento solo-CI |
| 4 | Dati personali nei campi testuali | fatto | Analisi su 169 ricevute reali (demo CV + esempio): unico dato personale in chiaro `on_behalf_of` = `elena.rizzo`. Corretto senza decisioni di prodotto: Unicode sempre valido (il taglio OTLP spezzava le emoji, e il cross-check Python non riusciva a calcolare l'impronta), `model.provider`/`digest` limitati a 256, affermazione falsa in `SECURITY.md`. Nuovo `docs/DATA-INVENTORY.md`; proposte D1–D7 in `docs/PROPOSTA-FASE-4.md`, da approvare |
| 5 | Hardening della configurazione di produzione, e limitazione dei tentativi di accesso | fatto | Punti 2, 10, 11, 12, 15, 16 corretti; 20 in parte. Limite ai tentativi di password (per indirizzo, blocco crescente, risposta identica a una password sbagliata) e alle API key sbagliate; revoca delle chiavi efficace sul server già avviato; scrypt asincrono; riconnessione al signer e `/healthz` che lo controlla; cookie `Secure`, sessioni revocabili, `no-store`, controllo di `Origin`, logout in POST; impostazioni numeriche validate all'avvio; container in sola lettura, senza capability, `no-new-privileges`, limiti di risorse, log a rotazione; password in un file segreto (assente da `docker compose config`, provato); log senza query string né segreti (provato con Fastify e con Caddy reale). Tre difetti nuovi trovati: la cartella dei backup non scrivibile nell'immagine, Caddy che non parte con `SIGILLO_TLS_EMAIL` vuota, la password stampata da `docker compose config`. 636 test verdi |
| 6 | Test di manomissione | fatto | Punti 3, 8, 17 corretti. 17 scenari di manomissione (i 10 richiesti più 7) su un fascicolo vero, ciascuno verificato con il `sigillo-verify` reale; due scenari passano da soli e vengono presi solo con le nuove opzioni `--key-id` (chiave attesa) e `--previous` (export precedente). Ora vera della marca (`genTime`) nel verificatore, nel PDF, in VERIFY.md e nella pagina web. Lettore ZIP più severo. Nuova sezione "What sigillo cannot detect" in `SECURITY.md`; corrette le affermazioni false in `SECURITY.md`, `FORMAT.md`, VERIFY.md e nel PDF. 665 test |
| 7 | Test completo di esportazione e verifica | fatto | Punti 4 e 9 corretti; punto 20 (`from_ts`/`to_ts`) corretto. Test end-to-end su tre giorni: signer vero, sistema e chiave dalla pagina web, OTLP e API nativa, checkpoint dal pulsante con marca RFC 3161 vera via HTTP, export dell'intera catena, di un giorno e da CLI, tutti verificati dal `sigillo-verify` reale con `--tsa-ca`, `--key-id`, `--previous` e `doc`. 678 test |
| 8 | Preparazione integrazione con un agente reale | fatto | Proposta in `docs/PROPOSTA-FASE-8.md`, nessuna modifica al codice. Misurato il traffico dell'SDK: la demo CV manda al server 244 KB in chiaro per 160 span, nomi dei candidati e testo dei CV compresi. Proposta D6 (impronte calcolate nell'SDK, elenco di attributi da tenere); fattibilità verificata: su 2 005 stringhe, impronte Python e TypeScript identiche. Rischi dell'integrazione reale e sette domande (A–G) per il committente |
| 9 | Prima integrazione reale | **sospesa, in attesa** | Parte solo dopo l'approvazione della fase 8: servono le risposte alle domande A–G di `docs/PROPOSTA-FASE-8.md` (quale agente, chi gestisce il server, D6, deduplicazione, `on_behalf_of`, marca temporale) |
| 10 | Preparazione alla produzione | fatto | `docs/DEPLOY-PRODUZIONE.md`: dal clone a un fascicolo verificato su un VPS con dominio e HTTPS, con checklist di 33 righe (comando e risultato atteso). I risultati attesi sono copiati da esecuzioni reali senza Docker (FreeTSA vera compresa). **La checklist resta da eseguire su una macchina vera: Docker qui non gira.** Corretti anche i punti 6 (batch OTLP atomico), 7 (storico delle chiavi di firma) e 13 (scritture fuori coda). 684 test |
| 11 | Revisione finale prima del pilot | fatto | `docs/REVISIONE-FASE-11.md`: tabella prima/dopo dei 20 punti (15 corretti, 2 mitigati, 1 rimandato alla fase 9, 2 accettati), difetti nuovi, cosa resta al committente, valutazione complessiva |

Il 2026-09-24 il committente ha mandato il prompt delle fasi 5-11, trascritto in fondo a `SPEC.md`
("Fasi 5-11 (pre-pilot)"). Il testo arrivato è incompleto: mancano le sezioni delle fasi 7, 8 e 9.
Per quelle fasi vale la definizione della tabella 3.2 di `docs/RAPPORTO-SESSIONE-2026-09-24.md`,
riportata anche in `SPEC.md`. Le fasi procedono senza conferma tra l'una e l'altra; la fase 9 non si
esegue in questa sessione.

## Fasi 5-11 — note di lavoro (dal 2026-09-24)

### Fase 5 — Hardening della configurazione di produzione (fatto)

Base: `main` @ `a5b6058`. Test Vitest: da 579 a **636** (più 1 saltato dove `caddy` non è
installato). Test Python SDK e demo: 26 e 17, invariati e verdi. `smoke-dist` e cross-check
Python: verdi.

**Difetti corretti, ciascuno riprodotto prima con un test che falliva.**

| Punto | Difetto | Test che lo riproduce (componenti reali) |
|---|---|---|
| 2 (ALTA) | La revoca da CLI non aveva effetto sul server già avviato | `api-keys.test.ts`: due `ApiKeyStore` sullo stesso file SQLite; la revoca fatta dal secondo ora vale anche per il primo, che aveva il token in cache |
| 10 | Uno scrypt sincrono (~55 ms) per ogni API key sbagliata bloccava il processo | `api-keys.test.ts`: durante la verifica di un token sbagliato l'event loop deve girare almeno una volta (con lo scrypt sincrono: zero volte) |
| 11 | Il server non si riconnetteva al signer riavviato; `/healthz` diceva sempre "ok" | `signer-client.test.ts`: signer reale ucciso e riavviato sullo stesso socket (stessa chiave → firma di nuovo; chiave diversa → rifiuto esplicito); `server-hardening.test.ts`: `/healthz` 503 finché il signer manca |
| 12 | Cookie senza `Secure`, sessione non revocabile, pagine senza `no-store`, logout in GET, nessun controllo di `Origin` | `ui-security.test.ts`, 12 test sul server Fastify vero |
| 16 | `SIGILLO_CHECKPOINT_MINUTES=abc` → `setInterval(NaN)`, cioè ogni millisecondo | `cli-config.test.ts`: la CLI vera, in un processo a parte, con 7 valori sbagliati: esce con 1 e nomina la variabile, prima di cercare il signer |
| 15 | Container senza hardening; cartella dei backup inesistente nell'immagine (Docker l'avrebbe creata di root, e `backup.sh`, che gira come `node`, non avrebbe potuto scrivere) | `deploy-config.test.ts`: `docker compose config` risolto davvero; confronto tra volumi montati e cartelle create nel Dockerfile. **Trovato leggendo i file, non riprodotto con Docker**, che qui non gira |
| nuovo | `docker compose config` stampava la password dell'amministratore (e quella della TSA) | riprodotto con `docker compose config` vero: prima 2 righe, ora 0. Stesso controllo in `deploy-config.test.ts`, che gira in CI |
| nuovo | Con `SIGILLO_TLS_EMAIL` vuota (il file lo permetteva) Caddy rifiuta tutta la configurazione e non parte | riprodotto con i binari reali di Caddy 2.10.2 e 2.11.4 (`caddy validate`); ora Compose si ferma prima e nomina la variabile |
| 20 (parte) | Il 500 di Fastify rimandava il messaggio interno; `/api/v1/receipts` rispondeva 400 col signer irraggiungibile; i log contenevano le query string | `server-hardening.test.ts`: 503 (ritentabile) col signer spento, `internal error` e niente altro per un 500, log controllato riga per riga |

**Limitazione dei tentativi di accesso** (richiesta del committente, ex fase 2). Funzione nuova
con test propri, non un difetto:
- dopo `SIGILLO_LOGIN_MAX_FAILURES` (5) password sbagliate in `SIGILLO_LOGIN_WINDOW_MINUTES`
  (15), l'indirizzo è bloccato per `SIGILLO_LOGIN_LOCKOUT_MINUTES` (5); ogni blocco successivo
  raddoppia fino a `SIGILLO_LOGIN_LOCKOUT_MAX_MINUTES` (60). Un accesso riuscito azzera tutto;
- durante il blocco la password non viene nemmeno controllata, e la risposta è **identica** a
  quella di una password sbagliata: stesso stato (401), stessa pagina, stesso testo ("Accesso non
  riuscito. Controlla la password; dopo troppi tentativi sbagliati l'accesso resta sospeso per
  qualche minuto."), nessun `Retry-After`. Chi attacca non può sapere se è bloccato, e nessun
  tentativo fatto durante il blocco può rivelargli la password giusta;
- test: N+1 tentativi bloccati anche con la password giusta; risposta bloccata identica byte per
  byte a quella sbagliata; sblocco esattamente allo scadere, con la password giusta accettata al
  primo colpo; un indirizzo bloccato non blocca gli altri; `X-Forwarded-For` ignorato se non si è
  detto di fidarsi di un proxy (altrimenti basterebbe cambiarlo a ogni tentativo);
- l'indirizzo è quello vero solo dietro Caddy: `SIGILLO_TRUST_PROXY=uniquelocal` nel Compose.
  Fastify 5.12 rifiuta ormai i conteggi di hop, quindi si indicano le reti fidate; verificato con
  Caddy reale che un `X-Forwarded-For` falso mandato dal client viene sostituito;
- stesso meccanismo per le API key sbagliate (`SIGILLO_INGEST_MAX_FAILURES`, 20 al minuto): durante
  il blocco non si calcola nessuno scrypt, ma un agente la cui chiave è già stata verificata
  continua a lavorare anche dallo stesso indirizzo.

Limite noto, accettato: i contatori stanno in memoria, un riavvio li azzera. Chi attacca da
molti indirizzi diversi ha 5 tentativi per indirizzo ogni 15 minuti; con una password di 12+
caratteri casuali resta impraticabile, e la checklist raccomanda `openssl rand -base64 24`.

**Docker e Caddy** (`deploy/`):
- tutti e tre i servizi: `read_only`, `no-new-privileges`, `cap_drop: ALL`, limiti di CPU,
  memoria e processi, log `json-file` con `max-size 10m` × 5 file. Server e signer girano già come
  `node`; Caddy resta root (la sua immagine lo richiede per scrivere certificati) ma con la sola
  capability `NET_BIND_SERVICE`;
- immagine Node fissata per digest; Caddy fissato alla versione `2.11.4-alpine` (l'ultima
  pubblicata). Il digest di Caddy non l'ho potuto leggere: Docker Hub ha risposto 429 (limite di
  richieste anonime dall'indirizzo condiviso di questo ambiente) — resta un passo della checklist
  della fase 10;
- Caddy: aggiunte `Permissions-Policy`, `Cross-Origin-Opener-Policy`,
  `Cross-Origin-Resource-Policy` a quelle che c'erano già (`X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, CSP, HSTS); log senza query string;
- password dell'amministratore in `deploy/secrets/admin_password`, montata come secret di
  Compose; `.env` non contiene più segreti. Il file locale `docker-compose.local.yml` (la prova
  sul proprio computer) tiene la password in `.env` come prima, ed è scritto nel file.

**Documentazione**: `SECURITY.md` (autenticazione, nuova sezione "Secrets and logs" con i comandi
eseguiti e i risultati, checklist "Before going to production"), `API.md` (401/503/500, `/healthz`,
tabella delle variabili), `PROVA-LOCALE.md` (cosa succede dopo 5 password sbagliate).

**Cosa non è verificato**: Docker non gira in questo ambiente (il demone non si può avviare),
quindi `read_only`, i limiti, i secret e i permessi dei volumi sono controllati solo su
`docker compose config`. Il primo `docker compose up` su una macchina vera è il vero collaudo:
è nella checklist della fase 10.

**Annotato per le fasi successive**
- Punto 13 (scritture fuori dalla coda: `recordTimestamp`, emissione di chiavi dalla UI) → fase 10.
- Punto 20, resto (`LIKE` senza escape nella ricerca; verificatore che non controlla
  `range.from_ts`/`to_ts` e che elenca come "verified" anche senza openssl) → fasi 6 e 7.
- Il vecchio elenco "Checklist di verifica finale M9" in fondo a questo file usa ancora la
  password in `.env`: la fase 10 lo sostituisce con `docs/DEPLOY-PRODUZIONE.md`.

### Fase 6 — Test di manomissione (fatto)

Test Vitest: da 636 a **664** (più 1 saltato dove `caddy` non è installato).

**Come sono fatti i test** (`apps/server/test/tamper.test.ts`). Il fascicolo di partenza è
prodotto come lo produce il server: SQLite reale, firme Ed25519 reali, un checkpoint reale e una
marca temporale RFC 3161 **vera**. La marca viene da un'autorità locale costruita con openssl
(`test/helpers/local-tsa.ts`: una CA e un certificato TSA con `extendedKeyUsage=timeStamping`),
che `openssl ts -verify` controlla come quelle di FreeTSA: niente rete, niente mock. Ogni
scenario altera una copia del fascicolo e la passa al comando `sigillo-verify` vero, in un
processo a parte, con `--tsa-ca`. Lo scenario passa solo se il comando esce con 1 e nomina il
controllo e il punto esatto.

| # | Scenario | Rilevato da |
|---|---|---|
| 1 | un byte alterato in una ricevuta | `chain-link` alla riga successiva |
| 2 | ricevuta rimossa | `sequence` |
| 3 | due ricevute scambiate | `sequence` |
| 4 | ricevuta duplicata | `sequence` ("appears twice") |
| 5 | firme sostituite con quelle di un'altra chiave valida (pubblicata nel manifest dal falsario, checkpoint e marca tolti) | **da solo passa**; con `--key-id` della chiave vera: `key` alla prima ricevuta rifirmata |
| 6 | `prev_hash` alterato e nient'altro | `chain-link` |
| 7 | radice Merkle del checkpoint alterata | `checkpoint-signature` |
| 7b | idem, ma rifirmato con la chiave vera (attaccante che usa il socket del signer) | `merkle-root` |
| 8 | prova di inclusione falsificata | `inclusion-proof` |
| 9 | token di marca sostituito con uno vero della stessa autorità su un'altra impronta | `timestamp` ("the token is over …") |
| 10 | manifest senza il `key_id` (o con un'altra chiave valida al suo posto) | `manifest` / `key` |
| 11 | ultime 3 ricevute tagliate, manifest corretto di conseguenza (punto 3b) | **da solo passa**; con `--previous`: `previous-export` |
| 12 | fascicolo interamente falso sotto una chiave nuova, marca compresa (punto 3c) | **da solo passa**; con `--key-id`: `key` |
| 13 | storia riscritta e rifirmata con la chiave vera dopo la consegna di un export | **da solo passa**; con `--previous`: `previous-export` alla prima ricevuta cambiata |
| 14 | token di marca tolto dallo zip | `timestamp` |
| 15 | secondo `receipts.jsonl` infilato nello zip | lettore ZIP: "appears twice" (uscita 2) |
| 16 | ricevuta con una firma vera della chiave giusta, ma di un'altra ricevuta | `signature` |

**Difetti corretti** (ciascuno riprodotto prima con un test che falliva):
- **Punto 3 (ALTA).** Le affermazioni false sono corrette: "Re-signing a forged chain requires
  the key" (`SECURITY.md`: durante una compromissione il socket del signer firma qualunque cosa),
  "removing the last ones is caught" (`SECURITY.md`, `FORMAT.md`: vero solo se il manifest non è
  stato ritoccato), "Nothing here asks you to trust…" e "any removal breaks a hash" (VERIFY.md),
  "nothing can be … removed" (PDF). Nel verificatore due opzioni nuove, che portano dentro la
  verifica ciò che un archivio non può fornire da sé: `--key-id` (ripetibile) e `--previous`.
  Senza `--key-id` il verificatore ora avvisa che le chiavi vengono dal manifest dell'archivio.
- **Punto 8.** `genTime` è letto dal token e stampato dal verificatore (via openssl), con un avviso
  se si discosta di più di un'ora dall'ora del checkpoint; il server lo legge con un piccolo lettore
  DER (`apps/server/src/timestamp/gentime.ts`) e lo mostra nel PDF, in VERIFY.md, nella pagina dei
  checkpoint e nella verifica di un documento. Le due letture sono confrontate su token veri.
- **Punto 17.** Il lettore ZIP ora rifiuta nomi duplicati, nome locale diverso da quello della
  directory centrale, voci cifrate, voci oltre 512 MiB o un totale oltre 1 GiB (prima di
  decomprimere), e non decomprime mai oltre la dimensione dichiarata. I flag dei data descriptor
  restano accettati: gli archivi rifatti con gli strumenti di sistema (per esempio quello del Mac)
  li usano.
- **Punto 20, una parte.** Il verificatore elencava come "verified" anche i controlli non fatti
  (nessun token, openssl assente, radici non ricostruibili): ora li elenca a parte, sotto
  "not verified".

**`SECURITY.md`, nuova sezione "What sigillo cannot detect"**, richiesta dal committente: la
sorgente che tace (solo semaforo giallo, mai "manomissione"), la sorgente che omette, i dati falsi
ben formati mandati con la propria chiave legittima, la chiave API rubata, `ts_event`, i duplicati
OTLP, ciò che un server compromesso può riscrivere prima della marca successiva o sostituire in
blocco, l'orologio del server, e ciò che un singolo archivio non può dire di sé (chiave, coda
tagliata, autorità).

**Dimensione del verificatore** (regola 5 di `CLAUDE.md`): `packages/verifier/src` passa da 911
a 1122 righe, `core/zip.ts` da 216 a 260; in tutto circa +250 righe. Cosa hanno comprato:
`--key-id` e `--previous` (le uniche difese contro i due falsi del punto 3 che passavano la
verifica), `genTime` (la prova del "quando"), il lettore ZIP che non si fa ingannare né esaurire
la memoria, e l'elenco onesto di ciò che non è stato verificato.

**Da fare nelle fasi successive**
- Fase 7: il verificatore non controlla `range.from_ts`/`to_ts` del manifest (punto 20); e
  l'export per date senza prove di inclusione (punto 4) oggi produce checkpoint "scollegati", di
  cui il verificatore non dice nulla.

### Fase 7 — Test completo di esportazione e verifica (fatto)

Test Vitest: da 664 a **678**.

**Difetti corretti** (ciascuno riprodotto prima con un test che falliva):
- **Punto 4 (ALTA).** Un export per date non portava nessuna prova di inclusione: le marche
  temporali nell'archivio non erano legate alle ricevute, e il verificatore non lo diceva.
  Riprodotto in `archive.test.ts` (checkpoint con `proofs: []`). Ora l'export riceve le impronte
  dell'intera catena (`store.readReceiptHashes`) e costruisce le prove della prima e dell'ultima
  ricevuta della finestra anche se la finestra non parte da 0. Porta solo i checkpoint utili:
  quelli che coprono almeno una ricevuta della finestra, fino al primo che le copre tutte. Il
  formato dell'archivio non cambia: `proofs` passa da vuoto a pieno.
- **Decisione ancora aperta del committente** (fase 1): un checkpoint senza alcun legame con le
  ricevute deve dare avviso o errore? Ho applicato la raccomandazione, cioè l'**avviso**. Il
  verificatore conta questi checkpoint (`unlinked_checkpoints`) e lo scrive due volte: tra le
  note, e sotto "not verified" ("prove nothing about this export"). Così gli archivi prodotti
  prima di oggi restano verificabili. Trasformarlo in errore è una riga in `verify.ts`.
- **Punto 9.** Con l'orologio del server tornato indietro, l'export per date selezionava `seq` 1 e
  3 saltando il 2, e l'archivio falliva la propria verifica. Riprodotto in `store.test.ts` con
  SQLite reale (`[1, 3]` invece di `[1, 2, 3]`). Ora le date scelgono solo il primo e l'ultimo
  `seq`, e si esporta tutto ciò che sta in mezzo.
- **Punto 20, `from_ts`/`to_ts`.** Il periodo dichiarato nel manifest, che il PDF stampa, non
  veniva controllato. Ora deve coincidere con `ts_received` della prima e dell'ultima ricevuta.

**Il test completo** (`apps/server/test/export-e2e.test.ts`) percorre tre giorni simulati,
senza nulla di finto tranne l'orologio:
- un signer vero su socket con file di chiave, e il server costruito come lo costruisce `serve`;
- il sistema `selezione-cv` e la sua chiave creati dalla pagina web;
- ogni giorno spazi OTLP (uno con l'impronta di un curriculum) e ricevute dall'API nativa;
- i checkpoint dei primi due giorni presi con il pulsante "Sigilla adesso", ancorati via HTTP da
  un'autorità RFC 3161 vera (openssl locale); il terzo giorno resta senza marca;
- quattro export, tutti verificati dal `sigillo-verify` reale:
  - l'intera catena dalla pagina web, con `--tsa-ca` e `--key-id`: 10 ricevute, 2 checkpoint,
    2 radici ricostruite, 2 token `verified` con l'ora attestata;
  - un solo giorno scelto per data: 3 ricevute, 1 checkpoint, **2 prove di inclusione**, nessun
    checkpoint scollegato;
  - l'intera catena esportata più tardi con `--previous` sul giorno: accettata; al contrario,
    rifiutata;
  - l'export da CLI (`sigillo-server export`) mentre il server gira;
- `sigillo-verify doc` trova il curriculum, e non lo trova più con una lettera cambiata;
- nessun contenuto in chiaro (nome del candidato, argomenti, esito) compare nell'archivio.

### Fase 8 — Preparazione dell'integrazione con un agente reale (fatto)

Documento: `docs/PROPOSTA-FASE-8.md`. Nessuna modifica al codice, come previsto per una fase di
analisi e proposta.

- **Misura del traffico reale dell'SDK.** Ho puntato l'esempio LangGraph e la demo CV su un server
  che registra ogni richiesta OTLP, decodificata con la libreria ufficiale. La demo manda 244 015
  byte in 160 span. Dentro ci sono `input.value` e `output.value` (120 000 caratteri), i metadati
  di LangGraph, le descrizioni dei tool, i messaggi del modello, e il nome di un candidato, le
  intestazioni dei CV e `elena.rizzo`: tutto in chiaro. Il server ne usa pochi identificativi e
  le impronte di ingresso e uscita. È il punto 5 della revisione, ora quantificato.
- **Proposta D6.** Un filtro nell'SDK sostituisce ingresso e uscita con le loro impronte
  (`sigillo.input.sha256`, `sigillo.output.sha256`) e lascia partire solo gli attributi di un
  elenco. Il server accetta le impronte già calcolate. Le ricevute restano identiche byte per
  byte, il formato non cambia e gli altri strumenti di osservabilità non sono toccati.
- **Fattibilità verificata.** Su 2 005 stringhe (casuali, con caratteri di controllo, emoji,
  U+2028/2029, U+FEFF, bidirezionali, NUL), l'impronta calcolata in Python con
  `sha256(json.dumps(s, ensure_ascii=False))` coincide sempre con `hashCanonicalJson` di
  `packages/core`.
- **Rischi dell'integrazione reale**: server irraggiungibile (le azioni perse appaiono come
  silenzio), duplicati dopo un ritentativo (punto 6), span non riconosciuti contati ma non
  visibili, orologi, versioni della strumentazione.
- **Sette domande per il committente** (A–G): quale agente; dove gira e chi gestisce il server;
  approvazione di D6; rifiuto degli span con contenuto; deduplicazione; `on_behalf_of`
  pseudonimo; marca temporale per il pilot. Piano della fase 9 in cinque passi, con criteri di
  accettazione.

### Fase 9 — Prima integrazione reale (sospesa, in attesa)

Non eseguita, come previsto dal prompt: aspetta le risposte alle domande A–G di
`docs/PROPOSTA-FASE-8.md`.

### Fase 10 — Preparazione alla produzione (fatto)

Test Vitest: da 678 a **684**. Test Python SDK (26) e demo (17), `smoke-dist` e cross-check: verdi.

**La guida `docs/DEPLOY-PRODUZIONE.md`**, in italiano, per chi non ha mai visto il progetto:
server, DNS, firewall, orologio, Docker, configurazione, password come segreto, costruzione,
chiave (con la copia cifrata fuori dal server e la prova che si apre), avvio, controlli
dall'esterno, primo sistema, agente di esempio dal portatile, pagina web e blocco dei tentativi,
checkpoint, export, verifica fuori dal server con `--tsa-ca` e `--key-id`, prova di
manomissione, backup notturno e copia fuori dal server, prova di ripristino, aggiornamenti,
cambio o ripristino della chiave, marca qualificata, tabella dei problemi. In fondo, una
**checklist di 33 righe**, con il comando e il risultato atteso per ciascuna.

**Come sono stati ottenuti i risultati attesi.** Senza Docker, ho eseguito davvero, con gli
eseguibili compilati:
- `keygen`, `serve` con la password letta da file, `system create`, `key create`;
- l'agente d'esempio attraverso l'SDK;
- `checkpoint` con **FreeTSA vera** ("1 new checkpoint(s), 1 anchored, 0 still waiting");
- `export` e la verifica con il certificato di FreeTSA e `--key-id` (token `verified`, con
  l'ora attestata);
- il blocco dopo 5 password sbagliate (`401` ×5, poi `401` anche con quella giusta);
- `Cache-Control: no-store`, il backup e la lettura del backup.

Le uscite scritte nella guida sono copiate da lì. La parte Docker (volumi, secret, `read_only`,
`docker compose run --entrypoint tar` per la copia della chiave, `docker cp` verso stdout) è
controllata solo sulla documentazione dei comandi e su `docker compose config`.

> **Da eseguire su una macchina vera: la checklist di `docs/DEPLOY-PRODUZIONE.md`.** È il
> collaudo che manca. Se una riga dà un risultato diverso da quello scritto, va annotato e
> corretto.

**Difetti corretti** (ciascuno riprodotto prima con un test che falliva, componenti reali):
- **Punto 6, la parte che non richiedeva decisioni.** Gli span di un batch OTLP venivano scritti
  uno per volta. Riprodotto in `batch-atomic.test.ts`: signer reale fermato dopo la prima firma
  di un batch da 3; il server risponde 503, ma la prima ricevuta resta scritta (`[0, 1]`), e il
  ritentativo dell'esportatore la duplica. Ora il batch sta in una sola transazione: tutto o
  niente, e il ritentativo lo scrive una volta sola. **Resta la decisione E della fase 8:** la
  deduplicazione per `trace_id`/`span_id`, che serve quando il server ha scritto ma la risposta
  si è persa in rete.
- **Punto 7.** Dopo un cambio di chiave, l'export pubblicava solo la chiave del momento e falliva
  ("key … which the manifest does not publish"); il semaforo diventava rosso. Riprodotto in
  `key-rotation.test.ts` con due chiavi Ed25519 reali sullo stesso database. Ora c'è una tabella
  append-only `signing_keys`: ogni export pubblica tutte le chiavi, e il monitor verifica ogni
  ricevuta con la sua. Limite: una chiave cambiata **prima** di questa versione non è nella
  tabella, perché la sua chiave pubblica non era salvata da nessuna parte.
- **Punto 13.** Due casi, riprodotti in `write-queue.test.ts`:
  - una marca temporale registrata mentre una ricevuta aspettava la firma entrava nella sua
    transazione, e andava persa quando questa falliva;
  - una chiave API emessa dalla pagina web, nello stesso momento, bloccava l'intero processo
    per 5 secondi e poi falliva con 400.

  Ora entrambe passano dalla coda di scrittura.

`SECURITY.md` (storico delle chiavi) e `README.md` (rimando alla guida, password come segreto)
sono aggiornati.

### Fase 11 — Revisione finale prima del pilot (fatto)

Documento completo: `docs/REVISIONE-FASE-11.md`.

#### Riepilogo finale della sessione del 24 settembre 2026 (fasi 5-11)

**I 20 problemi della revisione della fase 1, oggi**

| Stato | Punti |
|---|---|
| corretto | 1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 20 |
| mitigato (resta una tua decisione o una verifica su macchina vera) | 6 (deduplicazione), 15 (Docker mai eseguito) |
| rimandato alla fase 9, prima del pilot, con soluzione pronta | 5 (contenuti in chiaro verso il server: proposta D6) |
| accettato come rischio noto, documentato | 18 (dati nei campi testuali, decisioni D1–D5), 19 (impronte prevedibili, D7 dopo il pilot) |

Dei cinque problemi gravi, quattro sono corretti (1, 2, 3, 4). Il quinto (5) ha
la soluzione progettata e verificata sulla carta, e aspetta la tua approvazione.

**Difetti nuovi trovati e corretti in queste fasi:**
- `docker compose config` stampava le password;
- Caddy non partiva con l'email vuota;
- la cartella dei backup non era scrivibile.

Tutti e tre vengono da una configurazione Docker mai eseguita.

**Cosa è pronto**
- Nucleo crittografico e verificatore: nessun difetto trovato nel nucleo.
  Due verifiche nuove per ciò che un archivio non può provare da solo:
  `--key-id` e `--previous`.
- Verifica messa alla prova:
  - 17 scenari di manomissione, ciascuno controllato con il verificatore vero;
  - un percorso completo di tre giorni, con un'autorità di marcatura vera (openssl
    locale nei test, FreeTSA nella prova manuale).
- Server: limiti ai tentativi, sessioni revocabili, riconnessione al signer, batch
  atomici, storico delle chiavi, log puliti, configurazione validata.
- Deploy indurito; guida `docs/DEPLOY-PRODUZIONE.md` con checklist di 33 righe.
- `SECURITY.md`: cosa sigillo non può rilevare, e la checklist prima della
  produzione.
- 684 test Node (erano 579), più i 26 dell'SDK Python e i 17 della demo. CI verde.

**Cosa resta esplicitamente a tuo carico**
1. **Docker reale**: mai eseguito qui (il demone non si avvia in questo ambiente).
2. **Deploy su VPS**: eseguire la checklist di `docs/DEPLOY-PRODUZIONE.md` su un
   server vero, con dominio e HTTPS. È il collaudo di 1 e 2 insieme.
3. **Marca temporale qualificata eIDAS**: non configurata; FreeTSA non è
   qualificata. Per il pilot va accettata per iscritto, oppure sostituita.

Più le decisioni elencate in `docs/REVISIONE-FASE-11.md`:
- le domande A–G della fase 8, che sbloccano la fase 9;
- avviso o errore per un checkpoint scollegato (punto 4);
- chi custodisce la copia cifrata della chiave;
- D1–D5 e D7.

**La valutazione complessiva cambia?** Sì, in due direzioni:
- **in meglio**: le garanzie promesse reggono sotto prova, e nessuna correzione
  ha toccato il formato o le regole di verifica;
- **più precisa sui limiti**: un fascicolo da solo non dimostra né di chi è la
  chiave né che non manchi la coda. Tre cose esterne vanno trattate come parte
  del prodotto:
  - il `key_id` pubblicato per un altro canale;
  - gli export consegnati nel tempo, con le loro marche temporali;
  - un intervallo tra checkpoint breve (suggerisco 15 minuti per il pilot).

Il rischio principale del pilot oggi è **operativo**, non crittografico: il
Docker mai avviato, e il contenuto in chiaro verso il server finché D6 non è
approvata.

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

#### M3 — Firmatario (fatto)

- `apps/signer/src/key-file.ts` — `keygen` scrive una chiave Ed25519 PKCS#8 PEM con permessi `0600`
  (verificati nel test), si rifiuta di sovrascrivere una chiave esistente, e al caricamento **rifiuta**
  una chiave leggibile da altri (`chmod 644` → errore esplicito).
- `apps/signer/src/daemon.ts` — socket Unix, protocollo JSON a righe, `pubkey` e `sign`.
  `sign` accetta **solo** 64 caratteri hex minuscoli; tutto il resto è rifiutato. Il socket è `0660`.
- `apps/signer/src/cli.ts` — `sigillo-signer keygen` e `sigillo-signer serve` (commander).
- `apps/server/src/signer/client.ts` — il client sta nel server, come da SPEC. Conosce **solo** il path
  del socket. Verifica che il `key_id` annunciato corrisponda davvero alla chiave pubblica ricevuta,
  e che la firma abbia la forma richiesta dal formato: quello che arriva dal firmatario non è preso per buono.
- `packages/core/src/signing.ts` — `signDigest`, `verifyDigestSignature`, `verifyReceiptSignature`.

Verifiche eseguite (171 test verdi in totale):
- La firma prodotta da core **coincide byte per byte** con quella prodotta dalla CLI openssl sugli stessi
  32 byte (Ed25519 è deterministico). Vettore in `packages/core/test/fixtures/signing-vector.json`,
  generato con openssl, non con il nostro codice.
- Rifiuto di input di lunghezza sbagliata: 63 e 65 caratteri hex, hex maiuscolo, non-hex, prefisso `0x`,
  numero, null, array, oggetto, campo assente, campi in più, JSON non valido, JSON non oggetto,
  riga troppo lunga. 24 test sul solo protocollo.
- **Test end-to-end a due processi reali**: il firmatario gira come processo separato lanciato dalla CLI,
  il server scrive una catena completa attraverso il socket e tutte le ricevute verificano con la chiave
  pubblica del firmatario.
- Se il firmatario muore, l'append **fallisce** e la catena resta al solo genesis: nessuna riga non firmata,
  nessun buco.
- "Il server non apre mai il file della chiave": verificato in due modi — un test che ispeziona tutti i
  sorgenti di `apps/server/src` e fallisce se compare `createPrivateKey`, `generateKeyPair` o `privateKey`,
  e la stessa regola resa permanente in `pnpm lint`.

Nota sul test: `tsx` lancia il programma in un processo figlio, quindi uccidere il wrapper lasciava vivo
il firmatario. I test ora usano un gruppo di processi; senza questa correzione il test "il firmatario muore"
passava per il motivo sbagliato.

#### M4 — Verificatore v1 (fatto)

- `packages/verifier/src/verify.ts` — 8 controlli nell'ordine della SPEC, codice esplicito, nessuna
  astrazione. Si ferma al primo errore e indica **quale ricevuta** (file:riga e `seq`) e **quale controllo**.
- `packages/verifier/src/cli.ts` — `sigillo-verify <cartella>`; exit 0 se valido, 1 se manomesso,
  2 se l'archivio non è leggibile. In caso di successo stampa l'elenco di ciò che ha verificato.
- `apps/server/src/export/bundle.ts` — export minimale: `receipts.jsonl` (forma canonica, una per riga)
  + `manifest.json`.
- `packages/core/src/manifest.ts` — schema del manifest, documentato in `docs/FORMAT.md` §8.

Dimensione: **697 righe** fra verificatore e le parti di core che usa (obiettivo SPEC: sotto 1000).

Test di manomissione, tutti rilevati con il controllo giusto (205 test verdi in totale):
- byte modificato a metà catena → `chain-link`, nominando entrambe le ricevute coinvolte;
- byte modificato **nell'ultima** ricevuta (dove nessun link la copre) → `signature`;
- ricevuta cancellata → `sequence`; cancellata **l'ultima** → `range` (la catena resterebbe coerente:
  se ne accorge solo perché il manifest dichiara dove doveva arrivare);
- due ricevute scambiate → `sequence`; ricevuta duplicata → `sequence`;
- firma con altra chiave → `signature`; `key_id` assente dal manifest → `key`;
- genesi falsificata → `genesis`; ricevute di un altro sistema infilate dentro → `system`;
- manifest non JSON, campo mancante, conteggio sbagliato, `system_id` sbagliato.

Property test con `fast-check`:
- ogni catena ben formata di lunghezza 1..12 verifica;
- **qualsiasi singolo carattere** cambiato in `receipts.jsonl` fa fallire la verifica (300 casi);
- la rimozione di qualsiasi ricevuta fallisce; la duplicazione di qualsiasi ricevuta fallisce;
- qualsiasi riordino diverso dall'originale fallisce.

Verifica end-to-end: il server scrive la catena, la esporta su disco, e il comando `sigillo-verify`
lanciato come processo separato la accetta; manomettendo un byte esce con codice 1 e stampa
`chain-link at receipts.jsonl:6`.

Lacuna trovata da un test e corretta: il verificatore non controllava che il `key_id` pubblicato nel
manifest corrispondesse davvero alla chiave pubblica accanto. Dato che `key_id` è **derivato** dalla
chiave, ora lo verifica: una chiave pubblicata sotto l'identificativo di un'altra viene respinta subito,
invece di emergere più tardi come una firma inspiegabilmente non valida.

Decisione: il verificatore **non** richiede che le righe siano in forma canonica. Ricalcola lui la forma
canonica, quindi un export che riordina i campi o aggiunge spazi verifica lo stesso. È il comportamento
corretto: l'evidenza sta nel contenuto, non nella serializzazione del file.

#### M5 — Ingest OTLP e API nativa (fatto)

- `apps/server/proto/` — i quattro `.proto` ufficiali di `opentelemetry-proto` **tag v1.7.0**, copiati
  verbatim con licenza Apache-2.0, data, e SHA-256 di ogni file annotati nel README della cartella.
- `apps/server/src/ingest/otlp.ts` — decodifica protobuf (protobufjs sui `.proto` copiati) **e** JSON.
  Accetta sia `camelCase` sia `snake_case`, e identificatori sia in hex (come vuole OTLP/JSON) sia in
  base64 (come produce la mappatura proto3→JSON): entrambe le forme circolano davvero.
- `apps/server/src/ingest/adapter.ts` — adattatore a due dialetti, modulo isolato con i suoi test.
- `apps/server/src/auth/api-keys.ts` — una API key per sistema, solo hash scrypt salato.
- `apps/server/src/http/server.ts` — fastify: `POST /v1/traces`, `POST /api/v1/receipts`, `GET /healthz`.
- `apps/server/src/cli.ts` — `serve`, `system create|list`, `key create|revoke|list`, `export`.
- `docs/API.md` — endpoint, formati, comandi.

Fixture: **payload OTLP veri**, non scritti a mano. `scripts/gen_otlp_fixtures.py` avvia l'esportatore
OTLP ufficiale Python contro un server di cattura e salva il corpo esatto della richiesta. Due dialetti
× tre codifiche = 6 fixture. Le tre codifiche di uno stesso payload devono produrre le stesse ricevute,
ed è verificato da un test.

282 test verdi. Tra i controlli:
- span status → outcome, con **UNSET → `unknown`**: OpenTelemetry lascia lo status non impostato a meno
  che la sorgente non dica qualcosa, quindi leggere "non impostato" come "successo" sarebbe un'affermazione
  che la sorgente non ha fatto. È esattamente perché il vocabolario ha `unknown`.
- convenzioni non stabili: un `gen_ai.operation.name` sconosciuto (`rerank_documents`) e la vecchia
  convenzione senza operation name vengono **accettati e segnalati** nella risposta, non scartati.
- span che non sono azioni AI (una richiesta HTTP, una query) → ignorati e contati.
- i payload non vengono mai memorizzati: un test cerca le stringhe originali (`A-1099`,
  `where is my order`) dentro la catena serializzata e pretende di non trovarle.
- un attributo chiamato `__proto__` finisce in una `Map`, non in un prototipo di oggetto.
- l'ordinamento degli span per tempo di inizio rende l'ingest deterministico: lo stesso payload dà
  sempre la stessa catena, anche se il batch arriva in ordine inverso.

Difetto trovato da un test e corretto: il segreto delle API key era in base64url, che contiene `_`,
lo stesso separatore del token — chiunque avesse fatto `split("_")` avrebbe sbagliato. Ora entrambe le
metà sono esadecimali e il formato è senza ambiguità.

Verifica di sicurezza sulle chiavi: un test legge i **byte grezzi** del file di database (e di `-wal`/`-shm`)
e pretende che il segreto non compaia da nessuna parte.

Percorso completo eseguito davvero con i binari compilati, non solo nei test:
firmatario avviato → `system create` → `key create` → `serve` → POST protobuf (5 accettate, 1 ignorata)
→ POST JSON (5 accettate, 1 ignorata) → POST API nativa → 401 senza chiave → `export` →
`sigillo-verify` → `OK acme-support-bot: 12 receipts, seq 0..11`.

#### M6 — SDK Python (fatto)

- `sdk-python/src/sigillo/__init__.py` — **una sola funzione pubblica**, `sigillo.init(endpoint, api_key,
  system_id, instrument=["langchain","crewai"])`. Configura `TracerProvider` + `OTLPSpanExporter` HTTP
  con l'API key come Bearer, e attiva le instrumentazioni OpenInference richieste **se installate**
  (se mancano: warning, non errore).
- `sdk-python/examples/langgraph_agent.py` — agente LangGraph minimo, **modello fittizio**
  (`GenericFakeChatModel`) e tool finto: nessuna chiamata a un modello reale, quindi costo zero
  e comportamento deterministico.
- `sdk-python/README.md` — installazione, cosa fa `init`, cosa **non** viene registrato.
- Il pacchetto dipende solo da `opentelemetry-sdk` e `opentelemetry-exporter-otlp-proto-http`;
  le instrumentazioni sono extra opzionali, come da SPEC §3.

Test: **niente pytest**, solo `unittest` della libreria standard, così non serve alcuna dipendenza
fuori dalla lista consentita. 12 test verdi (9 unitari + 3 end-to-end), con `ResourceWarning`
trattati come errori.

Il test end-to-end fa girare **tre processi reali**: firmatario (con chiave vera, permessi 0600
verificati), server, ed esempio. Poi esporta e verifica con il verificatore open source.
Controlla che: la catena parta dalla genesi con `seq` contigui; ci siano `llm_call`, `tool_call` e
`agent_step`; ogni firma abbia la forma giusta; il `sigillo-verify` dia OK. Un secondo test manomette
l'export e pretende exit code 1.

Controllo di privacy nel test e2e: cerca `A-1099`, `where is my order` e `DHL` dentro
`receipts.jsonl` e pretende di **non trovarli**. L'agente ha detto quelle cose; il registro conserva
solo le impronte.

Difetto trovato da un test e corretto: il modulo ri-esportava i nomi importati
(`sigillo.TracerProvider`, `sigillo.Resource`, ...), cioè la superficie pubblica non era affatto
"una sola funzione". Ora gli import sono sotto nomi privati e un test lo verifica.

Nota sulle dipendenze: `langgraph` e `langchain-core` **non** sono dipendenze del pacchetto `sigillo`.
Servono solo all'esempio e stanno in `sdk-python/examples/requirements.txt`. Li ho usati perché la
SPEC §8 richiede esplicitamente un esempio LangGraph.

CI: aggiunto un terzo job che compila i pacchetti Node e poi esegue i test Python, end-to-end incluso.

#### M7 — Merkle e marca temporale (fatto)

- `packages/core/src/merkle.ts` — albero RFC 6962: foglia `SHA-256(0x00‖impronta)`, nodo
  `SHA-256(0x01‖sx‖dx)`, split alla massima potenza di 2 sotto n. Prove di inclusione **senza**
  marcatori sinistra/destra: i lati derivano da indice e dimensione, quindi la prova non può
  contraddire sé stessa.
- `packages/core/src/checkpoint.ts` — checkpoint (`v`, `system_id`, `tree_size`, `root_hash`, `ts`,
  `key_id`, `sig`), stesse regole di forma canonica e firma della ricevuta: chi sa verificare una
  ricevuta sa verificare un checkpoint.
- `apps/server/src/timestamp/rfc3161.ts` — richiesta costruita con `openssl ts -query -sha256
  -digest <root> -cert -no_nonce`, POST `application/timestamp-query`, token salvato **così com'è**
  (DER, base64), retry con ritardo che raddoppia, credenziali Basic opzionali.
- `apps/server/src/checkpoint/checkpointer.ts` — scheduler: un checkpoint per catena con ricevute
  nuove, poi ancoraggio di tutti i checkpoint ancora senza token.
- CLI: `sigillo-server checkpoint` per eseguire un giro a mano; `serve` avvia lo scheduler
  (`--checkpoint-minutes`, default 60; `--tsa-url` o `TSA_URL`).
- `docs/FORMAT.md` §8 e §9 — albero, prove di inclusione e ancoraggio documentati per intero.

Vettori Merkle: `scripts/gen_merkle_vectors.py` li deriva **dal testo della RFC 6962**, in Python,
senza usare il nostro codice, e calcola ogni radice **due volte** con due algoritmi diversi
(split ricorsivo e costruzione per livelli con promozione del nodo dispari). Se i due non
coincidono i vettori non vengono scritti. Coperte le dimensioni **0..17**, e per ogni dimensione
la prova di inclusione di **ogni** foglia.

Controlli a mano: radice dell'albero vuoto = `sha256("")`, radice di una foglia = `sha256(0x00‖e)`,
radice di due foglie = `sha256(0x01‖l0‖l1)`. Tutti verificati.

358 test verdi. Tra i controlli:
- ogni prova di inclusione ricostruisce la radice; alterando **qualsiasi passo** non la ricostruisce;
- una prova presentata per la ricevuta sbagliata o la posizione sbagliata fallisce;
- il checkpoint viene **salvato e firmato anche se la TSA non risponde**, e il token viene preso al
  giro successivo (requisito esplicito della SPEC);
- il retry rispetta i ritardi 100ms, 200ms, ... verificati senza attendere davvero;
- risposte non valide della TSA (500, corpo vuoto, pagina HTML, byte che non sono DER) rifiutate;
- i trigger append-only valgono anche per i checkpoint.

Difetto trovato da un test e corretto: una prova di inclusione **troppo lunga** non veniva
rifiutata — raggiunta la radice, i passi in più continuavano a produrre hash e restituivano la
radice di un altro albero. Ora la lunghezza attesa viene calcolata da indice e dimensione e
confrontata prima di iniziare.

**Test di rete eseguito davvero** contro `https://freetsa.org/tsr`: token ottenuto, `openssl ts
-reply -text` mostra `Status: Granted.` e il digest nel token coincide con la `root_hash` del
checkpoint. Il test si salta da solo se la TSA non è raggiungibile.

### Serve una decisione: la TSA qualificata eIDAS — *decisa il 2026-09-21: si aspetta*

La SPEC dice di fermarsi e chiedere quando si arriva al fornitore di produzione. Il codice è pronto:
`TSA_URL`, più `TSA_USERNAME`/`TSA_PASSWORD` per i fornitori che autenticano la richiesta.
**FreeTSA non è qualificata eIDAS**, quindi va bene solo per sviluppo e test. Per la produzione
servono: URL del fornitore qualificato, eventuali credenziali, e il certificato della sua CA per
la verifica offline (da includere nel fascicolo).

#### M8 — Fascicolo completo e verificatore v2 (fatto)

- `packages/core/src/zip.ts` — lettore e scrittore ZIP **senza dipendenze** (`node:zlib`, CRC-32
  scritto a mano). Solo voci stored e deflated, niente ZIP64, niente cifratura: rifiuta quello che
  non capisce invece di indovinare. Archivio riproducibile (nessun timestamp, ordine fisso).
- `apps/server/src/export/archive.ts` — l'archivio: `receipts.jsonl`, `checkpoints.jsonl` (con prove
  di inclusione di prima e ultima ricevuta), `timestamps/*.tsr` (DER grezzo), `manifest.json`,
  `report.pdf`, `VERIFY.md`.
- `apps/server/src/export/report.ts` — PDF con pdfkit: sistema, periodo, conteggi per tipo di azione,
  esito della verifica, elenco dei checkpoint con le loro marche, istruzioni, e le **tre finalità
  dell'art. 12(2) AI Act** (testo verificato sulla fonte, non citato a memoria).
- `apps/server/src/export/verify-instructions.ts` — `VERIFY.md` autosufficiente: come verificare col
  verificatore, come verificare **una ricevuta a mano con openssl**, come verificare un token, e
  cosa il fascicolo **non** prova.
- `packages/verifier/src/timestamps.ts` — verifica dei token con openssl, su **due livelli distinti**
  mai confusi: `verified` (certificato della CA fornito, firma controllata) e `imprint-only`
  (solo l'impronta confrontata). Senza openssl: `not-checked` e avviso esplicito. Un controllo
  mancante è riportato come mancante, mai come superato.

Il verificatore ora esegue **12 controlli** (era 8): aggiunti firma dei checkpoint, ricalcolo delle
radici Merkle dalle ricevute presenti, validità delle prove di inclusione, coerenza dei conteggi di
checkpoint e token, e verifica dei token RFC 3161.

386 test verdi. Manomissione di **ogni** componente, ciascuna rilevata col controllo giusto:
ricevuta a metà catena (`chain-link`), **ultima** ricevuta (`signature`, e la radice Merkle la
coprirebbe comunque), `root_hash` di un checkpoint (`checkpoint-signature`), checkpoint rifirmato con
altra chiave (`checkpoint-signature`), passo di una prova alterato (`inclusion-proof`), prova per una
ricevuta assente (`inclusion-proof`), conteggi del manifest (`range`), checkpoint rimosso (`range`),
file rimosso dallo zip (`range`), byte cambiato dentro lo zip (fallisce il CRC), token che non è un
token (fallimento della verifica, **non** un avviso).

Verifica incrociata dello ZIP: l'archivio viene aperto da `unzip` di sistema e da `zipfile` di Python
(che ne ricontrolla i CRC) nei test, non solo dal nostro lettore.

**Percorso completo eseguito con i binari compilati e una TSA vera**:
ingest protobuf + JSON → 11 ricevute → `checkpoint` con ancoraggio su `https://freetsa.org/tsr`
→ `export` → zip di 6 file → `sigillo-verify` → `OK, 1 root rebuilt, 2 inclusion proof(s)`,
token `imprint-only` con l'avviso; con `--tsa-ca` scaricato dalla CA di FreeTSA il token passa a
**`verified`**.

### Serve una decisione: la dimensione del verificatore — *decisa il 2026-09-21: opzione (a), si lascia com'è*

La SPEC pone come obiettivo "meno di 1000 righe tra verifier e la parte di core che usa".
Siamo a **1689 righe** (1320 escludendo vuote e commenti). Dettaglio:

| parte | righe | codice |
|---|---|---|
| verificatore: i controlli | 386 | 329 |
| verificatore: token RFC 3161 via openssl | 205 | 164 |
| verificatore: CLI | 189 | 164 |
| core: formato, canonicalizzazione, hash | 248 | 177 |
| core: chiavi e firme | 94 | 64 |
| core: Merkle e checkpoint | 227 | 163 |
| core: schemi dell'export | 123 | 89 |
| core: lettore/scrittore ZIP | 217 | 170 |

L'obiettivo era stato fissato quando il verificatore faceva 8 controlli su due file; ora ne fa 12,
legge archivi ZIP e verifica token RFC 3161, tutto richiesto dalla SPEC stessa (§8). Non c'è grasso
da togliere: comprimere i commenti farebbe scendere il numero peggiorando proprio la leggibilità che
l'obiettivo voleva proteggere. **Tre opzioni, decidi tu**: (a) alzare l'obiettivo a ~1700 righe e
lasciare com'è; (b) togliere la lettura degli ZIP dal verificatore (~217 righe) e far verificare solo
cartelle, chiedendo all'auditor di scompattare prima; (c) togliere la verifica dei token dal
verificatore (~205 righe) e lasciarla alle istruzioni di `VERIFY.md`. La mia raccomandazione è (a):
entrambe le altre tolgono all'auditor qualcosa che la SPEC gli aveva promesso.

#### M9 — UI, deploy, documentazione (fatto)

**La vista web** (`apps/server/src/http/ui.ts`, 360 righe). Renderizzata dal server, **nessun
JavaScript**, nessun foglio di stile esterno, nessuna dipendenza in più. Pagine: elenco dei sistemi
con conteggio ricevute e stato dell'ultimo checkpoint; dettaglio di un sistema con le ultime
ricevute e un filtro per agente, tipo di azione ed esito; elenco dei checkpoint con `tree_size`,
radice e stato dell'ancoraggio; un bottone che produce il fascicolo e lo scarica.

Due scelte che vale la pena scrivere:
- La UI **non viene montata affatto** se `SIGILLO_ADMIN_PASSWORD` non è impostata (e la password
  deve avere almeno 12 caratteri, altrimenti il server rifiuta di partire). Un deployment che non
  vuole la vista web non ha una pagina di login esposta da indovinare: non ha proprio la rotta.
- La sessione è un cookie firmato HMAC con un segreto generato a ogni avvio del processo
  (`HttpOnly`, `SameSite=Strict`, `Secure` dietro TLS). Riavviare il server invalida le sessioni:
  è il comportamento giusto per una console di amministrazione, e toglie di mezzo un segreto in più
  da gestire. Confronto della firma con `timingSafeEqual`.
- Ogni valore che finisce in pagina passa da `escape()`. La UI mostra **solo** metadati: nomi di
  agente, tipi di azione, impronte. Non esiste una pagina che possa mostrare un prompt, perché il
  prompt non è mai stato salvato.

**Il deployment** (`deploy/`). `Dockerfile` multi-stage con due target: `signer` e `server`, immagini
separate, entrambe non-root. `docker-compose.yml` con tre servizi, e la separazione è il punto:

| servizio | cosa tiene | rete |
|---|---|---|
| `signer` | la chiave privata, su un volume montato **solo qui** | `network_mode: none` — nessuna rete, parla solo dal socket |
| `server` | il database e il socket verso il firmatario | nessuna porta pubblicata |
| `caddy` | TLS automatico | l'unico sulle porte 80/443 |

`Caddyfile` con HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` e una CSP
`default-src 'none'` che la vista web rispetta perché non ha script propri. `backup.sh` usa l'API di
backup di SQLite, **non** `cp`: una copia presa mentre una scrittura è in volo è un database corrotto
che sembra a posto finché qualcuno non lo legge. Le copie vecchie si potano per numero, non per età,
così un backup che smette di girare non cancella in silenzio l'ultima copia buona.

**La documentazione**: `README.md` (cinque minuti dal clone alla verifica, con l'output vero dei
comandi), `docs/SECURITY.md` (dov'è la chiave, cosa succede se il server viene compromesso, cosa
l'operatore del servizio può e non può vedere, e una sezione **Known limits** che dice a chiare
lettere cosa sigillo non prova), `docs/API.md` e `docs/FORMAT.md` già scritti e aggiornati.

##### Difetti trovati dai test in questa milestone

1. **Malleabilità della firma in base64** — trovato da un property test con fast-check. La regex
   accettava qualunque stringa di 86 caratteri più `==`, ma gli ultimi quattro bit dell'86° carattere
   non fanno parte dei 64 byte della firma: **16 scritture diverse decodificano alla stessa firma**,
   e tutte e 16 passavano la verifica. Conseguenza reale: due esportazioni dello stesso registro
   potevano differire byte per byte pur essendo entrambe valide, e un confronto binario fra fascicoli
   non voleva dire niente. Corretto con `packages/core/src/base64.ts` (`isCanonicalBase64`: ricodifica
   e confronta), applicato alla firma della ricevuta, a quella del checkpoint e alla chiave pubblica
   nel manifest. Documentato in `docs/FORMAT.md` §5 e aggiunto al cross-check Python.
   **Non ho incrementato `v`**: la regola stringe soltanto, e rifiuta unicamente scritture che
   sigillo non ha mai prodotto. Ogni ricevuta esistente resta valida. *Il committente ha
   confermato questa scelta il 2026-09-21: il formato resta v1, definitivo.*
2. **Codici di stato della UI** — un helper metteva 200 su ogni risposta HTML. Un login **fallito**
   tornava 200, e un sistema inesistente pure. Lo stato è ora un parametro esplicito; i test
   controllano 401 sul login sbagliato e 404 sul sistema che non c'è.
3. **Un test intermittente, non un difetto del prodotto** — un test di manomissione sostituiva
   l'ultimo carattere esadecimale con `"0"`: una volta su 16 era già `"0"` e la manomissione era un
   non-cambiamento. Sostituito con un helper `flipLastHex`. Sei esecuzioni consecutive verdi dopo
   la correzione.

#### Dopo M9 — la guida per chi non usa il terminale, e un difetto nel Dockerfile

Scritto `PROVA-LOCALE.md`: guida passo per passo, in italiano, separata per Windows e Mac, che
porta una persona che non ha mai usato un terminale da zero a un fascicolo verificato. Ogni
comando ha sotto una frase che dice cosa fa, e c'è una sezione "se qualcosa va storto" con gli
errori più probabili e il rimedio.

Per non costringere quella persona a modificare a mano dello YAML — che è esattamente ciò che una
persona non tecnica sbaglia — ho aggiunto `deploy/docker-compose.local.yml`: niente Caddy, porta
pubblicata **solo** su `127.0.0.1`, e un servizio `esempio` che fa girare l'agente Python in un
container, così non serve installare Python. `COMPOSE_FILE` scritto nel `.env` accorcia tutti i
comandi successivi a `docker compose ...`.

Due cose notate mentre lo scrivevo, entrambe corrette:

- `deploy/.env` **non era in `.gitignore`**, e la guida dice di scriverci dentro la password di
  amministrazione e una chiave API. Su un repository pubblico era una trappola. Ora è ignorato.
- Un `:?` su `SIGILLO_API_KEY` avrebbe bloccato `docker compose up`: Compose interpola tutto il
  file **prima** di scegliere i servizi, quindi una variabile obbligatoria su un servizio dietro a
  un profilo ferma comunque l'avvio — e la chiave API non esiste finché il server non è in piedi.
  Reso opzionale; se manca, è l'esempio stesso a dirlo.

##### Il difetto: il Dockerfile non ha mai potuto costruire

Provando a verificare il comando di verifica della guida ho eseguito lo stesso `pnpm deploy` che
il `Dockerfile` usa, e **fallisce**:

```
ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE  By default, starting from pnpm v10, we only deploy
from workspaces that have "inject-workspace-packages=true" set
```

Esce con 1 **prima di scrivere `node_modules`**. Il `RUN` del Dockerfile sarebbe fallito e
`docker compose build` — il Passo 5 della guida — non sarebbe mai arrivato in fondo. Il progetto
fissa pnpm 10.33.0, quindi il difetto era certo, non probabile: semplicemente non era mai stato
eseguito, perché nella sessione cloud Docker non c'è.

Corretto aggiungendo `--legacy` ai tre comandi `deploy`, che è il rimedio indicato dall'errore
stesso di pnpm. Verificato: tutti e tre i pacchetti ora si impacchettano con exit 0, con
`node_modules` e `@sigillo/core` dentro, e i tre eseguibili partono da una cartella qualsiasi —
che è precisamente il meccanismo su cui si regge `node /verifier/dist/cli.js` dentro il container.

**Resta vero che il giro Docker completo non è mai stato eseguito.** Questo difetto è la prova
che la checklist in fondo a questo file va eseguita davvero, non data per buona.

##### Il percorso completo, eseguito davvero (senza Docker)

Docker **non è disponibile in questa sessione cloud**: il CLI c'è, il daemon no (`docker info`
esce 1). È esattamente il caso previsto dalla SPEC. Ho quindi validato `docker-compose.yml` con
`docker compose config` (che è analisi statica, non esecuzione) e ho eseguito **tutto il percorso di
accettazione con i binari compilati**, processi avviati direttamente. Sotto l'output annotato; la
checklist con Docker è in fondo al file.

```
### 2. firmatario     permessi della chiave: -rw-------  (key_id a16278409045516a)
### 3. sistema e chiave   creato acme-support-bot, genesi firmata
### 5. l'esempio Python, attraverso l'SDK
    instrumentations: langchain
    l'agente ha risposto: Your order A-1099 has shipped with DHL.
### 6. la vista web
    la pagina dei sistemi elenca acme-support-bot
    la pagina delle ricevute ne mostra 8
    export dalla UI: 200, 7608 byte
    senza il cookie: 302 (redirect al login)
### 7. checkpoint e ancoraggio
    acme-support-bot  tree_size 8  root 7257843a3faa...  1 ancorato, 0 in attesa
### 8. export e verifica
    OK  acme-support-bot: 8 receipts, seq 0..7, signed by a16278409045516a
        1 checkpoint(s), 1 root(s) rebuilt, 2 inclusion proof(s) verified
        timestamp timestamps/checkpoint-8-1.tsr: imprint-only
### 9. backup        scritti 73728 byte
```

Il criterio della SPEC è "meno di un'ora seguendo solo il README". Dalla chiave generata al fascicolo
verificato: **9 secondi**. L'ora serve a scaricare e compilare le immagini, non al percorso.

**406 test verdi** (erano 386), su sei esecuzioni consecutive. `pnpm lint`, `pnpm typecheck`,
`pnpm build`, lo smoke test sul `dist/` e il cross-check Python passano tutti.

##### Correzione a un numero scritto in M8

La tabella della dimensione del verificatore, qui sopra, **ometteva `packages/core/src/index.ts`**
(96 righe di re-export). Il numero onesto, ricontato ora e comprensivo di `base64.ts`, è
**1792 righe in totale, 1416 escludendo righe vuote e commenti**, non 1689. La decisione che ti
chiedo non cambia — le tre opzioni restano quelle — ma il numero su cui decidere è questo.

### Sessione 2 — 2026-09-22

Avviata la fase 2. Il prompt che la descrive (sezioni 1–6) è copiato integralmente in fondo a
`SPEC.md`, sezione "Fase 2"; le milestone della sua sezione 7 sono nella tabella qui sopra
(N1–N6, tutte `todo`); il fuori-ambito della sua sezione 8 è la nota qui sotto. Branch di lavoro:
`claude/sigillo-fase-2-illggi`, ripartito da `main` allo stesso commit con cui si era chiusa la
fase 1 (`7362402` — la PR #1 con le decisioni del committente era nel frattempo stata mergiata,
quindi il blocco "main non esiste sul remote" annotato in Sessione 1 è superato).

#### Fuori ambito per la fase 2

Non previsti in questa fase: il casello davanti ai modelli locali, la verifica incrociata tra più
fonti, multi-utente e ruoli, HSM/KMS, cancellazione per retention. Se durante il lavoro dovesse
emergere che uno di questi è necessario, la decisione si annota qui prima di proseguire.

#### Dipendenze nuove già autorizzate dal committente nel prompt della fase 2

Il prompt nomina esplicitamente due dipendenze non ancora nella lista approvata di `CLAUDE.md`:
`openinference-instrumentation-openai` (extra opzionale Python, usata in N2) e `langchain-ollama`
(solo per `demo/selezione-cv`, stesso trattamento di `langgraph`/`langchain-core` in M6: non è una
dipendenza del pacchetto `sigillo`, serve solo alla demo). Le aggiungo alla lista approvata quando
le uso davvero, in N2 e N5 rispettivamente, non prima.

#### N1 — Formato v2 (fatto)

- `packages/core/src/receipt.ts` — `v` diventa un'unione discriminata zod fra `unsignedReceiptV1Schema`
  (invariato bit per bit rispetto a prima) e `unsignedReceiptV2Schema`, che aggiunge `artifacts`
  (array non vuoto, mai vuoto: un'azione senza documenti omette il campo) e `model` (con `provider`
  e `digest` **nullable**, non opzionali, perché a differenza di `on_behalf_of` un nome di modello
  da solo resta un'evidenza significativa). I campi comuni vivono in una sola `receiptCoreShape`
  condivisa, così ogni versione resta uno `z.object` leggibile per intero, senza `.extend()` da
  inseguire. `RECEIPT_VERSION` (una sola costante) diventa `RECEIPT_VERSION_1`/`RECEIPT_VERSION_2`
  (`as const`, altrimenti TypeScript le allarga a `number` e l'unione discriminata smette di
  distinguere le due forme).
- `packages/core/src/checkpoint.ts` — disaccoppiato dalla versione della ricevuta: aveva sempre
  riusato `RECEIPT_VERSION` per il proprio campo `v`, che per puro caso valeva 1 in entrambi i casi.
  Ora ha una propria `CHECKPOINT_VERSION = 1`, perché la fase 2 non tocca affatto il formato del
  checkpoint e le due versioni non devono restare accoppiate per un incidente storico.
- `packages/core/src/manifest.ts` — `receipt_version` accetta `1` o `2` e cambia significato: non è
  più "la versione di questo export" ma **la versione più alta fra le ricevute presenti**, perché
  una catena può passare da v1 a v2 a metà strada e un fascicolo può contenerle entrambe. Un export
  tutto-v1 continua a dichiarare `1`, quindi ogni manifest già prodotto resta valido così com'è.
- `packages/verifier/src/verify.ts` — un solo controllo nuovo: `receipt_version` deve combaciare con
  il massimo delle versioni davvero presenti (stesso trattamento di `range`/`counts.*`, dichiarazione
  verificata contro il contenuto, mai presa per buona). La manomissione di un `artifact` o del `model`
  **non richiede nessun controllo nuovo**: sono campi dentro la ricevuta come ogni altro, quindi
  cambiarli cambia l'impronta della ricevuta e viene rilevato dal `chain-link`/`signature` che già
  esisteva. Le prove nuove lo dimostrano invece di limitarsi a dirlo.
- `apps/server/src/export/archive.ts` — `receipt_version` nel manifest calcolato dal massimo delle
  ricevute effettivamente esportate, non più letto da una costante: altrimenti sarebbe rimasto
  sbagliato dal giorno in cui il server iniziasse davvero a scrivere ricevute v2 (N2/N5).
  `apps/server/src/storage/store.ts` continua a scrivere `v: RECEIPT_VERSION_1`: **il server non
  scrive ancora ricevute v2**, di proposito — resta compito di N2 (SDK) e N5 (demo), che sono le
  prime milestone ad avere davvero `artifacts`/`model` da mettere in una ricevuta.
- `docs/FORMAT.md` — nuove sezioni 2.5 (`artifacts`) e 2.6 (`model`), tabella dei membri aggiornata,
  §7.1 con un esempio completo di ricevuta v2 (impronta calcolata e verificata con `openssl`, non
  scritta a mano), §10.3 e §10.4 aggiornate per il nuovo significato di `receipt_version` e per il
  controllo in più, nota di stato in testa che dichiara entrambe le versioni correnti.

Vettori: **20 in totale** (erano 14), 8 nuovi di versione 2 — nessuno v1 modificato. Coprono: v2
senza campi opzionali (canonicalizza come v1 a parte `v`), un artifact, due artifact (a riprova che
un array non viene mai riordinato dalla canonicalizzazione, solo le chiavi degli oggetti lo sono),
un modello con provider e digest, un modello con entrambi `null`, e artifact+model insieme. Il campo
di intestazione del file, `receipt_version` (singolare), diventa `receipt_versions: [1, 2]`, calcolato
dai vettori stessi invece che dichiarato a parte, così non può disallinearsi da ciò che il file contiene
davvero.

Verifiche eseguite (452 test verdi, erano 406):
- ogni vettore v1 esistente è bit per bit quello di prima (nessuna riga toccata in `vectors.json` per
  i primi 14 vettori, solo aggiunte in coda);
- una ricevuta v1 che porta `artifacts` o `model` viene **rifiutata**: v1 resta chiuso, non
  semplicemente permissivo;
- catena che verifica con ricevute v1 e v2 mescolate nello stesso export, e una interamente v2;
- manifest con `receipt_version` che sottostima o sovrastima la versione più alta davvero presente:
  entrambi rifiutati con `range` e il numero dichiarato nel messaggio;
- `scripts/crosscheck_vectors.py` re-deriva anche gli 8 vettori v2 con un'implementazione Python
  indipendente, inclusa la forma di `artifacts[]` e `model` — non solo i 12 vettori v1 di prima;
- l'impronta del vettore `v2-single-input-artifact` (552 byte, sha256
  `b50f22f0f6d1c7332d28f8cece6a5517f04baa85ffcbedb4a62817cb818ecdd6`) è stata ricalcolata **a mano**
  con `openssl dgst -sha256` prima di scriverla in `docs/FORMAT.md`, come già fatto per l'esempio v1
  in M1: verificata contro un valore esterno, non contro sé stessa;
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, `node scripts/smoke-dist.mjs` (20 vettori verificati
  sul pacchetto compilato) tutti verdi.

Dimensione di verifier+core: **1909 righe totali (1480 escludendo vuote e commenti)**, erano 1792
(1416). La crescita di 117 righe totali supera la soglia di ~100 righe della regola 5 di `CLAUDE.md`
— questa è la nota che la regola stessa richiede. Cosa ha comprato: lo schema v2 con `artifacts` e
`model` e la loro documentazione inline (~120 righe in `receipt.ts`), la separazione fra
`CHECKPOINT_VERSION` e le costanti di versione della ricevuta, e il controllo di coerenza su
`receipt_version` nel verificatore (~10 righe). Nessuna riga tolta o compressa per stare sotto la
soglia: la richiesta esplicita della fase 2 era di aggiungere questi due campi mantenendo v1
verificabile senza modifiche, e leggibilità resta il criterio, non il conteggio.

Nessun difetto trovato dai test in questa milestone: le decisioni di design più delicate (versione
del checkpoint disaccoppiata, `receipt_version` come massimo anziché come costante, `as const` sulle
nuove costanti di versione) sono state prese **prima** di scrivere lo schema, seguendo l'analisi di
come `RECEIPT_VERSION` veniva già usato in nove punti diversi del codice, non scoperte a posteriori
da un test che falliva.

#### N2 — SDK Python, fase 2 (fatto)

- `sdk-python/src/sigillo/__init__.py` — **`sigillo.artifact(data, role, label, media_type=None)`**:
  calcola SHA-256 in questo processo (`bytes` grezzi, `str` come byte UTF-8 esatti, un percorso letto
  da disco) e allega solo l'impronta allo span corrente come evento `sigillo.artifact`. Se non c'è
  uno span attivo, avvisa nei log e non fa nulla, invece di perdere l'evidenza in silenzio.
- **Digest dei modelli Ollama**: `sigillo.init(..., ollama_url=...)` legge `GET /api/tags` **una sola
  volta**, all'avvio, e aggiunge un `_ModelDigestProcessor` (un `SpanProcessor` su misura) che timbra
  `sigillo.model.digest` sullo span **a `on_start`, non a `on_end`**: uno span rifiuta nuovi attributi
  dopo la fine (`Span.set_attribute` diventa un no-op silenzioso), e una strumentazione corretta
  dichiara il nome del modello tra gli attributi iniziali dello span proprio perché hook come questo
  possano vederlo subito. Qualunque errore nel contattare Ollama (spento, rete, risposta inattesa) è
  un avviso nei log, mai un'eccezione: il digest è un arricchimento, non un requisito per registrare
  un'azione.
- **Estensione OpenAI**: `"openai"` tra i valori ammessi di `instrument`, con
  `openinference-instrumentation-openai` (aggiunta ora a `CLAUDE.md` e a `pyproject.toml`, come
  annotato in sessione all'avvio della fase 2).
- `apps/server/src/ingest/otlp.ts` — decodifica anche gli **eventi** dello span (`Span.events` nel
  proto OTLP), finora ignorati: `OtlpSpan` guadagna `events: OtlpSpanEvent[]`.
- `apps/server/src/ingest/adapter.ts` — `artifactsOf()` legge ogni evento `sigillo.artifact` e lo
  trasforma in una voce di `artifacts`; un evento malformato (ruolo sconosciuto, campo mancante,
  sha256 non esadecimale) viene **scartato, non lancia**: l'SDK garantisce la propria forma, ma un
  mittente qualunque sul filo no. `modelOf()` legge nome/provider/digest del modello, **solo per un
  `llm_call` riconosciuto** (scelta dell'adattatore, non un vincolo dello schema). Entrambe tollerano
  i due dialetti già noti (`gen_ai.*` e `llm.*`).
- `apps/server/src/storage/store.ts` — un evento con `artifacts` o `model` produce ora `v: 2`; uno
  senza resta `v: 1`, esattamente come prima. La decisione è per-ricevuta, quindi una catena passa da
  v1 a v2 in modo naturale nel momento in cui arriva davvero un documento o un modello da registrare,
  non con un interruttore globale.

Verifiche eseguite (**465 test Node**, erano 452; **22 test Python**, erano 12):
- `packages/core`/`packages/verifier` invariati: la crescita è tutta in `apps/server` e nell'SDK;
- Python, unitari: l'impronta calcolata da `sigillo.artifact()` coincide con `hashlib.sha256` calcolato
  a parte nel test; il contenuto originale **non compare** nei byte del payload OTLP catturato
  (intercettato con lo stesso server-giocattolo già usato per l'API key); un file letto da percorso
  hasha gli stessi byte di `path.read_bytes()` e indovina il media type; ruolo diverso da
  `input`/`output` rifiutato; nessuno span attivo → avviso, nessuna eccezione;
- Python, digest Ollama: un server-giocattolo che risponde su `/api/tags` produce
  `sigillo.model.digest` sullo span esportato; una porta locale dove non ascolta nessuno produce
  **nessun digest e nessuna eccezione**, con l'avviso nei log verificato; senza `ollama_url` nessuna
  chiamata di rete in più e nessun digest;
- Python, end-to-end (**nuovo**, firmatario e server veri): `sigillo.artifact()` chiamato da un
  processo Python reale produce, nell'export firmato e verificato dal verificatore reale, una
  ricevuta `v: 2` con l'`artifacts` atteso e il contenuto originale assente da `receipts.jsonl` —
  la prova end-to-end che la sezione 3 del prompt chiedeva, non solo un'asserzione unitaria;
  esegue con il modello fittizio, non richiede Ollama installato nell'ambiente cloud;
- Node, `adapter.ts`: un evento sconosciuto e un `sigillo.artifact` malformato (ruolo sbagliato,
  sha256 non valido, campo assente) non fanno fallire lo span; due artifact restano nell'ordine
  dell'evento; `label`/`media_type` troppo lunghi vengono troncati come già succede per `action.name`;
  un `gen_ai.request.model` su uno span che non è un `llm_call` riconosciuto **non** produce `model`;
- Node, `store.ts`: un evento senza `artifacts`/`model` resta `v: 1`; uno con l'uno o l'altro diventa
  `v: 2`, con i byte canonici salvati e rileggibili esattamente come per v1;
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, `node scripts/smoke-dist.mjs`,
  `python3 scripts/crosscheck_vectors.py` tutti verdi (i vettori non sono cambiati in questa
  milestone: N2 non tocca il formato).

Nessun difetto trovato dai test in questa milestone.

#### N3 — Verifica di un documento (fatto)

- `packages/core/src/export.ts` — `artifactsIndexEntrySchema`: una riga di `artifacts-index.jsonl`
  è `{ sha256, seq, role, label }`. Niente `system_id` per riga: il fascicolo ne copre uno solo,
  dichiarato nel manifest.
- `apps/server/src/storage/schema.ts` — tabella `artifacts` (append-only, stessi trigger di
  `receipts`/`checkpoints`/`timestamps`), `FOREIGN KEY (system_id, seq)` verso `receipts`, indice su
  `sha256`. `apps/server/src/storage/store.ts` scrive le righe **nella stessa transazione** della
  ricevuta che le dichiara — un documento non può comparire senza la ricevuta che lo nomina, né
  viceversa — e `findArtifactsBySha256()` risponde alla domanda "chi ha mai usato questo documento"
  con un indice, non con una scansione di ogni ricevuta.
- `apps/server/src/export/archive.ts` — `artifacts-index.jsonl` nel fascicolo: una riga per ogni
  *occorrenza* di artifact (una ricevuta con due documenti dà due righe).
- `packages/verifier/src/verify.ts` — un controllo nuovo, **simmetrico apposta**: l'insieme degli
  artifact che le ricevute v2 dichiarano deve coincidere esattamente con l'insieme delle righe
  dell'indice, in entrambe le direzioni. Una riga in più nell'indice è respinta tanto quanto un
  artifact senza riga corrispondente: solo così l'indice è affidabile per una ricerca, non soltanto
  per un conteggio. **Manomettere un artifact non ha richiesto nessun controllo apposito** (come già
  per N1): cambia l'impronta della ricevuta, quindi lo becca il controllo di catena o di firma che
  esisteva già. `Verification` ora espone anche `receipts` (le ricevute già validate), perché
  `sigillo-verify doc` ne ha bisogno senza doverle riparsare.
- `packages/verifier/src/cli.ts` — `sigillo-verify doc <fascicolo> <file>`: verifica **tutto** il
  fascicolo prima di rispondere (una ricerca su un archivio manomesso viene rifiutata, non
  semplicemente resa inaffidabile), poi hasha il file con SHA-256 e cerca la corrispondenza. Uscita
  come `grep`: 0 trovato, 1 non trovato o fascicolo non valido, 2 file o archivio illeggibile — così
  uno script può distinguere i tre casi dal solo codice di uscita.
- `apps/server/src/http/ui.ts` — pagina **"verifica un documento"**: file o testo incollato, un solo
  script inline che chiama `crypto.subtle.digest` nel browser e naviga a
  `/ui/verify-document?sha256=...` — il documento non raggiunge mai il server. È l'unica pagina con
  JavaScript, come vuole la sezione 4 del prompt; il resto della UI resta quello di M9. I testi di
  **questa** pagina sono in italiano (l'unica pagina per cui il prompt della fase 2 detta le frasi
  esatte); il resto dell'interfaccia passa all'italiano in N4, con i testi raccolti in un unico file
  come chiede la sezione 5.
- `deploy/Caddyfile` — invece di allentare la CSP `default-src 'none'` in generale, `script-src`
  ammette **solo** l'hash SHA-256 di quello script esatto (`'sha256-...'`). Un test
  (`apps/server/test/ui.test.ts`) ricalcola l'hash dallo script davvero esportato da `ui.ts` e lo
  confronta col Caddyfile: se qualcuno modifica lo script senza aggiornare l'hash, il test fallisce
  invece di scoprirlo in produzione con la console del browser che blocca lo script.
- `apps/server/src/export/report.ts` — sezione nuova nel PDF: quanti documenti sono indicizzati in
  questo periodo e, se almeno uno, il comando `sigillo-verify doc` per controllarli.
- `docs/FORMAT.md`, `docs/SECURITY.md` — `artifacts-index.jsonl` documentato (§10.3), il controllo
  nuovo nell'elenco del verificatore (§10.5, con la nota sulla simmetria), `sigillo-verify doc`
  spiegato; `SECURITY.md` estende "nessun contenuto" ai documenti (hashati lato client sia dall'SDK
  sia dal browser) e spiega la CSP con hash della pagina.

Verifiche eseguite (**485 test Node**, erano 465):
- un documento trovato mostra sistema, etichetta, azione e stato del checkpoint che lo copre;
- un documento modificato di un solo byte **non** viene trovato (impronta diversa, nessuna via di
  mezzo: o è esattamente il file usato, o "nessuna azione registrata");
- lo stesso documento usato in due ricevute diverse compare **in entrambe**, in ordine di tempo;
- un indice a cui manca un artifact dichiarato, o che ne dichiara uno in più, o che punta al `seq`
  sbagliato: tutti rifiutati con `artifacts-index` e il conteggio nel messaggio;
- `sigillo-verify doc` su un archivio con l'indice manomesso fallisce **l'intero archivio**, non
  restituisce semplicemente "non trovato" — la ricerca eredita la verifica, non la aggira;
- il server non riceve mai il contenuto del documento: la pagina lo hasha nel browser, l'SDK lo hasha
  nel processo del chiamante (già provato in N2); un test controlla che un `sha256` non valido nella
  query non venga trattato come una ricerca riuscita;
- XSS: un'etichetta o un nome di azione con markup incorporato arriva in pagina già sfuggito, come
  per le pagine di M9;
- `pnpm lint`, `pnpm typecheck`, `pnpm build`, `node scripts/smoke-dist.mjs`,
  `python3 scripts/crosscheck_vectors.py` tutti verdi (i vettori non cambiano: N3 non tocca il
  formato della ricevuta, solo l'export e il verificatore).

Dimensione di verifier+core: **2064 righe totali (1609 escludendo vuote e commenti)**, erano 1909
(1480) dopo N1. Crescita di 155 righe totali, di nuovo oltre la soglia di ~100 della regola 5. Cosa ha comprato: lo schema e il parsing di `artifacts-index.jsonl` in `core`, il controllo
di coerenza simmetrico e l'esposizione di `receipts` in `Verification`, e l'intero sottocomando
`sigillo-verify doc` (lettura dell'archivio, hashing del file, ricerca, messaggi) — tutti richiesti
esplicitamente dalla sezione 4 del prompt. Nessuna riga tolta per stare sotto la soglia.

Nessun difetto trovato dai test in questa milestone.

#### N4 — Interfaccia nuova (fatto)

- `apps/server/src/http/strings.ts` (nuovo) — ogni frase italiana della UI in un solo file: la
  costante `UI` (navigazione, login, le tre domande, pagina sistemi, cronologia, checkpoint,
  verifica documento) e due generatori di frasi, non solo stringhe fisse — `describeReceipt()`
  (una frase per ricevuta, diversa per ogni combinazione di `action.kind` × `outcome`: un tentativo
  fallito non è "completato" con un'etichetta diversa, è un verbo diverso) e `describeArtifact()`.
  Un domani una seconda lingua vuol dire un secondo file così, non una caccia in ogni pagina.
- `apps/server/src/health/chain-health.ts` (nuovo) — `ChainHealthMonitor` risponde alla prima
  domanda, "è tutto a posto?", con un semaforo verde/giallo/rosso **più una parola**, mai il solo
  colore (sezione 5 del prompt, e un requisito di accessibilità). La verifica è **incrementale**: ad
  ogni giro controlla solo le ricevute nuove dall'ultimo controllo (`store.readChainFrom`), non
  l'intera catena da capo — su un registro che cresce indefinitamente è l'unica scelta che resta
  economica. Un fallimento è **sticky**: una firma o un anello non validi mettono il sistema a
  rosso finché non lo si guarda di persona, anche se le ricevute successive tornano valide — un
  problema non deve poter "guarire da solo" scomparendo dalla vista. Giallo copre tre casi diversi
  con la stessa cautela (nessun checkpoint ancora, checkpoint non ancora marcato, ultima attività
  più vecchia della soglia `--stale-after-minutes`); rosso è riservato a una violazione crittografica
  vera. Gira ogni minuto come il `Checkpointer` di M7, stesso schema `start()`/`stop()` con
  `.unref()`.
- `apps/server/src/http/ui.ts` — riscritta: resta di sola lettura tranne la creazione di
  sistemi/chiavi (come già deciso in M9: la UI non scrive mai una ricevuta). Pagina principale
  (`/ui`) nelle tre domande esatte del prompt: **è tutto a posto?** una tabella semaforo per
  sistema con `ChainHealthMonitor`; **cosa ha fatto l'AI?** le ricevute più recenti come frasi di
  `describeReceipt()`, non come tabella tecnica; **mi prepari le prove?** un modulo con intervallo
  di date che genera lo stesso fascicolo `.zip` di M7/M8, ora anche per un periodo parziale
  (`GET/POST /ui/export`, riusa `store.readChainInRange` già esistente). La cronologia per sistema
  (`/ui/systems/:id`) affianca a ogni frase i tag degli eventuali documenti e un `<details>`
  "Dettagli tecnici" chiuso di default — `seq`, hash, firma, chiave — così chi non serve i dettagli
  non li vede, e chi li cerca li trova senza dover chiedere. Nuova pagina `/ui/sistemi`: elenco dei
  sistemi esistenti, la chiave di firma corrente, e un modulo per crearne uno nuovo; dopo la
  creazione (`systemCreatedPage`) la chiave compare **una sola volta**, con avviso esplicito che non
  sarà più recuperabile, più l'esempio Python (`sigillo.init(...)`) pronto da copiare — le
  "istruzioni di collegamento con codice copiabile" della sezione 5. La pagina "verifica un
  documento" di N3 resta invariata, incluso il suo unico script inline.
- CSS (`STYLE` in `ui.ts`) — variabili di colore su `:root`, ridefinite sotto
  `@media (prefers-color-scheme: dark)`: non è un tema scelto a mano, segue l'impostazione del
  sistema operativo del lettore. `@media (max-width: 640px)` per il telefono. Nessun framework,
  nessuna build: lo stesso CSS incorporato di M9, esteso. `deploy/Caddyfile` non cambia: la CSP resta
  quella con l'hash dello script di N3.
- `docs/screenshots/` (nuovo) — 7 schermate della UI vera, generate con Playwright (strumento
  globale del sistema, `/opt/node22/lib/node_modules/playwright`, **non** aggiunto alle dipendenze
  del progetto: non è nella lista approvata di `CLAUDE.md` e non serve a runtime, solo per questa
  verifica visiva una tantum): home con le tre domande, cronologia, cronologia con un `<details>`
  aperto, pagina sistemi, pagina verifica documento, home in tema scuro, home da telefono
  (`devices["iPhone 13"]`). Dati di prova: un sistema `acme-support-bot` con 4 ricevute varie (uno
  strumento riuscito con `on_behalf_of`, uno strumento bloccato, un passo, una decisione fallita) e
  un checkpoint marcato davvero da FreeTSA — non dati sintetici a caso, la stessa forma di prova che
  un ispettore vedrebbe.
- `apps/server/test/strings.test.ts` (nuovo, 30 test) — copertura esaustiva di `describeReceipt()`
  per ogni combinazione di tipo azione × esito, più genesi, `on_behalf_of`, le varianti di
  provenienza del modello, le etichette degli artifact.
- `apps/server/test/chain-health.test.ts` (nuovo, 9 test) — giallo (nessun checkpoint, checkpoint
  non marcato, inattività), verde, rosso (ottenuto manomettendo una riga con una seconda connessione
  diretta al database, aggirando i trigger append-only con `DROP TRIGGER` solo per il test), verifica
  incrementale, isolamento tra sistemi diversi.
- `apps/server/test/ui.test.ts` — riscritto: tutte le asserzioni sul testo passano all'italiano;
  nuovi blocchi per le tre domande della home, la pagina sistemi (elenco, creazione, nome duplicato),
  la cronologia con artifact e dettagli tecnici, l'accessibilità da tastiera (ogni `<label>` associato
  al suo campo, nessun `onclick=` o `<div role="button">` al posto di un vero `<button>`/`<a>`), e
  l'invariante CSP-hash ereditata da N3.

Decisioni prese senza fermarsi (nessuna richiede una lista fuori da quella approvata):
- Semaforo incrementale e sticky invece che una scansione completa ad ogni richiesta: su un registro
  che può crescere per anni, ricontrollare tutto ad ogni caricamento pagina non avrebbe retto; sticky
  perché un cruscotto di conformità che si "auto-assolve" al giro successivo sarebbe peggio di uno
  che non controlla affatto.
- L'export a intervallo di date riusa `readChainInRange`, già scritto per M7/M8 e già provato: N4 gli
  dà solo un modulo HTML davanti, non una seconda implementazione.
- Playwright resta uno strumento ad hoc per generare gli screenshot, non una dipendenza del
  repository: rispetta la regola 6 (nessuna dipendenza fuori lista senza chiedere) perché non è mai
  importato da codice che gira in produzione o nei test automatici.

Verifiche eseguite (**537 test Node**, erano 485 dopo N3): `pnpm lint`, `pnpm typecheck`, `pnpm
build`, `node scripts/smoke-dist.mjs`, `python3 scripts/crosscheck_vectors.py` tutti verdi; 7
screenshot generati e controllati a occhio (tre domande visibili in home, semaforo verde con la
parola oltre al colore, dettagli tecnici correttamente nascosti/espandibili, tema scuro e vista da
telefono entrambi leggibili).

Dimensione di verifier+core: **invariata, 2064 righe totali (1609 escludendo vuote e commenti)** —
N4 non tocca `packages/core` né `packages/verifier`, solo `apps/server` e la documentazione; la
regola 5 non si applica.

Nessun difetto trovato dai test in questa milestone.

#### N5 — Demo selezione CV (fatto)

- `demo/selezione-cv/curricula/` — 20 curriculum inventati, in italiano, per "sviluppatore backend
  junior". **Regole di punteggio neutre e dichiarate** (`agent.py`, `evaluate_cv_text`): leggono solo
  competenze tecniche pertinenti (elenco dichiarato `BACKEND_SKILLS`, corrispondenza a parola intera —
  altrimenti "javascript" farebbe contare anche "java") e anni di esperienza **specificamente come
  sviluppatore** (`EXPERIENCE_PATTERN` richiede "N anni di esperienza come sviluppat...": un candidato
  con anni di esperienza in un altro ruolo non li vede contare). Età, genere, provenienza, foto: non
  esiste un campo da cui leggerli, non solo una scelta di non usarli. Convenzione con cui i 20
  curriculum sono scritti apposta per essere testabili: esperienza pertinente in cifre ("2 anni di
  esperienza come sviluppatore"), esperienza in altri ruoli scritta in lettere ("Tre anni come
  contabile") — così un test può controllare che la seconda non venga mai letta come la prima. Il
  candidato n. 7 (Andrea Bianchi, su cui è costruito `ISPEZIONE.md`) ha deliberatamente **zero**
  competenze pertinenti, zero esperienza pertinente, nessuna formazione informatica: un rifiuto
  costruito per essere palesemente legittimo, non un caso limite.
- `agent.py` — tre strumenti (`leggi_curriculum`, `valuta_candidato`, `invia_email`, nomi esatti
  richiesti dal prompt, perché diventano `action.name` nelle ricevute) in un grafo LangGraph **a tre
  passi fissi**, non un ciclo dove un modello decide l'ordine: leggi, valuta, rispondi, sempre in
  quest'ordine. Scelta deliberata — un ordine deciso da un modello sarebbe meno auditabile e meno
  deterministico per un test, senza portare nulla in cambio qui. `valuta_candidato` calcola il
  punteggio da sé (la regola dichiarata sopra) e chiede al modello solo di trasformare i fatti già
  calcolati in una frase, mai di valutare da capo — così la parte che decide resta leggibile come
  codice, non nascosta nel comportamento di un modello.
- **Il modello**: `OLLAMA_URL` raggiungibile e modello già scaricato → `langchain_ollama.ChatOllama`,
  con il digest allegato alla ricevuta `llm_call` (già supportato da N2). Altrimenti
  `FakeRationaleModel`, un `SimpleChatModel` deterministico con la stessa interfaccia: stessi fatti in
  ingresso, stessa frase in uscita, nessuna rete — è quello che gira in questa sandbox e in CI.
  **Tentativo di installare Ollama in questa sessione**: `ollama.com` è raggiungibile (lo script di
  installazione si scarica correttamente), ma l'esecuzione dello script scaricato è stata bloccata dal
  classificatore di sicurezza della sandbox ("Code from External") — non un blocco di rete, un confine
  deliberato di questa sessione cloud, distinto e riportato con precisione invece di confonderlo con
  l'altro. Anche `pip install langchain-ollama` è stato bloccato allo stesso modo ("Untrusted Code
  Integration"). Nessun tentativo di aggirare il blocco: il percorso col modello reale resta scritto,
  testato nella sua parte deterministica, e documentato in `README.md` con i comandi esatti da eseguire
  su una macchina vera:
  ```
  curl -fsSL https://ollama.com/install.sh | sh
  ollama pull qwen2.5:3b
  export OLLAMA_URL=http://127.0.0.1:11434
  ./demo/selezione-cv/run_demo.sh
  ```
- **Un difetto vero trovato in `sigillo.artifact()` (N2), non solo nella demo.** Costruendo
  `leggi_curriculum`/`invia_email` è emerso che `sigillo.artifact()` non allegava mai nulla quando
  chiamato da dentro un vero strumento LangChain instrumentato da `openinference-instrumentation-
  langchain`: la funzione cerca "lo span corrente" con `trace.get_current_span()`, ma il tracer di
  OpenInference per LangChain crea i suoi span con `tracer.start_span(...)` e **apposta** non li
  attacca mai al contesto di OpenTelemetry (il suo stesso codice sorgente lo spiega: in un sistema a
  callback non si può garantire che un contesto agganciato venga sempre sganciato, quindi non lo
  aggancia mai). Risultato: nessuno dei test di N2 se ne era accorto, perché usavano tutti
  `tracer.start_as_current_span(...)` a mano, mai una vera chiamata LangChain. Corretto in
  `sdk-python/src/sigillo/__init__.py`: `artifact()` accetta ora un parametro opzionale `span`, e una
  nuova funzione `current_span_from_callbacks()` lo trova a partire dal `callbacks` che LangChain
  inietta in una funzione-strumento che dichiara un parametro con questo nome esatto — senza importare
  mai `langchain_core`, solo leggendo `.parent_run_id`/`.handlers`/`.get_span()` con `getattr`. Nuovo
  test in `sdk-python/tests/test_init.py`,
  `test_artifact_works_inside_a_real_langchain_tool_call`, che costruisce un vero `@tool` LangChain,
  lo invoca come farebbe LangGraph, e controlla che l'evento `sigillo.artifact` compaia sullo span
  giusto — questo è il test che avrebbe dovuto accorgersene in N2 e non l'ha fatto.
- `run_demo.sh` — segnalatore/server effimeri (stesso schema di M7/M9), l'agente sui 20 curriculum,
  un checkpoint marcato da FreeTSA (eseguito davvero in questa sessione: "1 anchored, 0 still
  waiting"), riepilogo finale. Controlli di avvio che falliscono in modo esplicito (porta già in uso,
  dipendenze Python mancanti con il comando `pip install` esatto da eseguire) invece di proseguire in
  silenzio.
- `run_demo.ps1` — stesso risultato su Windows, ma via Docker Desktop: riusa esattamente i container di
  `deploy/docker-compose.local.yml` (quelli di `PROVA-LOCALE.md`), in un progetto Compose separato
  (`sigillo-selezione-cv`) così da non toccare un'installazione di prova che l'utente avesse già in
  piedi. Aggiunto un nuovo servizio `selezione-cv` al compose file, sullo schema già esistente del
  servizio `esempio`; la porta pubblicata del server è ora parametrizzabile
  (`SIGILLO_LOCAL_PORT`, default 8080 invariato) proprio per permettere ai due stack di convivere.
  **Non eseguibile in questa sessione cloud** (Docker non è disponibile, come già annotato per la
  checklist Docker di M9): scritto e controllato riga per riga contro i comandi di `PROVA-LOCALE.md`
  già provati su macchina reale, non contro un'esecuzione vera.
- `ISPEZIONE.md` — il percorso completo sul candidato n. 7, in italiano, per chi non ha mai visto
  sigillo: dalla domanda del candidato alla verifica del documento, alla prova che manomettere anche un
  solo carattere del curriculum lo rende irriconoscibile. **Ogni comando di questo file è stato
  eseguito davvero in questa sessione** (non solo scritto): il documento giusto viene trovato, quello
  manomesso no, il fascicolo si verifica, `sigillo-verify doc` su un file modificato di un carattere
  restituisce "nessuna azione registrata" con uscita 1. Nota anche il limite onesto del percorso: il
  registro prova che l'azione è avvenuta su quel documento con quell'esito, non che la regola di
  punteggio è equa — quella si legge nel codice, non in una singola ricevuta.
- `VIDEO.md` — copione di circa 3 minuti per DPO e responsabili compliance, zero parole tecniche nel
  parlato, scena per scena, con note di produzione su cosa registrare.
- `demo/selezione-cv/tests/test_scoring.py` (nuovo, 14 test) — la regola di punteggio in isolamento:
  un profilo forte, un profilo a zero, la soglia come vero taglio netto (7 punti appena sotto, 8 appena
  sopra, sugli stessi identici dati salvo un anno di esperienza), "java" mai contato dentro
  "javascript", anni scritti in lettere in un altro ruolo mai contati, tutti i 20 curriculum spediti
  verificati contro l'esito atteso uno per uno, il candidato n. 7 verificato a zero su tutti e tre gli
  assi.
- `demo/selezione-cv/tests/test_demo_e2e.py` (nuovo, 3 test) — segnalatore e server reali, l'agente
  vero sui 20 curriculum, poi lo stesso export e lo stesso verificatore open source di ogni altra
  milestone: conta le ricevute per strumento (20 per ciascuno dei tre), conferma che ogni ricevuta reale
  porta `on_behalf_of: "elena.rizzo"`, conferma 40 righe nell'indice documenti (20 input + 20 output),
  verifica che il contenuto del curriculum del candidato n. 7 non compaia mai nell'export, prova
  `sigillo-verify doc` sul curriculum vero e su una sua versione manomessa.
- `sdk-python/src/sigillo/__init__.py`, `sdk-python/tests/test_init.py` — vedi il difetto corretto
  sopra; 4 test nuovi (l'override esplicito di `span`, due su `current_span_from_callbacks()` in
  isolamento, l'integrazione reale con LangChain), il test sulla superficie pubblica aggiornato per la
  terza funzione.

Decisioni prese senza fermarsi:
- Grafo a tre passi fissi invece di un agente che decide l'ordine degli strumenti: più leggibile, più
  deterministico da testare, e la sezione 6 del prompt non chiede altro.
- `langgraph`, `langchain-core`, `langchain-ollama` restano fuori dalla lista approvata di
  `CLAUDE.md`: stesso trattamento già riservato a `langgraph`/`langchain-core` in M6, dichiarati solo
  nel `requirements.txt` della demo, non dipendenze del pacchetto `sigillo`. La nota della sessione 2
  ("le aggiungo alla lista quando le uso, in N5") era una previsione scritta prima di arrivarci; il
  trattamento corretto, coerente con quanto già deciso in M6, è questo.
- Difetto di `sigillo.artifact()` corretto alla radice (nell'SDK) invece che aggirato solo nella demo:
  il problema riguarda chiunque usi LangChain con questo SDK, non solo questa demo.

Verifiche eseguite: **537 test Node** (invariati, N5 non tocca codice TypeScript), **26 test Python in
`sdk-python/tests`** (erano 22 dopo N2, +4 per il difetto corretto), **17 test Python nuovi in
`demo/selezione-cv/tests`**; `pnpm check` verde; `run_demo.sh` eseguito per intero in questa sessione,
incluso un checkpoint marcato da FreeTSA; ogni passo di `ISPEZIONE.md` eseguito davvero, non solo
scritto; `run_demo.ps1` scritto e controllato ma non eseguibile qui (nessun Docker in questa sandbox,
stesso limite già annotato per M9).

Dimensione di verifier+core: **invariata, 2064 righe totali (1609 escludendo vuote e commenti)** — N5
non tocca `packages/core` né `packages/verifier`; il difetto corretto vive in `sdk-python/`, fuori
dall'ambito della regola 5.

Difetto trovato e corretto in questa milestone: `sigillo.artifact()` non funzionava con LangChain reale
(sopra). Nessun altro difetto trovato dai test.

**Addendum, durante N6**: l'accettazione di N5 chiede esplicitamente "e2e in CI", ma
`.github/workflows/ci.yml` non è stato aggiornato insieme al resto — i 17 test di
`demo/selezione-cv/tests` giravano solo se lanciati a mano. Corretto aggiungendo un passo al job
Python esistente: nessuna installazione in più, perché `sdk-python/examples/requirements.txt` (già
installato in quel job) copre già `langgraph`/`langchain-core`/`openinference-instrumentation-
langchain`, le uniche dipendenze della demo che il test in CI usa davvero — `langchain-ollama` resta
fuori perché lì `OLLAMA_URL` non è mai impostata, quindi quel ramo di codice non viene mai importato.
Controllato che `python -m unittest discover -s demo/selezione-cv/tests -t demo/selezione-cv` passi
davvero senza `langchain-ollama` installato (è la condizione dell'ambiente CI, e anche quella di
questa sandbox).

#### N6 — Documentazione non tecnica (fatto)

`ISPEZIONE.md` e `VIDEO.md` erano già stati scritti in N5, dove appartengono (sono documenti della
demo, non della fase 2 in generale). Il lavoro rimasto per N6 era `PROVA-LOCALE.md`: non solo
estenderlo, ma prima **correggerlo**, perché descriveva un'interfaccia che non esiste più.

- **Due correzioni fattuali**, non aggiunte: il Passo 8 diceva "la pagina è in inglese" con
  "Administrator password" / "Sign in" — falso da N4 in poi, l'interfaccia è in italiano
  ("Password amministratore" / "Accedi"). Il Passo 12 nominava un bottone "Generate the evidence
  file" che non esiste più (ora "Genera fascicolo", con scelta di un intervallo di date). Il Passo 11
  descriveva un elenco tecnico di ricevute invece delle tre domande e delle frasi leggibili che la
  pagina principale mostra davvero da N4. Ho verificato ogni stringa citata contro
  `apps/server/src/http/strings.ts` e `ui.ts`, non a memoria.
- **Nuovo Passo 15 — "Le novità della fase 2"**, inserito prima di "Spegnere" (rinumerato da 15 a
  16; nessun altro passo lo referenzia per numero, quindi rinumerare non ha rotto rimandi
  nell'appendice). Due parti:
  - creare un sistema dalla pagina "sistemi" invece che da terminale — mostrata, non usata per
    forza, perché `acme-support-bot` esiste già a quel punto della guida;
  - verificare un documento: qui serviva dell'attenzione in più, perché l'agente di esempio del
    Passo 10 non allega mai documenti — la pagina risponderebbe sempre "nessuna azione registrata",
    correttamente ma senza dimostrare nulla. Ho scelto di far girare la demo `selezione-cv` **sullo
    stesso** sigillo già acceso (un secondo registro, stessi comandi `system create`/`key create`
    già visti al Passo 9, chiave passata con `-e` al comando `run` senza toccare il `.env` di
    `acme-support-bot`) invece di rimandare a `run_demo.sh`/`run_demo.ps1`: quegli script richiedono
    Node e Python **sul computer dell'utente**, mentre chi ha seguito `PROVA-LOCALE.md` fin qui ha
    solo Docker Desktop, per progetto (è il punto del servizio `esempio` già esistente, che installa
    le sue dipendenze dentro un container usa-e-getta). Riutilizzare il compose e il bind mount
    `..:/work` già presenti significa che `demo/selezione-cv/outbox/` finisce comunque sul disco
    reale dell'utente, esattamente dove `ISPEZIONE.md` (scritto in N5) si aspetta di trovarlo — le
    due guide restano compatibili senza doversi coordinare esplicitamente.

Decisioni prese senza fermarsi:
- Non ho spostato il Passo 9 (creazione sistema da CLI) a favore della pagina "sistemi": sarebbe
  stata una riscrittura strutturale di un documento già lungo e già controllato riga per riga in
  M9, con un beneficio marginale — mostrare la pagina "sistemi" più avanti, come alternativa, ottiene
  lo stesso risultato didattico con meno rischio.
- Nessun test automatico per questa milestone: è documentazione, non codice. La verifica è stata
  incrociare ogni frase, ogni etichetta di bottone e ogni percorso di file citati con il codice
  sorgente attuale (`strings.ts`, `ui.ts`, `docker-compose.local.yml`), non un'esecuzione reale della
  guida — Docker non è disponibile in questa sessione cloud, stesso limite già annotato per M9 e per
  `run_demo.ps1` in N5. Resta, come per la checklist Docker di M9, da confermare su una macchina vera.

Verifiche eseguite: nessun test nuovo (documentazione); `pnpm check` rieseguito per confermare che
nessun'altra modifica di questa sessione fosse rimasta non salvata (537 test Node verdi, invariati).

Con N6 tutte le milestone della fase 2 (N1–N6) sono `fatto`.

### Sessione 3 — 2026-09-22 — due difetti trovati dal committente su una macchina vera

La PR di fase 2 era già mergiata quando il committente ha effettivamente seguito
`PROVA-LOCALE.md` su Windows con Docker Desktop — la prima esecuzione reale, non simulata, di
questa guida. Due cose emerse, la seconda più seria della prima.

**Un difetto vero: le chiavi di `esempio` e `selezione-cv` condividevano lo stesso nome in
`.env`.** Seguendo il Passo 15 (aggiunto in N6), il committente ha creato il sistema
`selezione-cv` e la sua chiave, ma le ricevute dell'agente sono finite tutte dentro
`acme-support-bot` invece che in `selezione-cv`. Causa: in sigillo è **la chiave**, non il nome
che l'agente dichiara, a decidere il registro di destinazione (`apps/server/src/http/server.ts`,
`authenticate(request)` → `keys.verify(token)` — comportamento corretto e voluto, documentato nel
commento in cima al file). Il Passo 15 però faceva scrivere la nuova chiave con `-e
SIGILLO_API_KEY=...` sulla riga di comando invece che in `.env`, e quel nome di variabile era già
occupato dalla chiave di `acme-support-bot` fin dal Passo 9: se l'override sulla riga di comando
non va a segno per qualunque motivo (un `IL_TUO_CODICE_QUI` lasciato non sostituito, un problema di
quoting in PowerShell), il container eredita **silenziosamente** la chiave sbagliata — nessun
errore, solo ricevute scritte, validamente firmate, nel registro sbagliato. Non recuperabile a
catena già scritta (un registro append-only non si corregge, per la stessa ragione per cui non si
manomette).

Corretto: `deploy/docker-compose.local.yml` ora usa `SIGILLO_SELEZIONE_CV_KEY`, un nome distinto,
per la chiave del servizio `selezione-cv` (`SIGILLO_API_KEY: ${SIGILLO_SELEZIONE_CV_KEY:-}`) — non
`:?` perché Compose interpola l'intero file ad ogni comando, anche `up`, ben prima che questa
chiave esista al Passo 7; il fallimento resta quindi quello già previsto e già gestito dal codice
dell'agente stesso (`sigillo.init` si rifiuta con "set SIGILLO_ENDPOINT and SIGILLO_API_KEY
first") invece di un successo silenzioso sotto l'identità sbagliata. `PROVA-LOCALE.md` aggiornato
per scrivere questa chiave in `.env` con `Add-Content`/`echo`, come già fa il Passo 9, invece
dell'override sulla riga di comando; aggiunta una voce nella sezione "Se qualcosa va storto" per
questo identico sintomo, perché è un errore plausibile per chiunque, non solo conseguenza di
un'istruzione mia.

**Una richiesta legittima: forzare il sigillo dalla pagina web.** Il committente ha chiesto se il
semaforo giallo debba sempre passare dal terminale per diventare verde. Risposta corretta: no, il
server sigilla ogni registro da solo ogni 60 minuti (`Checkpointer`, già da M7) — nessuno deve mai
aprire un terminale in uso normale. Mancava però un modo per farlo **subito**, senza aspettare, che
non fosse il comando da terminale. Aggiunto: `POST /ui/checkpoint`, un bottone "Sigilla adesso"
nella pagina principale sotto "È tutto a posto?", collegato alla **stessa istanza** di
`Checkpointer` che il timer del server già usa (la sua costruzione in `apps/server/src/cli.ts` è
stata solo spostata prima di `buildServer()`, non duplicata) — così il bottone fa esattamente,
bit per bit, quello che il timer avrebbe fatto da solo, prima. 4 test nuovi in
`apps/server/test/ui.test.ts` (il bottone compare, richiede una sessione, crea davvero un
checkpoint e reindirizza con conferma, la conferma non compare quando non richiesta).

Verifiche eseguite: **541 test Node** (erano 537), `pnpm check` verde. Dimensione di
verifier+core invariata — nessuna di queste modifiche tocca `packages/core` o
`packages/verifier`.

Nota di processo: la PR #2 era già mergiata, quindi questo lavoro è ripartito da un ramo nuovo
sullo stesso nome, da `main` aggiornato (come da istruzioni), non impilato sulla cronologia già
mergiata.

## Checklist di verifica finale M9 (con Docker, da eseguire su una macchina vera)

> **Superata dalla fase 5 (2026-09-24).** Con il `docker-compose.yml` di produzione la password
> non va più in `.env` ma nel file `deploy/secrets/admin_password`, e `SIGILLO_TLS_EMAIL` è
> obbligatoria: seguendo alla lettera i comandi qui sotto `docker compose up` si ferma. La
> procedura aggiornata è `docs/DEPLOY-PRODUZIONE.md` (fase 10). Questa sezione resta come
> documento storico di M9.

> Esiste anche una versione **per chi non usa il terminale**: `PROVA-LOCALE.md`, in italiano,
> separata per Windows e Mac, che usa `deploy/docker-compose.local.yml` (senza dominio, senza
> Caddy, con l'agente di esempio in un container). Le due procedure verificano la stessa cosa;
> questa qui sotto è quella breve, per chi il terminale lo usa già.

Questi sono i comandi esatti. Docker non è disponibile nella sessione cloud, quindi il percorso
sopra è stato verificato senza Docker; questo qui sotto è quello che resta da confermare su una
macchina pulita. Servono solo `git`, Docker con Compose v2, e `curl`. Tempo atteso: 10–15 minuti,
quasi tutti di build delle immagini.

```bash
# 1. clone e configurazione
git clone https://github.com/giovanniemilionoventa-byte/sigillo.git
cd sigillo/deploy
cp .env.example .env
# Apri .env e metti: SIGILLO_DOMAIN (un dominio che punta a questa macchina),
# SIGILLO_TLS_EMAIL, e SIGILLO_ADMIN_PASSWORD (almeno 12 caratteri).
# Se provi in locale senza dominio, salta il servizio caddy: vedi il punto 9.

# 2. la chiave, creata una volta sola, nel volume del solo firmatario
docker compose run --rm signer keygen --key /var/lib/sigillo-key/signer.key
# atteso: "wrote /var/lib/sigillo-key/signer.key  key_id <16 hex>  mode 0600"

# 3. avvio
docker compose up -d --build
docker compose ps
# atteso: signer e server "healthy", caddy "running"

# 4. il firmatario non ha rete e nessun altro vede la chiave
docker compose exec signer sh -c 'ls -l /var/lib/sigillo-key/signer.key'   # -rw------- 
docker compose exec server sh -c 'ls /var/lib/sigillo-key 2>&1'           # atteso: No such file or directory
docker compose exec -T signer sh -c 'command -v curl wget || echo "nessun client HTTP"'

# 5. un sistema e una chiave API
docker compose exec server node dist/cli.js system create acme-support-bot
docker compose exec server node dist/cli.js key create acme-support-bot
# Copia il token stampato (sigillo_...): viene mostrato una volta sola.

# 6. l'agente di esempio, dall'esterno, attraverso l'SDK Python
cd ..
python3 -m venv .venv && . .venv/bin/activate
pip install -e sdk-python -r sdk-python/examples/requirements.txt
SIGILLO_ENDPOINT=https://<il tuo dominio> \
SIGILLO_API_KEY=<il token del punto 5> \
SIGILLO_SYSTEM_ID=acme-support-bot \
  python sdk-python/examples/langgraph_agent.py
# atteso: "instrumentations: langchain", poi "agent said: ..." e "receipts sent"

# 7. la vista web
#    Apri https://<il tuo dominio>/ui nel browser.
#    - chiede la password (quella di .env)
#    - il sistema acme-support-bot compare con le sue ricevute
#    - il bottone "Generate the evidence file" scarica uno zip
#    Controlla anche che senza login /ui/systems/acme-support-bot rimandi al login.

# 8. checkpoint, ancoraggio, export e verifica
docker compose exec server node dist/cli.js checkpoint
docker compose exec server node dist/cli.js export acme-support-bot --out /tmp/fascicolo.zip
docker compose cp server:/tmp/fascicolo.zip ./fascicolo.zip

# La verifica si fa FUORI dai container, con il verificatore indipendente:
corepack enable && pnpm install && pnpm build
node packages/verifier/dist/cli.js ./fascicolo.zip
# atteso: "OK  acme-support-bot: N receipts, seq 0..N-1, signed by <key_id>"
#         "1 checkpoint(s), 1 root(s) rebuilt, 2 inclusion proof(s) verified"
#         il token risulta "imprint-only" finché non gli dai il certificato della CA:
node packages/verifier/dist/cli.js ./fascicolo.zip --tsa-ca /percorso/della/ca.pem
# atteso con --tsa-ca: "verified"

# 9. il backup
docker compose exec -T server /app/backup.sh
docker compose exec server sh -c 'ls -l /var/lib/sigillo-backups'
# atteso: un file sigillo-<timestamp>.db

# 10. la prova che conta: manomissione rilevata
#     Apri fascicolo.zip, cambia un carattere in receipts.jsonl, richiudilo e riverifica.
#     atteso: uscita 1 e un messaggio che nomina file, riga e controllo fallito.

# 11. chiusura
docker compose down        # aggiungi -v SOLO se vuoi distruggere anche chiave e database
```

**Se provi in locale senza dominio** (punto 1): commenta l'intero servizio `caddy` in
`docker-compose.yml` e aggiungi al servizio `server` una porta pubblicata:

```yaml
    ports:
      - "127.0.0.1:8080:8080"
```

Poi usa `http://127.0.0.1:8080` al posto del dominio ai punti 6 e 7. È un ambiente di prova: senza
Caddy non c'è TLS, quindi non ci si mandano dati veri.

**Cosa mi aspetto che possa andare storto**, con il rimedio:
- La build di `better-sqlite3` richiede i toolchain di compilazione. Il `Dockerfile` li installa
  nello stage di build e non nell'immagine finale; se la build fallisce lì, l'errore è di rete
  (registry npm irraggiungibile), non di codice.
- Caddy non ottiene il certificato se il dominio non punta davvero alla macchina o se 80/443 sono
  occupate. `docker compose logs caddy` lo dice a chiare lettere.
- La TSA: `TSA_URL` punta di default a FreeTSA, che **non è qualificata eIDAS**. Se FreeTSA è giù,
  il checkpoint viene comunque salvato e firmato e il token viene preso al giro successivo — è un
  comportamento voluto, non un errore.
