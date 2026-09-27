# "Verifica un documento", riprogettata — proposta

Data: 2026-09-27. Documento per il committente. **Nessuna modifica al codice**: il lavoro
parte solo dopo la tua conferma esplicita delle decisioni D1–D8 in fondo.

## 1. La causa, verificata nel codice

Le quattro affermazioni del tuo messaggio sono tutte confermate, leggendo il codice di `main`
@ `c2702dc`:

| affermazione | dove | confermata |
|---|---|---|
| `sigillo.artifact()` hasha i byte grezzi | `sdk-python/src/sigillo/__init__.py`: `_artifact_bytes()` restituisce `data.encode("utf-8")` per una `str`, `path.read_bytes()` per un percorso; poi `hashlib.sha256(raw)` | sì |
| `input_hash`/`output_hash` passano per RFC 8785 | `_hash_content_value()` nell'SDK (`sha256(json.dumps(s, ensure_ascii=False))`), `hashCanonicalJson()` in `packages/core/src/canonical.ts`, chiamata da `ingest/adapter.ts` e `http/server.ts` | sì |
| il browser fa SHA-256 dei byte e cerca solo tra gli artifact | `VERIFY_DOCUMENT_SCRIPT` in `apps/server/src/http/ui.ts` (`crypto.subtle.digest("SHA-256", bytes)`), poi `store.findArtifactsBySha256()`, che interroga solo la tabella `artifacts` | sì |
| basta uno spazio o un a-capo per non trovare nulla | `docs/FORMAT.md` §2.5 lo dice esplicitamente ("one extra space or line ending changes the digest") | sì |

Un dettaglio in più, trovato leggendo la demo: `leggi_curriculum` restituisce
`percorso.read_text(encoding="utf-8")`, cioè il testo del CV **con gli a-capo già convertiti in
LF** da Python. La sua impronta finisce in `output_hash`, calcolata come stringa JSON. Il testo
incollato nella pagina (sempre LF) avrebbe quindi trovato quell'`output_hash` — se la pagina
l'avesse mai cercato. Vedi D6.

## 2. La regola di canonicalizzazione: `sigillo-text/1`

Si applica a un documento dato come **byte**, e produce un'impronta oppure **nessuna** impronta.

1. **Decodifica UTF-8 stretta.** Se i byte non sono UTF-8 valido, il documento non ha
   un'impronta testuale: resta solo quella sui byte grezzi. Nessun tentativo con altre codifiche
   (Latin-1, UTF-16): indovinare la codifica è esattamente il tipo di ambiguità da evitare.
2. **Rimozione di quattro caratteri invisibili**: U+00AD (trattino morbido), U+200B (spazio a
   larghezza zero), U+2060 (word joiner), U+FEFF (BOM / spazio indivisibile a larghezza zero).
3. **Normalizzazione Unicode NFC.**
4. **Ogni sequenza di spazi bianchi diventa un solo spazio U+0020.** Gli spazi bianchi sono
   **questa lista, scritta per esteso**: U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680,
   U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 (la proprietà Unicode `White_Space`).
   Quindi: tab, a-capo LF/CR/CRLF, spazio indivisibile, spazi tipografici, separatori di riga e
   paragrafo Unicode.
5. **Taglio** degli spazi all'inizio e alla fine.
6. Se il risultato è vuoto (il documento era solo spazi), **nessuna** impronta testuale.
7. **Impronta**: SHA-256 dei byte UTF-8 del risultato, esadecimale minuscolo. **Non** passa per
   JSON: niente virgolette, niente escape.

### Perché così — i compromessi

- **NFC, non NFKC.** NFC unifica solo le codifiche *equivalenti* dello stesso carattere (`è`
  precomposto e `e` + accento combinante, che capita copiando da PDF o da macOS). NFKC andrebbe
  oltre e trasformerebbe `m²` in `m2`, `½` in `1⁄2`, `ﬁ` in `fi`, le cifre a larghezza piena in
  cifre normali: sono differenze di **contenuto** (10² non è 102), quindi NFKC è escluso.
- **Lo spazio si riduce, non si elimina.** Togliere del tutto gli spazi farebbe coincidere
  `1 2` e `12`, `1 000` e `1000`. Ridurli a uno solo fa coincidere un testo riformattato (a-capo
  in punti diversi, doppio spazio, tab) ma non due testi in cui le parole sono separate in modo
  diverso.
