# Fase 8 — Integrazione con un agente reale: analisi e proposta

Data: 2026-09-24. Documento per il committente. **Nessuna modifica al codice in
questa fase**: la fase 9 (la prima integrazione reale) parte solo dopo la tua
approvazione di quanto segue.

Non ho inventato un agente. Le misure qui sotto vengono dai due agenti che il
repository ha già: l'esempio LangGraph di `sdk-python/examples/` e la demo di
selezione CV di `demo/selezione-cv/`. Nessuna delle due chiama un modello vero.
Ma la strumentazione (OpenInference per LangChain/LangGraph) e l'SDK sono quelli
veri, gli stessi che userebbe un agente in produzione.

## 1. Cosa arriva oggi al server: misurato

Ho fatto girare i due agenti con l'SDK puntato su un server che registra ogni
richiesta OTLP così come arriva (protobuf, decodificato con la libreria ufficiale
`opentelemetry-proto`).

**Demo CV, 20 curriculum: 1 richiesta, 244 015 byte, 160 span.**

| attributo | caratteri in tutto | in quanti span | cosa contiene | serve al server? |
|---|---:|---:|---|---|
| `output.value` | 64 948 | 160 | l'uscita di ogni passo: testo del CV, valutazione, email | solo la sua impronta |
| `input.value` | 54 892 | 160 | l'ingresso di ogni passo | solo la sua impronta |
| `metadata` | 42 020 | 160 | metadati di LangGraph (nodo, passo, identificativi) | no |
| `tool.description` | 10 980 | 60 | la docstring di ogni tool | no |
| `llm.input_messages.*.content` | 6 985 | 20 | il prompt mandato al modello | no |
| `llm.output_messages.*.content` | 4 024 | 20 | la risposta del modello | no |
| `user.id` | 1 760 | 160 | `elena.rizzo` | sì (`on_behalf_of`) |
| `llm.invocation_parameters` | 1 000 | 20 | parametri del modello | no |
| `tool.name`, `openinference.span.kind`, `llm.provider`, `*.mime_type`, `*.role` | | | identificativi | in parte |

Più 40 eventi `sigillo.artifact`, che portano solo impronte.

**Cercando stringhe precise nel traffico:** il nome di un candidato inventato
(`Andrea Bianchi`), le intestazioni dei CV (`Candidatura per`, `Formazione`) e
`elena.rizzo` sono **tutti presenti**. Il testo integrale dei curriculum
attraversa la rete fino al server sigillo e resta nella sua memoria il tempo di
elaborare la richiesta. Non viene scritto da nessuna parte: nel database, negli
export e nei log ci sono solo impronte (verificato nelle fasi 4 e 5).

**Esempio LangGraph: 10 826 byte, 7 span.** Stessa struttura.

Il server usa di tutto questo pochissimo:

- `openinference.span.kind`, `tool.name`, `llm.model_name`, `llm.provider`, lo
  stato dello span e gli identificativi di trace e span: per costruire la
  ricevuta;
- `user.id`/`enduser.id`: diventa `on_behalf_of`;
- `input.value` e `output.value`: **solo per calcolarne l'impronta**;
- gli eventi `sigillo.artifact`, già ridotti a impronte dall'SDK.

Tutto il resto viene scartato all'arrivo. Sulla demo, circa un terzo dei
caratteri ricevuti non viene nemmeno letto (`metadata`, descrizioni dei tool,
messaggi del modello, parametri). Quasi tutto il resto (`input.value`,
`output.value`) viene letto solo per calcolarne l'impronta. Tutto arriva in
chiaro.

## 2. Proposta D6: le impronte si calcolano nell'SDK, prima dell'invio

### Come funziona

`sigillo.init(...)` mette davanti all'esportatore OTLP di sigillo un filtro che,
per ogni span, prima di spedirlo:

1. sostituisce `input.value` e `output.value` con le loro impronte, in due
   attributi nuovi, `sigillo.input.sha256` e `sigillo.output.sha256`;
2. toglie tutti gli attributi che il server non usa (`llm.*_messages.*`,
   `metadata`, `tool.description`, `tool.parameters`,
   `llm.invocation_parameters`, i documenti di retrieval e così via). Non si
   elenca cosa togliere, ma **cosa tenere**: ciò che non è nell'elenco non parte;
3. lascia intatti gli eventi `sigillo.artifact`, che portano già solo impronte.

