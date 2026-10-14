# DESIGN-V2.md — «Il filo e il sigillo»

The look and the structure of the redesigned console (`SIGILLO_CONSOLE_V2`,
`off|operator|all`, default `operator`, CLAUDE.md rule 11). The proposal and its
mockups were presented on 2026-10-14; this file records what is built.
Implementation: `apps/server/src/http/style-v2.ts`, `pages-v2.ts`,
`console-mode.ts`, the V2 branches of `layout.ts` and `history.ts`.
Colours: `design/tokens-v2.json` (checked against the stylesheet by a test).

## Structure

Three places, each a question; the title is the question and the first line is
the answer, in the text colour.

| place | route | question |
|---|---|---|
| Stato | `/ui` | È tutto a posto? |
| Azioni | `/ui/actions` | Cosa ha fatto l'AI? |
| Prove | `/ui/evidence` | Mi prepari le prove? |

Below a line: the systems, one list, with the shape of their state. A system has
the tabs Azioni · Collega · Gestisci. The operator also has Amministrazione
(today the customers page). The account opens from the avatar.

The new routes answer 404 to anyone the switch leaves out.

## Rules

- State is the shape of an icon, a word and a colour; the colour is for state only.
- An action's outcome is a sign and a word in ink, never the colours of the record.
- «Nuovo» (grey dash) for a register with no action yet; the record's integrity
  and the agent's signal are separate columns.
- Codes and fingerprints in mono, groups of four.
- No grey helper sentence under a title (session 24). One primary action per page,
  top right.
- Fascicolo dates (Dal/Al) are Italian calendar days, as the history's.

## Not yet built (proposal, owner to decide)

Esecuzione (`SIGILLO_RUNS`), extra keys, «Consegnati», Italian report.pdf,
the pack reader on /verify, the new site, Amministrazione › Servizio, the
dedicated Collega/Gestisci layouts, the phone layouts beyond the shared
responsive rules.
