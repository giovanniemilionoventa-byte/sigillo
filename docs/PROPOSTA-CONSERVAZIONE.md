# Proposta: quanto tempo tenere i dati, e come cancellare (2026-10-12)

Per Giovanni. Nessuna cancellazione automatica di dati reali è stata costruita: questa è una proposta da approvare.

## 1. Cosa succede oggi

- Le **ricevute non si cancellano**: lo vietano i trigger del database (`schema.ts`). È il cuore del prodotto: una catena con un buco non si verifica più.
- Si può eliminare solo ciò che non ha mai registrato nulla: un **sistema vuoto** (solo la ricevuta iniziale).
- Da questa PR l'amministratore può anche **eliminare un cliente** (pagina Clienti, scrivendo "elimina") se nessuno dei suoi sistemi ha ricevute oltre l'iniziale: toglie i sistemi vuoti, le persone e l'organizzazione, e scrive tutto nel registro amministrativo. Un cliente con anche una sola azione registrata viene **rifiutato**: i suoi sistemi si archiviano.
- Le iscrizioni in attesa si rifiutano con "Rifiuta" (PR #82).
- Il caos che vedi ora viene quasi sicuramente da account e sistemi di prova: questi due pulsanti li fanno sparire, finché non hanno ricevute.

## 2. Quanto spazio serve davvero

Una ricevuta pesa circa 2 KB. Quindi:

| cliente | ricevute al mese | spazio al mese | 12 mesi |
|---|---|---|---|
| pilot gratuito (limite 10.000) | 10.000 | 20 MB | 240 MB |
| Standard (100.000) | 100.000 | 200 MB | 2,4 GB |

Il tuo server ha 40 GB. Con 10 clienti Standard, un anno sono circa 24 GB. **Lo spazio non è un problema per i pilot; lo diventa dopo una decina di clienti paganti.** Per questo non conviene costruire adesso una cancellazione complicata.

## 3. I vincoli

- **AI Act**: chi usa un sistema ad alto rischio deve conservare i log **almeno 6 mesi** (art. 26) e chi lo fornisce pure (art. 19). Il tuo servizio vale quanto più il periodo è lungo: 6 mesi è il **minimo di legge**, non un tetto sensato. Il cliente deve poter scegliere di più.
- **GDPR**: i dati personali non vanno tenuti più del necessario. Già oggi la persona si cancella (il pseudonimo) senza rompere la catena.

## 4. La politica che consiglio (semplice)

1. **Periodo di conservazione online per piano**: pilot 6 mesi, Standard 12 mesi. Spazio oltre il periodo = costo aggiuntivo (come dici tu).
2. **Prima di togliere qualcosa, l'archivio firmato**: il cliente scarica l'esportazione (già esiste, si verifica da sola con `sigillo-verify`). Non si cancella nulla di un cliente che non l'ha scaricata o che non ha detto "no grazie".
3. **Preavviso e grazia**: avviso 30 giorni prima, poi 30 giorni di grazia durante i quali si può ancora tornare indietro.
4. **La catena resta verificabile**: si toglie solo l'inizio della catena, e si lascia un "punto di partenza" firmato e marcato nel tempo che prende il posto della parte tolta. L'archivio scaricato dimostra tutto ciò che è stato tolto.
5. **Chi non paga né scarica**: i dati restano fermi (sola lettura) per 90 giorni, poi vanno via, con il tuo OK esplicito caso per caso.

## 5. Cosa serve costruire (non fatto)

Il punto 4 è la parte difficile: il formato delle ricevute oggi collega ogni ricevuta alla precedente fino alla prima. Togliere l'inizio richiede un nuovo tipo di ricevuta "punto di partenza", una versione nuova del formato (regola 3: le vecchie restano verificabili), le modifiche al verificatore e ai trigger. È un lavoro grande e delicato, e il verificatore deve restare leggibile. **Consiglio di farlo dopo il primo cliente pagante**, con un test di restauro vero. Fino ad allora: nessuna cancellazione di ricevute, archivio scaricabile su richiesta, backup fuori dal server (PR #82).

## 6. Cosa mi serve da te

- Ti va bene "pilot 6 mesi / Standard 12 mesi, e di più a pagamento"?
- Costruiamo il "punto di partenza" ora o dopo il primo cliente? (Io: dopo.)
