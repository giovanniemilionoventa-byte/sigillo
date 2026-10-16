# Self-hosted: conviene costruirlo? (2026-10-16)

Per Giovanni. Nessun codice è stato scritto: questa è una valutazione e una proposta da approvare.
Il file precedente con questo nome non era nel repository ed è stato riscritto da zero a partire dal
codice, da `DEPLOY.md`, `docs/DEPLOY-PRODUZIONE.md` e dall'analisi della tua amica.

## In una frase

**Non costruire ora una versione self-hosted "da scaffale".** Se un cliente regolamentato la chiede
davvero, la risposta più semplice e più economica è **un'istanza dedicata, gestita da noi, in Europa**
(stesso codice, un server solo per quel cliente). Il pacchetto Docker da installare a casa del cliente
si fa dopo, e solo se un cliente lo mette per iscritto come condizione d'acquisto.

## Cosa esiste già

Più di quanto sembri. Oggi in `deploy/` ci sono già:

- `docker-compose.yml`: tre servizi (signer con la chiave, server col database, Caddy per HTTPS), già
  blindati (nessun privilegio, file system in sola lettura, limiti di memoria);
- `update.sh`, `backup.sh`, `offsite-backup.sh` (backup cifrato fuori sede);
- una guida passo-passo con i risultati attesi (`docs/DEPLOY-PRODUZIONE.md`) e una per gli
  aggiornamenti (`DEPLOY.md`), collaudata il 1° ottobre su una copia simulata.

Le parti "da servizio online" sono già opzionali o spegnibili con un'impostazione: il login clienti
con Firebase (vuoto = solo password dell'amministratore), le organizzazioni, il gateway modelli, i
limiti mensili. Il server di marca temporale si cambia con `TSA_URL`. Quindi **il prodotto girabile a
casa di qualcuno esiste già**; manca tutto quello che serve per *consegnarlo a un cliente non tecnico*.

## Cosa manca per consegnarlo (le tre strade)

| | A. Istanza dedicata gestita da noi | B. Pacchetto Docker dal cliente | C. B + "testimone" nostro |
|---|---|---|---|
| Chi gestisce | noi | il cliente | il cliente, noi controlliamo |
| Dove stanno i dati | server UE solo per lui | in casa sua | in casa sua |
| Lavoro per te (stima) | 3–5 giorni | 2–3 settimane | 4–6 settimane |
| Supporto dopo la vendita | basso: sappiamo cosa gira | alto: ogni ambiente è diverso | alto |
| Risponde a "i dati non escono" | in parte (restano in UE, ma li gestiamo noi) | sì, del tutto | sì, del tutto |
| Rischio principale | il cliente vuole comunque "a casa mia" | supporto e aggiornamenti non finiscono mai | complessità del formato |

Le stime sono mie, a occhio, non misurate: servono solo a confrontare le strade.

**A. Istanza dedicata.** È la guida di produzione già scritta, ripetuta per un cliente: un piccolo
server UE a suo nome, un dominio suo (`sigillo.cliente.it`), la sua chiave, il suo database, il suo
backup. Da fare: uno script che prepara tutto con pochi comandi, un backup fuori sede per istanza,
un controllo che ti avvisa se un'istanza è ferma. Il costo del server è di pochi euro al mese per
cliente (da verificare con il provider scelto) e va dentro il prezzo "Custom" già previsto (circa 490 €/mese, "server dedicato").

**B. Pacchetto Docker.** Oggi per installare bisogna scaricare tutto il codice e compilarlo sul server
(`build:` nel compose, serve compilatore e 2 GB di RAM). Per un cliente non tecnico serve invece:
immagini già pronte pubblicate in un registro, uno script d'installazione che crea chiave e password,
un comando unico per aggiornare, una guida in inglese e italiano, una **licenza** (oggi nel
repository non c'è nessun file di licenza), prova su un computer pulito, e un manuale di assistenza.
In più il tuo codice esce di casa: va deciso prima con chi può leggerlo.

**C. Il "testimone".** Chi ha il server e la chiave potrebbe riscrivere la propria storia e rifirmarla:
per questo il progetto aveva immaginato un nostro servizio che controfirma i punti di controllo. Ma le
marche temporali RFC 3161 che già mettiamo sui punti di controllo fanno una parte di questo lavoro: una
catena riscritta *dopo* la marca non torna. Il testimone serve solo contro chi riscrive *prima* della
marca, un rischio piccolo. È la parte più complicata e quella meno richiesta: **rimandala**.

## Rischi e costi da dire chiaramente

- **Supporto.** Ogni cliente self-hosted ha il suo Linux, il suo firewall, il suo proxy. È questo, non il
  codice, il vero costo: ogni aggiornamento diventa una telefonata.
- **Aggiornamenti.** Il formato delle ricevute è versionato e c'è il comando `migrate`, ma un cliente
  fermo a una versione vecchia va tenuto compatibile: più versioni da mantenere.
- **La chiave.** Nel self-hosted la chiave è del cliente: se la perde, perde la possibilità di firmare
  sulla stessa catena. Serve una procedura di copia cifrata (esiste già, 3.3 della guida).
- **Prova a metà.** Il vantaggio per l'auditor resta solo se la marca temporale è affidabile: oggi si
  usa FreeTSA, non qualificata. Per clienti regolamentati serve comunque un fornitore eIDAS (è
  un'impostazione, ma costa e serve un contratto, e la SRL).
- **Distrazione.** Con zero clienti paganti, tre settimane su B sono tre settimane non spese su ciò che
  l'analisi della tua amica mette come bloccante: backup fuori sede, termini e DPA, prove con clienti
  veri.

## Cosa NON dipende dal self-hosted (e vale di più, adesso)

L'analisi indica backup fuori sede e DPA/termini come **critici**, il self-hosted solo come "alto". E il
self-hosted risponde a un'obiezione che spesso si risolve con una promessa scritta: "i dati restano in
UE, sui nostri server, e c'è un contratto che lo dice". Quindi, in ordine:

1. Attivare il backup fuori sede (script e guida esistono, 6.1: va solo acceso e provato un ripristino).
2. DPA e termini (non è lavoro di codice; serve una persona legale).
3. Una pagina che dice, onestamente, dove sono i dati e cosa vede il server (il gateway modelli vede
   il testo passare dalla memoria, e il documento principale lo dice già).

## Raccomandazione e passi minimi

1. **Adesso:** nessuna riga di codice self-hosted. Tieni questa proposta e rispondi ai clienti: "oggi
   offriamo un'istanza dedicata in UE; l'installazione a casa vostra è in valutazione".
2. **Quando un pilota la chiede per iscritto:** fare la strada A (3–5 giorni). Si può promettere subito perché
   è la guida che c'è già.
3. **Solo se due clienti, o uno molto grande, mettono "in casa nostra" come condizione:** la strada B, a
   quel punto con un cliente reale con cui provare l'installazione.
4. **Il testimone (C):** non prima di aver visto una richiesta concreta.

## Cosa mi serve da te

- Ti va bene la raccomandazione (A quando serve, B solo su richiesta firmata, C rimandata)?
- Quale provider UE vuoi per le istanze dedicate? Io non ne ho scelto uno.
- Per B, in futuro: chi può leggere il codice (licenza)? Va deciso prima, non durante.
