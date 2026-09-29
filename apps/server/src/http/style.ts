/**
 * The look of the operator's view: the "Registro" direction, paper and ink.
 * design/DESIGN.md and design/tokens.json are the source of truth; the
 * custom properties on :root below are those tokens, one for one, and
 * nothing else in this file names a colour.
 *
 * The theme follows the reader's operating system. The traffic-light
 * colours are never the only signal: every state carries an icon of its own
 * shape and a word.
 *
 * Everything is inline CSS: the content security policy (deploy/Caddyfile)
 * allows no stylesheet or image from anywhere, and fonts only from this
 * origin (fonts.ts serves them). The seal in the masthead is inline SVG.
 */

/**
 * The typefaces, one file per weight, served from /fonts/ by fonts.ts. Only
 * these names are served.
 */
const FACES = [
  { family: "Newsreader", file: "newsreader-latin", weights: [400, 600] },
  { family: "Public Sans", file: "public-sans-latin", weights: [400, 500, 600] },
  { family: "IBM Plex Mono", file: "ibm-plex-mono-latin", weights: [400, 500] },
] as const;

export const FONT_FILES: readonly string[] = FACES.flatMap(({ file, weights }) =>
  weights.map((weight) => `${file}-${weight}-normal.woff2`),
);

const FONT_FACE_CSS = FACES.flatMap(({ family, file, weights }) =>
  weights.map(
    (weight) =>
      `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: swap; ` +
      `src: url(/fonts/${file}-${weight}-normal.woff2) format("woff2"); }`,
  ),
).join("\n");

