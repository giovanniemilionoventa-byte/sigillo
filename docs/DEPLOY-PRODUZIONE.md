# Mettere sigillo in produzione su un server vero

Questa guida porta chi non ha mai visto il progetto dal `git clone` a un
**fascicolo esportato e verificato**, su un server raggiungibile da internet,
con un dominio vero e HTTPS vero. In fondo c'è una **checklist**: ogni comando
con il risultato atteso, da spuntare riga per riga.

> **Stato di questa guida.** È stata scritta il 24 settembre 2026 in un ambiente
> dove Docker non può girare. Ogni comando di sigillo qui dentro (generazione
> della chiave, creazione del sistema, checkpoint con FreeTSA, export,
> verifica, backup, blocco dopo le password sbagliate) è stato eseguito davvero,
> senza Docker, e i risultati attesi sono copiati da quelle esecuzioni. La parte
> Docker è stata controllata solo con `docker compose config`. **La prima
> esecuzione completa su un VPS è il collaudo che manca**: se un passo dà un
> risultato diverso da quello scritto, fermati e annotalo.

Per una prova sul proprio computer, senza dominio, c'è `PROVA-LOCALE.md`.
Questa guida è per il server vero.

---

## Cosa serve

- **Un server** (VPS) con Ubuntu 24.04 LTS, almeno 2 GB di RAM e 20 GB di disco,
  e accesso SSH come utente con `sudo`. La RAM serve soprattutto alla prima
  costruzione delle immagini.
- **Un dominio** (per esempio `sigillo.tuaazienda.it`) di cui puoi modificare il
  DNS.
- **Un indirizzo email** per gli avvisi del certificato HTTPS.
- **Un secondo computer** (il tuo portatile) da cui mandare le azioni di prova e,
  soprattutto, **verificare il fascicolo**. La verifica va fatta fuori dal
  server: è il punto dell'intero sistema.
- Un **gestore di password**, dove salvare la password della pagina web e la
  passphrase del backup della chiave.

In tutta la guida:

- `sigillo.tuaazienda.it` va sostituito con il tuo dominio;
- `ops@tuaazienda.it` va sostituito con il tuo indirizzo email;
- i comandi con `$` davanti si eseguono **sul server**, quelli con `portatile$`
  **sul tuo computer**.

---

## Parte 1 — Preparare il server

### 1.1 Il DNS

Nel pannello del tuo provider DNS crea un record **A** (e, se il server ha un
indirizzo IPv6, un record **AAAA**) da `sigillo.tuaazienda.it` all'indirizzo
del server. Aspetta che si propaghi:

```sh
portatile$ dig +short sigillo.tuaazienda.it
```

Deve rispondere con l'indirizzo IP del server. Se non risponde nulla, aspetta
qualche minuto e riprova: senza questo, al punto 3.4 Caddy non ottiene il
certificato.

### 1.2 Aggiornamenti, firewall, orologio

```sh
$ sudo apt update && sudo apt -y upgrade
$ sudo ufw allow OpenSSH
$ sudo ufw allow 80/tcp
$ sudo ufw allow 443/tcp
$ sudo ufw enable
$ sudo ufw status
```

`ufw status` deve mostrare `Status: active` e le sole regole `OpenSSH`, `80/tcp`
e `443/tcp`. **La porta 8080 non deve essere aperta**: il server di sigillo non
deve essere raggiungibile se non attraverso Caddy.

> **Attenzione:** Docker scrive regole di firewall proprie e le porte che
> *pubblica* restano raggiungibili anche se `ufw` non le elenca. Nel nostro
> `docker-compose.yml` solo Caddy pubblica porte (80 e 443), quindi va bene. Non
> aggiungere `ports:` agli altri servizi.

L'orologio: `ts_received`, i checkpoint e le richieste di marca temporale vengono
tutti da qui.

```sh
$ timedatectl
```

Deve dire `System clock synchronized: yes` e `NTP service: active`. Se no:
`sudo timedatectl set-ntp true`.

### 1.3 Docker

```sh
$ curl -fsSL https://get.docker.com | sudo sh
$ sudo usermod -aG docker $USER
```

Esci da SSH e rientra, poi:

```sh
$ docker version --format '{{.Server.Version}}'
$ docker compose version
```

