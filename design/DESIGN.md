# DESIGN.md — the "Registro" direction

This file and `design/tokens.json` are the source of truth for how the
operator's web view looks. The implementation lives in
`apps/server/src/http/style.ts` (CSS and the seal) and
`apps/server/src/http/ui.ts` (markup). When the two disagree, this file wins
and the code is the bug.

Scope: appearance only. Nothing here changes what a page does, which routes
exist, what is stored, or what goes into an evidence file.

## Identity

A register, not an AI startup: sober, precise, the look of a document.

- **Mark**: the seal — two concentric circles and a solid diamond at the
  centre, inline SVG, drawn in `accent`.
- **Under the name**: "registro probatorio per agenti AI" (see "Open points").

## Colour

| token | role | light | dark |
|---|---|---|---|
| `ground` | page background | `#F6F1E7` | `#1A1815` |
| `surface` | panels, technical details | `#FFFDF8` | `#221F1B` |
| `ink` | text | `#1C1917` | `#EFE9DC` |
| `muted` | secondary text | `#5C554B` | `#B0A899` |
| `faint` | large register numerals only | `#8B8272` | `#7F786B` |
| `rule` | lines | `#D9D0BF` | `#3A362F` |
| `rule-strong` | borders of controls | `#948871` | `#7A7264` |
| `accent` | mark, active nav item, links, focus ring | `#8E2A24` | `#D9756D` |
| `ok` | green state | `#1F6B4A` | `#7CCB9F` |
| `warn` | yellow state | `#8A5A00` | `#E3B04B` |
| `bad` | red state | `#A3261F` | `#FF8A80` |

The theme follows the operating system (`prefers-color-scheme`), as the view
already did before this direction: there is no in-page switch, and adding one
would be a change of behaviour.

### Contrast check (WCAG 2.2 AA)

Ratios computed with the WCAG relative-luminance formula, against `ground` /
`surface`.

| token | light | dark | used as | requirement | result |
|---|---|---|---|---|---|
| `ink` | 15.54 / 17.20 | 14.64 / 13.56 | body text | 4.5 | pass |
| `muted` | 6.53 / 7.23 | 7.51 / 6.96 | secondary text | 4.5 | pass |
| `accent` | 7.44 / 8.24 | 5.67 / 5.25 | links, active item | 4.5 | pass |
| `ok` | 5.72 / 6.34 | 9.20 / 8.52 | state word | 4.5 | pass |
| `warn` | 5.27 / 5.83 | 8.92 / 8.27 | state word | 4.5 | pass |
| `bad` | 6.54 / 7.24 | 7.76 / 7.19 | state word | 4.5 | pass |
| `surface` on `ink` | 17.20 | 13.56 | primary button label | 4.5 | pass |
| `faint` | 3.37 / 3.73 | 4.05 / 3.75 | numerals ≥ 24 px | 3.0 (large text) | pass |
| `rule-strong` | 3.10 / 3.43 | 3.73 / 3.45 | control borders | 3.0 (non-text, 1.4.11) | pass after correction |
| `accent` focus ring | 7.44 | 5.67 | focus indicator | 3.0 | pass |

**Corrections made**

1. `rule-strong` was specified as `#BDB29C` (light) and `#514B42` (dark). As
   the border of form fields it is what shows where a field is, so WCAG
   1.4.11 asks for 3:1; the specified values give 1.86 and 2.05. Corrected to
   `#948871` (light) and `#7A7264` (dark), the lightest/darkest values in the
   same hue that pass on both `ground` and `surface`. `rule` stays as
   specified: it only separates, it never identifies a control.
2. `faint` had a light value only (`#8B8272`). Dark value derived as
   `#7F786B`, which stays quieter than `muted` and passes 3:1 as large text.
   `faint` is never used below 24 px.

## Typography

| role | family | weight |
|---|---|---|
| headings, receipt sentences, large numerals | Newsreader, fallback Georgia | 600 for headings |
| interface | Public Sans | 400 / 500 / 600 |
| hashes, IDs, keys, times, uppercase labels | IBM Plex Mono | 400 / 500 |

