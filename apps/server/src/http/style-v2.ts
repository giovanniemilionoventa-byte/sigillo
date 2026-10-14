import { STYLE, THEME } from "./style.js";

/**
 * The look of the redesigned console (SIGILLO_CONSOLE_V2), direction "Il filo
 * e il sigillo" (design/DESIGN-V2.md, design/tokens-v2.json): cool neutral
 * greys, one ink blue for actions, full colour only for state, the seal as the
 * mark and as the family of proof signs.
 *
 * It is the stylesheet of style.ts with its tokens replaced, so every page not
 * yet redrawn takes the new palette as it is, followed by the rules of the new
 * shell and the new pages. The custom properties below are design/tokens-v2.json
 * one for one (apps/server/test/style-v2.test.ts checks it, and the contrast).
 * The old names stay, with new values; the kind colours collapse into one ink,
 * because the kind is said by the icon's shape.
 */

const DARK_TOKENS_V2 = `
    /* design/tokens-v2.json, dark theme */
    --bg: #111317; --canvas: #111317; --sidebar: #15181c; --surface: #1a1d22; --fill: #262a31; --current: #1d2640;
    --segment: #262a31; --segment-on: #1a1d22; --hover: #2e333b; --scrim: rgba(0,0,0,0.60);
    --text: #eceef2; --secondary: #a3aab7; --label: #c8cdd6;
    --separator: #2d323a; --separator-soft: #262a31; --sidebar-rule: #2d323a; --control: #7c8491;
    --action: #4a66d2; --on-action: #ffffff; --link: #9db2ff; --selection: #1d2640; --focus: #9db2ff; --brand: #eceef2;
    --ok: #6ccb88; --ok-fill: #173020; --warn: #eeb44e; --warn-fill: #352912; --bad: #ff8a80; --bad-fill: #3d1f1c;
    --danger: #c2372b; --neutral: #a3aab7; --thread: #5a616d; --selected: #1d2640;
    --kind-tool: #c8cdd6; --kind-tool-fill: #262a31; --kind-model: #c8cdd6; --kind-model-fill: #262a31;
    --kind-step: #c8cdd6; --kind-step-fill: #262a31; --kind-decision: #c8cdd6; --kind-decision-fill: #262a31;
    --kind-genesis: #c8cdd6; --kind-genesis-fill: #262a31;
    --code: #0b0d10; --on-code: #e4e7ec;
    --shadow-card: 0 0 0 1px var(--separator);
    --shadow-sheet: 0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px var(--separator);
    --shadow-segment: 0 0 0 1px var(--separator);
    color-scheme: dark;
`;

export const THEME_V2 = `
:root {
  color-scheme: light dark;
  /* design/tokens-v2.json, light theme */
  --bg: #f6f7f9; --canvas: #f6f7f9; --sidebar: #eef0f3; --surface: #ffffff; --fill: #eceef2; --current: #e9edfa;
  --segment: #eceef2; --segment-on: #ffffff; --hover: #e3e6eb; --scrim: rgba(16,19,24,0.40);
  --text: #16191f; --secondary: #555d6b; --label: #353b46;
  --separator: #dce0e6; --separator-soft: #eceef2; --sidebar-rule: #dce0e6; --control: #7d8491;
  --action: #2846a8; --on-action: #ffffff; --link: #2846a8; --selection: #e9edfa; --focus: #2846a8; --brand: #8e2a24;
  --ok: #1c6a34; --ok-fill: #e3f1e7; --warn: #8a5200; --warn-fill: #faeed6; --bad: #b3261e; --bad-fill: #fae5e2;
  --danger: #b3261e; --neutral: #555d6b; --thread: #9aa2ae; --selected: #e9edfa;
  --kind-tool: #353b46; --kind-tool-fill: #eceef2; --kind-model: #353b46; --kind-model-fill: #eceef2;
  --kind-step: #353b46; --kind-step-fill: #eceef2; --kind-decision: #353b46; --kind-decision-fill: #eceef2;
  --kind-genesis: #353b46; --kind-genesis-fill: #eceef2;
  --code: #16191f; --on-code: #e4e7ec;
  --shadow-card: 0 0 0 1px var(--separator);
  --shadow-sheet: 0 12px 32px rgba(16,19,24,0.18), 0 0 0 1px var(--separator);
  --shadow-segment: 0 0 0 1px var(--separator);
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS_V2}  }
}
:root[data-theme="dark"] {${DARK_TOKENS_V2}}
:root[data-theme="light"] { color-scheme: light; }
`;

