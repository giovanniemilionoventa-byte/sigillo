# Copione video — "Cosa ha fatto la vostra AI? Ora potete dimostrarlo."

Durata: circa 3 minuti. Pubblico: DPO e responsabili compliance, non
tecnici. Nel parlato: zero parole tecniche (niente "hash", "firma digitale",
"crittografia", "API", "log"). Le uniche schermate mostrate sono
l'interfaccia web della demo `selezione-cv`, già in esecuzione con i 20
candidati caricati (`run_demo.sh` o `run_demo.ps1`).

---

### Scena 1 — 0:00–0:20 — Il problema

**Si vede:** schermo nero, poi una candidatura scartata da un sistema
automatico (un fermo immagine semplice, non serve altro).

**Si dice:**
"La vostra azienda usa l'intelligenza artificiale per leggere curriculum,
rispondere a clienti, prendere piccole decisioni ogni giorno. Ma se un giorno
qualcuno vi chiede: 'cosa ha fatto esattamente, e come lo dimostrate?' — sapete
rispondere? La maggior parte delle aziende, oggi, no."

---

### Scena 2 — 0:20–0:45 — La prima domanda: è tutto a posto?

**Si vede:** home page di sigillo, la sezione "È tutto a posto?" con il
pallino verde e la scritta "verde".

**Si dice:**
"Questa è sigillo. Ogni azione che la vostra AI compie viene registrata in un
modo che nessuno — nemmeno chi gestisce il sistema — può poi modificare senza
che si veda. La prima cosa che vedete è un semaforo: verde, giallo o rosso,
sempre con una parola accanto al colore, così è chiaro anche a chi non
distingue bene i colori. Verde vuol dire: il registro è integro, e i controlli
sono aggiornati."

---

### Scena 3 — 0:45–1:15 — La seconda domanda: cosa ha fatto l'AI?

**Si vede:** scorrimento della sezione "Cosa ha fatto l'AI?": frasi come "L'agente ha usato lo strumento «leggi_curriculum»" e "La decisione è stata presa — completato."

**Si dice:**
"Qui sotto, in frasi normali, non in codice: cosa ha fatto l'agente, quando,
e con quale esito. Se volete i dettagli tecnici, ci sono, ma nascosti finché
non li cercate — perché la maggior parte delle volte a voi serve la frase,
non i dettagli."

---

### Scena 4 — 1:15–1:50 — Un candidato si lamenta

**Si vede:** una email o un messaggio simulato: "Ritengo di essere stato
scartato ingiustamente." Poi la pagina "verifica documento": caricamento del
curriculum del candidato, click su "Verifica", comparsa del messaggio di
conferma con spunta verde.

**Si dice:**
"Immaginate: un candidato scartato scrive che la selezione non è stata equa.
Prendete il suo curriculum e lo caricate qui. Il documento non lascia mai il
vostro computer — viene solo controllato. In un istante, sigillo vi conferma:
sì, è esattamente il documento che l'AI ha usato, in quella data, per
quell'azione. Non un documento simile. Esattamente quello."

---

### Scena 5 — 1:50–2:15 — Non si può barare

**Si vede:** lo stesso file, con un carattere cambiato in un editor di testo,
ricaricato nella stessa pagina: questa volta compare "Nessuna azione
registrata ha usato questo documento."

**Si dice:**
"E se qualcuno provasse a far combaciare un documento diverso, magari
cambiato dopo i fatti? Basta un carattere, uno solo, e sigillo non lo
riconosce più. Questo è il punto: non dovete credere sulla parola a nessuno,
nemmeno a chi ha costruito questo sistema."

---

### Scena 6 — 2:15–2:45 — La terza domanda: mi prepari le prove?

**Si vede:** sezione "Mi prepari le prove?", scelta dell'intervallo di date,
click su "Genera fascicolo", download dello .zip.

**Si dice:**
"Quando un ispettore, un revisore o un cliente chiede le prove, non serve
preparare niente a mano: scegliete un periodo, e sigillo prepara un fascicolo
completo. E la parte più importante: chiunque può controllarlo con uno
strumento gratuito e pubblico, che non appartiene a chi vende sigillo. Non
dovete fidarvi di noi. Potete verificare da soli — o far verificare a chi
volete voi."

---

### Scena 7 — 2:45–3:00 — Chiusura

**Si vede:** home page, semaforo verde, logo/nome "sigillo".

**Si dice:**
"Il nuovo regolamento europeo sull'intelligenza artificiale chiede alle
aziende di poter dimostrare cosa i loro sistemi hanno fatto. Sigillo esiste
per questo: non per dirvi se la vostra AI ha fatto la cosa giusta, ma per
darvi — e dare a chiunque ve lo chieda — le prove per verificarlo voi stessi."

---

## Note di produzione

- Tutte le schermate sono quelle reali della demo `selezione-cv`; non serve
  animazione, bastano registrazioni schermo con il cursore ben visibile.
- Il candidato della scena 4 può essere il candidato n. 7 della demo
  (Andrea Bianchi) — si veda `ISPEZIONE.md` per lo stesso scenario passo per
  passo, se serve improvvisare oltre il copione durante le riprese.
- Nessuna scena richiede di mostrare il terminale: tutto quello che un
  responsabile compliance deve vedere è nel browser. Il terminale compare
  solo nella variante più tecnica del percorso, in `ISPEZIONE.md`.
