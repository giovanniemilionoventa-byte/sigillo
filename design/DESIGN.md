# DESIGN.md — direction "B" (three panes, macOS-like)

This file and `design/tokens.json` are the source of truth for how the
operator's web view looks. The implementation lives in
`apps/server/src/http/style.ts` (CSS, the seal and the icons) and in the
markup of `apps/server/src/http/ui.ts`, `layout.ts`, `history.ts` and
`pages.ts`. When the two disagree, this file wins and the code is the bug.

Scope: appearance and navigation only. Nothing here changes what a page does,
which routes exist, what is stored, or what goes into an evidence file. Every
form keeps its `action`, `method` and field names.

The reference mockups are in `design/proposta-b/mockups/` (read
`design/proposta-b/README.md` first: they are canvas templates, not code).
Direction "B" replaces direction "Registro" (paper and ink, session 13).

Since session 24 the screens follow the "semplice" proposal
(`design/proposta-semplice/`, one HTML mockup per screen): the same tokens
and the same three panes, with no grey subtitle or helper sentence under
titles, four figures on the main page, a coloured light per system in the
sidebar, times said as people say them ("Oggi, 14:44"), and every technical
value (fingerprints, signature, ISO times) behind "Dettagli tecnici". Where
that proposal and a section below disagree, the proposal wins.

## Identity

A clear, quiet desktop application, the kind a client already knows how to
use: a sidebar to move, a list in the middle, the detail of the selected item
on the right. White ground, grey sidebar, one blue for actions.

- **Mark**: the seal — two concentric circles and a solid diamond, inline
  SVG, drawn in `brand` (the only place that colour is used).
- **Under the name**: "registro probatorio per agenti AI".

## Colour

Every value below is a CSS custom property in `style.ts`, light and dark.
The theme follows the operating system (`prefers-color-scheme`) unless the
reader picks one in Impostazioni → Aspetto: the choice is a cookie, and the
server writes it on `<html>` as `data-theme="light"` or `"dark"` (the CSP
allows no script to do it). The dark values apply under the media query
unless `data-theme="light"`, and always under `data-theme="dark"`.

| token | role | light | dark |
|---|---|---|---|
| `bg` | window and list background | `#FFFFFF` | `#1C1C1E` |
| `canvas` | page area behind cards, the inspector | `#FAFAFC` | `#161618` |
| `sidebar` | sidebar | `#F0F0F3` | `#232325` |
| `surface` | cards, sheets, inputs | `#FFFFFF` | `#242426` |
| `fill` | quiet boxes inside a card (notes, a selected person receipt) | `#F5F5F7` | `#2C2C2E` |
| `current` | the current sidebar item | `#E2E2E7` | `#343436` |
| `segment` | the track of a segmented control | `#EEEEF0` | `#2C2C2E` |
| `segment-on` | the current segment | `#FFFFFF` | `#3A3A3C` |
| `hover` | a sidebar item or a row under the pointer | `#E5E5EA` | `#38383A` |
| `scrim` | behind an open sheet | `rgba(0,0,0,.28)` | `rgba(0,0,0,.55)` |
| `text` | text | `#1D1D1F` | `#F5F5F7` |
| `secondary` | secondary text, counts, captions | `#636366` | `#A1A1A6` |
| `label` | form labels, body copy in notes | `#3A3A3C` | `#D1D1D6` |
| `separator` | lines between rows and sections | `#E5E5EA` | `#38383A` |
| `separator-soft` | lines inside a card | `#F0F0F3` | `#2C2C2E` |
| `sidebar-rule` | the sidebar's own border | `#DCDCE1` | `#38383A` |
| `control` | borders of inputs and secondary buttons | `#8A8A8E` | `#7C7C80` |
| `action` | primary buttons, the current tab's underline | `#0071E3` | `#0A6BD6` |
| `on-action` | text on `action`, `selection`, `danger` | `#FFFFFF` | `#FFFFFF` |
| `link` | links | `#0066CC` | `#4DA3FF` |
| `selection` | the selected row of a list | `#0A63D1` | `#0A5FC4` |
| `focus` | focus ring | `#0071E3` | `#4DA3FF` |
| `brand` | the seal | `#8E2A24` | `#E0857C` |
| `ok` / `ok-fill` | green state, word and badge | `#1B6E30` / `#E3F3E7` | `#5FD17F` / `#1D3524` |
| `warn` / `warn-fill` | yellow state | `#8A5A00` / `#FBF0D9` | `#F0B84A` / `#3A2E12` |
| `bad` / `bad-fill` | red state | `#B3261E` / `#FBE4E2` | `#FF8A80` / `#44221F` |
| `code` / `on-code` | the snippets of the connect page | `#1D1D1F` / `#E5E5EA` | `#0E0E10` / `#E5E5EA` |
| `danger` | destructive button | `#B3261E` | `#B3261E` |
| `kind-tool` / fill | icon of a tool call | `#0066CC` / `#E5F0FC` | `#6CB2FF` / `#1B3149` |
| `kind-model` / fill | icon of a model call | `#0B6B6B` / `#E2F4F4` | `#4FD1C7` / `#11393A` |
| `kind-step` / fill | icon of an agent step | `#4A4A8C` / `#ECECF6` | `#B4B4F5` / `#2A2A48` |
| `kind-decision` / fill | icon of a decision | `#6E3FC9` / `#EFE9FB` | `#C9A8FF` / `#33264D` |
| `kind-genesis` / fill | icon of the register's opening | `#48484A` / `#EDEDF0` | `#D1D1D6` / `#3A3A3C` |

