# Provare sigillo sul tuo computer

Questa guida ti porta da zero a un **fascicolo di prova verificato**, sul tuo
computer, senza dominio e senza comprare niente. Non serve saper usare il
terminale: qui ogni comando è scritto per intero, e sotto ognuno c'è una frase
che dice cosa fa.

**Quanto ci vuole:** circa un'ora la prima volta, di cui la gran parte è
attesa — l'installazione di Docker Desktop e la costruzione del programma.
Il tempo in cui devi fare qualcosa è sì e no venti minuti.

**Cosa otterrai:** una pagina web sul tuo computer che mostra le azioni di un
agente di esempio, e un file `.zip` — il *fascicolo* — che un programma
indipendente dichiara integro. Poi, se vuoi, cambierai **un solo byte** dentro
quel file e vedrai la verifica rifiutarlo.

> **Questa è una prova, non un'installazione vera.** Tutto resta sul tuo
> computer, non è raggiungibile da internet e non c'è il lucchetto della
> connessione sicura. Non metterci dentro dati veri.

---

## Prima di cominciare: quattro cose sul terminale

Il *terminale* è una finestra dove si scrivono comandi invece di cliccare. Fa
paura più di quanto sia difficile.

1. **Si copia e si incolla.** Non devi digitare niente a mano. Copia il comando
   da questa pagina e incollalo nella finestra nera.
2. **Un comando alla volta.** Incolla, premi **Invio**, aspetta che il cursore
   torni a lampeggiare da solo, poi passa al successivo.
3. **Nessuna risposta è una buona risposta.** Molti comandi, quando funzionano,
   non scrivono nulla. Il silenzio non è un errore.
4. **Le maiuscole contano**, e gli spazi anche. Per questo si copia e incolla.

Quando più avanti vedi scritto `IL_TUO_VALORE_QUI`, quella parte va sostituita
prima di premere Invio.

---

## Passo 1 — Installare Docker Desktop

Docker è il programma che fa girare sigillo in scatole separate, senza
sporcare il tuo computer. Quando avrai finito la prova, si disinstalla tutto
insieme.

### Su Windows

1. Vai su **https://www.docker.com/products/docker-desktop/** e clicca
   **Download for Windows**.
2. Apri il file scaricato (`Docker Desktop Installer.exe`) e vai avanti
   accettando le impostazioni proposte. Se ti chiede di usare **WSL 2**, di':
   sì.
3. **Riavvia il computer** quando te lo chiede. Serve davvero.
4. Dopo il riavvio apri **Docker Desktop** dal menu Start e aspetta che in
   basso a sinistra la scritta accanto alla balenottera diventi **Engine
   running**. La prima volta può metterci qualche minuto.

### Su Mac

1. Clicca sulla **mela** in alto a sinistra → **Informazioni su questo Mac**, e
   guarda la voce **Chip** o **Processore**. Ti serve per il passo dopo.
2. Vai su **https://www.docker.com/products/docker-desktop/** e scarica la
   versione giusta: **Apple Silicon** se il chip è un M1, M2, M3 o M4,
   **Intel Chip** se c'è scritto Intel.
3. Apri il file `.dmg` scaricato e **trascina l'icona di Docker nella cartella
   Applicazioni**.
4. Apri **Docker** dalla cartella Applicazioni. La prima volta chiede la
   password del Mac: è normale, gli serve per installare una sua componente.
5. Aspetta che in basso a sinistra compaia **Engine running**.

> **Docker Desktop deve restare aperto** per tutto il resto della guida. Se lo
> chiudi, sigillo si ferma.

---

## Passo 2 — Aprire il terminale

### Su Windows

Premi il tasto **Windows**, scrivi `powershell`, e clicca su **Windows
PowerShell**.

Si apre una finestra blu scura. È quella giusta: **non** usare il "Prompt dei
comandi" (`cmd`), perché alcuni comandi di questa guida lì si comportano
diversamente.

### Su Mac

Premi **Cmd + Barra spaziatrice**, scrivi `terminale`, e premi **Invio**.

Si apre una finestra bianca o nera con del testo e un cursore che lampeggia.

---

## Passo 3 — Scaricare il progetto

### Su Windows

```powershell
cd $HOME\Downloads
```
**Cosa fa:** ti sposta nella cartella Download, dove finirà il progetto.

```powershell
Invoke-WebRequest -Uri "https://github.com/giovanniemilionoventa-byte/sigillo/archive/refs/heads/main.zip" -OutFile "sigillo.zip"
```
**Cosa fa:** scarica il progetto da GitHub in un file compresso chiamato
`sigillo.zip`. Può metterci qualche secondo senza scrivere niente.