Il server, quando trova `sigillo.input.sha256` o `sigillo.output.sha256`, li usa
come `input_hash` e `output_hash` così come sono. Quando trova `input.value`
(un SDK vecchio, o un altro mittente OTLP) si comporta come oggi.

### Perché le impronte coincidono

Il server calcola `SHA-256(canonicalize(testo))` con RFC 8785. Per una stringa
la forma canonica è la stringa JSON con gli escape di ECMAScript. In Python
questa forma si ottiene con `json.dumps(testo, ensure_ascii=False)`.

**L'ho verificato oggi** su 2 005 stringhe: casuali, con caratteri di controllo,
emoji, U+2028/U+2029, U+FEFF, caratteri bidirezionali e NUL. Le impronte
calcolate in Python con quella formula e quelle calcolate da `packages/core`
coincidono tutte. L'unica differenza possibile è una stringa con una metà di
coppia surrogata isolata, che Python non codifica in UTF-8. L'SDK la
sostituirebbe con U+FFFD, come fa già il server sul protobuf (fase 4).

### Cosa cambia per chi usa sigillo

- **Le ricevute sono identiche, byte per byte.** Stesso formato (resta `v: 2`),
  stesse impronte, stessi vettori di test. Nessuna modifica al verificatore.
- **Al server sigillo non arriva più il contenuto**, solo le impronte e gli
  identificativi. Chi gestisce il server smette di essere destinatario del testo
  di prompt, risposte e documenti. Resta destinatario di ciò che sta nei campi in
  chiaro (`on_behalf_of`, nomi delle azioni: vedi `DATA-INVENTORY.md` e D1).
- **Il traffico** scende di circa 5 volte sulla demo (stima dalle misure sopra,
  da confermare con il test della fase 9).
- **Gli altri strumenti di osservabilità non cambiano.** Se l'agente manda le
  stesse tracce anche a Phoenix, Langfuse o a un proprio collector, il filtro
  agisce solo sulla copia destinata a sigillo.

### Rischi

- **Divergenza tra le due implementazioni.** Si copre con vettori condivisi (le
  stringhe di questa verifica, messe nel repository) controllati sia dai test
  Node sia dai test Python, come già succede per le ricevute con
  `scripts/crosscheck_vectors.py`.
- **Un mittente può dichiarare un'impronta falsa.** È già così oggi: chi manda
  `input.value` può mandare un testo diverso da quello vero. sigillo attesta ciò
  che riceve, non la sua verità (`SECURITY.md`, "What sigillo cannot detect").
  Il rischio non cambia.
- **Un attributo nuovo della strumentazione, che il server userebbe, viene
  tolto dal filtro.** Se in futuro il server leggesse un attributo nuovo,
  andrebbe aggiunto anche all'elenco dell'SDK. Un test controllerà che i due
  elenchi coincidano.

### Test previsti (fase 9)

- La demo CV con il filtro attivo: **nessuno** dei 20 nomi, e nessuna riga dei
  curriculum, compare nel traffico catturato come sopra.
- Le stesse azioni, con il filtro e senza: gli `input_hash`/`output_hash` delle
  ricevute coincidono uno per uno.
- I vettori di stringhe condivisi, in Python e in Node.
- Uno span senza `input.value` resta senza impronta: nessuna impronta inventata.

## 3. Cosa succede quando l'agente è vero: rischi dell'integrazione

Questi sono i rischi reali di collegare un agente in produzione. Non dipendono
da D6.

1. **sigillo irraggiungibile.** L'esportatore OTLP riprova per un tempo limitato
   e poi scarta. La coda in memoria (`BatchSpanProcessor`) ha 2 048 posti, e ciò
   che non entra viene perso. L'agente non si ferma, ed è giusto così: la
   registrazione non deve bloccare il servizio. Ma quelle azioni **non arrivano
   mai**, e in sigillo appaiono come silenzio, non come errore. Proposta: nella
   fase 9 misurare quanto regge una caduta del server (1 minuto, 10 minuti) e
   scriverlo nella guida. Un buffer persistente su disco nell'SDK è possibile, ma
   è lavoro nuovo: da decidere dopo il pilot.
2. **Duplicati dopo un ritentativo** (punto 6 della revisione). Se il server
   risponde 503 dopo aver scritto una parte del batch, l'esportatore rimanda
   tutto e le prime ricevute compaiono due volte. La tua decisione su
   "scartare uno span già registrato" (stessi `system_id`, `trace_id`,
   `span_id`) serve **prima** del pilot. Raccomandazione: sì.