const V2_RULES = `
/* ---- redesigned console (SIGILLO_CONSOLE_V2) ---- */
body { font-size: 15px; line-height: 1.47; }
.content { max-width: 1264px; }
.brand svg { width: 24px; height: 24px; }
.side-item { min-height: 36px; font-size: 15px; font-weight: 500; border-radius: 6px; }
.side-item[aria-current="page"] { background: var(--selected); box-shadow: inset 3px 0 0 var(--action); font-weight: 600; }
.side-item > .sign svg, .side-item > svg { width: 16px; height: 16px; }
.side-rule { height: 1px; background: var(--separator); margin: 10px 8px; }
.side-group { margin: 4px 0 2px; padding: 0 10px; font-size: 13px; font-weight: 500; color: var(--secondary); }
.card { border-radius: 10px; box-shadow: none; border: 1px solid var(--separator); }
.button, button { border-radius: 6px; }
.row[aria-current="true"] { background: var(--selected) !important; color: var(--text) !important; box-shadow: inset 3px 0 0 var(--action); }
.row[aria-current="true"] .row-time { color: var(--secondary) !important; }
.row[aria-current="true"] .kind { background: var(--fill) !important; color: var(--label) !important; }

.q-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 0 0 20px; }
.q-head h1 { font-size: 28px; line-height: 34px; font-weight: 600; letter-spacing: -0.005em; }
.answer { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; font-size: 20px; line-height: 28px; font-weight: 600; color: var(--text); }
.answer svg { width: 20px; height: 20px; }
.answer.green svg { color: var(--ok); } .answer.yellow svg { color: var(--warn); } .answer.red svg { color: var(--bad); }
.answer a { font-size: 15px; font-weight: 600; }
.sign { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; line-height: 18px; font-weight: 600; white-space: nowrap; }
.sign svg { width: 16px; height: 16px; }
.sign.green { color: var(--ok); } .sign.yellow { color: var(--warn); } .sign.red { color: var(--bad); } .sign.neutral { color: var(--neutral); }
.sign.ink { color: var(--label); font-weight: 500; }
.sign .detail { color: var(--secondary); font-weight: 500; }
.out { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px 2px 7px; border: 1px solid var(--control); border-radius: 999px;
  font-size: 13px; line-height: 18px; font-weight: 500; color: var(--label); white-space: nowrap; }
.out svg { width: 12px; height: 12px; }
.model-b { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 24px; align-items: start; }
.figs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 24px; }
.fig { display: flex; flex-direction: column; gap: 2px; padding: 14px 16px; border: 1px solid var(--separator); border-radius: 10px;
  background: var(--surface); color: var(--text); }
.fig:hover { border-color: var(--control); text-decoration: none; }
.fig strong { font-size: 20px; line-height: 28px; font-weight: 600; }
.fig span { font-size: 13px; line-height: 18px; font-weight: 500; color: var(--secondary); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--separator); }
.card-head h2 { font-size: 17px; line-height: 24px; font-weight: 600; }
.card-foot { padding: 12px 16px; border-top: 1px solid var(--separator); }
.grid-table { width: 100%; border-collapse: collapse; font-size: 15px; }
.grid-table th { text-align: left; font-size: 13px; line-height: 18px; font-weight: 500; color: var(--secondary); padding: 10px 16px; border-bottom: 1px solid var(--separator); }
.grid-table td { padding: 12px 16px; border-bottom: 1px solid var(--separator); vertical-align: middle; }
.grid-table tr:last-child td { border-bottom: 0; }
.grid-table td.go { width: 1%; text-align: right; white-space: nowrap; }
.grid-table a.name { color: var(--text); font-weight: 600; }
.watch { list-style: none; margin: 0; padding: 0; }
.watch li + li { border-top: 1px solid var(--separator); }
.watch a { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 12px 16px; color: var(--text); }
.watch a:hover { background: var(--hover); text-decoration: none; }
.watch .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 4px; font-size: 13px; color: var(--secondary); }
.watch .chev svg, .chev svg { width: 16px; height: 16px; color: var(--secondary); }
.filters-v2 { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin: 0 0 16px; }
.filters-v2 .flabel { font-size: 13px; font-weight: 500; color: var(--secondary); margin-right: 6px; }
.seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 8px; background: var(--fill); }
.seg a { padding: 5px 10px; border-radius: 6px; font-size: 13px; line-height: 18px; font-weight: 500; color: var(--label); }
.seg a[aria-current="true"] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 0 0 1px var(--separator); }
.seg a:hover { text-decoration: none; }
.seg .c { color: var(--secondary); margin-left: 4px; }
.act-list { list-style: none; margin: 0; padding: 0; }
.act-day { padding: 14px 16px 6px; font-size: 13px; line-height: 18px; font-weight: 600; color: var(--secondary); }
.act { display: grid; grid-template-columns: 48px 28px minmax(0, 1fr) auto; gap: 12px; align-items: center; min-height: 48px; padding: 8px 16px; color: var(--text); }
.act:hover { background: var(--hover); text-decoration: none; }
.act .tm { font-size: 13px; color: var(--secondary); font-weight: 500; }
.act .tx { min-width: 0; overflow-wrap: anywhere; }
.act .rt { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--secondary); }
.more { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--separator); font-size: 13px; color: var(--secondary); }
.np { border: 1px solid var(--separator); border-radius: 10px; background: var(--surface); padding: 14px 16px; }
.np h3 { font-size: 13px; line-height: 18px; font-weight: 600; color: var(--label); margin-bottom: 6px; }
.np ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.np li::before { content: "–  "; color: var(--secondary); }
.steps-v2 { list-style: none; margin: 0; padding: 0; }
.steps-v2 li { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 14px 0; border-top: 1px solid var(--separator); }
.steps-v2 li:first-child { border-top: 0; }
.steps-v2 .num { width: 28px; height: 28px; border-radius: 999px; border: 1.5px solid var(--label); display: grid; place-items: center; font-size: 13px; font-weight: 600; color: var(--label); }
.code-key { font-family: var(--mono); font-size: 15px; font-weight: 600; letter-spacing: 0.02em; word-spacing: 0.3em; }
.preview { font-size: 20px; line-height: 28px; font-weight: 600; margin: 4px 0 16px; }
.evidence-form { display: grid; gap: 16px; }
.evidence-form > *, .model-b > * { min-width: 0; }
.evidence-form select, .evidence-form input { width: 100%; max-width: 100%; }
.evidence-form .row-fields { display: flex; flex-wrap: wrap; gap: 12px; }
.evidence-form .row-fields label { flex: 1 1 180px; }
.sys-id { font-family: var(--mono); font-size: 13px; color: var(--secondary); }
.card-title { font-size: 17px; line-height: 24px; font-weight: 600; margin-bottom: 8px; }
.empty-state .button { margin-top: 12px; }
@media (max-width: 900px) {
  .model-b { grid-template-columns: minmax(0, 1fr); }
  .figs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid-table thead { display: none; }
  .grid-table tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 12px 16px; border-bottom: 1px solid var(--separator); }
  .grid-table td { padding: 0; border: 0; }
  .grid-table td.go { grid-row: 1 / span 4; grid-column: 2; align-self: center; }
  .act { grid-template-columns: 44px 28px minmax(0, 1fr); }
  .act .rt { grid-column: 3; }
}
`;

