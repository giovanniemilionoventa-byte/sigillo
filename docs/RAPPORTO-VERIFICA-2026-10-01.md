# Rapporto di verifica prima del deploy — 1° ottobre 2026

Sessione di **sola verifica** del codice su `main` (commit `f05818b`), prima di
portarlo sul VPS. Nessun deploy, nessun accesso al VPS, nessuna modifica a `main`.

## Verdetto: PRONTO CON RISERVE

Il codice è sano e l'aggiornamento funziona: tutti i test passano, le prove di
manomissione vengono scoperte, la migrazione di un database "come quello di
produzione" riesce in circa un secondo, i fascicoli vecchi restano verificabili e
quelli nuovi contengono quelli vecchi senza cambiamenti. Il signer resiste ai
crash e rifiuta ogni richiesta irregolare.

Le riserve riguardano **cosa promettere sulla privacy** (problemi 1 e 2) e
**come comportarsi se un giorno si ripristina un backup o si torna indietro**
(problemi 3–6). Nessuna di queste peggiora la situazione di oggi: il deploy la
migliora. Ma vanno conosciute prima, e il problema 1 va deciso con chi tratta i
dati personali.

Le tre PR sono state unite tutte in `main`: #18 (orari nel verificatore), #20
(signer con memoria), #19 (pseudonimi, impronte con sale, ricevute v4).

---

## Problemi trovati