export const STYLE = `
${FONT_FACE_CSS}
:root {
  color-scheme: light dark;
  /* design/tokens.json, light theme */
  --ground: #f6f1e7; --surface: #fffdf8; --ink: #1c1917; --muted: #5c554b; --faint: #8b8272;
  --rule: #d9d0bf; --rule-strong: #948871; --accent: #8e2a24;
  --ok: #1f6b4a; --warn: #8a5a00; --bad: #a3261f;
  --display: Newsreader, Georgia, serif;
  --text: "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    /* design/tokens.json, dark theme */
    --ground: #1a1815; --surface: #221f1b; --ink: #efe9dc; --muted: #b0a899; --faint: #7f786b;
    --rule: #3a362f; --rule-strong: #7a7264; --accent: #d9756d;
    --ok: #7ccb9f; --warn: #e3b04b; --bad: #ff8a80;
  }
}
* { box-sizing: border-box; }
html { background: var(--ground); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--ground); color: var(--ink);
  font: 400 16px/1.55 var(--text); font-variant-numeric: tabular-nums; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: .2em; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.skip { position: absolute; left: -999px; top: 0; }
.skip:focus { left: 16px; top: 16px; background: var(--surface); padding: 8px 16px; z-index: 2; }

/* the page grid: 1120px of content, 80px gutters at 1280, 16px on a phone */
.masthead-inner, main, .colophon { max-width: 1280px; margin: 0 auto; padding-left: clamp(16px, 6.25vw, 80px);
  padding-right: clamp(16px, 6.25vw, 80px); }

/* labels: monospace capitals, the register's column heads */
.eyebrow, th, summary, label, .label { font: 500 12px/1.4 var(--mono); text-transform: uppercase;
  letter-spacing: .14em; color: var(--muted); }

/* the masthead */
.masthead { background: var(--ground); border-bottom: 1px solid var(--rule); }
.masthead-inner { min-height: 72px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 32px; }
.brand { display: flex; align-items: center; gap: 12px; color: var(--ink); text-decoration: none; min-height: 44px; }
.brand svg { width: 36px; height: 36px; flex: none; }
.wordmark { display: block; font: 600 24px/1 var(--display); letter-spacing: .005em; }
.tagline { display: block; margin-top: 4px; font: 400 12px/1.3 var(--mono); text-transform: uppercase;
  letter-spacing: .14em; color: var(--muted); }
.masthead nav { margin-left: auto; display: flex; flex-wrap: wrap; align-items: stretch; gap: 0 4px; align-self: stretch; }
.masthead nav a, .masthead nav button.link { display: inline-flex; align-items: center; min-height: 44px; padding: 0 12px;
  color: var(--ink); text-decoration: none; font: 500 15px/1 var(--text); border-radius: 0; }
.masthead nav form.inline { display: flex; }
.masthead nav a:hover, .masthead nav button.link:hover { color: var(--accent); }
.masthead nav a[aria-current="page"] { box-shadow: inset 0 -2px 0 var(--accent); }

main { padding-top: 48px; padding-bottom: 80px; }
.colophon { padding-bottom: 40px; color: var(--muted); font-size: 14px; }
.colophon p { margin: 0; padding-top: 16px; border-top: 1px solid var(--rule); overflow-wrap: anywhere; }
.colophon code { font-size: 13px; }

/* headings */
.page-head { margin: 0 0 40px; }
.eyebrow { margin: 0 0 12px; }
h1 { font: 600 46px/1.1 var(--display); margin: 0; letter-spacing: -.01em; overflow-wrap: anywhere; }
h2 { font: 600 28px/1.2 var(--display); margin: 48px 0 16px; }
h3 { font: 600 20px/1.3 var(--display); margin: 32px 0 8px; }
.lead { font-size: 18px; line-height: 1.5; color: var(--muted); margin: 16px 0 0; max-width: 44em; }
.sid { font-family: var(--mono); font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.page-head .sid { display: inline-block; margin-top: 12px; }
p { margin: 0 0 12px; }

/* sheets: a surface with a hairline, nothing more */
.sheet { background: var(--surface); border: 1px solid var(--rule); border-radius: 2px; padding: 24px; margin: 0 0 16px; }
.sheet.formal { border-top-color: var(--ink); }
.sheet.danger { border-color: var(--bad); }
.sheet > :first-child { margin-top: 0; }
.sheet > :last-child { margin-bottom: 0; }
.notice { background: var(--surface); border: 1px solid var(--rule); border-radius: 2px; padding: 12px 16px; margin: 0 0 24px; }
.notice.bad { border-color: var(--bad); }

.badge { display: inline-flex; align-items: center; gap: 6px; font: 500 12px/1.4 var(--mono); text-transform: uppercase;
  letter-spacing: .14em; color: var(--muted); margin-left: 8px; vertical-align: .3em; }
.badge::before { content: ""; flex: none; width: 13px; height: 13px; border: 1.5px solid currentColor; border-radius: 50%;
  background: linear-gradient(currentColor, currentColor) center / 6px 1.5px no-repeat; }
h1 .badge { vertical-align: .55em; }

/* the state: always an icon of its own shape, a word, and a colour */
.stamp { display: inline-flex; align-items: center; gap: 8px; font: 600 15px/1.3 var(--text); white-space: nowrap; align-self: start; }
.stamp.green { color: var(--ok); }
.stamp.yellow { color: var(--warn); }
.stamp.red { color: var(--bad); }
.stamp.archived { color: var(--muted); }
.dot { display: inline-flex; flex: none; }
.dot svg { width: 18px; height: 18px; }
.status-word { display: inline-block; }
.status-word::first-letter { text-transform: uppercase; }

/* technical details, closed by default */
details { margin: 8px 0 0; }
summary { cursor: pointer; display: flex; align-items: center; gap: 8px; min-height: 44px; width: fit-content; }
summary:hover { color: var(--ink); }
.panel { background: var(--surface); border: 1px solid var(--rule); border-radius: 2px; padding: 16px;
  font: 13px/1.5 var(--mono); }

/* tables */
.table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { border-collapse: collapse; width: 100%; font-size: 15px; }
th, td { text-align: left; padding: 12px; border-bottom: 1px solid var(--rule); vertical-align: top; }
thead th, tr:first-child > th:only-child { border-bottom-color: var(--ink); }
th { white-space: nowrap; }
table.wide { min-width: 36rem; }
table.wide tr:first-child th { border-bottom-color: var(--ink); }
.panel table { font-size: 13px; }
.panel th, .panel td { padding: 6px 12px 6px 0; }
.panel tr:last-child > * { border-bottom: none; }
code, .hash { font-family: var(--mono); font-size: 13px; }
.hash { color: var(--muted); word-break: break-all; }
.muted { color: var(--muted); }
.small { font-size: 15px; }
.warn { color: var(--bad); }
.empty { color: var(--muted); padding: 8px 0; }

/* forms */
form.fields { display: flex; flex-wrap: wrap; gap: 16px; align-items: end; margin: 0 0 12px; }
label { display: flex; flex-direction: column; gap: 8px; }
label > input, label > select, label > textarea { text-transform: none; letter-spacing: normal; }
input, select, textarea { font: 400 16px/1.4 var(--text); padding: 10px 12px; color: var(--ink);
  background: var(--surface); border: 1px solid var(--rule-strong); border-radius: 2px; min-height: 44px; }
input:hover, select:hover, textarea:hover { border-color: var(--ink); }
::placeholder { color: var(--muted); opacity: 1; }
details.search { background: var(--surface); border: 1px solid var(--rule); border-radius: 2px; padding: 0 16px; margin: 0 0 24px; }
details.search[open] { padding-bottom: 16px; }
details.search[open] > summary { margin-bottom: 8px; }
textarea { width: 100%; max-width: 40rem; min-height: 8rem; }
input[type="text"], input[type="password"] { min-width: min(20rem, 100%); }
input[type="file"] { padding: 8px; max-width: 100%; }

button { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 20px;
  font: 500 15px/1.2 var(--text); color: var(--ink); background: transparent; border: 1px solid var(--rule-strong);
  border-radius: 2px; cursor: pointer; }
button:hover { border-color: var(--ink); }
button.primary, #sigillo-doc-button { min-height: 48px; padding: 0 24px; font-weight: 600;
  background: var(--ink); color: var(--surface); border-color: var(--ink); }
button.primary:hover, #sigillo-doc-button:hover { background: var(--accent); border-color: var(--accent); }
button.danger { min-height: 48px; font-weight: 600; background: var(--bad); color: var(--surface); border-color: var(--bad); }
button.danger:hover { background: var(--ink); border-color: var(--ink); }
button:disabled, button:disabled:hover { cursor: not-allowed; opacity: .5; background: var(--ink); border-color: var(--ink); }
form.inline { display: inline; margin: 0; }
button.link { background: none; border: none; min-height: 0; color: var(--accent); text-decoration: underline;
  font: inherit; padding: 0; }
.hint { color: var(--muted); font-size: 15px; margin: 8px 0 0; }

/* filters: the current one in solid ink */
.tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 24px; padding: 0; list-style: none; }
.tabs a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border: 1px solid var(--rule-strong);
  border-radius: 2px; text-decoration: none; color: var(--ink); font: 500 15px/1 var(--text); }
.tabs a:hover { border-color: var(--ink); }
.tabs a[aria-current="page"] { background: var(--ink); color: var(--surface); border-color: var(--ink); }

.token-box { font-family: var(--mono); background: var(--surface); border: 1px solid var(--ink); padding: 12px 16px;
  border-radius: 2px; word-break: break-all; margin: 8px 0; font-size: 15px; }
pre.code { background: var(--surface); border: 1px solid var(--rule); padding: 16px; border-radius: 2px; overflow-x: auto;
  font: 13px/1.5 var(--mono); }
.log { list-style: none; padding: 0; margin: 8px 0 0; font-size: 15px; border-top: 1px solid var(--ink); }
.log li { padding: 8px 0; border-bottom: 1px solid var(--rule); }

/* the login page */
.login { max-width: 400px; margin: 12vh auto 0; padding: 0 16px; text-align: center; }
.login .sheet { text-align: left; }
.login svg { width: 64px; height: 64px; }
.login .wordmark { font-size: 40px; margin: 16px 0 4px; }
.login .tagline { margin: 0 0 32px; }
.login input { width: 100%; }

/* the overview: the three questions as lines of a register */
.question { margin: 0 0 48px; }
.register-row { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; gap: 4px 24px; align-items: start;
  padding: 24px 0; border-top: 1px solid var(--ink); }
.numeral { font: 400 44px/1 var(--display); color: var(--faint); }
.register-row h2 { margin: 4px 0 0; font: 600 24px/1.25 var(--display); }
.register-row .detail { margin: 4px 0 0; font-size: 15px; color: var(--muted); }
.row-state { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; padding-top: 6px; }
.question-body { margin-left: 96px; }
.register-foot { margin: 48px 0 0; padding-top: 16px; border-top: 1px solid var(--rule); overflow-wrap: anywhere; }
.register-foot code { font-size: 12px; color: var(--ink); }

/* systems on the overview */
.systems { list-style: none; padding: 0; margin: 0 0 16px; border-top: 1px solid var(--rule); }
.systems > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 24px;
  padding: 16px 0; border-bottom: 1px solid var(--rule); }
.system-name { font: 600 20px/1.3 var(--display); overflow-wrap: anywhere; }
.system-name a { color: var(--ink); text-decoration: none; }
.system-name a:hover { text-decoration: underline; }
.system-meta { grid-column: 1 / -1; color: var(--muted); font-size: 15px; margin: 0; }
.system-links { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px 24px; font-size: 15px; }

/* the ledger: one entry per receipt, its number and time in the margin */
.ledger { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--rule); }
.ledger > li { display: grid; grid-template-columns: 128px minmax(0, 1fr); column-gap: 24px;
  padding: 16px 0; border-bottom: 1px solid var(--rule); }
.ledger .margin { font: 13px/1.5 var(--mono); color: var(--muted); }
.ledger .margin .no { display: block; color: var(--ink); font-weight: 500; }
.ledger .margin .when { display: block; }
.ledger .entry { min-width: 0; font: 400 18px/1.4 var(--display); }
.ledger .entry .who { display: block; width: fit-content; margin-bottom: 4px; font: 500 12px/1.4 var(--mono);
  text-transform: uppercase; letter-spacing: .14em; color: var(--muted); text-decoration: none; }
.ledger .entry a.who:hover { color: var(--accent); text-decoration: underline; }
.tag { display: inline-block; border: 1px solid var(--rule); border-radius: 2px; padding: 0 8px;
  font: 13px/1.6 var(--text); margin: 4px 4px 0 0; }

/* the history: one row per receipt, opening on its technical details */
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.history-head, .history-row { display: grid; grid-template-columns: 56px 128px minmax(0, 1fr) 152px 112px 128px;
  column-gap: 16px; align-items: baseline; }
.history-head { padding: 0 0 8px; border-bottom: 1px solid var(--ink); font: 500 12px/1.4 var(--mono);
  text-transform: uppercase; letter-spacing: .14em; color: var(--muted); }
.history { list-style: none; padding: 0; margin: 0; }
.history > li { border-bottom: 1px solid var(--rule); }
.history details { margin: 0; }
.history summary.history-row { display: grid; width: auto; min-height: 44px; padding: 16px 0; cursor: pointer;
  font: 400 15px/1.45 var(--text); text-transform: none; letter-spacing: normal; color: var(--ink); list-style: none; }
.history summary::-webkit-details-marker { display: none; }
.history summary:hover .action { color: var(--accent); }
.history .no { font: 500 13px/1.6 var(--mono); }
.history .no::before { content: "+"; display: inline-block; width: 16px; color: var(--muted); }
.history details[open] .no::before { content: "\\2212"; }
.history .time, .history .fingerprint { font: 13px/1.6 var(--mono); color: var(--muted); }
.history .time .day, .history .time .hour { display: block; }
.history .action { font: 400 18px/1.4 var(--display); min-width: 0; }
.history .outcome .stamp { font-size: 15px; }
.history .dot svg { width: 16px; height: 16px; }
.history .pending { color: var(--warn); font-weight: 600; }
.history .panel { margin: 0 0 16px; }

@media (max-width: 640px) {
  .masthead-inner { padding-top: 12px; gap: 4px 16px; }
  .masthead nav a, .masthead nav button.link { white-space: nowrap; padding: 0 8px; }
  .masthead nav { margin-left: -8px; width: calc(100% + 8px); }
  main { padding-top: 32px; padding-bottom: 48px; }
  h1 { font-size: 34px; }
  h2 { font-size: 24px; }
  .lead { font-size: 17px; }
  .sheet { padding: 16px; }
  .register-row { grid-template-columns: 40px minmax(0, 1fr); }
  .numeral { font-size: 32px; }
  .row-state { grid-column: 2; align-items: flex-start; padding-top: 4px; }
  .question-body { margin-left: 0; }
  .ledger > li { grid-template-columns: minmax(0, 1fr); row-gap: 4px; }
  .history-head { display: none; }
  .history summary.history-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; }
  .history .time .day, .history .time .hour { display: inline; }
  .history .action { flex-basis: 100%; }
  .panel th, .panel td { display: block; padding: 0; border: none; }
  .panel td { padding-bottom: 8px; }
  .ledger .margin .no, .ledger .margin .when { display: inline; }
  .ledger .margin .no { margin-right: 8px; }
  form.fields > label, form.fields > button { width: 100%; }
  input[type="text"], input[type="password"], input[type="date"], select { width: 100%; }
}
`;

