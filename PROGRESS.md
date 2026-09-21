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

### Serve una decisione: la TSA qualificata eIDAS

La SPEC dice di fermarsi e chiedere quando si arriva al fornitore di produzione. Il codice è pronto:
`TSA_URL`, più `TSA_USERNAME`/`TSA_PASSWORD` per i fornitori che autenticano la richiesta.
**FreeTSA non è qualificata eIDAS**, quindi va bene solo per sviluppo e test. Per la produzione
servono: URL del fornitore qualificato, eventuali credenziali, e il certificato della sua CA per
la verifica offline (da includere nel fascicolo).

## Checklist di verifica finale M9 (da eseguire fuori dalla sessione cloud)

Da completare quando si arriverà a M9 — placeholder, verrà sostituito con i comandi esatti.