Il primo deve stampare una versione (26 o più recente), il secondo
`Docker Compose version v2.x` o più recente.

---

## Parte 2 — Scaricare e configurare sigillo

### 2.1 Il codice

```sh
$ sudo mkdir -p /srv && sudo chown $USER /srv
$ git clone https://github.com/giovanniemilionoventa-byte/sigillo.git /srv/sigillo
$ cd /srv/sigillo/deploy
```

### 2.2 Le impostazioni non segrete

```sh
$ cp .env.example .env
$ nano .env
```

Cambia solo queste due righe, lascia le altre come sono:

```
SIGILLO_DOMAIN=sigillo.tuaazienda.it
SIGILLO_TLS_EMAIL=ops@tuaazienda.it
```

Salva con `Ctrl+O`, `Invio`, `Ctrl+X`. **In `.env` non va nessuna password.**

### 2.3 La password della pagina web, come segreto

La password sta in un file a parte, che Docker consegna al server senza
metterla nelle variabili d'ambiente (così non compare in `docker compose config`
né in `docker inspect`).

```sh
$ install -d -m 700 secrets
$ openssl rand -base64 24 | tr -d '\n' > secrets/admin_password
$ chmod 444 secrets/admin_password
$ cat secrets/admin_password; echo
```

L'ultimo comando mostra la password (32 caratteri): **copiala subito nel
gestore di password**. La cartella `secrets` è leggibile solo dal tuo utente; il
file dentro è leggibile dall'utente senza privilegi del container.

Se preferisci sceglierla tu (almeno 12 caratteri, meglio 20):

```sh
$ read -rsp 'Password: ' P && printf '%s' "$P" > secrets/admin_password && unset P && echo
```

### 2.4 Controllare la configurazione

```sh
$ docker compose config --quiet && echo configurazione-ok
$ docker compose config | grep -cF "$(cat secrets/admin_password)"
```

Il primo deve stampare `configurazione-ok`, il secondo `0`: la password non
compare da nessuna parte nella configurazione risolta. Se il primo si lamenta di
`SIGILLO_DOMAIN` o `SIGILLO_TLS_EMAIL`, torna al punto 2.2.

### 2.5 (Consigliato) Fissare anche l'immagine di Caddy per impronta

L'immagine di Node è già fissata per impronta nel `Dockerfile`. Quella di Caddy
è fissata per versione (`caddy:2.11.4-alpine`); per fissarla anche per impronta:

```sh
$ docker compose pull caddy
$ docker image inspect caddy:2.11.4-alpine --format '{{index .RepoDigests 0}}'
```