```powershell
Expand-Archive -Path "sigillo.zip" -DestinationPath "." -Force
```
**Cosa fa:** scompatta il file appena scaricato, creando la cartella
`sigillo-main`.

```powershell
cd sigillo-main\deploy
```
**Cosa fa:** entra nella cartella `deploy` dentro al progetto: è da lì che si
danno tutti i comandi successivi.

### Su Mac

```sh
cd ~/Downloads
```
**Cosa fa:** ti sposta nella cartella Download, dove finirà il progetto.

```sh
curl -L -o sigillo.zip "https://github.com/giovanniemilionoventa-byte/sigillo/archive/refs/heads/main.zip"
```
**Cosa fa:** scarica il progetto da GitHub in un file compresso chiamato
`sigillo.zip`. Mentre scarica mostra una riga di numeri che avanzano.

```sh
unzip -o sigillo.zip
```
**Cosa fa:** scompatta il file appena scaricato, creando la cartella
`sigillo-main`. Stampa un elenco lungo di righe `inflating:`: è normale.

```sh
cd sigillo-main/deploy
```
**Cosa fa:** entra nella cartella `deploy` dentro al progetto: è da lì che si
danno tutti i comandi successivi.

> **Da qui in poi i comandi sono identici su Windows e su Mac**, tranne dove
> scritto diversamente. E vanno dati **sempre da questa cartella**: se chiudi
> il terminale e lo riapri, devi rifare il comando `cd` qui sopra.

---

## Passo 4 — Scegliere la password della pagina web

sigillo mostra una pagina web protetta da una password. La scegli tu adesso.

**Regole:** almeno **12 caratteri**, e usa **solo lettere e numeri**. Simboli
come `$`, `#`, gli spazi e le virgolette confondono il file di
configurazione e ti fanno perdere tempo.

Negli esempi qui sotto la password è `provaLocale2026`. **Cambiala** se vuoi,
ma ricordatela: ti servirà tra qualche minuto per entrare nella pagina.

### Su Windows

```powershell
Set-Content -Path ".env" -Value "COMPOSE_FILE=docker-compose.local.yml"
```
**Cosa fa:** crea il file di configurazione `.env` e ci scrive dentro che
vogliamo la versione "prova locale", quella senza dominio né certificato.

```powershell
Add-Content -Path ".env" -Value "SIGILLO_ADMIN_PASSWORD=provaLocale2026"
```
**Cosa fa:** aggiunge al file la password della pagina web.

### Su Mac

```sh
echo "COMPOSE_FILE=docker-compose.local.yml" > .env
```
**Cosa fa:** crea il file di configurazione `.env` e ci scrive dentro che
vogliamo la versione "prova locale", quella senza dominio né certificato.

```sh
echo "SIGILLO_ADMIN_PASSWORD=provaLocale2026" >> .env
```
**Cosa fa:** aggiunge al file la password della pagina web.

### Controlla che sia andata bene

**Windows:**
```powershell
Get-Content .env
```

**Mac:**
```sh
cat .env
```
**Cosa fa:** ti mostra il contenuto del file appena creato. Devi vedere
esattamente due righe: `COMPOSE_FILE=...` e `SIGILLO_ADMIN_PASSWORD=...`.

---

## Passo 5 — Costruire il programma

```sh
docker compose build
```
**Cosa fa:** costruisce le due scatole (*immagini*) che contengono sigillo,
partendo dal codice sorgente che hai scaricato.

Questa è **la parte lunga: dai cinque ai quindici minuti**, e scorreranno
centinaia di righe di testo. È normale, e serve una connessione a internet.
Hai finito quando il cursore torna a lampeggiare da solo.

---

## Passo 6 — Creare la chiave di firma

```sh
docker compose run --rm signer keygen --key /var/lib/sigillo-key/signer.key
```
**Cosa fa:** genera la chiave privata con cui saranno firmate tutte le
ricevute, e la chiude in un'area a cui solo il firmatario può accedere.

Deve rispondere con tre righe, tra cui una che comincia con `key_id` seguita
da 16 caratteri. Quella è l'"targhetta" della chiave: la ritroverai alla fine,
nel risultato della verifica.

Questo comando si dà **una volta sola**. Se lo ripeti ti risponderà
`a key file already exists ... refusing to overwrite it`, ed è giusto così:
una chiave sovrascritta renderebbe impossibile verificare tutte le firme fatte
prima.