The dark palette follows macOS's dark appearance: near-black window, a
slightly lighter sidebar and cards, the same hues for states and kinds,
lightened until they read.

### Contrast check (WCAG 2.2 AA)

Computed with the WCAG relative-luminance formula. Requirement: 4.5:1 for
text, 3:1 for the borders of controls, the focus ring and icons that carry
meaning (1.4.11). "min" is the lowest ratio over every background the token is
used on.

| foreground | backgrounds | light min | dark min | requirement | result |
|---|---|---|---|---|---|
| `text` | bg, canvas, sidebar, surface, fill, current, segment, segment-on, hover | 13.04 | 10.42 | 4.5 | pass |
| `secondary` | bg, canvas, sidebar, surface, fill, current, segment, hover | 4.64 | 4.55 | 4.5 | pass after correction |
| `label` | bg, canvas, surface, fill | 10.42 | 9.16 | 4.5 | pass |
| `link` | bg, canvas, sidebar, surface, fill | 4.89 | 5.31 | 4.5 | pass |
| `ok` | bg, canvas, sidebar, surface, `ok-fill` | 5.49 | 6.88 | 4.5 | pass |
| `warn` | bg, canvas, sidebar, surface, `warn-fill` | 5.21 | 7.38 | 4.5 | pass |
| `bad` | bg, canvas, sidebar, surface, `bad-fill` | 5.38 | 6.16 | 4.5 | pass |
| `on-action` | `action` | 4.70 | 5.14 | 4.5 | pass |
| `on-action` | `selection` | 5.65 | 6.09 | 4.5 | pass |
| `on-action` | `danger` | 6.54 | 6.54 | 4.5 | pass |
| `control` | bg, canvas, sidebar, surface, fill | 3.02 | 3.35 | 3.0 | pass after correction |
| `focus` | bg, canvas, sidebar, surface | 4.13 | 5.90 | 3.0 | pass |
| `brand` | bg, canvas, sidebar | 7.37 | 5.84 | 3.0 (graphic) | pass |
| `kind-*` | its own fill | 4.82 | 5.97 | 3.0 (graphic) | pass |

**Corrections made to the mockups' values**

