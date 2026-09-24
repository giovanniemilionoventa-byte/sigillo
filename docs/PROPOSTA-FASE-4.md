# Fase 4 — Dati nei campi testuali: analisi e proposta

Data: 2026-09-24. Documento per il committente. La descrizione tecnica campo
per campo, pensata per chi integra un agente, è in
[DATA-INVENTORY.md](DATA-INVENTORY.md).

Nessuna delle proposte qui sotto dichiara o rende sigillo "conforme GDPR". Si
tratta di misure tecniche per ridurre il rischio di registrare dati personali
non necessari.

## 1. Cosa ho verificato

**Uso reale.** Ho fatto girare la demo CV e l'esempio LangGraph contro un server
vero: 169 ricevute.

- `actor.agent` è sempre il nome del sistema.
- `action.name` contiene solo identificativi di codice (nodi, tool, classi di
  modello).
- Le etichette dei documenti sono categorie.
- **L'unico dato personale in chiaro è `actor.on_behalf_of` = `elena.rizzo`**,
  presente in 160 ricevute su 169: la demo lo imposta di proposito come
  `user.id`.
- Nel file del database non compaiono nomi di candidati né righe dei CV.

**Cosa accettano oggi i campi.** Ho fatto sette prove, tutte riprodotte con il
server compilato:

- L'API nativa accetta con `201` ognuno di questi valori nei campi nome:
  - un'email;
  - una frase intera con nome e data di nascita;
  - un a capo;
  - un carattere di inversione bidirezionale (U+202E);
  - uno spazio a larghezza zero;
  - un carattere NUL.

  L'unico controllo è la lunghezza.
- L'adattatore OTLP, tagliando un nome a 256, spezzava un'emoji a metà. Il
  server **firmava** una ricevuta con Unicode non valido, e l'implementazione
  Python indipendente del repository non riesce nemmeno a calcolarne
  l'impronta (`UnicodeEncodeError`).
- Un `gen_ai.provider.name` più lungo di 256 caratteri faceva fallire l'intero
  batch OTLP con `500`.

**Vincolo di fondo.** Ciò che entra in una ricevuta non può più essere
corretto né cancellato senza rompere la verifica. Qualunque protezione deve
quindi agire **prima** della firma: nell'agente, nell'SDK o all'ingresso del
server.

## 2. Cosa ho già corretto

Queste correzioni non richiedevano decisioni di prodotto.

1. **Unicode sempre valido nelle ricevute.**
   - L'adattatore OTLP non spezza più un carattere quando taglia un nome.
   - Una metà di coppia surrogata isolata, arrivata in OTLP/JSON, diventa
     U+FFFD: è ciò che la decodifica protobuf fa già con i byte non UTF-8.
   - Lo store rifiuta, **prima di chiedere la firma**, qualunque ricevuta che
     contenga ancora una stringa non valida. Vale per tutte le vie d'ingresso:
     API nativa (risponde `400`), OTLP, interfaccia web, CLI.
   - Il formato non cambia e le ricevute già firmate restano verificabili.
2. **`model.provider` e `model.digest`** vengono tagliati a 256 come
   `model.name`, invece di far fallire il batch.
3. **Documentazione.**
   - Ho corretto `SECURITY.md`, che affermava: "A caller cannot smuggle a
     prompt into a name field". È falso: 256 caratteri bastano per un nome o
     un'email.
   - Ho aggiunto `DATA-INVENTORY.md`, con ogni campo in chiaro, la sua
     provenienza, dove riappare, perché non si può cancellare e le
     raccomandazioni per chi integra un agente.
   - Ho aggiunto una nota in `FORMAT.md` sull'Unicode valido.

Test: 14 nuovi, scritti prima della correzione e visti fallire. Tra questi c'è
un test di proprietà (fast-check, 300 casi) che manda **qualsiasi** stringa
UTF-16, lunga fino a 600 caratteri, in tutti i campi e verifica che ne esca
sempre una ricevuta valida e con Unicode valido.

## 3. Decisioni da approvare

Per ciascuna ci sono opzioni e una raccomandazione. Nessuna modifica il formato
della ricevuta, perché agiscono tutte all'ingresso o nell'SDK.

