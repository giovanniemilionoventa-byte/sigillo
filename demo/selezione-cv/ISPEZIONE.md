# Ispezione simulata: "il candidato n. 7 sostiene di essere stato scartato ingiustamente"

Questa guida è per chi non ha mai visto sigillo: un responsabile compliance,
un DPO, o la persona che deve rispondere a un ispettore. Non serve sapere
programmare, non serve la riga di comando oltre ai comandi indicati qui sotto,
copiabili così come sono.

## La storia

L'azienda ha usato un agente AI (`selezione-cv`) per una prima scrematura di
20 candidature per una posizione di sviluppatore backend junior. Il
candidato n. 7, **Andrea Bianchi**, non è stato invitato al colloquio e
scrive: *"Ritengo di essere stato scartato ingiustamente. Chiedo di sapere
esattamente cosa ha valutato l'intelligenza artificiale sul mio conto."*

Il responsabile compliance deve rispondere con i fatti, non con una
rassicurazione generica: cosa ha fatto l'AI, su quali basi, e con quali prove
che quei fatti non sono stati alterati dopo l'accaduto.

## Prima di cominciare

Se la demo non è già in esecuzione:

- **Mac/Linux**: `./demo/selezione-cv/run_demo.sh`
- **Windows** (richiede Docker Desktop): `demo\selezione-cv\run_demo.ps1`

Lo script stampa l'indirizzo dell'interfaccia (di solito
`http://127.0.0.1:8099/ui`) e la password amministratore. Apri quell'indirizzo
nel browser e accedi con quella password.

## Passo 1 — Il quadro generale

Nella pagina principale, sotto **"È tutto a posto?"**, controlla il semaforo
del sistema `selezione-cv` (se chi gestisce sigillo gli ha dato un nome
leggibile, vedi quel nome, con `selezione-cv` scritto piccolo sotto: è
l'identificativo, ed è quello che conta in ricevute e fascicoli): deve essere
**verde**. Se fosse rosso o giallo,
sarebbe il primo problema da segnalare prima di proseguire — un registro
manomesso o senza controlli recenti non è una base su cui rispondere a
un ispettore.

## Passo 2 — Restringere la cronologia al periodo giusto

Clicca sul sistema `selezione-cv` per aprirne la cronologia. Se sai
approssimativamente quando la selezione è avvenuta (dal tuo sistema HR, che è
separato da sigillo), inserisci quell'intervallo nei campi **"dal (ricevuto)"**
/ **"al"** e cerca. Vedrai le frasi in linguaggio naturale di ogni azione
registrata quel giorno: strumenti usati, passi dell'agente, decisioni.

Nota bene: sigillo **non registra il nome del candidato** da nessuna parte —
solo l'impronta dei documenti coinvolti (si veda `SECURITY.md` del progetto).
Restringere per data aiuta a orientarsi, ma la prova che collega una ricevuta
esattamente al candidato n. 7 è il passo successivo.

## Passo 3 — Verificare il curriculum del candidato n. 7

Procurati la copia del curriculum che il candidato ha inviato (in questa
demo: `demo/selezione-cv/curricula/candidato-07.txt`).

Apri **"verifica documento"** nel menu in alto e carica il file (oppure
incollane il testo nella casella). Il documento non lascia il tuo computer:
il browser ne calcola le impronte e manda a sigillo solo quelle.

Il risultato atteso è una conferma di questa forma:

> ✓ Questo documento è esattamente quello usato da selezione-cv il [data e
> ora], come «curriculum», nell'azione leggi_curriculum (input). Non è stato
> modificato.

Le conferme possibili sono di tre tipi, e la pagina dice sempre quale:

- **"esattamente quello usato"**: i byte coincidono uno per uno;
- **"ha lo stesso testo di quello usato"**: il testo coincide parola per
  parola, ma la copia differisce per spazi, a capo o caratteri invisibili
  (per esempio un testo incollato, o riformattato da un programma di posta).
  Vale per i documenti di testo registrati da questa versione di sigillo in
  poi; una lettera, una cifra o una virgola diversa non corrisponde mai;
- **"è quello usato ..., a meno del modo di andare a capo"**: vale per i
  documenti registrati prima di questa versione, e copre soltanto la
  differenza tra gli a capo di Windows (CRLF) e quelli di Mac e Linux (LF),
  l'a capo finale e il segno BOM iniziale.

Se la pagina risponde "Nessuna azione registrata ha usato questo documento",
confronta l'impronta esatta mostrata con quella del file
(`Get-FileHash candidato-07.txt -Algorithm SHA256` su Windows, `sha256sum
candidato-07.txt` su Linux).

**Lo stesso controllo, senza server** — con il verificatore offline, sul
fascicolo esportato (lo stesso che userai al Passo 6):

1. Genera il fascicolo di `selezione-cv` per l'intervallo del passo 2 (dalla
   pagina principale, sotto **"Mi prepari le prove?"**).