3. **Span non riconosciuti.** Gli span che non sembrano azioni AI vengono
   ignorati e contati, ma il conteggio arriva solo nella risposta HTTP, che
   nessuno legge. Proposta per la fase 9: scrivere nel log del server, per ogni
   sistema, quanti span sono stati ignorati e con quali attributi sconosciuti
   (i nomi, mai i valori). Così la prima settimana del pilot dice se la
   strumentazione copre davvero l'agente.
4. **Orologi.** `ts_event` viene dall'host dell'agente, `ts_received` dal server:
   entrambi vanno sincronizzati con NTP. La checklist di `SECURITY.md` lo chiede
   per il server; per l'host dell'agente va detto al cliente.
5. **Versioni della strumentazione.** Le convenzioni `gen_ai.*` e OpenInference
   cambiano. L'adattatore tollera nomi alternativi, ma una versione nuova può
   spostare un attributo. Proposta: fissare nel pilot le versioni esatte dei
   pacchetti dell'agente e rieseguire la misura della sezione 1 a ogni
   aggiornamento.

## 4. Cosa mi serve da te per la fase 9

| # | Domanda | Perché serve | Mia proposta |
|---|---|---|---|
| A | **Quale agente?** Un agente vostro o di un cliente del pilot, con framework e versione | Il lavoro della fase 9 dipende da come è strumentato | Un agente LangGraph o LangChain, che l'SDK copre già; altrimenti uno che usi direttamente l'SDK OpenAI verso un server compatibile |
| B | **Dove gira, e chi gestisce il server sigillo?** | Se il server è di un soggetto diverso dall'utilizzatore dell'agente, quel soggetto diventa destinatario dei dati che arrivano (con D6 solo impronte e identificativi) | Server sigillo presso chi usa l'agente, per il pilot |
| C | **Approvi D6** (impronte calcolate nell'SDK, attivo per default)? | È la modifica principale della fase 9 | Sì, attivo per default, disattivabile solo in modo esplicito |
| D | **Il server deve rifiutare** gli span che portano ancora contenuto in chiaro? | Garantirebbe che nessun contenuto arrivi, anche da un SDK vecchio o da un altro mittente, ma farebbe perdere quelle azioni invece di registrarle | No per il pilot: si registra e si segnala nel log. Da rivalutare dopo |
| E | **Deduplicazione** degli span ritentati (punto 6)? | Senza, un pilot con rete instabile produce ricevute doppie, e non si possono togliere | Sì |
| F | **`on_behalf_of`**: identificativo opaco, o pseudonimo HMAC con chiave del cliente (D1)? | È l'unico dato personale che la strumentazione mette in chiaro per progetto | Pseudonimo HMAC, funzione nell'SDK |
| G | **Quale marca temporale** per il pilot? | FreeTSA non è qualificata eIDAS | FreeTSA accettata per iscritto per il pilot, qualificata dopo |

Le decisioni D2–D5 e D7 della fase 4 restano aperte e non bloccano la fase 9.

## 5. Piano della fase 9, se approvato

1. **SDK:** il filtro D6, i vettori condivisi e i test della sezione 2. Se
   approvata, anche la funzione di pseudonimo (D1).
2. **Server:** lettura di `sigillo.input.sha256` e `sigillo.output.sha256`; la
   deduplicazione (E), se approvata; il conteggio degli span ignorati nel log.
3. **Demo CV** aggiornata al filtro, con la misura della sezione 1 ripetuta:
   atteso zero occorrenze dei nomi.
4. **L'agente reale** (A): installazione dell'SDK, configurazione, una settimana
   di funzionamento, poi misura della copertura (span ricevuti, ignorati,
   sconosciuti), un export e la sua verifica da parte di una persona diversa da
   chi gestisce il server, con `--key-id` preso per un canale separato.
5. **Prova di caduta:** server spento per 1 e per 10 minuti con l'agente attivo;
   si conta cosa arriva e cosa si perde, e lo si scrive nella guida.

**Criteri di accettazione della fase 9:**

- nel traffico verso sigillo, nessun contenuto dei documenti;
- impronte identiche con il filtro e senza;
- export dell'agente reale verificato da un terzo;
- perdite in caso di caduta misurate e documentate.