- **Lista esplicita, mai `\s` o `isspace()`.** Python e JavaScript non sono d'accordo su cosa sia
  uno spazio, e l'ho misurato qui: `str.isspace()` di Python considera spazio U+001C–U+001F (e
  JavaScript no); `\s` di JavaScript considera spazio U+FEFF (e Python no). Con le funzioni di
  libreria, SDK e browser produrrebbero impronte diverse sullo stesso testo — proprio il problema
  da cui siamo partiti.
- **Quali invisibili si tolgono, e quali no.** Si tolgono solo i quattro che non cambiano mai né
  l'aspetto né il significato. **Restano** (e quindi continuano a contare come differenze):
  - U+200C/U+200D (ZWNJ/ZWJ): cambiano il significato in persiano e nelle scritture indiane, e
    compongono le emoji (👨‍👩‍👧 non è 👨👩👧);
  - i controlli bidirezionali (U+202A–U+202E, U+2066–U+2069): toglierli farebbe coincidere un
    testo con uno che **si legge diversamente a schermo** (è l'attacco noto come "Trojan
    Source"). Per un auditor questo è l'unico caso in cui "invisibile" non vuol dire "innocuo";
  - i selettori di variante (emoji, ideogrammi).
- **Ordine dei passi.** Gli invisibili si tolgono prima di NFC, perché un invisibile tra una
  lettera e il suo accento impedirebbe la composizione. Dopo NFC, ridurre e tagliare gli spazi
  non può creare nuove composizioni: la regola è **idempotente** (applicarla due volte dà lo
  stesso risultato), e sarà un test.

### Cosa continua a NON corrispondere (voluto)

Maiuscole/minuscole, cifre, lettere, punteggiatura, virgolette tipografiche contro dritte (`“` e
`"`), trattini (`–` e `-`), legature, apici e pedici, **presenza** di uno spazio (`1 000` e
`1000`), una parola spezzata a fine riga (`contrat-⏎to` e `contratto`: il trattino è un
carattere vero).

### Cosa una corrispondenza testuale NON garantisce (andrà scritto in SECURITY.md)

Che l'**impaginazione** sia la stessa. `A 1⏎B 2` e `A⏎1 B⏎2` hanno la stessa impronta testuale.
Per la prosa è ciò che vogliamo; per tabelle, colonne separate da tab, codice sorgente, YAML o
poesia la disposizione è contenuto. Per questo la regola si applica solo a `text/plain` (D2), e
la pagina distingue sempre "identico byte per byte" da "stesso testo" (D3).

### Un limite dichiarato: la versione di Unicode

Python 3.11 qui usa i dati Unicode 14.0, Node 22 la 17.0, e ogni browser la sua. NFC è stabile
per ogni carattere già assegnato in entrambe le versioni (è una garanzia di Unicode). Un testo con
caratteri assegnati dopo Unicode 14 **e** con scomposizione canonica (alcune scritture introdotte
di recente, nessuna europea) potrebbe normalizzarsi diversamente: il risultato sarebbe un
documento **non trovato**, mai uno trovato a torto. Lo scrivo in FORMAT.md e SECURITY.md.

## 3. Lo schema: `v: 3`, con due impronte

**Raccomando di non cambiare il significato di `sha256`**, e di aggiungere accanto l'impronta
testuale, con l'algoritmo dichiarato:

```json
{
  "role": "input",
  "label": "curriculum",
  "media_type": "text/plain",
  "sha256": "…byte esatti, come sempre…",
  "text": { "canon": "sigillo-text/1", "sha256": "…impronta canonica…" }
}
```

- `sha256` ha lo stesso significato in **ogni** versione: byte grezzi. Un auditor non deve mai
  chiedersi di che cosa sia l'impronta che ha davanti.
- `text` è opzionale, presente solo per un documento `text/plain` in UTF-8 valido e non vuoto;
  `canon` ammette un solo valore, `sigillo-text/1`: qualsiasi altro è rifiutato. Una regola
  diversa in futuro sarà `sigillo-text/2` **e** una nuova `v`.
- Per un documento testuale non si perde l'affermazione più forte: la pagina può dire
  "identico byte per byte" quando lo è, e "stesso testo, a meno di spazi e a-capo" quando è solo
  quello.
- `v: 3` = `v: 2` più il membro `text`. Il server scrive una ricevuta `v: 3` **solo quando almeno
  un artifact porta `text`**; altrimenti `v: 1` o `v: 2` come oggi (stessa logica con cui oggi
  sceglie tra 1 e 2). Una ricevuta `v: 2` con `text` è invalida. Le ricevute `v: 1` e `v: 2` già
  scritte restano verificabili senza modifiche, e una catena può mescolare le tre versioni.
- Costo: un secondo SHA-256 per documento testuale nell'SDK, circa 100 byte in più per ricevuta.

L'alternativa (un'unica impronta, il cui significato dipende da un campo che dichiara
l'algoritmo) funziona, ma fa perdere l'impronta esatta dei documenti testuali e dà a `sha256` due
significati: la sconsiglio.

**Il server non può ricalcolare l'impronta testuale** (non vede mai il contenuto: regola 2 di
CLAUDE.md), esattamente come oggi non ricalcola `sha256`: la fiducia nell'SDK è la stessa di oggi.