/** The redesigned console's whole stylesheet. */
export const STYLE_V2 = `${STYLE.replace(THEME, THEME_V2)}${V2_RULES}`;

/** Icons the redesigned console adds, on the 24-unit grid of style.ts. */
const line = (shape: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round">${shape}</svg>`;

export const ICONS_V2 = {
  /** Stato: a pulse. */
  pulse: line('<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>'),
  /** Prove: a document with a seal. */
  evidence: line('<path d="M14 3H6.5v18H11"/><path d="M14 3l4.5 4.5V10"/><circle cx="16.5" cy="16" r="4"/>'),
  failed: line('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
  blocked: line('<circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/>'),
  unknown: line('<path d="M9 9a3 3 0 1 1 4.2 2.8c-.8.4-1.2 1-1.2 1.9"/><path d="M12 17.5v.1"/>'),
} as const;

/** The proof signs, from the seal's geometry: not sealed yet, sealed with the timestamp still to come, sealed and timestamped. */
export const PROOF_ICONS = {
  open: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 7.5l4.5 4.5-4.5 4.5-4.5-4.5z" style="fill: none; stroke: currentColor; stroke-width: 1.6"/></svg>',
  pending:
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7.5" style="fill: none; stroke: currentColor; stroke-width: 1.4"/><path d="M12 8.5l3.5 3.5-3.5 3.5-3.5-3.5z" style="fill: none; stroke: currentColor; stroke-width: 1.4"/></svg>',
  full: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10.5" style="fill: none; stroke: currentColor; stroke-width: 1.6"/><circle cx="12" cy="12" r="7.5" style="fill: none; stroke: currentColor; stroke-width: 1.2"/><path d="M12 8.5l3.5 3.5-3.5 3.5-3.5-3.5z" style="fill: currentColor"/></svg>',
} as const;
