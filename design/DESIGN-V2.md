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

## Switches (all `off|operator|all`, default `operator`, rule 11)

| switch | what it turns on |
|---|---|
| `SIGILLO_CONSOLE_V2` | the redesigned console: Stato, Azioni, Prove, new shell and look |
| `SIGILLO_RUNS` | an agent's run (its trace) as a group in Azioni, as a list of its own, and its own pack |
| `SIGILLO_EXTRA_KEYS` | add a key without retiring the others; retire one, never the last |
| `SIGILLO_EXPORT_REGISTER` | «Consegnati»: the packs handed out, with the zip's SHA-256 (never the file) |
| `SIGILLO_REPORT_LANGUAGE` | an Italian cover in report.pdf and an Italian preamble in VERIFY.md |
| `SIGILLO_PACK_READER` | `/ui/verify`: check a pack in the browser, key code, actions in words, a document |
| `SIGILLO_SITE_V2` | the new public home: `/ui/admin/site` for the operator, `/` with `all` |

Amministrazione › Servizio (`/ui/admin/service`) and Account (`/ui/account`)
have no switch: the first is the operator's by nature, the second belongs to
the console itself.

## Known limits

- The pack reader shows the sealing time the server declared, not the time the
  timestamp authority attests (reading the RFC 3161 token in the browser is not
  built); it says so and points to the full verification.
- The document check in the reader compares the document's bytes with the
  fingerprints the pack records; the «same text» grades need the command line.
- One run's pack is the contiguous window from its first to its last action; the
  preview says how many actions of other runs fall inside it.
- Collega and Gestisci are the pages of before, inside the new tabs, with the new
  keys card; the phone layout is the shared responsive rules.
- The new site's legal facts (company, VAT, address, server country) are
  bracketed placeholders until the owner gives them.