### Cosa cambia negli altri pezzi

- **SDK Python** (`sigillo.artifact()`): calcola sempre `sha256` sui byte; in più, se il tipo
  effettivo (quello passato, o quello dedotto) è `text/plain` e i byte sono UTF-8 valido, calcola
  `text`. Nuovi attributi dell'evento: `sigillo.artifact.text_canon`,
  `sigillo.artifact.text_sha256`. Un SDK vecchio continua a funzionare: i suoi artifact
  semplicemente non hanno `text`.
- **Ingest**: legge i due attributi; un `text_canon` sconosciuto o un'impronta malformata fanno
  cadere solo `text`, non l'artifact.
- **Database**: due colonne nuove, nulle, in `artifacts` (`text_canon`, `text_sha256`) con un
  indice; migrazione in avanti senza riscrivere nulla. I record di produzione restano come sono.
- **Export**: `artifacts-index.jsonl` riporta anche `text` per le righe `v: 3`; il controllo 8 del
  verificatore lo confronta come confronta già il resto.
- **`sigillo-verify doc`**: calcola entrambe le impronte del file e dice quale ha trovato.

## 4. La nuova pagina "verifica un documento"

Il browser calcola, dal file o dal testo incollato, **tutte** le impronte applicabili, e il
server le cerca:

| impronta calcolata nel browser | cercata in | risultato mostrato |
|---|---|---|
| SHA-256 dei byte grezzi | `artifacts.sha256`, **ogni versione** | "identico byte per byte" |
| `sigillo-text/1` | `artifacts.text_sha256` (solo `v: 3`) | "stesso testo, a meno di spazi, a-capo e caratteri invisibili" |
| varianti di fine riga (D5) | `artifacts.sha256`, per i record vecchi | "stesso documento, a meno della convenzione di fine riga" |
| stringa JSON del testo (D6) | `receipts.input_hash`/`output_hash` | "questo testo è esattamente l'intero ingresso/uscita di un'azione" |

**I record già registrati sul VPS** (byte grezzi, per qualunque tipo) si trovano senza
re-ingestione tramite la prima riga, come oggi. La tolleranza a spazi e a-capo **non può**
estendersi a loro: di quei documenti esiste solo l'impronta dei byte, e da un'impronta non si
risale al testo. La riga D5 recupera il caso concreto che ha fatto fallire le prove (CRLF contro
LF), non di più.

Il documento non lascia mai il browser: viaggiano solo le impronte, come oggi. Cosa si elimina e
si ricostruisce: `verifyDocumentForm`, `verifyDocumentResult`, `VERIFY_DOCUMENT_SCRIPT`,
`store.findArtifactsBySha256`. Il collegamento nel menu torna solo alla fine, a lavoro testato.

## 5. "Scritta una volta sola": come, onestamente

SDK Python e browser sono due linguaggi: lo **stesso file** non può girare in entrambi. Quello
che propongo è il massimo ottenibile, e ogni punto è verificato da un test:

1. **Una definizione normativa**, in `docs/FORMAT.md`, con le liste di caratteri per esteso.
2. **Un'implementazione di riferimento**, in `packages/core/src/text.ts`: una funzione pura
   `canonicalText(string) → string | null`, senza dipendenze, più l'impronta con `node:crypto`.