| # | Gravità | Problema, in una frase |
|---|---|---|
| 1 | **Alta** | Le ricevute scritte **prima** dell'aggiornamento contengono il nome della persona in chiaro (e impronte senza sale), per sempre: "cancella interessato" non le tocca, ma il comando risponde «its receipts no longer lead to anyone» e `SECURITY.md` non lo dice. |
| 2 | Media | L'SDK Python, nella sua impostazione predefinita, manda impronte **senza sale**: nella prova "score: 7" si ritrova con un solo tentativo (limite già scritto in `SECURITY.md`, decisione ancora aperta). |
| 3 | Media | Dopo un ritorno alla versione vecchia, la memoria del signer resta nel suo volume: al successivo aggiornamento `init-from-db` si rifiuta e i sistemi diventano rossi; la guida non lo dice (ora è in `DEPLOY.md`, passo R4). |
| 4 | Media | Se si ripristina un backup del database più vecchio del signer, quei sistemi restano rossi e bloccati; l'unica via d'uscita riusa posizioni già firmate (una biforcazione), e non c'è una procedura scritta. |
| 5 | Media | Semaforo della pagina web e `/healthz` non si parlano: con il signer spento la pagina resta verde (ma `/healthz` dà 503); con un sistema rosso `/healthz` dice "ok", quindi il controllo automatico di Docker non se ne accorge. |
| 6 | Media | La versione vecchia non parte su un database che contiene anche una sola ricevuta v4: tornare indietro vuol dire rimettere il backup e perdere le ricevute nel frattempo. |
| 7 | Media | `sigillo-verify --strict` dà OK anche senza `--tsa-ca`, cioè senza aver controllato la firma dell'autorità delle marche temporali. |
| 8 | Bassa | Anche i comandi che dovrebbero solo leggere (es. `system list`) aggiornano lo schema del file che aprono, compreso un backup che si sta "solo controllando". |
| 9 | Bassa | `docs/API.md` dice ancora che le ricevute da OpenTelemetry sono v2/v3, ma il server ora scrive solo v4. |
| 10 | Bassa | Gli scenari di manomissione sono numerati 1–16 e poi 18 (manca il 17; ci sono anche 7b e 18b); `SECURITY.md` parla di "18 scenarios". Nessun duplicato. |
| 11 | Bassa | `sigillo-verify --quiet` stampa tutti i dettagli quando la verifica riesce, mentre l'aiuto dice «print only the verdict». |
| 12 | Bassa | Il verificatore va in crash con un messaggio tecnico invece di un errore chiaro se la sua uscita viene troncata (es. `| head`) o se non può scrivere nella cartella temporanea. |
| 13 | Bassa | Un export che chiede di nominare una persona già cancellata, o di rivelare nonce già cancellati, non scrive nulla e non avvisa. |
| 14 | Bassa | Uno span OpenTelemetry "GenAI" che porta il contenuto in `input.value` (attributo dell'altro dialetto) produce una ricevuta senza impronta, in silenzio (comportamento documentato in `API.md`). |
| 15 | Bassa | Il cross-check Python non copriva la frontiera di Merkle né casi di ricevute v4 da rifiutare: aggiunti nella branch `chore/crosscheck-v4` (non unita). |

**Su cosa significa il problema 1 in pratica.** Nella prova, un database creato
con la versione vecchia conteneva 505 ricevute con "mario.rossi.TEST" scritto in
chiaro. Dopo l'aggiornamento e dopo "cancella interessato", sono ancora 505: le
ricevute non si possono modificare (è il punto di sigillo). Sul VPS va prima
contato (comando al punto 0 di `DEPLOY.md`). Se il numero è zero, il problema non
esiste per voi. Se non è zero, servono una decisione e una frase onesta
nell'informativa e in `SECURITY.md`; le ricevute nuove non hanno il problema.

---

## Cosa ho verificato e come

**Ambiente.** Copia nuova del repository in una cartella temporanea,
dipendenze installate da zero (`pnpm install --frozen-lockfile`; il progetto usa
pnpm, non npm), ambiente Python nuovo. Docker avviato nell'ambiente cloud.

### Fase 1 — Integrità del codice

1. **Marcatori di conflitto**: nessuno in nessun file.
2. **Numerazione**: ricevute v4 ovunque (core, server, verificatore, cross-check
   Python, documenti), con v1–v3 ancora accettate; protocollo del signer 2 sia nel
   signer sia nel client del server, e nei documenti. Le "migrazioni" del database
   non sono numerate: ogni avvio applica tutte le modifiche in modo idempotente,
   quindi non possono esserci duplicati o buchi. Scenari di manomissione: nessun
   duplicato (vedi problema 10).
3. **Test**, tutti verdi:
   - Node (lint, controllo dei tipi, unitari, property-based, tutti gli scenari di
     manomissione vecchi e nuovi, test del signer): **1079 superati, 1 saltato**.
     Il saltato è la validazione del `Caddyfile`, che richiede il programma Caddy:
     l'ho rifatta a mano con l'immagine ufficiale di Caddy → «Valid configuration».
   - Prova del pacchetto compilato (`smoke-dist`): OK.
   - SDK Python: **50 test** superati; demo selezione CV: **22 test** superati.
   - Cross-check Python: OK (26 ricevute, 4 impronte con sale, 46 testi).
   - Controllo vulnerabilità delle dipendenze (Node e Python): nessuna nota.

### Fase 2 — Prova completa in Docker

Con il `docker-compose.yml` **di produzione** (signer senza rete, server, Caddy
con HTTPS su `localhost`) e una TSA locale vera (RFC 3161, con OpenSSL) in un
container sulla rete interna.

4. Un sistema nuovo; **30 ricevute via SDK Python** (20 con le impostazioni
   predefinite, 10 mandando il contenuto), **10 via API nativa**, **10 via
   OpenTelemetry diretto**; tutte con "mario.rossi.TEST" come persona e
   "score: 7" come contenuto, e con artifacts quelle via SDK e OpenTelemetry
   (l'API nativa non li prevede). Tutte v4, tutte con pseudonimo `psn_…`. Le 10
   via OpenTelemetry diretto sono senza impronta del contenuto (problema 14).
5. **Due checkpoint** forzati, entrambi con marca della TSA locale.
6. **Export verificato in una cartella separata**, con un verificatore
   installato da solo (solo i pacchetti `verifier` e `core`): OK con
   `--key-id` (è l'opzione che "fissa" la chiave comunicata a parte: non esiste
   `--pin`), OK con `--strict`; con un `key_id` sbagliato: rifiutato.
7. **Compatibilità**: fascicoli prodotti dalla versione vecchia (ricevute v1, v2
   e v3) accettati dal verificatore nuovo.
8. **Privacy**: "score: 7" non compare in chiaro né nel database (file e WAL), né
   nei log dei container, né nel PDF. "mario.rossi.TEST" compare solo nella
   tabella cancellabile `subjects`. Prima della cancellazione, con il nonce
   divulgato, `sigillo-verify open` dice MATCH; dopo "cancella interessato" e la
   cancellazione dei 40 nonce: il nome e i nonce non sono più nei byte del file,
   `open` dice NO MATCH, e le ricevute restano valide.
9. **Crash del signer e del server**:
   - server ucciso (SIGKILL) durante 8 scritture in parallelo: il crash è caduto
     proprio tra firma e scrittura; al riavvio il server ha **recuperato** la
     ricevuta dal signer e l'ha scritto nel registro amministrativo. Catena
     integra, nessuna ricevuta persa o doppia;
   - signer ucciso durante le scritture: le richieste ricevono 503 finché non
     torna, poi tutto riprende. Conteggio finale esatto (4551 = ricevute
     confermate), semaforo verde, verifica OK anche contro l'export precedente;
   - richieste ostili al socket del signer: hash grezzo (protocollo 1 e 2),
     hash al posto della ricevuta, posizione già usata, salto in avanti,
     `prev_hash` sbagliato, ritorno a metà catena, checkpoint con radice imposta:
     **tutte rifiutate**, testa della catena invariata.
10. **Orari**: catena riscritta per intero con la chiave vera e marche nuove
    datate 3 ore dopo: **avviso** senza `--strict`, **errore** con `--strict`, e
    `FAILED previous-export` contro un fascicolo precedente.

### Fase 3 — Migrazione

11. Database "come quello di produzione" creato con **la versione vecchia**
    (commit `30b5e9a`, l'ultimo prima delle tre PR), in Docker: 4 sistemi, 509
    ricevute v1/v2/v3, 6 checkpoint con marca, un sistema con la sola genesi, un
    sistema archiviato, 5 ricevute finali non ancora sigillate. Non avevo accesso
    a un backup reale.
12. **Aggiornamento** seguendo alla lettera `docs/DEPLOY-PRODUZIONE.md` 6.3: backup
    del database e della chiave cifrata (aperti e controllati), `git pull`, build,
    `init-from-db`, riavvio.
    - Tempi: `init-from-db` **1,1 s** in Docker (0,3 s senza Docker), migrazione
      dello schema 0,3 s; servizio fermo **circa 30 s** in tutto.
    - Il signer riporta **le stesse teste** del database per tutti e 4 i sistemi.
    - Tutti i fascicoli nuovi passano con `--strict` **e** contengono invariati
      quelli fatti prima dell'aggiornamento (`--previous`); catena mista v1/v2/v4.
    - `init-from-db` lanciato una seconda volta: **rifiutato**.
13. **Ripristino**:
    - da disastro (tutti i volumi cancellati): chiave dalla copia cifrata,
      database dal backup, `init-from-db` → stessa chiave, stesse teste, tutto
      verde;
    - database rimesso da un backup **più vecchio** del signer (10 ricevute di
      differenza): il sistema diventa **rosso** e rifiuta le scritture, gli altri
      continuano, nulla viene corretto da solo. È il comportamento voluto. Per
      ripartire bisogna mettere da parte la memoria del signer e rifare
      `init-from-db`: funziona, ma le posizioni già firmate vengono riusate
      (problema 4);
    - ritorno alla versione vecchia: non parte sul database aggiornato
      (problema 6); col backup pre-aggiornamento sì. Al successivo aggiornamento
      ho trovato la trappola del problema 3, e verificato che spostare la memoria
      del signer la risolve.

### Fase 4 — Cross-check Python

14. La reimplementazione Python copriva già lo schema v4 e le impronte con
    nonce, ma **non la frontiera di Merkle** (e le radici di Merkle non venivano
    ricontrollate in CI), né ricevute da rifiutare. Aggiunti nella branch
    `chore/crosscheck-v4`: frontiera per le dimensioni 0–17 calcolata in modo
    indipendente, 11 ricevute v4 sbagliate che sia il core sia Python rifiutano.
    Ho controllato che il cross-check fallisca davvero se si altera un valore.
    Test: 1093 superati, 1 saltato (Caddy). I 26 vettori esistenti sono
    invariati. **Non è unita a `main`.**

### Fase 5

15–16. Questo rapporto e `DEPLOY.md` (nella radice del repository): procedura
passo per passo per il VPS, con i controlli e il piano di ritorno. I comandi
nuovi di `DEPLOY.md` (conteggio dei nomi in chiaro, `key_id` dalla copia
cifrata, prova del backup su una copia, confronto GET_HEAD, ricevuta di prova,
verifica in un contenitore senza rete, ritorno indietro) sono stati eseguiti
nella simulazione.

---

## Cosa non ho potuto verificare

- **Il VPS vero e il suo database**: nessun accesso, per scelta. Non so con
  certezza quale versione giri lì: ho simulato il commit `30b5e9a`. Il punto 0 di
  `DEPLOY.md` annota la versione reale.
- **FreeTSA**: la rete di questo ambiente la blocca. Le marche sono della TSA
  locale dei test (vera RFC 3161, ma non FreeTSA).
- **Un certificato vero** (Let's Encrypt): Caddy ha usato il suo certificato
  locale per `localhost`.
- **Volumi grandi**: la prova è su circa 500 ricevute. Il tempo di
  `init-from-db` cresce con il numero di ricevute (ricontrolla ogni firma): con
  molte decine di migliaia di ricevute conviene misurarlo su una copia prima.
- **La pagina web nel browser**: guardata solo tramite richieste dirette e i test
  automatici con Chromium (che passano).
- **La prova locale per Windows/Mac** (`docker-compose.local.yml`,
  `PROVA-LOCALE.md`) e l'agente LangGraph di esempio in container.
- Per costruire le immagini qui ho dovuto aggiungere, **solo nella mia copia**, il
  certificato del proxy di rete di questo ambiente e scaricare le immagini da un
  mirror (stessa impronta per Node). Sul VPS non serve nulla di questo.

## Domande per te

1. **Problema 1**: il conteggio del punto 0 di `DEPLOY.md` dirà se riguarda il
   VPS. Se sì: va bene aggiungere a `SECURITY.md` e al messaggio di
   "cancella interessato" che le ricevute precedenti a ottobre 2026 non vengono
   toccate?
2. **Problema 2**: si decide ora se l'SDK debba calcolare impronte con sale
   (era la domanda 1 della sessione 16)?
3. La branch `chore/crosscheck-v4` è nella pull request #22, in bozza e non
   unita. Vuoi che ne apra un'altra per i problemi bassi (9–13), che sono piccoli?
