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
| N1 | Formato v2 | todo | Campi `artifacts` e `model`; `v: 2`; le ricevute v1 restano verificabili senza modifiche |
| N2 | SDK Python, fase 2 | todo | `sigillo.artifact()` con hash lato client; digest dei modelli Ollama; `instrument=["openai"]` |
| N3 | Verifica di un documento | todo | Hash calcolato nel browser; `sigillo-verify doc`; `artifacts-index.jsonl` nel fascicolo |
| N4 | Interfaccia nuova | todo | Le tre domande del responsabile compliance; semaforo; cronologia in linguaggio naturale |
| N5 | Demo selezione CV | todo | 20 curriculum, Ollama o modello fittizio, ispezione simulata, e2e in CI |
| N6 | Documentazione non tecnica | todo | `ISPEZIONE.md`, `VIDEO.md`, `PROVA-LOCALE.md` esteso alla fase 2 |

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

## Checklist di verifica finale M9 (con Docker, da eseguire su una macchina vera)

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
