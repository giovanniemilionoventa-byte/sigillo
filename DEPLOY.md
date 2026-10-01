# Aggiornare sigillo sul VPS (ottobre 2026)

Procedura per portare il server di produzione dalla versione attuale (ricevute
v2, signer "senza memoria") a quella con le tre novità unite in `main`:

- **orari nel verificatore** (PR #18): l'ora della marca temporale è l'ora provata;
- **signer con memoria** (PR #20): il signer tiene un registro di ogni catena e
  firma solo la ricevuta successiva;
- **pseudonimi e impronte con sale, ricevute v4** (PR #19).

È stata provata per intero il 1° ottobre 2026 su una copia simulata della
produzione, in Docker, con la stessa `docker-compose.yml` (rapporto:
`docs/RAPPORTO-VERIFICA-2026-10-01.md`). Il servizio resta fermo **circa 30 secondi**
(punto 4). In tutto servono 30–45 minuti, quasi tutti di controlli.

## Come leggere questa pagina

- Ogni comando si copia e si incolla **così com'è**, uno alla volta.
- `$` vuol dire "sul VPS", `portatile$` "sul tuo computer". Il simbolo non si copia.
- Sotto ogni comando: ✅ **se va bene** (cosa deve comparire) e ❌ **se non va**
  (cosa fare). Se succede qualcosa che non è scritto qui: **fermati**. Fino al
  punto 4 non è cambiato nulla e si può semplicemente lasciare tutto com'è.
- Dove leggi `sigillo.tuaazienda.it` metti il vostro dominio; `utente` è
  l'utente con cui entri nel VPS.
- Mai usare `docker compose down -v`: il `-v` cancella database e chiave.

---

## 0. Prima di cominciare

```sh
$ cd /srv/sigillo/deploy
$ git -C /srv/sigillo rev-parse HEAD | tee ~/sigillo-commit-prima.txt
```
✅ Una riga di 40 caratteri esadecimali: è la versione attuale, ti serve per il
ritorno indietro. ❌ `No such file or directory`: il progetto non è in
`/srv/sigillo`; trova la cartella giusta e usa quella in tutti i comandi.

```sh
$ docker compose ps
```
✅ `signer` e `server` `(healthy)`, `caddy` `Up`. ❌ Qualcosa non è sano già
adesso: non aggiornare, prima capisci perché (`docker compose logs server`).

```sh
$ docker compose logs signer | grep -o 'key [0-9a-f]\{16\}' | tail -1
```
✅ `key ` seguito da 16 caratteri: è il `key_id` della chiave di firma.
**Deve essere uguale** a quello che avete comunicato ai destinatari dei
fascicoli. Scrivilo qui: `KEY_ID = ________________`. ❌ Nessuna riga: usa
`docker compose logs server | grep 'signing with key' | tail -1`.

**Quante ricevute già scritte contengono un nome in chiaro.** Le ricevute
scritte finora (v1–v3) non verranno mai cambiate: se contengono un nome nel campo
`on_behalf_of`, lo conterranno per sempre, anche dopo l'aggiornamento e anche
dopo "cancella interessato" (rapporto, problema 1). È bene saperlo prima.

```sh
$ docker compose exec -T server node --input-type=module - <<'EOF'
import Database from "better-sqlite3";
const db = new Database("/var/lib/sigillo/sigillo.db", { readonly: true });
console.table(db.prepare(`
  SELECT json_extract(canonical, '$.v') AS versione,
         count(*) AS ricevute,
         sum(substr(coalesce(json_extract(canonical, '$.actor.on_behalf_of'), 'psn_'), 1, 4) <> 'psn_') AS con_nome_in_chiaro
  FROM receipts GROUP BY 1 ORDER BY 1`).all());
EOF
```
✅ Una tabellina con, per ogni versione, quante ricevute ci sono e quante
contengono un nome in chiaro. Annota i numeri. ❌ Un errore: annotalo e vai
avanti, è solo informativo.

**Un fascicolo per ogni sistema, fatto con la versione attuale.** Servirà al
punto 7 per dimostrare che l'aggiornamento non ha cambiato nulla del passato.

```sh
$ docker compose exec server node dist/cli.js system list --all
```
✅ L'elenco dei sistemi con il numero di ricevute. Annota i nomi.

Per **ogni** sistema dell'elenco (qui `NOME_SISTEMA`):

```sh
$ docker compose exec server node dist/cli.js export NOME_SISTEMA --out /var/lib/sigillo-backups/prima-NOME_SISTEMA.zip
$ docker compose cp server:/var/lib/sigillo-backups/prima-NOME_SISTEMA.zip ~/prima-NOME_SISTEMA.zip
```
✅ Il primo finisce con `the archive verifies`, il secondo con `Copied`.
❌ `the archive does not verify`: **fermati**, il problema c'è già oggi.

---

## 1. Backup del database e della chiave, e prova che si possano ripristinare

### 1.1 Il database

```sh
$ docker compose exec -T server /app/backup.sh
```
✅ `wrote … bytes to /var/lib/sigillo-backups/sigillo-AAAAMMGGThhmmssZ.db` e
`backups in /var/lib/sigillo-backups: N`. ❌ Un errore: non andare avanti senza
backup; `docker compose logs server`.

```sh
$ mkdir -p ~/sigillo-pre-aggiornamento
$ f=$(docker compose exec -T server sh -c "ls -1t /var/lib/sigillo-backups/sigillo-*.db | head -1")
$ docker cp "$(docker compose ps -q server):$f" - | tar -xf - -C ~/sigillo-pre-aggiornamento
$ ls -l ~/sigillo-pre-aggiornamento
```
✅ Un file `sigillo-….db` di dimensione simile al database (da qualche centinaio
di KB in su). ❌ Cartella vuota: ripeti; se resta vuota, fermati.

**Prova di ripristino, su una copia** (aprire un file col programma lo modifica,
quindi mai sull'originale):

```sh
$ rm -rf /tmp/prova-ripristino && mkdir /tmp/prova-ripristino
$ cp ~/sigillo-pre-aggiornamento/sigillo-*.db /tmp/prova-ripristino/copia.db
$ docker run --rm --network none --user "$(id -u):$(id -g)" -v /tmp/prova-ripristino:/r sigillo-server system list --all --db /r/copia.db
```
✅ Lo stesso elenco di sistemi, con gli stessi numeri di ricevute, del punto 0.
❌ Numeri diversi o un errore: il backup non è buono, **fermati**.

```sh
$ rm -rf /tmp/prova-ripristino
```

Porta il backup anche fuori dal VPS:

```sh
portatile$ scp -r utente@sigillo.tuaazienda.it:'~/sigillo-pre-aggiornamento' .
portatile$ scp utente@sigillo.tuaazienda.it:'~/prima-*.zip' .
```
✅ I file sono sul portatile. ❌ Errore di `scp`: controlla utente e dominio.

### 1.2 La chiave, cifrata

```sh
$ docker compose run --rm --no-deps -T --entrypoint tar signer -C /var/lib/sigillo-key -cf - signer.key \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -out ~/sigillo-chiave-$(date +%F).tar.enc
```
✅ `openssl` chiede due volte una passphrase (sceglila lunga, **salvala nel
gestore di password**), poi nessun errore. ❌ `no such service: signer`: non sei
in `/srv/sigillo/deploy`.

Prova che si apra **e** che sia la chiave giusta:

```sh
$ openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in ~/sigillo-chiave-$(date +%F).tar.enc | tar -tvf -
$ openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in ~/sigillo-chiave-$(date +%F).tar.enc | tar -xOf - signer.key \
    | openssl pkey -pubout -outform DER | tail -c 32 | sha256sum | cut -c1-16
```
✅ Il primo elenca `signer.key` con `-rw-------`. Il secondo stampa 16 caratteri
**identici al `KEY_ID` del punto 0**. ❌ `bad decrypt`: passphrase sbagliata,
rifai la copia. `KEY_ID` diverso: **fermati** (non è la chiave in uso).

```sh
portatile$ scp utente@sigillo.tuaazienda.it:'~/sigillo-chiave-*.tar.enc' .
$ rm ~/sigillo-chiave-*.tar.enc
```
✅ La copia cifrata è sul portatile e non più sul VPS.

---

## 2. Aggiornare il codice

```sh
$ git -C /srv/sigillo status --short
```
✅ Nessuna riga, oppure solo `?? deploy/.env` / `?? deploy/secrets/`. ❌ Righe
con `M`: qualcuno ha modificato file sul VPS; **fermati** e chiedi.

```sh
$ git -C /srv/sigillo pull --ff-only
$ git -C /srv/sigillo log --oneline -1
```
✅ L'ultima riga mostra `f05818b Merge pull request #19 …` o un commit più
recente di `main`. ❌ `Not possible to fast-forward`: **fermati**, non forzare.

```sh
$ docker compose build
```
✅ Finisce con `Built` per `server` e `signer`, senza `ERROR`. Intanto il
servizio vecchio continua a funzionare. ❌ Errore durante `pnpm install`: rete
verso il registro npm, riprova; altri errori: fermati (non è cambiato nulla).

**Non usare `update.sh` per questo aggiornamento**: serve il passo 3, che lo
script non fa.

---

## 3. Fermare, preparare la memoria del signer (una volta sola), ripartire

Da qui il servizio è fermo, circa 30 secondi.

```sh
$ docker compose stop server signer
```
✅ `Stopped` per entrambi.

```sh
$ docker volume ls | grep sigillo-data
```
✅ Una riga che finisce con `sigillo_sigillo-data`. ❌ Nome diverso: usa quel
nome al posto di `sigillo_sigillo-data` nel comando seguente.

```sh
$ docker compose run --rm --no-deps -v sigillo_sigillo-data:/var/lib/sigillo signer \
    init-from-db --db /var/lib/sigillo/sigillo.db --state /var/lib/sigillo-key/state
```
✅ Una riga per ogni sistema, `NOME: seq N, N+1 receipts, head <64 caratteri>`,
con gli stessi numeri del punto 0, e alla fine
`initialised K system(s), 0 retired; written to the administrative log`.
(Su 506 ricevute ha impiegato circa un secondo.)
❌ `already initialised`: è già stato fatto, va bene così, prosegui.
❌ Un messaggio che nomina un sistema e una posizione (`seq`): una catena non
torna. **Non scrive nulla.** Riparti con la versione vecchia (Piano di ritorno,
passo R2–R4, senza R3) e chiedi aiuto.

```sh
$ docker compose up -d
$ docker compose restart caddy
```
✅ `Started` / `Restarted`.

```sh
$ sleep 45 && docker compose ps
```
✅ `signer` e `server` `(healthy)`, `caddy` `Up`. ❌ `server` `Restarting`:
`docker compose logs server | tail -20`; se dice `Invalid discriminator value`
o simile, vai al Piano di ritorno.

---

## 4. Controlli: chiave, semaforo, teste delle catene

```sh
$ docker compose logs signer | grep listening | tail -1
```
✅ `listening on /run/sigillo/signer.sock with key KEY_ID`, **lo stesso
`KEY_ID` del punto 0**. ❌ Un `key_id` diverso: la chiave è cambiata,
**fermati** (Piano di ritorno).

```sh
$ docker compose logs server | grep -i disagree
```
✅ Nessuna riga. ❌ Righe `the signer and the database disagree`: il passo 3 non
è stato fatto o non è riuscito; rileggi il suo risultato.

**Il semaforo.** Apri `https://sigillo.tuaazienda.it/ui` ed entra.
✅ In alto «Il registro è integro» / «Tutti i N registri sono integri», semaforo
**verde** (o giallo solo per «nessuna attività recente»). Nella pagina Sistemi,
il registro amministrativo mostra «registrato nello stato del firmatario» per
ogni sistema. ❌ Rosso con «Il firmatario e il database non concordano»: non
correggere nulla a mano; Piano di ritorno.

**GET_HEAD: il signer e il database devono dire la stessa cosa** per ogni sistema.

```sh
$ docker compose exec -T server node --input-type=module - <<'EOF'
import { createConnection } from "node:net";
import Database from "better-sqlite3";
import { receiptHashHex } from "@sigillo/core";
const db = new Database("/var/lib/sigillo/sigillo.db", { readonly: true });
const socket = createConnection("/run/sigillo/signer.sock");
let buffer = ""; const waiting = [];
socket.on("data", (data) => { buffer += data; let i; while ((i = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); waiting.shift()(JSON.parse(line)); } });
const ask = (message) => new Promise((resolve) => { waiting.push(resolve); socket.write(JSON.stringify(message) + "\n"); });
for (const { system_id } of db.prepare("SELECT system_id FROM systems ORDER BY system_id").all()) {
  const last = db.prepare("SELECT seq, hash FROM receipts WHERE system_id = ? ORDER BY seq DESC LIMIT 1").get(system_id);
  const reply = await ask({ v: 2, id: system_id, method: "GET_HEAD", system_id });
  const head = reply.ok && reply.head ? { seq: reply.head.seq, hash: receiptHashHex(reply.head) } : null;
  const same = head !== null && head.seq === last.seq && head.hash === last.hash;
  console.log(system_id.padEnd(24), "database seq", last.seq, "| signer seq", head?.seq, same ? "UGUALI" : "DIVERSI");
}
socket.end();
EOF
```
✅ Una riga per sistema, tutte `UGUALI`. ❌ Anche una sola `DIVERSI`:
**fermati**, Piano di ritorno.

**La pagina "verifica un documento"** (Caddy deve usare il Caddyfile nuovo):

```sh
$ grep -o "script-src '[^']*'" /srv/sigillo/deploy/Caddyfile
$ curl -sI https://sigillo.tuaazienda.it/ui/login | grep -io "script-src '[^']*'"
```
✅ Le due righe sono uguali. ❌ Diverse: `docker compose restart caddy` e ripeti.

---

## 5. Una ricevuta di prova

Un sistema apposta, così le catene vere non contengono prove tecniche. Non si
potrà cancellare (avrà una ricevuta vera), solo archiviare: è voluto.

```sh
$ docker compose exec server node dist/cli.js system create verifica-aggiornamento-2026-10
$ docker compose exec server node dist/cli.js key create verifica-aggiornamento-2026-10
```
✅ `created …`, `genesis signed by key KEY_ID`, poi un token `sigillo_…`.
Copialo nella riga sotto al posto di `IL_TOKEN`.

```sh
$ curl -sS https://sigillo.tuaazienda.it/api/v1/receipts \
    -H "Authorization: Bearer IL_TOKEN" -H "Content-Type: application/json" \
    -d '{"actor":{"agent":"prova-aggiornamento","on_behalf_of":"persona.di.prova.20261001"},"action":{"kind":"decision","name":"prova.aggiornamento"},"outcome":"ok","input":"contenuto di prova 20261001","output":"contenuto di prova 20261001"}'
```
✅ `{"seq":1,"system_id":"verifica-aggiornamento-2026-10",…,"key_id":"KEY_ID"}`.
❌ `503`: il signer non firma (punto 4). `401`: token copiato male.

Controlla che sia una ricevuta v4, con pseudonimo e impronte con sale:

```sh
$ docker compose exec -T server node --input-type=module - <<'EOF'
import Database from "better-sqlite3";
const db = new Database("/var/lib/sigillo/sigillo.db", { readonly: true });
const { canonical } = db.prepare("SELECT canonical FROM receipts WHERE system_id = 'verifica-aggiornamento-2026-10' ORDER BY seq DESC LIMIT 1").get();
const r = JSON.parse(canonical);
console.log({ v: r.v, on_behalf_of: r.actor.on_behalf_of, input_hash_scheme: r.input_hash_scheme, output_hash_scheme: r.output_hash_scheme });
EOF
```
✅ `v: 4`, `on_behalf_of: 'psn_…'`, `input_hash_scheme: 'salted'`,
`output_hash_scheme: 'salted'`. ❌ Altro: Piano di ritorno.

**Privacy, nei byte del file:**

```sh
$ docker compose exec -T server sh -c "cat /var/lib/sigillo/sigillo.db /var/lib/sigillo/sigillo.db-wal | grep -a -c 'contenuto di prova 20261001'"
$ docker compose exec server node dist/cli.js subject erase --identifier persona.di.prova.20261001
$ docker compose exec -T server sh -c "cat /var/lib/sigillo/sigillo.db /var/lib/sigillo/sigillo.db-wal | grep -a -c -i 'persona.di.prova.20261001'"
```
✅ Il primo stampa `0` (il contenuto non c'è). Il secondo `erased psn_…`. Il
terzo `0` (dopo la cancellazione il nome non c'è più). ❌ Numeri diversi da `0`:
annotali e segnalali; non è un motivo per tornare indietro.

---

## 6. Sigillare ed esportare

```sh
$ docker compose exec server node dist/cli.js checkpoint
```
✅ Una riga per sistema con ricevute nuove e
`N new checkpoint(s), N anchored, 0 still waiting`. ❌ `0 anchored, N still
waiting`: FreeTSA non ha risposto; aspetta 5 minuti e ripeti (si riprova da solo).

Per la prova e per **ogni** sistema del punto 0:

```sh
$ docker compose exec server node dist/cli.js export verifica-aggiornamento-2026-10 --out /var/lib/sigillo-backups/dopo-verifica-aggiornamento-2026-10.zip
$ docker compose exec server node dist/cli.js export NOME_SISTEMA --out /var/lib/sigillo-backups/dopo-NOME_SISTEMA.zip
$ docker compose cp server:/var/lib/sigillo-backups/dopo-NOME_SISTEMA.zip ~/dopo-NOME_SISTEMA.zip
```
✅ `the archive verifies` per ognuno. ❌ `does not verify`: Piano di ritorno.

---

## 7. Verifica indipendente

### 7.1 Sul VPS, in un contenitore senza rete che vede solo i fascicoli

```sh
$ mkdir -p ~/verifica && cp ~/prima-*.zip ~/dopo-*.zip ~/verifica/
$ curl -sS -o ~/verifica/freetsa-cacert.pem https://freetsa.org/files/cacert.pem
$ docker run --rm --network none --read-only --tmpfs /tmp --user "$(id -u):$(id -g)" -v ~/verifica:/verifica:ro \
    --entrypoint node sigillo-server /verifier/dist/cli.js /verifica/dopo-NOME_SISTEMA.zip \
    --key-id KEY_ID --tsa-ca /verifica/freetsa-cacert.pem --strict --previous /verifica/prima-NOME_SISTEMA.zip
```
✅ Prima riga `OK  NOME_SISTEMA: …`, poi tra le altre `contains
/verifica/prima-NOME_SISTEMA.zip unchanged, and reaches at least as far` e
`every signature is by a key you said to expect: KEY_ID`; `echo $?` stampa `0`.
❌ `FAILED unanchored … (--strict)` solo per le ultime ricevute: sono arrivate
dopo l'ultimo checkpoint, ripeti il punto 6. ❌ `FAILED previous-export`:
**grave**, il passato è cambiato: Piano di ritorno e chiedi aiuto.
❌ `FAILED key`: il `KEY_ID` scritto non è quello giusto, ricontrollalo.

### 7.2 Sul portatile, fuori dal server (la verifica che conta)

```sh
portatile$ scp utente@sigillo.tuaazienda.it:'~/dopo-*.zip' .
portatile$ cd sigillo && git pull --ff-only && corepack enable && pnpm install && pnpm build
portatile$ curl -sSO https://freetsa.org/files/cacert.pem
portatile$ node packages/verifier/dist/cli.js ../dopo-NOME_SISTEMA.zip --tsa-ca cacert.pem --key-id KEY_ID --strict --previous ../prima-NOME_SISTEMA.zip
```
✅ Come al 7.1. Le marche risultano `verified (https://freetsa.org/tsr)`.

### 7.3 Chiudere la prova

```sh
$ docker compose exec server node dist/cli.js system archive verifica-aggiornamento-2026-10
$ docker compose exec server sh -c 'rm -f /var/lib/sigillo-backups/prima-*.zip /var/lib/sigillo-backups/dopo-*.zip'
```
✅ `archived …`. L'aggiornamento è finito.

Il backup notturno (`crontab`) non cambia. **Da ora in poi**, per gli
aggiornamenti normali si torna a `/srv/sigillo/deploy/update.sh`.

---

## Piano di ritorno (rollback)

Quando: il punto 3 si rifiuta, oppure ai punti 4–7 qualcosa resta rosso,
`DIVERSI` o `FAILED`.

**Cosa si perde.** La versione vecchia **non parte** su un database che contiene
anche una sola ricevuta v4 (si riavvia di continuo con `Invalid discriminator
value`): bisogna rimettere il backup del punto 1. Le ricevute arrivate dopo il
backup vanno perse. Per questo il ritorno va deciso **subito**, prima che gli
agenti scrivano molto.

**R1. Fermare server e signer**

```sh
$ cd /srv/sigillo/deploy && docker compose stop server signer
```
✅ `Stopped`.

**R2. Tornare al codice di prima**

```sh
$ git -C /srv/sigillo checkout "$(cat ~/sigillo-commit-prima.txt)"
$ docker compose build
```
✅ `HEAD is now at …` (avviso `detached HEAD`: normale), poi `Built`.

**R3. Rimettere il database di prima** (salta questo passo se ti sei fermato al
punto 3 con un rifiuto di `init-from-db`: in quel caso nulla è stato scritto)

```sh
$ docker compose run --rm --no-deps -T --entrypoint sh -v ~/sigillo-pre-aggiornamento:/r:ro server \
    -c 'rm -f /var/lib/sigillo/sigillo.db-wal /var/lib/sigillo/sigillo.db-shm && cp /r/sigillo-*.db /var/lib/sigillo/sigillo.db && ls -l /var/lib/sigillo'
```
✅ Elenca solo `sigillo.db`, proprietario `node`, dimensione uguale al backup.
❌ `No such file`: il backup non è in `~/sigillo-pre-aggiornamento`; riportalo
dal portatile con `scp`.

**R4. Mettere da parte la memoria del signer** (necessario: la versione vecchia
non la usa, ma se restasse lì il prossimo aggiornamento troverebbe una memoria
"più avanti" del database, rifiuterebbe `init-from-db` e mostrerebbe i sistemi
in rosso; è stato provato)

```sh
$ docker compose run --rm --no-deps -T --entrypoint sh signer \
    -c 'test -d /var/lib/sigillo-key/state && mv /var/lib/sigillo-key/state /var/lib/sigillo-key/state.rollback-$(date -u +%Y%m%dT%H%M%SZ); ls -l /var/lib/sigillo-key'
```
✅ Elenca `signer.key` e, se c'era, `state.rollback-…`. **`signer.key` deve
esserci**: se manca, fermati e chiedi aiuto (la copia cifrata è sul portatile,
punto 1.2; procedura in `docs/DEPLOY-PRODUZIONE.md`, 6.4).

**R5. Ripartire e controllare**

```sh
$ docker compose up -d && docker compose restart caddy && sleep 45 && docker compose ps
$ docker compose exec server node dist/cli.js system list --all
```
✅ `signer`, `server` `(healthy)`; l'elenco dei sistemi coincide con quello del
punto 0. Verifica un fascicolo come al punto 7.1, con i file `prima-…`
(senza `--previous`).

Per riprovare l'aggiornamento più avanti, si ricomincia da questa pagina,
punto 0.

---

## Se il database viene ripristinato da un backup DOPO l'aggiornamento

Da ora il signer ricorda l'ultima ricevuta firmata di ogni catena. Se si rimette
un backup del database **più vecchio** del signer (per esempio quello della
notte), le catene che nel frattempo hanno avuto ricevute diventano **rosse**, e
il server rifiuta di scrivere su di esse (`503`) finché qualcuno non decide.
Gli altri sistemi continuano a funzionare. `/healthz` resta `ok`: se ne accorge
solo chi guarda la pagina web o il registro amministrativo (`signer.divergence`).

- Se il signer è avanti di **una sola** ricevuta, il server la recupera da solo
  (`signer.recovered` nel registro): nessuna azione.
- Se è avanti di **più** ricevute, quelle ricevute sono perse (il signer ricorda
  solo l'ultima). L'unico modo di ripartire è mettere da parte la memoria del
  signer (come al passo R4) e rifare `init-from-db`: la catena riprende dal
  database, e **riusa le posizioni (`seq`) già firmate**. Chi ha un fascicolo
  esportato nel frattempo vedrà `FAILED previous-export`: è una biforcazione
  vera, e va spiegata. Non farlo senza averlo deciso e scritto.
