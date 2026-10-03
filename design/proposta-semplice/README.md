# Design proposal "semplice" — reference mockups

Static mockups of every screen of the web view in a simpler form, made on
2026-10-03 at the project owner's request: a centred two-step sign-in
(Google or email, then password) with no side panel and no operator
password on the page, and no grey explanatory subtitles anywhere. The
explanations move to the full guide; technical values (hashes, signatures,
keys) stay one click away under "Dettagli tecnici".

These are **reference mockups, not code to ship**. `mockups.mjs` writes one
static HTML file per screen; the PNGs in `screenshots/` were rendered from
them with Chromium at 1280 px (desktop) and 390 px (phone). The data is the
fixture of `scripts/screenshots.ts`, slightly simplified.

Ideas in the proposal beyond removing the subtitles:

- the operator sign-in moves off the customer sign-in page to its own address;
- four figures at the top of the main page (actions today, blocked, failed, last seal);
- a coloured dot per system in the sidebar instead of the warning triangle;
- after creating a system: the key with a copy button, three choices
  (SDK Python, OpenTelemetry, API HTTP) showing only the chosen snippet, and a
  line that turns green when the first receipt arrives;
- a first-run checklist for a new customer;
- times in Italian form ("Oggi, 14:44");
- "Sigilli" as the tab name instead of "Checkpoint";
- a settings page (account, organization and monthly quota, administrative
  log, signing key), so those leave the other pages;
- a "new key" action in a system's settings.

Nothing here is decided until the project owner approves it.