---

## Passo 7 — Accendere

```sh
docker compose up -d
```
**Cosa fa:** avvia il firmatario e il server in sottofondo, e ti restituisce
subito il terminale.

```sh
docker compose ps
```
**Cosa fa:** ti mostra cosa sta girando. Devi vedere due righe, `signer` e
`server`, con scritto `running` o `healthy`. Se una delle due dice `exited`,
salta alla sezione **Se qualcosa va storto**.

---

## Passo 8 — Aprire la pagina nel browser

Apri il tuo browser e vai a questo indirizzo esatto:

```
http://127.0.0.1:8080/ui
```

`127.0.0.1` vuol dire "questo computer": l'indirizzo funziona solo qui e non è
raggiungibile da nessun altro.

> Se il browser aggiunge da solo `https://` davanti e dà errore, cancella tutto
> e riscrivi l'indirizzo cominciando da `http://`. Qui la connessione sicura
> non c'è, ed è voluto: nella prova locale non serve.

**La pagina è in inglese**: sigillo è pensato per essere letto anche da
revisori stranieri. Ti comparirà un riquadro **Administrator password**: metti
quella del Passo 4 (`provaLocale2026`, se non l'hai cambiata) e clicca
**Sign in**.

Entrato, vedrai una pagina che dice che non c'è ancora nessun sistema. Giusto:
lo creiamo adesso.

---

## Passo 9 — Creare il sistema e la chiave di accesso

Un *sistema* è il registro di un agente: una catena di ricevute con un nome.

```sh
docker compose exec server node dist/cli.js system create acme-support-bot
```
**Cosa fa:** crea il registro chiamato `acme-support-bot` e ci scrive dentro la
prima ricevuta, quella che apre la catena.

```sh
docker compose exec server node dist/cli.js key create acme-support-bot
```
**Cosa fa:** genera la chiave di accesso con cui l'agente avrà il permesso di
scrivere in quel registro.

**Attenzione.** La risposta è di tre righe: la prima comincia con `key_id`,
la **seconda è un codice lungo che comincia con `sigillo_`**, e la terza ti
avverte che non è recuperabile. Seleziona col mouse la seconda riga e copiala
adesso: **non verrà mostrata mai più**. Se la perdi non è grave — basta rifare
questo comando e ottenerne un'altra.

Ora incollalo nel file di configurazione, al posto di `IL_TUO_CODICE_QUI`:

**Windows:**
```powershell
Add-Content -Path ".env" -Value "SIGILLO_API_KEY=IL_TUO_CODICE_QUI"
```

**Mac:**
```sh
echo "SIGILLO_API_KEY=IL_TUO_CODICE_QUI" >> .env
```
**Cosa fa:** salva il codice di accesso nel file di configurazione, così
l'agente di esempio lo trova da solo al prossimo passo.

---

## Passo 10 — Far girare l'agente di esempio

```sh
docker compose run --rm esempio
```
**Cosa fa:** avvia un piccolo agente di esempio che finge di rispondere a un
cliente, e manda a sigillo ogni azione che compie.

La prima volta si ferma un minuto buono a scaricare le librerie di Python:
è normale, e succede solo la prima volta.

Quando ha finito vedrai qualcosa del genere:

```
recording acme-support-bot to http://server:8080/v1/traces
instrumentations: langchain
agent said: Your order A-1099 has shipped with DHL.
receipts sent
```

L'agente non parla con nessun servizio a pagamento: il modello è finto, la
risposta è sempre la stessa, e non costa niente.

---

## Passo 11 — Guardare le ricevute

Torna nel browser su `http://127.0.0.1:8080/ui` e **ricarica la pagina**.

Ora `acme-support-bot` compare nell'elenco. Cliccaci sopra: vedrai le ricevute,
una per ogni azione dell'agente — la chiamata al modello, la chiamata allo
strumento, i passi dell'agente.

**Guarda cosa non c'è.** Non trovi da nessuna parte la domanda del cliente né
la risposta dell'agente. Ci sono i nomi delle azioni e delle impronte
(le sequenze di lettere e numeri). Il contenuto non è stato salvato: sigillo
prova *che* una cosa è successa e *quando*, non *cosa* è stato detto.

---

## Passo 12 — Generare il fascicolo

Il *fascicolo* è il file da consegnare a un revisore: contiene le ricevute, le
firme, le marche temporali e una relazione in PDF.

### Dalla pagina web

Nella pagina del sistema c'è un bottone **"Generate the evidence file"**.
Cliccalo: il browser scarica un file `.zip` nella tua cartella Download.
Puoi aprirlo con un doppio clic e guardarci dentro — c'è un `report.pdf`
leggibile e un `VERIFY.md` che spiega come controllarlo.

### E adesso di nuovo, ma dal terminale

Serve perché al passo dopo dobbiamo verificarlo, e dal terminale possiamo
dargli un nome che conosciamo tutti e due.

```sh
docker compose exec server node dist/cli.js checkpoint
```
**Cosa fa:** chiude il registro allo stato attuale, lo firma, e chiede a
un'autorità esterna una marca temporale che provi *quando* quello stato
esisteva.

Ti risponde con il nome del sistema, quante ricevute contiene, e una riga che
dice quante marche ha ottenuto. Se il tuo computer è offline dirà `0 anchored`:
non è un errore, la marca verrà presa al prossimo giro.

```sh
docker compose exec server node dist/cli.js export acme-support-bot --out /tmp/fascicolo.zip
```
**Cosa fa:** scrive il fascicolo completo dentro la scatola, con il nome
`fascicolo.zip`.

```sh
docker compose cp server:/tmp/fascicolo.zip .
```
**Cosa fa:** copia quel file dalla scatola alla cartella in cui ti trovi, così
ce l'hai anche tu sul computer.

---

## Passo 13 — Verificare il fascicolo

Questo è il punto di tutto: un programma **separato** che rilegge il fascicolo
da capo e dice se è integro.

```sh
docker compose exec server node /verifier/dist/cli.js /tmp/fascicolo.zip
```
**Cosa fa:** controlla una per una tutte le firme, la catena delle ricevute,
l'albero dei checkpoint e le marche temporali, e dice come è andata.

Deve rispondere con qualcosa che comincia per **`OK`**, seguito dal nome del
sistema, da quante ricevute ha controllato e dalla targhetta della chiave —
lo stesso `key_id` che avevi visto al Passo 6.

Tra le righe finali ne vedrai probabilmente una con scritto **`imprint-only`**.
Vuol dire: *"la marca temporale corrisponde a questo fascicolo, ma non ho
controllato la firma dell'autorità perché non mi hai dato il suo
certificato"*. Nella prova locale va benissimo. In un uso vero il certificato
dell'autorità viene messo nel fascicolo, e allora la riga diventa `verified`.

---

## Passo 14 (facoltativo) — La prova che conta

Fin qui hai visto un programma dire che un file va bene. Adesso vediamo se sa
anche dire di no.

```sh
docker compose exec server node -e "const fs=require('fs'); const b=fs.readFileSync('/tmp/fascicolo.zip'); const i=Math.floor(b.length/2); b[i] = b[i] === 255 ? 0 : b[i] + 1; fs.writeFileSync('/tmp/manomesso.zip', b)"
```
**Cosa fa:** fa una copia del fascicolo cambiando **un solo byte** nel mezzo —
una modifica invisibile, su un file di migliaia di byte.

```sh
docker compose exec server node /verifier/dist/cli.js /tmp/manomesso.zip
```
**Cosa fa:** prova a verificare la copia manomessa.

**Deve fallire.** A seconda di dove è caduto il byte cambiato ti dirà che
l'archivio non è leggibile, oppure ti nominerà il controllo che non torna: non
importa quale dei due, l'importante è che **non dica `OK`**.

Questo è l'unico motivo per cui sigillo esiste: non rende i registri
impossibili da modificare — rende ogni modifica impossibile da nascondere.

---

## Passo 15 — Spegnere

```sh
docker compose down
```
**Cosa fa:** spegne il firmatario e il server, ma **tiene** la chiave, il
database e tutto quello che hai creato. La prossima volta riparti dal Passo 7.

Se invece vuoi buttare via tutto:

```sh
docker compose down -v
```
**Cosa fa:** spegne tutto e **cancella definitivamente** chiave, database e
ricevute. Il fascicolo che hai già copiato sul computer resta dov'è.

Per togliere anche Docker: disinstallalo come un normale programma
(Windows: Impostazioni → App; Mac: trascina Docker dalle Applicazioni nel
Cestino).

---

## Se qualcosa va storto

Questa procedura è stata scritta sui file veri del progetto e controllata riga
per riga, ma **il giro completo con Docker non l'ha ancora eseguito nessuno**:
nell'ambiente dove sigillo è stato costruito Docker non era disponibile. Sei la
prima persona a farlo. Se un comando si comporta diversamente da com'è scritto
qui, non è colpa tua: segnalalo, così la guida viene corretta.

### "docker: command not found" oppure "il termine 'docker' non è riconosciuto"

Docker Desktop non è installato, oppure il terminale è stato aperto prima
dell'installazione. **Chiudi la finestra del terminale, riaprila** e riprova.
Se ancora non va, riavvia il computer.

### "Cannot connect to the Docker daemon" oppure "error during connect"

Docker Desktop non è **aperto**. Aprilo dal menu Start o dalle Applicazioni,
aspetta che dica **Engine running**, e ridai il comando.

### "no configuration file provided" oppure "can't find a suitable configuration file"

Sei nella cartella sbagliata. Torna in quella giusta:

**Windows:**
```powershell
cd $HOME\Downloads\sigillo-main\deploy
```

**Mac:**
```sh
cd ~/Downloads/sigillo-main/deploy
```

### "required variable SIGILLO_ADMIN_PASSWORD is missing a value"

Il file `.env` non c'è o è nella cartella sbagliata. Rifai il **Passo 4**
assicurandoti di essere nella cartella `deploy`.

### Il server dice `exited` in `docker compose ps`

Quasi sempre è la password troppo corta. Guarda cosa dice:

```sh
docker compose logs server
```
**Cosa fa:** mostra il diario del server, con il motivo per cui si è fermato.

Se trovi `SIGILLO_ADMIN_PASSWORD must be at least 12 characters`, la password
è di meno di 12 caratteri: rifai il Passo 4 con una più lunga e poi ridai
`docker compose up -d`.

### "port is already allocated" oppure "bind: address already in use"

Un altro programma sta già usando la porta 8080. La cosa più semplice è
chiuderlo. In alternativa apri il file `docker-compose.local.yml` con un
editor di testo, cerca la riga `- "127.0.0.1:8080:8080"`, cambia **solo il
primo** numero in `8081`, salva, e poi usa `http://127.0.0.1:8081/ui` nel
browser.

### La pagina del browser non si apre, o dice "impossibile raggiungere il sito"

Tre controlli, in quest'ordine: Docker Desktop è aperto? `docker compose ps`
mostra `server` in esecuzione? L'indirizzo comincia con `http://` e non con
`https://`?

### La password non viene accettata

Deve essere identica a quella scritta nel `.env`, maiuscole comprese.
Ricontrollala con `Get-Content .env` (Windows) o `cat .env` (Mac). Se contiene
simboli come `$` o `#`, riscrivila con sole lettere e numeri e riavvia con
`docker compose up -d`.

### La costruzione (Passo 5) si ferma con un errore

Quasi sempre è la rete: il computer non è riuscito a scaricare qualcosa.
Ridai `docker compose build`: riparte da dove si era fermato. Se sei sotto una
rete aziendale con un proxy, potrebbe essere quello a bloccare.

### "set SIGILLO_ENDPOINT and SIGILLO_API_KEY first"

Al Passo 9 il codice `sigillo_...` non è finito nel `.env`. Controlla il file:
deve esserci una riga `SIGILLO_API_KEY=sigillo_...` con il codice per intero,
senza virgolette e senza spazi attorno all'`=`.

### "no such service: esempio"

Alcune versioni di Docker Compose vogliono che si chieda esplicitamente il
gruppo a cui appartiene l'agente di esempio. Usa questo comando al posto di
quello del Passo 10:

```sh
docker compose --profile strumenti run --rm esempio
```

### Il checkpoint dice `0 anchored`

sigillo non è riuscito a raggiungere l'autorità che rilascia le marche
temporali — di solito perché il computer è offline. **Non è un errore e non
perdi niente:** il checkpoint è stato comunque salvato e firmato, e la marca
verrà chiesta al prossimo giro. Puoi riprovare con
`docker compose exec server node dist/cli.js checkpoint`.

### La verifica dice `imprint-only` e non `verified`

È il comportamento atteso in una prova locale, spiegato al Passo 13. Non
significa che qualcosa non va.

### Il download del Passo 3 dà errore 404 o "Not Found"

Il progetto potrebbe non essere più pubblico, o il nome del ramo principale
potrebbe essere cambiato. Chiedi a chi ti ha dato questa guida il link
aggiornato.

### Voglio ricominciare da capo

```sh
docker compose down -v
```
**Cosa fa:** cancella chiave, database e ricevute, lasciando intatte le
immagini già costruite. Poi riparti dal **Passo 6**: non devi ricostruire
niente.