Stampa qualcosa come `caddy@sha256:…`. In `docker-compose.yml` cambia la riga
`image: caddy:2.11.4-alpine` in `image: caddy:2.11.4-alpine@sha256:…` (con
l'impronta appena letta).

---

## Parte 3 — La chiave e l'avvio

### 3.1 Costruire le immagini

```sh
$ docker compose build
```

La prima volta dura 5–15 minuti. Deve finire senza `ERROR`. Se si ferma durante
`pnpm install` con errori di rete, riprova: è il registro npm che non ha
risposto, non il codice.

### 3.2 Generare la chiave di firma, una volta sola

```sh
$ docker compose run --rm signer keygen --key /var/lib/sigillo-key/signer.key
```

Risultato atteso (i valori cambiano):

```
key written to /var/lib/sigillo-key/signer.key
key_id 4841bb4e0392d8d8
public_key_base64 KT+wwm6XysxT7xJMK/hm6+pD8xR7WxpsmmWFdyEcGec=
```

**Scrivi il `key_id` da qualche parte fuori da questo server.** È l'impronta
pubblica della tua chiave: chi riceverà un fascicolo la confronterà con quella
che gli comunichi tu per un altro canale (un allegato al contratto, una email
firmata, il vostro sito). È ciò che distingue un fascicolo vostro da uno
fabbricato da zero (`SECURITY.md`, "What sigillo cannot detect").

Se lanci di nuovo lo stesso comando, si rifiuta di sovrascrivere la chiave: è
voluto.

### 3.3 Copia di sicurezza della chiave, cifrata, fuori dal server

Se il volume della chiave va perso, le ricevute già firmate restano verificabili
(la chiave pubblica è in ogni fascicolo e nel database), ma **non si potrà più
firmare con la stessa chiave**, e tutti i destinatari dovranno imparare un
`key_id` nuovo. La copia si fa adesso, prima di usarla:

```sh
$ docker compose run --rm --no-deps -T --entrypoint tar signer -C /var/lib/sigillo-key -cf - signer.key \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -out ~/sigillo-chiave-$(date +%F).tar.enc
```

`openssl` chiede una passphrase due volte: sceglila lunga e **salvala nel gestore
di password**, separata dal file. Controlla che la copia si apra:

```sh
$ openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in ~/sigillo-chiave-*.tar.enc | tar -tvf -
```

Deve elencare `signer.key` con permessi `-rw-------`. Poi porta il file fuori dal
server e cancellalo da lì:

```sh
portatile$ scp utente@sigillo.tuaazienda.it:'~/sigillo-chiave-*.tar.enc' .
$ rm ~/sigillo-chiave-*.tar.enc
```

Chi può accedere a quella copia e alla passphrase è una decisione tua: scrivila.

### 3.4 Avviare

```sh
$ docker compose up -d
$ docker compose ps
```

Dopo 30–60 secondi `docker compose ps` deve mostrare `signer` e `server` come
`Up … (healthy)` e `caddy` come `Up`. Se `server` resta `(health: starting)` o
diventa `(unhealthy)`: `docker compose logs server`.

Controlla che Caddy abbia ottenuto il certificato:

```sh
$ docker compose logs caddy | grep -i "certificate obtained successfully"
```

Deve trovare una riga con il tuo dominio. Se trovi invece errori con `acme` o
`challenge`, il DNS (1.1) non punta ancora qui, oppure le porte 80/443 sono
chiuse dal provider.

### 3.5 Controlli dall'esterno

```sh
portatile$ curl -sS https://sigillo.tuaazienda.it/healthz; echo
portatile$ curl -sSI https://sigillo.tuaazienda.it/ui/login | grep -iE 'strict-transport|x-frame|x-content-type|referrer-policy|cache-control'
portatile$ curl -sS -m 5 http://sigillo.tuaazienda.it:8080/healthz; echo "uscita $?"
```

1. `{"status":"ok"}`.
2. Cinque righe: `strict-transport-security`, `x-frame-options: DENY`,
   `x-content-type-options: nosniff`, `referrer-policy: no-referrer`,
   `cache-control: no-store`.
3. Un errore di connessione e `uscita 7` o `uscita 28`: la porta 8080 non è
   raggiungibile. Se invece risponde `{"status":"ok"}`, il server è esposto
   direttamente: fermati e controlla di non aver aggiunto `ports:` al servizio
   `server`.

E dal server, che la separazione tra i container sia quella voluta:

```sh
$ docker compose exec server sh -c 'ls /var/lib/sigillo-key 2>&1'
$ docker compose exec signer sh -c 'ls -l /var/lib/sigillo-key/signer.key'
$ docker compose exec server sh -c 'touch /prova 2>&1'
```

1. `ls: cannot access '/var/lib/sigillo-key': No such file or directory`: il
   server non vede la chiave.
2. `-rw------- 1 node node … signer.key`.
3. `touch: cannot touch '/prova': Read-only file system`.

---

## Parte 4 — Il primo sistema e le prime ricevute

### 4.1 Un sistema e la sua chiave d'accesso

```sh
$ docker compose exec server node dist/cli.js system create acme-support-bot
$ docker compose exec server node dist/cli.js key create acme-support-bot
```

Risultato atteso:

```
created acme-support-bot
genesis signed by key 4841bb4e0392d8d8
```

e poi

```
key_id 9aa3e04224199b7f
sigillo_9aa3e04224199b7f_…(64 caratteri)
this token is not recoverable: store it now
```

Il `key_id` della prima riga (`genesis signed by key …`) deve essere quello del
punto 3.2. **Il token `sigillo_…` si vede solo ora**: copialo nel gestore di
password. (Lo stesso si può fare dalla pagina web, sotto "sistemi".)

### 4.2 Un agente di esempio, dal tuo computer

Sul portatile servono `git` e Python 3.11 o più recente.

```sh
portatile$ git clone https://github.com/giovanniemilionoventa-byte/sigillo.git && cd sigillo
portatile$ python3 -m venv .venv && . .venv/bin/activate
portatile$ pip install -e sdk-python -r sdk-python/examples/requirements.txt
portatile$ SIGILLO_ENDPOINT=https://sigillo.tuaazienda.it \
           SIGILLO_API_KEY='sigillo_…il token del punto 4.1…' \
           SIGILLO_SYSTEM_ID=acme-support-bot \
           python sdk-python/examples/langgraph_agent.py
```

Risultato atteso:

```
recording acme-support-bot to https://sigillo.tuaazienda.it/v1/traces
instrumentations: langchain
agent said: Your order A-1099 has shipped with DHL.
receipts sent
```

L'agente usa un modello finto: non chiama nessun servizio a pagamento.

### 4.3 La pagina web

Apri `https://sigillo.tuaazienda.it/ui` nel browser. Chiede la password (quella
del punto 2.3). Dentro:

- sotto "È tutto a posto?", `acme-support-bot` con il semaforo **giallo** e la
  scritta che la marca temporale è in attesa (normale: il primo sigillo arriva
  entro un'ora, o al punto 5.1);
- sotto "Cosa ha fatto l'AI?", le azioni dell'agente, in frasi.

Prova il limite ai tentativi, dal portatile (blocca **il tuo** indirizzo per 5
minuti: fallo quando non ti serve la pagina):

```sh
portatile$ for i in 1 2 3 4 5; do curl -s -o /dev/null -w '%{http_code} ' -d password=sbagliata https://sigillo.tuaazienda.it/ui/login; done; echo
portatile$ curl -s -o /dev/null -w '%{http_code}\n' --data-urlencode "password=LA_PASSWORD_VERA" https://sigillo.tuaazienda.it/ui/login
```

1. `401 401 401 401 401`.
2. `401` anche con la password giusta: l'indirizzo è bloccato, e la risposta è
   identica a quella di una password sbagliata.

Dopo 5 minuti lo stesso secondo comando deve rispondere `302` (accesso
riuscito).

---

## Parte 5 — Il fascicolo

### 5.1 Sigillare subito

Il server sigilla ogni registro da solo ogni 60 minuti. Per non aspettare:

```sh
$ docker compose exec server node dist/cli.js checkpoint
```

Risultato atteso (numeri e radice cambiano):

```
acme-support-bot	tree_size 8	root 0906f02c64f91522078febd0463b51c1d663cf5469b3eead08683dfa67f69a03
1 new checkpoint(s), 1 anchored, 0 still waiting
```

`1 anchored` vuol dire che FreeTSA ha rilasciato la marca temporale. Se dice
`0 anchored, 1 still waiting`, FreeTSA non ha risposto: il checkpoint è salvato
comunque e la marca verrà ritentata al giro successivo. Ricarica la pagina web:
il semaforo diventa **verde**. (Lo stesso fa il pulsante "Sigilla adesso".)

### 5.2 Esportare

```sh
$ docker compose exec server node dist/cli.js export acme-support-bot --out /var/lib/sigillo-backups/fascicolo.zip
$ docker compose cp server:/var/lib/sigillo-backups/fascicolo.zip ./fascicolo.zip
$ docker compose exec server rm /var/lib/sigillo-backups/fascicolo.zip
```

Il primo deve finire con `the archive verifies`. Il file si scrive nel volume dei
backup perché il resto del container è in sola lettura, e `docker compose cp`
non legge la sua cartella temporanea. (Dalla pagina web, "Genera fascicolo" fa
lo stesso e scarica il file nel browser.)

Porta il fascicolo sul portatile:

```sh
portatile$ scp utente@sigillo.tuaazienda.it:/srv/sigillo/deploy/fascicolo.zip .
```

### 5.3 Verificarlo, fuori dal server

Sul portatile servono Node.js 22 e pnpm (`corepack enable`). Nella cartella
`sigillo` clonata al punto 4.2:

```sh
portatile$ corepack enable && pnpm install && pnpm build
portatile$ curl -sSO https://freetsa.org/files/cacert.pem
portatile$ node packages/verifier/dist/cli.js fascicolo.zip --tsa-ca cacert.pem --key-id IL_KEY_ID_DEL_PUNTO_3_2
```

Risultato atteso:

```
OK  acme-support-bot: 8 receipts, seq 0..7, signed by 4841bb4e0392d8d8
    1 checkpoint(s), 1 root(s) rebuilt, 2 inclusion proof(s) verified
    timestamp timestamps/checkpoint-8-1.tsr: verified (https://freetsa.org/tsr), attested time 2026-…
    every signature is by a key you said to expect: 4841bb4e0392d8d8

verified:
  - …
```

e uscita `0` (`echo $?`). `verified` accanto al token vuol dire che la firma
dell'autorità è stata controllata con il suo certificato; l'`attested time` è
l'ora certificata da FreeTSA, la prova del "quando". Se manca l'opzione
`--tsa-ca` il token risulta `imprint-only`: la marca riguarda proprio questo
registro, ma la sua firma non è stata controllata.

### 5.4 La prova che conta: una modifica viene scoperta

```sh
portatile$ mkdir prova && cd prova && unzip -q ../fascicolo.zip
portatile$ sed -i.bak '3s/"ok"/"error"/' receipts.jsonl && rm receipts.jsonl.bak
portatile$ zip -q -r ../fascicolo-alterato.zip . && cd ..
portatile$ node packages/verifier/dist/cli.js fascicolo-alterato.zip; echo "uscita $?"
```

Risultato atteso: `FAILED  chain-link at receipts.jsonl:4`, una riga che spiega
quale ricevuta non collega più alla precedente, e `uscita 1`.

---

## Parte 6 — Tenerlo in piedi

### 6.1 Backup del database, ogni notte, e fuori dal server

```sh
$ crontab -e
```

Aggiungi la riga:

```
0 3 * * * cd /srv/sigillo/deploy && docker compose exec -T server /app/backup.sh >> /srv/sigillo-backup.log 2>&1
```

Provalo subito a mano:

```sh
$ cd /srv/sigillo/deploy && docker compose exec -T server /app/backup.sh
```

Deve stampare `wrote … bytes to /var/lib/sigillo-backups/sigillo-….db` e
`backups in /var/lib/sigillo-backups: 1`. Ne tiene 14, i più recenti.

**Quel volume è sullo stesso disco del database.** Un backup vero sta altrove.
Il modo più semplice è prendere ogni giorno l'ultima copia dal portatile, o da
un altro server:

```sh
portatile$ ssh utente@sigillo.tuaazienda.it \
  'cd /srv/sigillo/deploy && f=$(docker compose exec -T server sh -c "ls -1t /var/lib/sigillo-backups/sigillo-*.db | head -1") && docker cp "$(docker compose ps -q server):$f" -' > sigillo-backup.tar
portatile$ tar -tvf sigillo-backup.tar
```

L'ultimo comando deve elencare un file `sigillo-….db`.

### 6.2 Provare un ripristino, una volta

Un backup mai provato non è un backup. Sul portatile, nella cartella `sigillo`:

```sh
portatile$ tar -xf sigillo-backup.tar
portatile$ node apps/server/dist/cli.js system list --db sigillo-*.db
```

Deve elencare `acme-support-bot` con lo stesso numero di ricevute che mostra la
pagina web a quell'ora.

### 6.3 Aggiornare

```sh
$ cd /srv/sigillo && git pull
$ cd deploy && docker compose build && docker compose up -d
$ docker compose restart caddy
$ docker compose ps
```

`restart caddy` serve ogni volta che l'aggiornamento cambia il `Caddyfile`, e nel
dubbio non fa danni: `up -d` non tocca Caddy, e il Caddy già avviato continua a
leggere il `Caddyfile` di prima (il file è montato da solo, e `git pull` lo
sostituisce con uno nuovo). Nel `Caddyfile` c'è l'impronta dello script della
pagina "verifica un documento": se Caddy non viene riavviato dopo un
aggiornamento che cambia quello script, la pagina mostra in rosso "Il calcolo
dell'impronta non è attivo" e il pulsante Verifica resta disattivato. Per
controllare che Caddy mandi l'impronta del `Caddyfile` attuale:

```sh
$ grep -o "script-src '[^']*'" Caddyfile
$ curl -sI https://sigillo.tuaazienda.it/ui/login | grep -io "script-src '[^']*'"
```

Le due righe devono essere uguali.

Il database e la chiave stanno nei volumi e non vengono toccati. **Non rigenerare
mai la chiave** durante un aggiornamento. Non usare mai `docker compose down -v`:
`-v` cancella i volumi, e con loro la chiave e il database.

### 6.4 Se il signer si riavvia, o la chiave cambia

Se il container `signer` si riavvia, il server si ricollega da solo alla
richiesta successiva, e intanto `/healthz` risponde `503`. Se il signer torna con
una chiave **diversa** (volume perso e chiave rigenerata), il server rifiuta di
firmare finché non lo riavvii tu (`docker compose restart server`): è voluto,
perché cambiare chiave è una decisione. Dopo il riavvio, i fascicoli pubblicano
entrambe le chiavi, la vecchia e la nuova, e le ricevute vecchie restano
verificabili. A chi riceve i fascicoli va comunicato il nuovo `key_id`.

Per ripristinare invece la chiave vecchia dal backup del punto 3.3:

```sh
$ docker compose stop signer server
portatile$ scp sigillo-chiave-AAAA-MM-GG.tar.enc utente@sigillo.tuaazienda.it:
$ openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in ~/sigillo-chiave-*.tar.enc \
    | docker compose run --rm --no-deps -i -T --entrypoint tar signer -C /var/lib/sigillo-key -xf -
$ rm ~/sigillo-chiave-*.tar.enc
$ docker compose up -d
```

(Il volume deve essere vuoto: se contiene già una chiave nuova, va tolta prima;
chiedi aiuto prima di farlo.)

### 6.5 La marca temporale qualificata

FreeTSA **non è un'autorità qualificata eIDAS**. Per un pilot può bastare se è
accettato per iscritto. Quando ci sarà un fornitore qualificato: `TSA_URL` e
`TSA_USERNAME` in `.env`, la password in `secrets/tsa_password`, e le due righe
`tsa_password` in `docker-compose.yml` da decommentare. Poi
`docker compose up -d`, e il suo certificato va usato con `--tsa-ca` nella
verifica.

---

## Se qualcosa va storto

| Sintomo | Causa probabile | Cosa fare |
|---|---|---|
| `required variable SIGILLO_TLS_EMAIL is missing a value` | `.env` incompleto | punto 2.2 |
| `secret file … admin_password not found` o simile | manca il file della password | punto 2.3 |
| `server` resta `unhealthy` | non raggiunge il signer | `docker compose logs signer server`; il signer deve dire `listening on /run/sigillo/signer.sock` |
| `server` esce subito con un nome di variabile nel log | un'impostazione numerica non valida in `.env` | correggi quella variabile: il messaggio dice quale |
| Il browser dice che il certificato non è valido | Caddy non ha ancora il certificato | punto 3.4, `docker compose logs caddy` |
| La password non viene accettata | sbagliata, oppure 5 tentativi falliti negli ultimi 15 minuti | aspetta 5 minuti e usa quella salvata al punto 2.3 |
| `0 anchored` al checkpoint | FreeTSA non risponde | niente: si riprova da solo; controlla dopo un'ora |
| La verifica dice `imprint-only` | manca `--tsa-ca` | punto 5.3 |
| La verifica dice `FAILED  key` con `--key-id` | il fascicolo è firmato con un'altra chiave | confronta il `key_id` con quello del punto 3.2; se non coincide, il fascicolo non è vostro, o la chiave è cambiata (6.4) |
| `docker compose build` fallisce durante `pnpm install` | rete verso il registro npm | riprova |

---

## Checklist finale

Da eseguire in ordine. Ogni riga ha il comando e cosa deve succedere. Se una riga
non dà il risultato atteso, fermati lì.

| # | Dove | Comando | Risultato atteso |
|---|---|---|---|
| 1 | portatile | `dig +short sigillo.tuaazienda.it` | l'IP del server |
| 2 | server | `sudo ufw status` | `active`; solo OpenSSH, 80/tcp, 443/tcp |
| 3 | server | `timedatectl` | `System clock synchronized: yes` |
| 4 | server | `docker compose version` | `v2.x` o più recente |
| 5 | server | `git clone … /srv/sigillo && cd /srv/sigillo/deploy` | nessun errore |
| 6 | server | `cp .env.example .env` e modifica di `SIGILLO_DOMAIN`, `SIGILLO_TLS_EMAIL` | — |
| 7 | server | `install -d -m 700 secrets && openssl rand -base64 24 \| tr -d '\n' > secrets/admin_password && chmod 444 secrets/admin_password` | nessun output; password salvata nel gestore |
| 8 | server | `docker compose config --quiet && echo configurazione-ok` | `configurazione-ok` |
| 9 | server | `docker compose config \| grep -cF "$(cat secrets/admin_password)"` | `0` |
| 10 | server | `docker compose build` | termina senza `ERROR` |
| 11 | server | `docker compose run --rm signer keygen --key /var/lib/sigillo-key/signer.key` | `key written to …`, `key_id <16 hex>`, `public_key_base64 …`; key_id scritto fuori dal server |
| 12 | server | copia cifrata della chiave (3.3), poi `openssl enc -d … \| tar -tvf -` | elenca `signer.key` `-rw-------`; file portato fuori e cancellato dal server |
| 13 | server | `docker compose up -d && sleep 60 && docker compose ps` | signer e server `(healthy)`, caddy `Up` |
| 14 | server | `docker compose logs caddy \| grep -i "certificate obtained successfully"` | almeno una riga con il dominio |
| 15 | portatile | `curl -sS https://sigillo.tuaazienda.it/healthz` | `{"status":"ok"}` |
| 16 | portatile | `curl -sSI https://sigillo.tuaazienda.it/ui/login \| grep -iE 'strict-transport\|x-frame\|x-content-type\|referrer-policy\|cache-control'` | cinque righe |
| 17 | portatile | `curl -sS -m 5 http://sigillo.tuaazienda.it:8080/healthz; echo $?` | errore di connessione, `7` o `28` |
| 18 | server | `docker compose exec server sh -c 'ls /var/lib/sigillo-key 2>&1'` | `No such file or directory` |
| 19 | server | `docker compose exec server sh -c 'touch /prova 2>&1'` | `Read-only file system` |
| 20 | server | `docker compose exec server node dist/cli.js system create acme-support-bot` | `created acme-support-bot`, `genesis signed by key <il key_id della riga 11>` |
| 21 | server | `docker compose exec server node dist/cli.js key create acme-support-bot` | `key_id …` e `sigillo_…`; token salvato |
| 22 | portatile | agente di esempio (4.2) | `instrumentations: langchain`, `agent said: …`, `receipts sent` |
| 23 | browser | `https://sigillo.tuaazienda.it/ui`, login | il sistema con semaforo giallo, e le azioni dell'agente |
| 24 | portatile | 5 password sbagliate con `curl`, poi quella giusta (4.3) | `401` ×5, poi `401`; dopo 5 minuti `302` |
| 25 | server | `docker compose exec server node dist/cli.js checkpoint` | `1 new checkpoint(s), 1 anchored, 0 still waiting` |
| 26 | browser | ricarica la pagina | semaforo verde |
| 27 | server | export nel volume dei backup e `docker compose cp` (5.2) | `the archive verifies`; `fascicolo.zip` sul server, poi sul portatile |
| 28 | portatile | `node packages/verifier/dist/cli.js fascicolo.zip --tsa-ca cacert.pem --key-id <key_id>` | `OK …`, token `verified … attested time …`, `every signature is by a key you said to expect`; uscita 0 |
| 29 | portatile | fascicolo alterato (5.4) | `FAILED  chain-link at receipts.jsonl:4`, uscita 1 |
| 30 | server | `docker compose exec -T server /app/backup.sh` | `wrote … bytes`, `backups in …: 1` |
| 31 | server | `crontab -l` | la riga delle 03:00 |
| 32 | portatile | copia dell'ultimo backup (6.1) e `tar -tvf sigillo-backup.tar` | un file `sigillo-….db` |
| 33 | portatile | `node apps/server/dist/cli.js system list --db sigillo-*.db` | `acme-support-bot	N receipts` |

Quando tutte le righe sono spuntate, sigillo è in produzione. Restano le scelte
della checklist "Before going to production" di `SECURITY.md`: chi custodisce la
copia della chiave, a chi e come comunicare il `key_id`, e se FreeTSA è
accettata per il pilot.