2. Da terminale, una volta sola: `corepack enable && pnpm install && pnpm build`.
3. Poi, per ogni documento da controllare:

```bash
node packages/verifier/dist/cli.js doc /percorso/del/fascicolo.zip demo/selezione-cv/curricula/candidato-07.txt
```

che stampa la stessa conferma, in inglese ("This document is exactly the one
used by selezione-cv ...", oppure "has the same text as the one used ...").

Questa è la prova che il file che il candidato dice di aver inviato è
**esattamente** quello che l'agente ha letto — non una versione simile, non
un file con lo stesso nome ma contenuto diverso.

### Se avevi fatto girare la demo prima del 26 settembre 2026: gli a capo dei curricula

Fino a quella data il repository non diceva a git come andare a capo nei
curricula della demo, e git per Windows li scriveva con gli a capo CRLF,
mentre su Mac e Linux li scriveva con gli a capo LF. Da allora una regola
(`demo/selezione-cv/curricula/.gitattributes`) li fissa ad **LF su ogni
sistema operativo**. Il testo dei curricula non è cambiato, gli a capo sì,
e quindi anche i byte e l'impronta. Per `candidato-07.txt`:

| la tua copia | dimensione | impronta SHA-256 |
|---|---|---|
| scritta da git su Windows **prima** della regola (a capo CRLF) | 406 byte | `ecfe08f13aba545b439aa4cbd6e09edddeec73ccd1dc024060793da0d9214347` |
| scritta da git **dopo** la regola, su qualunque sistema; oppure su Mac o Linux da sempre (a capo LF) | 392 byte | `d819ede88a6701f43f96b03c186db6c59ab8946a997f59cfa79cfeadcdbb204b` |

**Le ricevute già scritte non cambiano, ed è giusto così.** Ogni ricevuta
scritta da un'esecuzione precedente dell'agente, nel database della demo o in
un sistema di prova in produzione, contiene l'impronta del file **come l'agente
lo ha letto quella volta**. Su Windows, prima della regola, era la versione
CRLF da 406 byte. Una ricevuta non deve cambiare quando il file cambia
altrove: è proprio la garanzia che sigillo offre. Nessuno deve correggerle,
e non vanno toccate.

La conseguenza pratica: se verifichi un file scritto **dopo** la regola
contro una ricevuta scritta **prima**, i byte non coincidono (l'impronta
esatta mostrata è `d819ede8…`), ma la pagina lo trova lo stesso e lo dice:
"è quello usato ..., a meno del modo di andare a capo". **Non si è rotto
niente**: il testo è lo stesso, i byte no, e la pagina dice esattamente in che
cosa differiscono.

Cosa succede alla tua copia su Windows:

- **Un `git pull` non la cambia.** Git non riscrive un file il cui contenuto nel
  repository non è cambiato: la tua copia resta CRLF, 406 byte, e continua a
  corrispondere alle ricevute scritte prima.
- **Diventa LF** solo con un clone nuovo, oppure se la cancelli e la fai
  riscrivere a git. Se vuoi conservare la versione CRLF, che serve a verificare
  le ricevute vecchie, copiala prima in un'altra cartella:

  ```powershell
  Copy-Item demo\selezione-cv\curricula -Destination $HOME\curricula-crlf -Recurse
  Remove-Item demo\selezione-cv\curricula\candidato-*.txt
  git checkout -- demo/selezione-cv/curricula
  ```

  Dopo questi comandi, se fai girare di nuovo l'agente, le ricevute nuove
  conterranno le impronte LF, e i file del checkout corrisponderanno a quelle.

**Come sapere quale versione hai.** In PowerShell, dalla cartella del
repository (il comando conta i byte uno per uno, non modifica il file):

```powershell
$f = "demo\selezione-cv\curricula\candidato-07.txt"
$b = [System.IO.File]::ReadAllBytes((Resolve-Path $f))
$crlf = 0; $lf = 0; $cr = 0
for ($i = 0; $i -lt $b.Length; $i++) {
    if ($b[$i] -eq 13 -and $i + 1 -lt $b.Length -and $b[$i + 1] -eq 10) { $crlf++; $i++ }
    elseif ($b[$i] -eq 13) { $cr++ }
    elseif ($b[$i] -eq 10) { $lf++ }
}
"$($b.Length) byte, CRLF: $crlf, LF isolati: $lf, CR isolati: $cr"
(Get-FileHash -Algorithm SHA256 $f).Hash.ToLower()
```

Risposte possibili: `406 byte, CRLF: 14, LF isolati: 0` con `ecfe08f1…` (prima
della regola), oppure `392 byte, CRLF: 0, LF isolati: 14` con `d819ede8…` (dopo).
Qualunque altra risposta vuol dire che il file è stato modificato da qualcosa
che non è git, per esempio salvato di nuovo da un editor: non corrisponde a
nessuna delle due versioni.

## Passo 4 — Vedere le azioni intorno a quel momento

Torna alla cronologia e cerca, vicino all'orario appena confermato, la
sequenza di tre azioni che l'agente esegue per ogni candidato: lo strumento
`leggi_curriculum`, il passo `valuta_candidato`, lo strumento `invia_email`.
Apri **"Dettagli tecnici"** su ciascuna se vuoi vedere i campi tecnici (hash,
firma, chiave) che il verificatore controlla.

Quello che **non** troverai — di proposito — è il punteggio o la motivazione
scritti in chiaro nel registro: quei contenuti non vengono mai salvati (si
veda la regola 2 di `CLAUDE.md` e `docs/SECURITY.md`). Quello che il
registro prova è che l'azione è avvenuta, con quell'esito, su quel documento,
in quel momento, e che nessuno l'ha alterata da allora — non serve altro per
rispondere a questa richiesta.

## Passo 5 — Verificare la mail di risposta ricevuta

Chiedi al candidato la mail di risposta che ha ricevuto (in questa demo: il
file scritto da `invia_email` sotto `demo/selezione-cv/outbox/`). Controllala
allo stesso modo del Passo 3: caricala in **"verifica documento"**, oppure
incollane il testo — una mail inoltrata o copiata da un programma di posta
cambia spesso gli a capo, e per un testo registrato da questa versione di
sigillo la pagina lo trova comunque ("ha lo stesso testo"). Offline, con lo
stesso fascicolo già generato:

```bash
node packages/verifier/dist/cli.js doc /percorso/del/fascicolo.zip <percorso della mail>
```

La conferma attesa questa volta nomina l'azione `invia_email`, con l'etichetta
`"email di risposta"` (output). Questo prova che la mail che il candidato ha
in mano è esattamente quella che l'agente ha prodotto, non una falsificazione
né una versione alterata.

## Passo 6 — Generare e verificare il fascicolo del giorno

Dalla pagina principale, sotto **"Mi prepari le prove?"**, scegli il sistema
`selezione-cv` e lo stesso intervallo di date del passo 2, poi **"Genera
fascicolo"**. Scarica lo `.zip`.

Da terminale, con il verificatore open source (incluso in sigillo, non serve
altro):

```bash
node packages/verifier/dist/cli.js /percorso/del/fascicolo.zip
```

Deve rispondere `OK` con il conteggio delle ricevute e nessun errore. Questo
verificatore non si fida del server sigillo: ricalcola ogni firma, ogni hash
della catena, ogni radice Merkle da zero.

## Passo 7 — La prova che il documento non può essere sostituito dopo il fatto

Questo è il passo che convince un ispettore scettico. Copia il curriculum del
candidato n. 7 e cambia **un solo carattere** (per esempio una lettera nel
nome):

```bash
cp demo/selezione-cv/curricula/candidato-07.txt /tmp/manomesso.txt
# apri /tmp/manomesso.txt in un editor di testo e cambia un carattere qualsiasi
```

Poi cerca quel file nel fascicolo, invece che nel sistema in esecuzione:

```bash
node packages/verifier/dist/cli.js doc /percorso/del/fascicolo.zip /tmp/manomesso.txt
```

Il risultato è **"Nessuna azione registrata ha usato questo documento"**
(codice di uscita 1) — non un'approssimazione, un rifiuto netto. Rilancia lo
stesso comando con il file originale, non modificato: quello viene trovato.
La differenza tra i due risultati, per un solo carattere, è la dimostrazione
che l'impronta è specifica byte per byte e non si può far quadrare con un
documento diverso a posteriori.

## Cosa dire all'ispettore (o al candidato)

A questo punto hai, con prove verificabili indipendentemente e non dal
fornitore del software:

1. La sequenza esatta di azioni che l'agente ha compiuto su quella
   candidatura, con data e ora.
2. La certezza che il curriculum che il candidato ha inviato è quello
   valutato, non uno diverso.
3. La certezza che la mail ricevuta dal candidato è quella prodotta
   dall'agente, non un'altra comunicazione.
4. Un fascicolo che chiunque — anche un consulente esterno, anche il
   candidato stesso — può verificare da sé, senza fidarsi della parola
   dell'azienda.

Quello che questa procedura **non** fa da sola è dimostrare che la regola di
punteggio è equa: quella è una proprietà del codice (`agent.py`,
`evaluate_cv_text`), leggibile da chiunque, non un fatto registrato per ogni
singola candidatura — si veda `README.md`, "Neutral scoring", per la regola
per esteso e perché nel caso del candidato n. 7 il punteggio è zero su basi
del tutto estranee a età, genere, provenienza o aspetto.