3. **Il browser esegue quella stessa funzione, non una copia riscritta.** Il server serve allo
   script della pagina il sorgente della funzione che esegue lui stesso
   (`Function.prototype.toString()`), come file `/ui/verify-document.js`. Un test lo esegue in un
   contesto isolato (senza Node) contro tutti i vettori: se la funzione un giorno dipendesse da
   qualcosa fuori di sé, il test fallirebbe. Il browser calcola lo SHA-256 con Web Crypto, come
   oggi. Questo richiede D7.
4. **Python: un port, legato a core da tre vincoli**:
   - un file di vettori condiviso, `packages/core/test/text-vectors.json`, letto sia da vitest sia
     da pytest (tutti i casi difficili: CRLF, NBSP, NFC/NFD, ZWJ, bidi, U+001C, U+FEFF, emoji,
     byte non UTF-8…);
   - un test pytest che esegue **la funzione vera di core in Node** su migliaia di stringhe
     casuali costruite da un alfabeto di caratteri difficili, e confronta le impronte una per una
     — lo stesso schema che `sdk-python/tests/test_init.py` usa già per `hashCanonicalJson`;
   - `scripts/crosscheck_vectors.py` (già in CI) esteso ai nuovi vettori e alle ricevute `v: 3`.

## 6. Test, scritti prima del codice

Quelli che hai chiesto, più le proprietà che li rendono generali:

- due testi identici salvo spaziatura/a-capo (CRLF, tab, NBSP, doppi spazi, spazi agli estremi)
  → stessa impronta canonica, in TS e in Python;
- due testi identici salvo una cifra o una lettera, una maiuscola, un segno di punteggiatura →
  impronte diverse;
- un file binario (PDF vero, PNG vero) → nessuna impronta testuale, `sha256` = hash esatto dei
  byte; un file non UTF-8 idem;
- un artifact registrato con lo schema vecchio (`v: 2`, byte grezzi) → trovato dal nuovo codice,
  in pagina e con `sigillo-verify doc`, e il fascicolo che lo contiene verifica ancora;
- proprietà (fast-check): idempotenza; sostituire uno spazio con qualunque sequenza non vuota di
  spazi bianchi della lista non cambia l'impronta; sostituire un carattere visibile con un
  altro non equivalente la cambia sempre;
- i quattro invisibili tolti, ZWJ e controlli bidi **non** tolti;
- vettori `v: 3` nuovi in `vectors.json`, ricalcolati dal cross-check Python indipendente;
- nel browser vero (Playwright, come oggi): file CRLF contro testo incollato LF, testo copiato
  con spazi diversi, PDF, record vecchio, e un record trovato via `output_hash` (se D6).

## 7. Decisioni da confermare

| # | decisione | la mia raccomandazione |
|---|---|---|
| D1 | La regola `sigillo-text/1` della sezione 2, così com'è | sì |
| D2 | Si applica solo ai documenti `text/plain` (una `str` passata all'SDK lo è per default); CSV, Markdown, HTML, codice restano solo byte | sì: in quei formati spazi e a-capo sono contenuto |
| D3 | Due impronte (`sha256` sempre sui byte, più `text`), non una che cambia significato | sì |
| D4 | `v: 3` scritta solo quando un artifact porta `text`; `v: 1`/`v: 2` invariate | sì |
| D5 | Per i record vecchi, la pagina prova anche poche varianti: CRLF↔LF, a-capo finale sì/no, BOM sì/no (al massimo 18 impronte, calcolate nel browser) | sì: è il caso che ha fatto fallire le prove in produzione, e il risultato lo dichiara |
| D6 | La pagina cerca anche in `input_hash`/`output_hash` l'impronta JSON del testo, **solo esatta** (quei campi sono `v: 1`, definitivi: nessuna tolleranza possibile lì) | sì, con un indice nuovo su `receipts`; trova i casi come `leggi_curriculum` |
| D7 | Lo script della pagina diventa un file servito dal server, e la CSP passa da `script-src 'sha256-…'` a `script-src 'self'` | sì: il server non serve mai JavaScript scritto da altri, e sparisce l'hash da tenere allineato a mano nel Caddyfile (e il riavvio di Caddy a ogni modifica) |
| D8 | `SPEC.md` aggiornato con questa sezione dopo la tua conferma | sì |

Stima dell'effetto sul verificatore (regola 5 di CLAUDE.md): circa 80–120 righe tra
`packages/core/src/text.ts`, lo schema `v: 3` e `sigillo-verify doc`. Se supera le 100, lo annoto
in `PROGRESS.md` con il motivo.
