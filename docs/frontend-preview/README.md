# Istantanee HTML delle pagine principali

Questi cinque file sono **istantanee**: l'HTML vero, byte per byte, che il
server ha restituito in un dato momento per ciascuna pagina, con dati di
esempio realistici (un sistema `acme-support-bot` e uno `selezione-cv`, come
la demo di selezione CV). Ogni file è completo e autosufficiente: tutto il
CSS è inline (nessun foglio esterno, coerente con la CSP dell'app), non ci
sono immagini o font esterni — solo un sigillo disegnato in SVG, anch'esso
inline. Si aprono **direttamente in un browser**, senza server acceso, con
un doppio clic o `file://…/00-login.html`.

Servono per **sperimentare visivamente**: colori, spaziatura, tipografia.
Modificarli qui non cambia l'app vera, e non verranno mai riletti da
nessuno strumento del progetto: non sono serviti dall'applicazione, non
sono usati da nessun test, e una rigenerazione (vedi sotto) li sovrascrive
senza preavviso.

## File

| file | pagina |
|---|---|
| `00-login.html` | accesso (senza sessione) |
| `01-registro.html` | pagina principale, "le tre domande" |
| `02-sistemi.html` | elenco dei sistemi |
| `03-gestisci-selezione-cv.html` | "gestisci" per il sistema `selezione-cv` |
| `04-cronologia-selezione-cv.html` | cronologia di `selezione-cv`, con ricevute |

## Per rendere permanente una modifica

Una modifica fatta qui dentro resta solo qui dentro. Lo stile reale di
**ogni** pagina dell'interfaccia è generato da un unico modulo, da quando è
stato centralizzato nella sessione 8 (`PROGRESS.md`):

```
apps/server/src/http/style.ts
```

Quel file esporta la costante `STYLE`, il CSS che ogni pagina inserisce
inline in un `<style>` (vedi `apps/server/src/http/ui.ts`, funzione `page()`).
Per rendere permanente una modifica provata qui, riportala a mano in
`style.ts`, poi rigenera queste istantanee (comando sotto) per controllare il
risultato con dati veri, e infine avvia il server vero (o `pnpm test`, che
copre anche l'interfaccia) per confermare che nulla si sia rotto.

Il testo delle pagine (le frasi in italiano) vive invece in
`apps/server/src/http/strings.ts`, non in questi file né in `style.ts`.

## Come sono stati generati

```sh
pnpm tsx scripts/frontend-snapshots.ts [cartella]
```

Lo script (`scripts/frontend-snapshots.ts`) avvia il server vero in locale,
con un firmatario Ed25519 vero e un'autorità di marcatura temporale RFC 3161
locale (fatta con `openssl`, senza rete), lo popola con dati di esempio
rappresentativi, poi scarica via HTTP l'HTML di ciascuna pagina — senza
browser: il CSS è già tutto inline, quindi basta la risposta HTTP grezza —
e la salva qui. Senza argomenti scrive in questa stessa cartella
(`docs/frontend-preview/`); un argomento sceglie un'altra destinazione.
Dev-only: non fa parte dell'app in esecuzione, non è eseguito da nessun test.