### D1. `on_behalf_of`: identificativo pseudonimo

È il campo che porta dati personali per progetto: chi ha dato l'ordine
all'agente.

- **A.** Solo documentazione: già fatto in `DATA-INVENTORY.md`.
- **B.** Una funzione nell'SDK, per esempio
  `sigillo.pseudonimo(valore, chiave)`, che calcola HMAC-SHA256 con una chiave
  **custodita dal cliente e mai inviata a sigillo**, e registra un valore come
  `p:3f9a…`. La corrispondenza con la persona resta presso il cliente, e senza
  la chiave il valore non si ricollega alla persona. Resta comunque un dato
  personale per chi ha la chiave. La demo andrebbe aggiornata per usarla.
- **C.** Il server impone un formato (per esempio `^[A-Za-z0-9._:-]{1,64}$`).
  Non impedisce `elena.rizzo`, quindi serve a poco.

**Raccomandazione: A + B.** B è codice nuovo nell'SDK con test, senza
dipendenze nuove.

### D2. Caratteri non stampabili nei campi nome

Riguarda i caratteri di controllo (NUL, a capo, …), i caratteri di inversione
bidirezionale e i caratteri invisibili.

- **A.** Registrare tutto come arriva: comportamento attuale.
- **B.** API nativa: rifiutare con `400`. OTLP: sostituire con U+FFFD, perché
  un client OTLP non può correggere e rinviare, e un rifiuto farebbe fallire
  tutto il batch.
- **C.** Registrare come arriva, ma nell'interfaccia web mostrare quei
  caratteri in forma visibile (per esempio `⟨U+202E⟩`).

**Raccomandazione: B per controlli e bidirezionali, più C** per ciò che resta
comunque visibile. Motivo: un nome di azione come `invia‮lgnahc` appare
all'operatore diverso da com'è davvero, e un'evidenza non deve poter
ingannare chi la legge.

### D3. Normalizzazione Unicode (NFC)

La stessa parola può arrivare con byte diversi, per esempio "è" come un solo
carattere oppure "e" più accento.

**Raccomandazione: non normalizzare.** L'evidenza registra ciò che è stato
inviato. Se serve, la ricerca nell'interfaccia può normalizzare per conto suo.

### D4. Lunghezze

Oggi i limiti sono 128 per `system_id` e 256 per gli altri campi, e i valori
reali osservati non superano i 20 caratteri. Abbassare i limiti all'ingresso
(per esempio 64 per `on_behalf_of`) ridurrebbe lo spazio per scriverci frasi,
senza cambiare il formato.

**Raccomandazione: 64 per `on_behalf_of`, 256 per il resto.**

### D5. Avvisi su probabili dati personali

Il server potrebbe riconoscere nei campi di testo schemi tipici come email,
telefono, IBAN o codice fiscale, e **avvisare senza bloccare**: un contatore
nella risposta dell'ingest e un'indicazione nell'interfaccia, senza mai
ripetere il valore nei log. È un'euristica: non trova tutto e a volte segnala
a torto.

**Raccomandazione: sì, solo avviso, come aiuto durante il pilot.**

### D6. Contenuti in chiaro in transito verso il server

È il punto 5 della revisione, ancora aperto. L'SDK potrebbe calcolare le
impronte dei contenuti prima dell'invio.

**Raccomandazione: farlo nella fase dell'integrazione reale (8/9)**, perché
tocca SDK, adattatore e demo insieme.

### D7. Impronte di valori prevedibili

Un esito come `"colloquio"` si ricostruisce provando le alternative. Un sale
cambierebbe il formato: servirebbe `v: 3` e tutte le verifiche andrebbero
aggiornate.

**Raccomandazione: per ora solo documentazione (già fatta).** Se ne riparla
dopo il pilot, in base ai casi d'uso reali.

## 4. Cosa non ho fatto, di proposito

- Nessuna cancellazione automatica e nessun troncamento di campi al di fuori
  dei limiti già previsti dal formato.
- Nessuna modifica al formato della ricevuta né al verificatore.
- Nessuna delle decisioni D1–D7 è stata implementata.