Scale: page title 44–48 px (46 px at 1280), h2 28 px, row title 24 px, body
15–16 px, lead 18 px, mono labels 12 px uppercase with 0.14em tracking.
Numbers are always tabular (`font-variant-numeric: tabular-nums`).

Fonts are embedded in the repository as woff2 (SIL Open Font License, taken
from the `@fontsource` packages, latin subset), with `font-display: swap`,
and served by the application itself. No request to Google Fonts or any
other domain. The content security policy gains exactly `font-src 'self'`.
Each font's licence text ships next to the files.

## Shape

- Unit 4 px; every spacing is a multiple.
- Page gutters 80 px at 1280 wide, content column 1120 px; 16 px gutters on
  a phone.
- Radius 2 px. No shadows. Lines 1 px; under table headings 1 px in `ink`.
- Buttons: 48 px (primary: solid `ink`, label in `surface`), 44 px
  (secondary and filters: 1 px `rule-strong` border). Every target at least
  44 px.
- Focus: 2 px `accent` ring with a 2 px gap.

## Components

- **Header**, 72 px: mark, name and subtitle on the left, navigation on the
  right; the current item has a 2 px `accent` underline.
- **State** (traffic light): always icon + word + colour, and the icons
  differ in shape, so colour is never the only signal.
  - circle with a check — `ok`
  - triangle with an exclamation mark — `warn`
  - octagon with a cross — `bad`
  - circle with a dash — archived (`muted`)
- **Register row** (overview): large numeral in Newsreader, `faint`;
  question in Newsreader 24 px 600 with a 15 px `muted` detail line; state on
  the right with a 12 px mono line under it.
- **History**: columns N. | Ora | Azione (Newsreader 18) | Esito |
  Ancoraggio ("Ancorata" `muted`, "In attesa" `warn` 600) | Impronta (mono
  13). Each row opens (`<details>`, no script) to the technical details —
  fingerprint, previous receipt, signature, key — in a `surface` panel with a
  `rule` border, mono 13.
- **Systems**: table Sistema (name in Newsreader 22 + connection type) |
  Stato | Ricevute (mono) | Ultima ricevuta | Gestisci; below it, "Collegare
  un agente" in three columns, each under a 1 px `ink` rule.
- **Filters**: 44 px buttons, the current one solid `ink`.

## Overview layout

Mono uppercase label; a large Newsreader title that states the situation in
one sentence; a subtitle; the three register rows with the questions and
texts already in the interface; the two actions; at the bottom a mono line
with the `key_id` and the number of receipts.

## Tone

Plain Italian, full sentences, no jargon in the main text (technical detail
goes in the collapsible details). No exclamation marks, no emoji. Never
promise anonymity or legal value.

## Never

Gradients, frosted glass, decorative shadows, cards with a coloured left
border, emoji, heavily rounded corners.

## Implementation notes

- **Outcome icons** in the history: `ok` uses the check circle, `error` the
  octagon, `blocked` and `unknown` the triangle. The words are the existing
  outcome words ("completato", "fallito", "bloccato", "esito sconosciuto").
- **Anchoring** ("Ancorata" / "In attesa"): a receipt is anchored when a
  checkpoint that has at least one timestamp token covers it
  (`tree_size > seq`).
- **Connection type** on the systems page comes from the `source.type` of
  the system's latest non-genesis receipt.
- `faint` is only used for the overview numerals (44 px).

## Text choices

Settled in the first implementation; each is one line in
`apps/server/src/http/strings.ts` to change.

- **Subtitle**: "registro probatorio per agenti AI", as the brief asks. It
  replaces "registro delle azioni AI". "Probatorio" describes what the
  register holds (evidence), not a claim of legal value; revisit if it reads
  otherwise.
- **Existing texts kept**: the buttons stay "Genera fascicolo" and "Sigilla
  adesso", the state words stay "verde / giallo / rosso" (shown capitalised
  by CSS). The brief's "Esporta il fascicolo", "Verifica adesso" and
  "Integra / Da controllare / Non riuscita" were not applied, because the
  brief also says not to change existing texts.
- **New texts**, only where the new layout needs them: the overview's summary
  sentence and subtitle, the history and systems column heads, "Ancorata" /
  "In attesa", "attivo", and the connection type.
