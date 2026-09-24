# Revisione finale prima del pilot — Fase 11

Data: 2026-09-24. Documento per il committente. Mette a confronto i 20 problemi
di [`REVISIONE-FASE-1.md`](REVISIONE-FASE-1.md) (base `80b750b`) con lo stato del
ramo `claude/sigillo-fasi-5-11-yb9cis` alla fine delle fasi 5-10.

Legenda:

- **corretto**: il difetto era riprodotto da un test che falliva, e ora quel
  test passa;
- **mitigato**: la parte tecnica è fatta, e ne resta una che richiede una tua
  decisione o una verifica su una macchina vera;
- **accettato**: rischio noto, documentato, con il motivo per non intervenire
  ora;
- **rimandato**: con la fase o il momento in cui va affrontato.

## Tabella prima/dopo

| # | Problema (fase 1) | Gravità | Prima | Adesso | Dove e come |
|---|---|---|---|---|---|
| 1 | Firma sbagliata salvata per sempre dopo un timeout del signer | ALTA | riprodotto | **corretto** | Fase 2: abbinamento per `id` e verifica di ogni firma prima di scrivere |
| 2 | Revoca di una API key da CLI senza effetto sul server avviato | ALTA | riprodotto | **corretto** | Fase 5: `revoked_at` letto dal database a ogni richiesta; test con due connessioni allo stesso file |
| 3 | Documentazione che promette più di quanto la verifica garantisca | ALTA | riprodotto | **corretto**, e i limiti **accettati** e scritti | Fase 6. Frasi false corrette in `SECURITY.md`, `FORMAT.md`, VERIFY.md e PDF. Il verificatore ha `--key-id` e `--previous`, gli unici modi per rilevare un archivio fabbricato con una chiave nuova e una coda tagliata, che un archivio da solo non può rivelare (è una proprietà di qualunque file firmato, non un difetto riparabile). Elencati in "What sigillo cannot detect" |
| 4 | Export per date senza prove di inclusione | ALTA | riprodotto | **corretto**; decisione aperta | Fase 7: prove della prima e dell'ultima ricevuta anche per una finestra, e solo i checkpoint pertinenti. Un checkpoint senza legami dà un **avviso** (la raccomandazione della fase 1): **va confermato da te** se debba invece essere un errore |
| 5 | Prompt, output e documenti in chiaro verso il server | ALTA (privacy) | verificato nel codice | **rimandato alla fase 9**, prima del pilot | Fase 8: misurato (244 KB in chiaro per 160 span della demo, nomi dei candidati compresi) e progettato (D6, impronte nell'SDK, fattibilità verificata). Si implementa nella fase 9, **dopo la tua approvazione** (domanda C). Nel frattempo il server non salva nulla di quel contenuto, e `DATA-INVENTORY.md` lo dice |
| 6 | Batch OTLP a metà: ricevute scritte e duplicate dai retry | MEDIA | riprodotto | **mitigato** | Fase 10: il batch è atomico (un errore a metà non lascia nulla, e il retry scrive una volta sola). Resta un caso: il server scrive e la risposta si perde in rete. Serve la deduplicazione per `trace_id`/`span_id`, che è una **tua decisione** (fase 8, domanda E; raccomandazione: sì, prima del pilot) |
| 7 | Rotazione o perdita della chiave: ricevute vecchie non verificabili | MEDIA | verificato nel codice | **corretto**; custodia della copia da decidere | Fase 10: storico append-only delle chiavi, pubblicate in ogni export e usate dal monitor. Fase 5 e guida: copia cifrata fuori dal server, con prova di apertura. **Chi custodisce copia e passphrase lo decidi tu.** Limite: una chiave cambiata prima di questa versione non è nello storico |
| 8 | L'ora vera della marca (`genTime`) mai mostrata | MEDIA | verificato nel codice | **corretto** | Fase 6: verificatore (via openssl, con avviso se lontana dal checkpoint), PDF, VERIFY.md, pagina web (lettore DER confrontato con openssl su token veri) |
| 9 | Export per data con orologio all'indietro: archivio con un buco | MEDIA | riprodotto | **corretto** | Fase 7: le date scelgono solo gli estremi, e si esporta la sequenza continua |
| 10 | Nessun limite ai tentativi; scrypt blocca il processo | MEDIA | riprodotto | **corretto** | Fase 5: limite per indirizzo su password e API key, blocco crescente, risposta indistinguibile; scrypt asincrono |
| 11 | Il server non si riconnette al signer; `/healthz` dice sempre "ok" | MEDIA | verificato nel codice | **corretto** | Fase 5: riconnessione alla richiesta successiva, rifiuto di una chiave diversa, `/healthz` 503 finché il signer manca (test con processi signer reali) |
| 12 | Cookie senza `Secure`, sessione non revocabile, niente `no-store` | MEDIA | verificato nel codice | **corretto** | Fase 5: `Secure` in HTTPS, logout in POST che chiude tutte le sessioni, `no-store`, controllo di `Origin` |
| 13 | Scritture fuori dalla coda di scrittura | MEDIA-BASSA | verificato nel codice | **corretto** | Fase 10: marche temporali ed emissione di chiavi dalla pagina web passano dalla coda (riprodotti entrambi: marca persa, processo bloccato 5 s) |
| 14 | Dipendenze: nessun controllo automatico, Python non bloccato | MEDIA | verificato | **corretto** il controllo; **accettato** il resto | Fase 3: audit in CI e ogni lunedì. Accettati per ora: le dipendenze Python con solo `>=`, e le versioni maggiori indietro (`zod`, `canonicalize` e altre). Le prime vanno fissate quando si sceglie l'agente del pilot (fase 8, rischio 5); le seconde stanno sul percorso crittografico e vanno aggiornate una alla volta, con vettori e cross-check, dopo il pilot |
| 15 | Hardening dei container; backup sullo stesso host; chiave senza backup | MEDIA | verificato nei file | **corretto** nei file; **da verificare su Docker vero** | Fase 5: sola lettura, nessuna capability, `no-new-privileges`, limiti, log a rotazione, password come secret, cartella dei backup corretta. Guida (fase 10): backup e chiave copiati fuori dal server, prova di ripristino. **Nulla di questo è mai stato eseguito su un Docker vero** |
| 16 | Variabili numeriche non validate (`NaN` → checkpoint ogni ms) | BASSA-MEDIA | verificato nel codice | **corretto** | Fase 5: ogni impostazione validata prima di partire, messaggio con il nome della variabile |
| 17 | Lettore ZIP: decompressione illimitata, nomi duplicati | BASSA | verificato nel codice | **corretto** | Fase 6: limiti prima di decomprimere, mai oltre la dimensione dichiarata, duplicati, nomi discordanti e cifratura rifiutati |
| 18 | Dati personali nei campi testuali | da decidere | verificato nel codice | **accettato**, con le decisioni D1–D5 aperte | Fase 4: analisi e `DATA-INVENTORY.md`. Il solo dato personale per progetto è `on_behalf_of`: il pseudonimo (D1) è nella domanda F della fase 8 |
| 19 | Impronte di valori prevedibili | da decidere | verificato nel codice | **accettato** fino a dopo il pilot | Fase 4: documentato. Un sale richiede `v: 3` e nuove regole di verifica (D7) |
| 20 | Minori | BASSA | verificato nel codice | **corretto**, tranne uno **accettato** | Corretti: messaggi d'errore interni (5xx generico, 503 per il signer), URL con query string nei log di Fastify e Caddy (fase 5), surrogati UTF-16 (fase 4), CSRF (controllo di `Origin`, fase 5), `from_ts`/`to_ts` e l'elenco "verified" onesto nel verificatore (fasi 6-7). Accettato: `%` e `_` non neutralizzati nella ricerca per nome della pagina web, che fanno trovare più risultati (effetto solo funzionale, nessuna iniezione) |

**In sintesi:**

- corretti **15** su 20;
- **mitigati** 2 (6, 15);
- **rimandato** 1 (5, alla fase 9);
- **accettati** 2 (18, 19).

Dei 5 problemi di gravità alta:

- **quattro sono corretti**: 1, 2, 3 e 4;
- **il quinto (5) ha la soluzione pronta**, che aspetta la tua approvazione.

Per il punto 4 resta da confermare la scelta tra avviso ed errore.

## Difetti nuovi trovati in queste fasi

Nessuno era nella revisione della fase 1. Tutti sono stati riprodotti e corretti:

| Fase | Difetto | Gravità |
|---|---|---|
| 5 | `docker compose config` stampava la password dell'amministratore e quella della TSA | MEDIA |
| 5 | Con `SIGILLO_TLS_EMAIL` vuota (il file lo permetteva) Caddy non parte affatto | MEDIA |
| 5 | La cartella dei backup non esisteva nell'immagine: `backup.sh` non avrebbe mai potuto scrivere | MEDIA |

Tutti e tre hanno una cosa in comune: **la configurazione Docker non era mai stata
eseguita**. Sono stati trovati leggendo i file e usando `docker compose config` e
il binario vero di Caddy. È probabile che il primo `docker compose up` su un
server vero ne trovi altri: per questo la checklist di `DEPLOY-PRODUZIONE.md` è il
collaudo che manca.

## Cosa è pronto

- **Il nucleo crittografico**: formato, catena, firme, Merkle, marca temporale e
  verificatore indipendente. Nessun difetto trovato in queste fasi nel nucleo
  (`packages/core`) né nelle sue regole. I difetti corretti stavano intorno:
  server, export, lettore ZIP, documentazione.
- **La verifica di un fascicolo**:
  - 17 scenari di manomissione, ciascuno rilevato dal verificatore reale;
  - un percorso completo di tre giorni, controllato fino alla firma
    dell'autorità di marcatura;
  - le due verifiche che un archivio non può fare da solo (chiave del gestore,
    export precedente), ora possibili.
- **Il server per la produzione**:
  - limiti ai tentativi e sessioni revocabili;
  - riconnessione al signer e `/healthz` che lo controlla;
  - batch atomici, storico delle chiavi e configurazione validata;
  - log senza segreti né contenuti.
- **La configurazione di deploy** indurita, e una guida con checklist per un VPS.
- **La documentazione**: `SECURITY.md` dice cosa sigillo protegge, cosa non può
  rilevare e cosa controllare prima di andare in produzione.
- **Test**: 684 test Node (erano 579), 26 dell'SDK Python e 17 della demo, tutti
  verdi. CI verde.

## Cosa resta a tuo carico

I tre punti di "ciò che non è verificato" del rapporto precedente restano tali:

1. **Docker reale.** Non è mai stato eseguito: in questo ambiente il demone non
   si avvia. La configurazione è controllata con `docker compose config` e con
   test, non con un avvio.
2. **Deploy su VPS.** HTTPS, Caddy, volumi, secret, backup e copia della chiave:
   la checklist di 33 righe di `docs/DEPLOY-PRODUZIONE.md` va eseguita su un
   server vero. È il collaudo di 1 e 2 insieme.
3. **Marca temporale qualificata eIDAS.** Non configurata; resta FreeTSA, non
   qualificata. Decisione già presa: si aspetta. Per il pilot, va accettata per
   iscritto.

Le decisioni che aspettano te:

| Da | Decisione | Raccomandazione |
|---|---|---|
| Fase 8, A–B | Quale agente per il pilot, dove gira, chi gestisce il server | Un agente LangGraph/LangChain; server presso chi usa l'agente |
| Fase 8, C | D6: impronte calcolate nell'SDK | Sì, attivo per default |
| Fase 8, D | Il server deve rifiutare gli span con contenuto in chiaro? | No per il pilot |
| Fase 8, E / punto 6 | Deduplicazione degli span ritentati | Sì, prima del pilot |
| Fase 8, F / D1 | `on_behalf_of` pseudonimo | Sì, funzione nell'SDK |
| Fase 8, G | FreeTSA accettata per il pilot? | Sì, per iscritto |
| Punto 4 | Checkpoint scollegato: avviso o errore | Avviso (applicato) |
| Punto 7 | Chi custodisce la copia cifrata della chiave e la passphrase | Due persone diverse, fuori dall'host |
| Fase 3 | `pip-audit` come strumento solo-CI | Sì |
| Fase 4 | D2–D5 e D7 | Come in `PROPOSTA-FASE-4.md` |

## Cambia la valutazione complessiva?

**Sì, in due modi.**

**In meglio, sulla sostanza.**

- Le proprietà promesse da sigillo reggono dove sono state messe alla prova: 17
  manomissioni e un percorso completo con un'autorità di marcatura vera.
- I cinque punti gravi della fase 1 sono chiusi, tranne uno che ha una soluzione
  pronta.
- Nessuna delle correzioni ha toccato il formato delle ricevute o le regole
  della verifica. I fascicoli prodotti prima restano verificabili.

**Più precisa, sui limiti.** La sicurezza di un fascicolo non sta tutta nel
fascicolo. Tre cose la reggono dall'esterno, e vanno trattate come parte del
prodotto, non come dettagli:

1. **il `key_id` comunicato per un canale indipendente**, perché un archivio
   fabbricato da zero è coerente e verifica;
2. **gli export consegnati nel tempo e le marche temporali**, perché una coda
   tagliata, o una storia riscritta da chi controlla il server, si vede solo
   confrontando con qualcosa che è uscito prima;
3. **l'intervallo tra i checkpoint**: tutto ciò che è successo dopo l'ultima
   marca temporale può essere riscritto da chi controlla il server. Con il
   default di 60 minuti, quella finestra è di almeno un'ora. Per il pilot
   suggerisco 15 minuti (`SIGILLO_CHECKPOINT_MINUTES=15`): costa quattro marche
   all'ora a FreeTSA, e riduce la finestra di quattro volte.

Il rischio principale del pilot, oggi, **non è crittografico ma operativo**: una
configurazione Docker mai avviata, e un SDK che manda al server il contenuto in
chiaro finché D6 non è approvata. Il primo si chiude con la checklist, il
secondo con la fase 9.
