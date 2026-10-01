# Design direction "B" (three-pane, macOS-like) — reference mockups

These files are **reference mockups**, not code to ship. They were made on a
design canvas and use its component format (`<x-dc>`, `<sc-for>`, `<sc-if>`,
`{{holes}}`, a `./support.js` loader that does not exist here). Read them for
layout, hierarchy, spacing, colours, copy and states. Re-implement the result
in `apps/server/src/http/ui.ts`, `style.ts` and `strings.ts` as server-rendered
HTML; do not copy the template syntax.

The data in them comes from the fixture in `scripts/screenshots.ts`. A few
values the designer could not see are placeholders: `[firma della ricevuta]`,
`[impronta]`, `psn_[…]`, and hashes cut to 12 characters. The real pages show
real values.

## Screen → route map

| mockup | route | notes |
|---|---|---|
| `B-Accesso.dc.html` | `GET /ui/login` | split layout: identity panel left, form right |
| `B-Accesso-errore.dc.html` | `POST /ui/login` (wrong password) | existing `UI.login.wrong` text |
| `B-Registro.dc.html` | `GET /ui` | the three questions: health + latest actions left, evidence form right |
| `B-Studio.dc.html` | `GET /ui/systems/:id` | sidebar + list + inspector of the selected receipt |
| `B-Strumenti.dc.html` | `GET /ui/systems/:id?kind=tool_call` | filter state; selected receipt with outcome "bloccato" |
| `B-Modelli.dc.html` | `GET /ui/systems/:id?kind=llm_call` | model receipt (name, local provider) |
| `B-SelezioneCV.dc.html` | `GET /ui/systems/selezione-cv` | receipt with an input artifact |
| `B-Apertura.dc.html` | `GET /ui/systems/:id?kind=genesis` | genesis receipt, anchoring still pending |
| `B-Fascicolo.dc.html` | export form of `/ui/systems/:id` | sheet over the history page; same fields as today |
| `B-Checkpoint.dc.html` | `GET /ui/systems/:id/checkpoints` | tab "Checkpoint" of the system |
| `B-Gestisci.dc.html` | `GET /ui/systems/:id/manage` | tab "Gestisci" of the system |
| `B-Sistemi.dc.html` | `GET /ui/sistemi` | views attivi / archiviati / tutti as a segmented control |
| `B-Verifica.dc.html` | `GET /ui/verify-document` | input left, result right |
| `B-Persone.dc.html` | `GET /ui/persone` | search, result, erase |

The five history mockups are one interactive prototype in the canvas: in the
real app the same states are reached with links and query parameters, without
JavaScript (see the CSP in `deploy/Caddyfile`).