/**
 * The seal: two concentric circles and a solid diamond, in the accent
 * colour. Drawn here rather than shipped as an image, because the content
 * security policy allows no image from anywhere.
 */
export const SEAL_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
<circle cx="24" cy="24" r="22" style="fill: none; stroke: var(--accent); stroke-width: 2"/>
<circle cx="24" cy="24" r="16" style="fill: none; stroke: var(--accent); stroke-width: 1.25"/>
<polygon points="24,15 33,24 24,33 15,24" style="fill: var(--accent)"/>
</svg>`;

/**
 * The icons of the four states, each a different shape so that colour is
 * never the only signal: a circle with a check, a triangle with an
 * exclamation mark, an octagon with a cross, a circle with a dash. They take
 * the colour of the text around them and are always next to a word.
 */
const icon = (shape: string): string =>
  `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" style="fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round">${shape}</svg>`;

export const STATE_ICONS = {
  ok: icon('<circle cx="10" cy="10" r="8.25"/><path d="M6.25 10.25l2.5 2.5 5-5.25"/>'),
  warn: icon('<path d="M10 2.25 18.5 17.25h-17z"/><path d="M10 7.75v4"/><circle cx="10" cy="14.4" r=".6" style="fill: currentColor"/>'),
  bad: icon('<path d="M6.6 1.75h6.8l4.85 4.85v6.8l-4.85 4.85H6.6L1.75 13.4V6.6z"/><path d="M7.5 7.5l5 5M12.5 7.5l-5 5"/>'),
  archived: icon('<circle cx="10" cy="10" r="8.25"/><path d="M6.5 10h7"/>'),
} as const;
