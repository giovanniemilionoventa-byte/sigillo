# Sigillo — Rapporto di sessione, 24 settembre 2026

Cosa è stato fatto in questa sessione, cosa resta da fare e quali decisioni
aspettano il committente. I rapporti di dettaglio di ogni fase sono in
`docs/REVISIONE-FASE-1.md`, `docs/PROPOSTA-FASE-4.md` e `PROGRESS.md`.

## In sintesi

| | Inizio sessione | Fine sessione |
|---|---|---|
| Test Vitest | 541 (539 + 2 saltati senza rete) | **579** |
| Test Python SDK / demo | 26 / 17 | 26 / 17 |
| Vulnerabilità note nelle dipendenze | 7 (1 critica, 1 alta, 5 moderate; solo sviluppo) | **0** |
| Controllo automatico dipendenze | assente | in CI, a ogni push/PR e ogni lunedì |
| Problemi di gravità alta della revisione | 5 aperti | **1 corretto** (signer); 4 aperti |
| Fasi del piano pilot | 0 su 11 | **4 completate** (1, 2, 3, 4) |

Pull request:
- [#4](https://github.com/giovanniemilionoventa-byte/sigillo/pull/4): fasi 1–3,
  **unita a `main`**.
- [#5](https://github.com/giovanniemilionoventa-byte/sigillo/pull/5): fase 4,
  **aperta** in bozza, CI verde, in attesa della tua revisione.

---

## Parte 1 — Modifiche fatte

### Fase 1 — Revisione tecnica pre-produzione
Commit `5f5413a` · PR #4 (unita)

- Revisione completa del codice: crittografia, server, database, signer, web,
  dipendenze, deploy.
- **20 problemi** documentati in `docs/REVISIONE-FASE-1.md`, ciascuno con
  gravità, file, correzione proposta, rischio e test necessari. **5 sono di
  gravità alta.**
- I problemi principali sono stati **riprodotti con codice reale** (Ed25519 e
  SQLite veri, senza mock) prima di essere dichiarati.
- Nessuna modifica al codice.

### Fase 2 — Correzione dell'associazione tra richiesta e firma
Commit `5812029` · PR #4 (unita) · punto 1 della revisione, gravità alta

- **Problema.** Il server abbinava le risposte del signer alle richieste in base
  all'ordine di arrivo. Dopo un timeout, la risposta tardiva completava la
  richiesta *successiva*, con una firma calcolata su un'altra ricevuta. Lo store
  la salvava per sempre, perché non verificava la firma.
- **Riproduzione.** Col signer reale congelato (`SIGSTOP`) e poi ripreso
  (`SIGCONT`).
- **Correzione, su due barriere indipendenti:**
  1. ogni richiesta ha un `id`, che il signer ripete nella risposta: una
     risposta completa solo la richiesta con lo stesso id;
  2. lo store verifica ogni firma (ricevute e checkpoint) sugli stessi byte che
     sta per salvare, prima di scriverli.
- **Test.** 24 nuovi, scritti prima della correzione e visti fallire.
- Formato delle ricevute e verificatore invariati.

### Fase 3 — Controllo automatico delle dipendenze
Commit `748ec29` e `5aa7d96` · PR #4 (unita)

- **Aggiornamento di vitest** da 2.1.9 a 4.1.11: elimina le 7 vulnerabilità
  trovate (tutte negli strumenti di sviluppo). I 565 test sono rimasti uguali.
- **Controllo delle dipendenze:**
  - Node, con `pnpm audit`: le dipendenze di produzione bloccano a qualsiasi
    gravità, quelle di sviluppo da `high` in su;
  - Python, con `pip-audit`: SDK con tutti gli extra, esempio e demo;
  - comandi locali: `pnpm audit:node`, `pnpm audit:python`, `pnpm audit:deps`.
- **Workflow `dependency-audit.yml`:** gira a ogni push e PR, ogni lunedì alle
  05:00 UTC e su richiesta.
- **Verificato che fallisca davvero** sulle vulnerabilità note: lodash in
  produzione, vitest 2 in sviluppo, urllib3 in Python.
- **Guida** in `docs/DEPENDENCY-AUDIT.md`.

### Fase 4 — Dati nei campi testuali
Commit `42ca0ba` · PR #5 (aperta)

- **Analisi su 169 ricevute reali.** Il solo dato personale in chiaro è
  `on_behalf_of` = `elena.rizzo`, messo di proposito dalla demo. Nel database
  non ci sono nomi di candidati né testo dei CV.
- **Correzioni che non richiedevano decisioni di prodotto:**
  - il server firmava ricevute con Unicode non valido: tagliando un nome a 256
    caratteri, spezzava un'emoji a metà. Ora il taglio è corretto, e lo store
    rifiuta l'Unicode non valido prima di chiedere la firma;
  - `model.provider` e `model.digest` non avevano limite di lunghezza, e un
    valore lungo faceva fallire l'intero batch OTLP.
- **Documentazione:**
  - nuovo `docs/DATA-INVENTORY.md`: cosa viene registrato in chiaro e come
    evitarlo;
  - corretta un'affermazione falsa in `SECURITY.md`;
  - aggiunta una nota in `FORMAT.md`.
- **Test.** 14 nuovi, tra cui un test di proprietà con stringhe arbitrarie.
- **Proposta D1–D7** in `docs/PROPOSTA-FASE-4.md`, da approvare.

---

## Parte 2 — Decisioni che aspettano il committente

| Da | Decisione | Raccomandazione |
|---|---|---|
| Fase 1 | Checkpoint senza prove in un export: avviso o errore? | Avviso (compatibile con gli archivi già prodotti) |
| Fase 1 | Scartare gli span OTLP già registrati (duplicati da retry)? | Sì |
| Fase 1 | Dove e da chi conservare la copia di backup della chiave del signer | Fuori dall'host, cifrata |
| Fase 3 | Confermare `pip-audit` come strumento solo-CI | Sì |
| Fase 3 | Soglie: produzione qualsiasi gravità, sviluppo `high`, Python qualsiasi | Confermare |
| Fase 3 | Attivare Dependabot? | Facoltativo |
| Fase 4 D1 | `on_behalf_of` pseudonimo (HMAC con una chiave che resta al cliente) | Sì, funzione nell'SDK |
| Fase 4 D2 | Caratteri di controllo e bidirezionali | Rifiuto nell'API nativa, U+FFFD in OTLP, visibili nell'interfaccia |
| Fase 4 D3 | Normalizzazione Unicode (NFC) | No |
| Fase 4 D4 | Limiti di lunghezza | 64 caratteri per `on_behalf_of` |
| Fase 4 D5 | Avvisi su probabili dati personali | Solo avviso |
| Fase 4 D6 / Fase 1 | Calcolare le impronte nell'SDK (contenuti in chiaro in transito) | Sì, nelle fasi 8–9 |
| Fase 4 D7 | Sale sulle impronte (richiede `v: 3`) | Dopo il pilot |
| Piano | Numero da assegnare alla "limitazione dei tentativi di accesso" | — |

---

## Parte 3 — Da fare

### 3.1 Problemi della revisione ancora aperti

Numerazione di `docs/REVISIONE-FASE-1.md`.

| # | Problema | Gravità | Stato | Dove andrebbe |
|---|---|---|---|---|
| 1 | Firma sbagliata dopo un timeout del signer | ALTA | **corretto** (fase 2) | — |
| 2 | La revoca di una API key da CLI non ha effetto sul server in esecuzione | **ALTA** | aperto | da fare presto: fase dedicata o insieme ai tentativi di accesso |
| 3 | Documentazione che promette più di quanto la verifica garantisca (coda troncata, archivio rifirmato, "serve la chiave") | **ALTA** | aperto (corretta solo la frase sui campi nome) | Fase 6 |
| 4 | Export per date senza prove di inclusione | **ALTA** | aperto | Fase 7 |
| 5 | Contenuti in chiaro in transito verso il server | **ALTA** (privacy) | aperto, decisione D6 | Fasi 8–9 |
| 6 | Batch OTLP non atomico: i retry creano duplicati | MEDIA | **in parte**: tolta una causa (provider/digest lunghi), restano non atomicità e duplicati | da assegnare |
| 7 | Rotazione o perdita della chiave: ricevute vecchie non verificabili | MEDIA | aperto | Fase 5 o 10 |
| 8 | L'ora vera della marca temporale (`genTime`) non viene mostrata | MEDIA | aperto | Fase 6 o 7 |
| 9 | Export per data con orologio all'indietro: buco nella sequenza | MEDIA | aperto | Fase 7 |
| 10 | Nessun limite ai tentativi di accesso; scrypt blocca il processo | MEDIA | aperto | fase "tentativi di accesso" |
| 11 | Il server non si riconnette al signer riavviato; `/healthz` dice "ok" | MEDIA | aperto (ora almeno fallisce subito) | Fase 5 o 10 |
| 12 | Cookie senza `Secure`, sessione non revocabile, niente `no-store` | MEDIA | aperto | fase "tentativi di accesso" |
| 13 | Scritture fuori dalla coda di scrittura | MEDIA-BASSA | aperto | da assegnare |
| 14 | Controllo automatico delle dipendenze | MEDIA | **corretto** (fase 3) | — |
| 15 | Hardening dei container, backup, chiave senza backup | MEDIA | aperto | Fase 5 |
| 16 | Variabili numeriche non validate (`NaN` → checkpoint ogni ms) | BASSA-MEDIA | aperto | Fase 5 o 10 |
| 17 | Lettore ZIP del verificatore (decompressione illimitata, nomi duplicati) | BASSA | aperto | Fase 6 o 7 |
| 18 | Dati personali nei campi testuali | — | **analizzato** (fase 4), decisioni D1–D5 | — |
| 19 | Impronte di valori prevedibili | — | **documentato** (fase 4), decisione D7 | — |
| 20 | Minori | BASSA | **in parte**: sistemati i surrogati UTF-16, il resto è aperto | da assegnare |

### 3.2 Fasi del piano ancora da fare

| Fase | Contenuto | Note |
|---|---|---|
| — | Limitazione dei tentativi di accesso | Era la fase 2 del piano iniziale; va ancora collocata. Naturale unirla ai punti 2, 10 e 12 |
| 5 | Hardening della configurazione di produzione | Docker, Caddy, porte, utenti, volumi, log, segreti (punti 11, 15, 16) |
| 6 | Test di manomissione | 10 casi, e documentare cosa **non** si può rilevare (punti 3, 8, 17) |
| 7 | Test completo di esportazione e verifica | Punti 4 e 9 |
| 8 | Preparazione dell'integrazione con un agente reale | Analisi e proposta, senza inventare un agente (D6) |
| 9 | Prima integrazione reale | Dopo l'approvazione della fase 8 |
| 10 | Preparazione alla produzione | Dal `git clone` alla verifica dell'export, per un utente esterno |
| 11 | Revisione finale prima del pilot | Tabella prima/dopo |

---

## Parte 4 — Ciò che non è verificato

- **Docker non è mai stato eseguito**: in questo ambiente il demone non è
  disponibile. Solo `docker compose config` è stato controllato.
- **Nessun deploy su VPS.** HTTPS, Caddy e i volumi in produzione restano da
  provare su una macchina vera.
- **La marca temporale qualificata eIDAS non è configurata.** Resta FreeTSA,
  che non è qualificata (decisione già presa: si aspetta).
- **Il controllo settimanale delle dipendenze** parte solo sul branch
  principale. Ora che #4 è unita è attivo, ma non ha ancora fatto il primo giro
  programmato.