1. **`secondary`**: the mockups use `#6E6E73`, which gives 4.46:1 on the
   sidebar, 4.38:1 on a segmented control's track and 3.93:1 on the current
   sidebar item — all under 4.5 for text that is 11–12 px. Corrected to
   `#636366` (Apple's own darker secondary grey), lowest ratio 4.64:1.
2. **`current`**: the mockups darken the current sidebar item with
   `rgba(0,0,0,.08)`, about `#DCDCE0`, on which no secondary grey above
   `#5E5E62` reaches 4.5:1. Lightened to `#E2E2E7`; the current item is also
   set in 600 weight, so it is not told by its background alone. Dark:
   `#343436`.
3. **`control`**: the mockups draw inputs with a `#C7C7CC` border and
   secondary buttons with `#D2D2D7`, 1.6:1 and 1.5:1 on white. A field's
   border is what shows where the field is, so 1.4.11 asks for 3:1.
   Corrected to `#8A8A8E` (3.02:1 on the sidebar, 3.44:1 on white) for every
   input, select, textarea and secondary button.
4. **`segment-on` in dark**: `#3A3A3C`, on which `secondary` gives 4.41:1;
   the count inside the current segment is therefore set in `text`
   (10.42:1), never in `secondary`.
5. **`action` in dark**: macOS's dark blue `#0A84FF` gives 3.65:1 under white
   text. Darkened to `#0A6BD6` for buttons; links use the lighter `#4DA3FF`.

## Typography

System fonts only, as the mockups ask: nothing is downloaded.

| role | family |
|---|---|
| interface | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif` |
| fingerprints, identifiers, keys | `ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` |

Scale (desktop): page title 26 px 700; system title 19 px 700; section
heading 15 px 700; sheet title 17 px 700; inspector sentence 16 px 600;
row title 14 px 600; body 13 px; captions and labels 12 px (labels 600 in
`label`); sidebar section heads and counts 11 px 600. Numbers are tabular.
On a phone the body goes to 15 px and inputs to 16 px (so iOS does not zoom).

The fonts of direction "Registro" (Newsreader, Public Sans, IBM Plex Mono)
are no longer named by the stylesheet. `fonts.ts` still serves them and the
files stay in `apps/server/assets/fonts`: removing them is a separate
decision.

## Shape

- Unit 2 px; spacings from the mockups (4, 6, 8, 10, 12, 14, 16, 18, 20, 22,
  24, 28, 32).
- Radius: 7–9 px for controls, 10 px for rows, 12 px for cards, 14 px for a
  sheet; badges are pills.
- Shadows: a card is `0 0 0 1px rgba(0,0,0,.07), 0 1px 2px rgba(0,0,0,.04)`
  (in dark, a 1 px `separator` ring); a sheet over the page
  `0 24px 60px rgba(0,0,0,.3)`. Nothing else casts a shadow.
- Controls are 34 px high on a desktop (WCAG 2.5.8 asks 24 px) and at least
  44 px on a phone. Focus: 2 px `focus` ring with a 2 px gap, always visible
  on keyboard focus.

## Layout

- **Shell**: a 248 px sidebar and the content. The sidebar stays in place
  while the page scrolls.
- **Sidebar**: the mark with name and subtitle; "Registro"; the section
  "Sistemi" with a "+" that goes to the creation form; each system shown on
  the main page (active, or archived but still shown there — the same rule),
  with its chain state icon and its number of receipts; "Archiviati" with
  their count; "Tutti i sistemi"; the section "Strumenti" with "Verifica
  documento" and "Persone"; at the bottom the signing key and "Esci" (a POST
  form, as before). The state of each system is the chain health monitor's,
  the same as the main page's traffic lights.
- **A system** (history, checkpoints, manage): a header with the name, the
  identifier, the number of receipts, the chain state from the monitor (icon
  plus "Registro integro" / "Da controllare" / "Verifica fallita", and the
  monitor's full sentence when it is not green) and "Genera fascicolo"; under
  it the tabs "Cronologia / Checkpoint / Gestisci", links to the existing
  routes.
- **History**: list and inspector side by side (inspector 360 px). Each column
  scrolls on its own, so selecting a row (a link with `?ricevuta=<seq>` and a
  `#r-<seq>` fragment) keeps the list where it was.
- **Everything else**: content on `canvas`, 28 px / 32 px padding, cards.

### Phone and narrow windows (under 900 px)

No mockup; decided here.

- The sidebar becomes a top bar with the mark and a "Menu" link. The menu is
  the sidebar itself, opened with `:target` (`#menu`) as a full-screen panel
  with a "Chiudi" link: no script.
- History: the list is the page. Selecting a row opens the receipt as its own
  page — the same URL with `?ricevuta=`, where the list is hidden and a link
  "Torna all'elenco" goes back to the list at that row. Without `?ricevuta=`
  the inspector is not shown on a phone.
- Two-column pages (main page, verify, people) stack. Tables become cards.
- Every target at least 44 px. No horizontal scroll of the page: long
  fingerprints wrap.

## Components

- **State**: always an icon of its own shape, a word, and a colour — colour
  is never the only signal.
  - circle with a check — `ok` (verde, completato, ancorata)
  - triangle with an exclamation mark — `warn` (giallo, bloccato, esito
    sconosciuto, in attesa)
  - octagon with a cross — `bad` (rosso, fallito)
  - circle with a dash — archived (`secondary`)
  In the sidebar the word is read by screen readers and the shape carries it
  on screen (there is no room for a word beside each name).
- **Outcome badge**: a pill in the state's fill, with icon and word. Rows show
  it only when the outcome is not "completato"; the inspector always shows it.
- **Kind icon**: a rounded square in the kind's fill — a wrench (tool), a chip
  (model), a forward arrow in a circle (step), a fork (decision), an open book
  (opening of the register).
- **Segmented control**: links on a `segment` track; the current one is a
  white (dark: `current`) pill with a shadow and 600 weight, and carries
  `aria-current`. Each segment has its count.
- **Row** (history): time, kind icon, a short title ("Ha usato «x»") and a
  line under it (agent, model, on whose behalf, files), the outcome badge
  when not ok, and "n. <seq>". The selected row is `selection` with white
  text.
- **Inspector**: "Ricevuta n. X" and the outcome badge; the kind icon; the
  full sentence (`describeReceipt`); groups "Chi e quando", "File", "Catena"
  as cards of label/value rows; a `<details>` "Mostra firma, chiave e
  impronte complete".
- **Sheet** ("Genera fascicolo"): opened with `:target` (`#fascicolo`) over
  the page; period, optional disclosures, "Annulla" and "Genera fascicolo".
  The same form as before (`POST /ui/systems/:id/export`), which now also
  reads the period it shows.
- **Buttons**: primary `action` with white text; secondary `surface` with a
  `control` border; destructive `danger` with white text.

## Tone

Plain Italian, full sentences, no jargon in the main text (technical detail
goes in the collapsible details). No exclamation marks, no emoji. Never
promise anonymity or legal value. Existing strings are reused word for word;
where the layout capitalises a lowercase string (a navigation entry, a state
word), CSS does it.

## Never

Gradients, frosted glass, decorative shadows beyond the two above, emoji,
colour as the only signal, a new script.
