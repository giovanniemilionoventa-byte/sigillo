/**
 * The look of the web view: direction "B", three panes in the manner of a
 * macOS application (sidebar, content, inspector), in its "semplice" form of
 * 2026-10-03 (design/proposta-semplice): one title per section and no grey
 * explanatory lines. design/DESIGN.md and design/tokens.json are the source of
 * truth; the custom properties on :root below are those tokens, one for one
 * (apps/server/test/style.test.ts checks it), and nothing else in this file
 * names a colour except the shadows, the selected row's translucent icon
 * ground, and Google's own logo on the sign-in button.
 *
 * The theme follows the reader's operating system unless they chose one in
 * Impostazioni (data-theme on <html>). The state colours are never the only
 * signal: every state carries an icon of its own shape or a word.
 *
 * Everything is inline CSS: the content security policy (deploy/Caddyfile)
 * allows no stylesheet or image from anywhere. The seal and the icons are
 * inline SVG. Nothing here needs a script: the phone menu and the sheets open
 * with :target, the technical details with <details>, and the three ways to
 * connect an agent are radio buttons with :checked.
 */

/**
 * The typefaces of direction "Registro", still served from /fonts/ by
 * fonts.ts but no longer named by the stylesheet: direction "B" uses the
 * system's own fonts. Kept until the project owner decides to drop them.
 */
const FACES = [
  { file: "newsreader-latin", weights: [400, 600] },
  { file: "public-sans-latin", weights: [400, 500, 600] },
  { file: "ibm-plex-mono-latin", weights: [400, 500] },
] as const;

export const FONT_FILES: readonly string[] = FACES.flatMap(({ file, weights }) =>
  weights.map((weight) => `${file}-${weight}-normal.woff2`),
);

/**
 * The dark theme's tokens, written once and used twice below: when the
 * reader's system asks for dark and the reader has not chosen light, and when
 * the reader has chosen dark (Impostazioni, Aspetto; ui.ts puts the choice on
 * <html> as data-theme).
 */
const DARK_TOKENS = `
    /* design/tokens.json, dark theme */
    --bg: #1c1c1e; --canvas: #161618; --sidebar: #232325; --surface: #242426; --fill: #2c2c2e; --current: #343436;
    --segment: #2c2c2e; --segment-on: #3a3a3c; --hover: #38383a; --scrim: rgba(0,0,0,0.55);
    --text: #f5f5f7; --secondary: #a1a1a6; --label: #d1d1d6;
    --separator: #38383a; --separator-soft: #2c2c2e; --sidebar-rule: #38383a; --control: #7c7c80;
    --action: #0a6bd6; --on-action: #ffffff; --link: #4da3ff; --selection: #0a5fc4; --focus: #4da3ff; --brand: #e0857c;
    --ok: #5fd17f; --ok-fill: #1d3524; --warn: #f0b84a; --warn-fill: #3a2e12; --bad: #ff8a80; --bad-fill: #44221f;
    --danger: #b3261e;
    --kind-tool: #6cb2ff; --kind-tool-fill: #1b3149; --kind-model: #4fd1c7; --kind-model-fill: #11393a;
    --kind-step: #b4b4f5; --kind-step-fill: #2a2a48; --kind-decision: #c9a8ff; --kind-decision-fill: #33264d;
    --kind-genesis: #d1d1d6; --kind-genesis-fill: #3a3a3c;
    --code: #0e0e10; --on-code: #e5e5ea;
    --shadow-card: 0 0 0 1px var(--separator);
    --shadow-sheet: 0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px var(--separator);
    --shadow-segment: 0 1px 3px rgba(0,0,0,0.5);
    color-scheme: dark;
`;

/**
 * The colour tokens in both themes, and the theme choice on <html>: the part
 * of the stylesheet the public site (site.ts) shares with the web view, so
 * that the two can never drift apart.
 */
export const THEME = `
:root {
  color-scheme: light dark;
  /* design/tokens.json, light theme */
  --bg: #ffffff; --canvas: #fafafc; --sidebar: #f0f0f3; --surface: #ffffff; --fill: #f5f5f7; --current: #e2e2e7;
  --segment: #eeeef0; --segment-on: #ffffff; --hover: #e5e5ea; --scrim: rgba(0,0,0,0.28);
  --text: #1d1d1f; --secondary: #636366; --label: #3a3a3c;
  --separator: #e5e5ea; --separator-soft: #f0f0f3; --sidebar-rule: #dcdce1; --control: #8a8a8e;
  --action: #0071e3; --on-action: #ffffff; --link: #0066cc; --selection: #0a63d1; --focus: #0071e3; --brand: #8e2a24;
  --ok: #1b6e30; --ok-fill: #e3f3e7; --warn: #8a5a00; --warn-fill: #fbf0d9; --bad: #b3261e; --bad-fill: #fbe4e2;
  --danger: #b3261e;
  --kind-tool: #0066cc; --kind-tool-fill: #e5f0fc; --kind-model: #0b6b6b; --kind-model-fill: #e2f4f4;
  --kind-step: #4a4a8c; --kind-step-fill: #ececf6; --kind-decision: #6e3fc9; --kind-decision-fill: #efe9fb;
  --kind-genesis: #48484a; --kind-genesis-fill: #ededf0;
  --code: #1d1d1f; --on-code: #e5e5ea;
  --shadow-card: 0 0 0 1px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-sheet: 0 24px 60px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.08);
  --shadow-segment: 0 1px 3px rgba(0,0,0,0.14);
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS}  }
}
:root[data-theme="dark"] {${DARK_TOKENS}}
:root[data-theme="light"] { color-scheme: light; }
`;

export const STYLE = `${THEME}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { background: var(--bg); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--canvas); color: var(--text); font: 400 14px/1.45 var(--font);
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
p { margin: 0 0 8px; }
h1, h2, h3 { margin: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skip { position: absolute; left: -999px; top: 0; }
.skip:focus { left: 16px; top: 16px; z-index: 30; background: var(--surface); color: var(--text); padding: 8px 16px;
  border-radius: 8px; box-shadow: var(--shadow-card); }
svg { flex: none; }

/* the shell: sidebar and content */
.app { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
.topbar { display: none; }
.sidebar { background: var(--sidebar); border-right: 1px solid var(--sidebar-rule); }
.sidebar-inner { position: sticky; top: 0; height: 100vh; overflow: auto; display: flex; flex-direction: column; gap: 2px;
  padding: 18px 12px 12px; }
.side-top { display: flex; align-items: center; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 18px; color: var(--text); font-size: 17px;
  font-weight: 600; letter-spacing: -0.01em; }
.brand:hover { text-decoration: none; }
.brand svg { width: 28px; height: 28px; }
.menu-close { display: none; }
.side-nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.side-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.side-item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 34px; padding: 0 10px; border: 0;
  border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 14px; text-align: left;
  cursor: pointer; white-space: nowrap; }
.side-item:hover { background: var(--hover); text-decoration: none; }
.side-item[aria-current="page"] { background: var(--current); font-weight: 600; }
.side-item > svg { width: 16px; height: 16px; color: var(--secondary); }
.side-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.side-count { font-size: 12px; color: var(--secondary); }
.side-head { display: flex; align-items: center; justify-content: space-between; margin: 14px 0 2px; padding: 0 2px 0 10px;
  font-size: 12px; font-weight: 600; color: var(--secondary); min-height: 28px; }
.side-head a { color: inherit; }
.side-add { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border-radius: 7px;
  color: var(--link) !important; }
.side-add:hover { background: var(--hover); }
.side-add svg { width: 15px; height: 15px; }
.side-spacer { flex: 1; min-height: 16px; }
.light { width: 8px; height: 8px; border-radius: 50%; flex: none; margin: 0 4px; background: var(--secondary); }
.light.green { background: var(--ok); }
.light.yellow { background: var(--warn); }
.light.red { background: var(--bad); }
.account { display: flex; align-items: center; gap: 10px; margin-top: 8px; padding: 10px 4px 0 10px;
  border-top: 1px solid var(--sidebar-rule); }
.avatar { width: 30px; height: 30px; border-radius: 50%; background: var(--action); color: var(--on-action); display: flex;
  align-items: center; justify-content: center; font-weight: 600; font-size: 13px; flex: none; }
.avatar.large { width: 38px; height: 38px; font-size: 15px; }
.who { flex: 1; min-width: 0; line-height: 1.25; }
.who strong, .who span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.who strong { font-size: 13px; font-weight: 600; }
.who span { font-size: 12px; color: var(--secondary); }
.account form { margin: 0; }
.icon-button { width: 34px; min-height: 34px; padding: 0; border: 0; background: transparent; color: var(--secondary); }
.icon-button:hover { background: var(--hover); }

.content { min-width: 0; padding: 32px 40px 48px; background: var(--canvas); }
.narrow { max-width: 760px; }

/* headings */
h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.2; overflow-wrap: anywhere; }
.page-head { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin: 0 0 24px; }
.page-head .end { margin-left: auto; display: flex; gap: 10px; }
h2 { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
h2 .end { margin-left: auto; font-size: 13px; font-weight: 500; letter-spacing: 0; }
.section + .section { margin-top: 28px; }
p.section, form.section { margin-top: 12px; }
.muted { color: var(--secondary); }
.section-gap { margin-bottom: 22px; }
.danger-title { color: var(--bad); }
.danger-title svg { width: 18px; height: 18px; }

/* cards and lines */
.card { background: var(--surface); border-radius: 14px; box-shadow: var(--shadow-card); }
.card.padded { padding: 20px; }
.lines { list-style: none; margin: 0; padding: 0; overflow: hidden; border-radius: 14px; }
.lines > li + li { border-top: 1px solid var(--separator); }
.line { display: flex; align-items: center; gap: 14px; min-height: 52px; padding: 10px 18px; color: var(--text); }
a.line:hover { background: var(--fill); text-decoration: none; }
.line-text { flex: 1; min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line-time { width: 46px; flex: none; color: var(--secondary); font-size: 13px; }
.line-aside { flex: none; color: var(--secondary); font-size: 13px; }
.chevron { width: 16px; height: 16px; color: var(--secondary); }
.empty { margin: 0; padding: 20px; color: var(--secondary); }
.notice { display: flex; gap: 10px; align-items: flex-start; margin: 0 0 20px; padding: 12px 16px; border-radius: 12px;
  background: var(--surface); box-shadow: var(--shadow-card); line-height: 1.5; max-width: 760px; }
.notice svg { width: 17px; height: 17px; margin-top: 1px; }
.notice.ok svg { color: var(--ok); }
.notice.bad { background: var(--bad-fill); color: var(--bad); box-shadow: none; font-weight: 500; }
.notice.warn { background: var(--warn-fill); color: var(--warn); box-shadow: none; font-weight: 500; }

/* the state: an icon of its own shape, a word, and a colour */
.status { display: flex; align-items: center; gap: 12px; margin: 0 0 20px; padding: 16px 20px; border-radius: 14px;
  font-weight: 600; font-size: 15px; }
.status svg { width: 20px; height: 20px; }
.status.green { background: var(--ok-fill); color: var(--ok); }
.status.yellow { background: var(--warn-fill); color: var(--warn); }
.status.red { background: var(--bad-fill); color: var(--bad); }
.status a { margin-left: auto; color: inherit; font-size: 13px; font-weight: 500; text-decoration: underline; }
.pill { display: inline-flex; align-items: center; gap: 5px; flex: none; padding: 3px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 600; white-space: nowrap; background: var(--fill); color: var(--secondary); }
.pill svg { width: 13px; height: 13px; }
.pill.green { background: var(--ok-fill); color: var(--ok); }
.pill.yellow { background: var(--warn-fill); color: var(--warn); }
.pill.red { background: var(--bad-fill); color: var(--bad); }

/* the four figures */
.tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 28px; }
.tile { padding: 14px 16px; }
.tile strong { display: block; font-size: 24px; font-weight: 600; letter-spacing: -0.02em; }
.tile span { font-size: 13px; color: var(--secondary); }
.tile.yellow strong { color: var(--warn); }
.tile.red strong { color: var(--bad); }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 28px; align-items: start; }
.cols.even { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }

/* the kind of an action: an icon in a rounded square */
.kind { width: 30px; height: 30px; flex: none; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
.kind svg { width: 16px; height: 16px; }
.kind.large { width: 44px; height: 44px; border-radius: 12px; }
.kind.large svg { width: 22px; height: 22px; }
.kind.tool_call, .tile-icon.blue { background: var(--kind-tool-fill); color: var(--kind-tool); }
.kind.llm_call, .tile-icon.teal { background: var(--kind-model-fill); color: var(--kind-model); }
.kind.agent_step { background: var(--kind-step-fill); color: var(--kind-step); }
.kind.decision, .tile-icon.purple { background: var(--kind-decision-fill); color: var(--kind-decision); }
.kind.genesis, .tile-icon.grey { background: var(--kind-genesis-fill); color: var(--kind-genesis); }
.tile-icon { width: 36px; height: 36px; flex: none; border-radius: 10px; display: flex; align-items: center; justify-content: center; }
.tile-icon svg { width: 18px; height: 18px; }
.tile-icon.green { background: var(--ok-fill); color: var(--ok); }
.tile-icon.yellow { background: var(--warn-fill); color: var(--warn); }
.tile-icon.red { background: var(--bad-fill); color: var(--bad); }

/* controls */
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 38px; padding: 0 16px;
  border: 0; border-radius: 9px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--control); color: var(--text);
  font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; white-space: nowrap; }
button:hover, .button:hover { background: var(--fill); text-decoration: none; }
button svg, .button svg { width: 16px; height: 16px; }
button.primary, .button.primary, #sigillo-doc-button { background: var(--action); box-shadow: none; color: var(--on-action); }
button.primary:hover, .button.primary:hover, #sigillo-doc-button:hover { background: var(--action); filter: brightness(0.92); }
button.danger { background: var(--danger); box-shadow: none; color: var(--on-action); }
button.danger:hover { background: var(--danger); filter: brightness(0.92); }
button:disabled, button:disabled:hover { cursor: not-allowed; opacity: 0.5; filter: none; }
button.wide, .button.wide { width: 100%; }
button.big, .button.big { min-height: 44px; border-radius: 10px; font-size: 15px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--label); }
input, select, textarea { width: 100%; min-height: 40px; padding: 0 12px; border: 1px solid var(--control); border-radius: 9px;
  background: var(--surface); color: var(--text); font: inherit; font-size: 14px; font-weight: 400; }
textarea { padding: 12px 14px; min-height: 120px; resize: vertical; line-height: 1.5; }
input[type="file"] { padding: 6px; }
input[aria-invalid="true"] { border-color: var(--bad); }
input[aria-invalid="true"]:focus-visible { outline-color: var(--bad); }
::placeholder { color: var(--secondary); opacity: 1; }
.fields { display: flex; flex-direction: column; gap: 14px; margin: 0; }
.fields-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.inline { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin: 0; }
.inline > label, .inline > input { flex: 1; min-width: 180px; }
.field-error { display: flex; gap: 6px; align-items: center; margin: -4px 0 0; color: var(--bad); font-size: 13px; text-align: left; }
.field-error svg { width: 15px; height: 15px; }

/* disclosures */
details.fold > summary, details.tech > summary { display: flex; align-items: center; gap: 6px; min-height: 32px; width: fit-content;
  cursor: pointer; color: var(--link); font-weight: 500; font-size: 13.5px; list-style: none; }
details.fold > summary::-webkit-details-marker, details.tech > summary::-webkit-details-marker { display: none; }
details.fold > summary svg, details.tech > summary svg { width: 14px; height: 14px; transition: transform 0.1s; }
details.fold[open] > summary svg, details.tech[open] > summary svg { transform: rotate(90deg); }
details.fold > .fold-body { display: flex; flex-direction: column; gap: 12px; padding-top: 8px; }
.fold-body p { margin: 0; color: var(--label); font-size: 13px; line-height: 1.5; }

/* tabs and segmented controls */
.tabs { display: flex; gap: 24px; margin-top: 16px; }
.tabs a { display: flex; align-items: center; min-height: 40px; padding: 0 2px; border-bottom: 2px solid transparent;
  color: var(--secondary); font-weight: 500; }
.tabs a:hover { color: var(--text); text-decoration: none; }
.tabs a[aria-current="page"] { border-bottom-color: var(--action); color: var(--text); }
.segmented { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 9px; background: var(--segment); }
.segmented a, .segmented button { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 12px;
  border-radius: 7px; background: transparent; box-shadow: none; color: var(--text); font-size: 13px; font-weight: 500; }
.segmented a:hover, .segmented button:hover { text-decoration: none; background: var(--hover); }
.segmented [aria-current="page"], .segmented [aria-pressed="true"] { background: var(--segment-on); box-shadow: var(--shadow-segment); }
.segmented .count { font-size: 12px; color: var(--secondary); font-weight: 400; }
.setting-controls, .export-files { margin-top: 12px; }
.segmented a[aria-current="page"] .count { color: var(--text); }

/* one system: header and tabs */
.system-page { padding: 0; background: var(--bg); }
.sys-head { padding: 24px 28px 0; border-bottom: 1px solid var(--separator); background: var(--bg); }
.titleline { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.titleline h1 { font-size: 22px; letter-spacing: -0.01em; }
.titleline .end { margin-left: auto; }
.sys-health { margin: 12px 0 0; padding: 8px 12px; border-radius: 10px; background: var(--warn-fill); color: var(--warn);
  font-size: 13px; font-weight: 500; max-width: 760px; }
.sys-health.red { background: var(--bad-fill); color: var(--bad); }
.system-body { padding: 24px 28px 40px; max-width: 760px; }

/* the evidence sheet and the confirmations, opened with :target */
.sheet-layer { display: none; }
.sheet-layer:target { display: flex; position: fixed; inset: 0; z-index: 10; align-items: flex-start; justify-content: center;
  padding: 90px 16px 16px; overflow: auto; background: var(--scrim); }
.sheet { width: min(480px, 100%); background: var(--surface); border-radius: 16px; box-shadow: var(--shadow-sheet); overflow: hidden; }
.sheet-body { display: flex; flex-direction: column; gap: 14px; padding: 24px; }
.sheet-body h2 { margin: 0 0 4px; font-size: 19px; overflow-wrap: anywhere; }
.sheet-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 24px; background: var(--canvas);
  border-top: 1px solid var(--separator); }

/* the history: list and inspector side by side, each scrolling on its own */
/*
 * Every column of the history that scrolls on its own is also positioned. A
 * .sr label (position: absolute) inside a row would otherwise take the page
 * itself as its containing block, escape the column's clipping, and make the
 * document taller than the window: selecting a row (#r-<seq>) then scrolled
 * the whole page, leaving an empty band under it.
 */
.studio-list, .rows-scroll, .inspector { position: relative; }
.studio { display: grid; grid-template-columns: minmax(0, 1fr) 340px; height: 100vh; padding: 0; background: var(--bg); }
.studio-list { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.toolbar { position: relative; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 63px;
  padding: 14px 72px 14px 28px; border-bottom: 1px solid var(--separator); }
details.search > summary { position: absolute; right: 28px; top: 14px; width: 34px; height: 34px; display: flex; align-items: center;
  justify-content: center; border-radius: 9px; background: var(--fill); color: var(--secondary); cursor: pointer; list-style: none; }
details.search > summary::-webkit-details-marker { display: none; }
details.search > summary svg { width: 16px; height: 16px; }
details.search[open] { flex-basis: 100%; }
details.search[open] > summary { background: var(--action); color: var(--on-action); }
details.search form { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px;
  align-items: end; margin-top: 4px; }
.filter-line { display: flex; align-items: center; gap: 8px; padding: 10px 28px 0; font-size: 13px; }
.rows-scroll { flex: 1; min-height: 0; overflow: auto; padding: 4px 16px 24px; }
.day { margin: 14px 12px 6px; font-size: 13px; font-weight: 600; color: var(--secondary); }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.row { display: flex; align-items: center; gap: 14px; min-height: 52px; padding: 10px 12px; border-radius: 10px;
  color: var(--text); scroll-margin: 12px; }
.row:hover { background: var(--fill); text-decoration: none; }
.row-time { width: 46px; flex: none; font-size: 13px; color: var(--secondary); }
.row-title { flex: 1; min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* the selected row, where the inspector beside it shows it (on a phone the list is not shown with it) */
@media (min-width: 900px) {
  .row[aria-current="true"] { background: var(--selection); color: var(--on-action); }
  .row[aria-current="true"] .row-time { color: var(--on-action); }
  .row[aria-current="true"] .kind { background: rgba(255,255,255,0.2); color: var(--on-action); }
  .row[aria-current="true"] .pill { background: var(--surface); }
}
.empty-state { padding: 44px 20px; text-align: center; color: var(--secondary); }

.inspector { min-height: 0; overflow: auto; padding: 24px 22px 32px; background: var(--canvas); border-left: 1px solid var(--separator); }
.back { display: none; }
.insp-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.insp-title { margin: 14px 0 18px; font-size: 18px; line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
.insp-note { margin: -8px 0 14px; color: var(--label); font-size: 13px; }
.facts { margin: 0 0 14px; padding: 0; list-style: none; background: var(--surface); border-radius: 12px; box-shadow: var(--shadow-card); }
.facts > div, .facts > li { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 11px 14px;
  border-top: 1px solid var(--separator); font-size: 13.5px; }
.facts > :first-child { border-top: 0; }
.facts dt { color: var(--secondary); flex: none; }
.facts dd { margin: 0; min-width: 0; text-align: right; font-weight: 500; overflow-wrap: anywhere; }
.facts .stack { display: block; }
.facts .stack dd { margin-top: 3px; text-align: left; font-weight: 400; }
.facts .sub { display: block; font-size: 12px; font-weight: 400; color: var(--secondary); }
.facts .ok { color: var(--ok); }
.facts .wait { color: var(--warn); }
.hash-full, .prints .hash { display: block; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; word-break: break-all; color: var(--label); }
.file-row { display: flex; align-items: center; gap: 10px; }
.file-row > svg { width: 18px; height: 18px; color: var(--link); }
.file-row .file-name { flex: 1; min-width: 0; }
details.tech .facts { margin-top: 10px; }
.seals details.tech > summary.line { width: 100%; color: var(--text); font-size: 14px; }
.seals details.tech > summary.line:hover { background: var(--fill); }
.seals details.tech > .facts { margin: 0 18px 16px; }

/* the systems page */
.table .line { display: grid; grid-template-columns: minmax(0, 2fr) 150px 90px 160px; gap: 14px; }
.table .head { min-height: 40px; font-size: 12px; font-weight: 600; color: var(--secondary); background: var(--canvas); }
.table .num { text-align: right; }
.table .when { text-align: right; color: var(--secondary); font-size: 13px; }
.cell-main { min-width: 0; }
.cell-main strong { display: block; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cell-main span { font-size: 12.5px; color: var(--secondary); }
.views { margin: 0 0 16px; }

/* settings blocks */
.blocks { display: flex; flex-direction: column; gap: 14px; }
.block { display: flex; gap: 16px; padding: 20px; }
.block > div { flex: 1; min-width: 0; }
.block h2 { margin: 6px 0 12px; font-size: 15px; }
.lockline { display: flex; gap: 10px; align-items: center; padding: 12px 14px; border-radius: 10px; background: var(--fill);
  font-size: 14px; }
.lockline svg { width: 16px; height: 16px; color: var(--secondary); }
.meter { height: 8px; border-radius: 99px; background: var(--fill); overflow: hidden; margin: 12px 0 8px; }
.meter span { display: block; height: 100%; background: var(--action); border-radius: 99px; }
.meter.red span { background: var(--bad); }
.spread { display: flex; justify-content: space-between; gap: 12px; }

/* a system's key and the three ways to connect an agent */
.label { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--label); }
.keybox { display: block; padding: 14px 16px; border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-card);
  font-family: var(--mono); font-size: 13.5px; word-break: break-all; user-select: all; -webkit-user-select: all; }
.key-note { display: flex; gap: 8px; align-items: center; margin: 10px 0 30px; color: var(--warn); font-weight: 500; }
.key-note svg { width: 16px; height: 16px; }
.ways { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 0 16px; }
.way { display: flex; flex-direction: column; gap: 12px; padding: 18px; border-radius: 14px; background: var(--surface);
  box-shadow: var(--shadow-card); color: var(--text); font-size: 15px; font-weight: 600; cursor: pointer; }
.way .tile-icon { width: 38px; height: 38px; }
.way small { font-size: 12px; font-weight: 600; color: var(--link); }
.code { display: none; margin: 0; padding: 20px 22px; border-radius: 14px; background: var(--code); color: var(--on-code);
  font: 13px/1.65 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
#way-python:checked ~ .ways [for="way-python"] { box-shadow: 0 0 0 2px var(--action); }
#way-python:focus-visible ~ .ways [for="way-python"] { outline: 2px solid var(--focus); outline-offset: 2px; }
#way-python:checked ~ .code.python { display: block; }
#way-model:checked ~ .ways [for="way-model"] { box-shadow: 0 0 0 2px var(--action); }
#way-model:focus-visible ~ .ways [for="way-model"] { outline: 2px solid var(--focus); outline-offset: 2px; }
#way-model:checked ~ .code.model { display: block; }
.wait-line { display: flex; align-items: center; gap: 12px; margin-top: 16px; padding: 14px 18px; font-weight: 500; }
.wait-line .end { margin-left: auto; }
.wait-line.green { color: var(--ok); }
.wait-line svg { width: 18px; height: 18px; }
.spinner { width: 16px; height: 16px; flex: none; border-radius: 50%; border: 2px solid var(--separator); border-top-color: var(--action);
  animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }

/* first run */
.steps .line { min-height: 68px; padding: 14px 20px; }
.steps .later { opacity: 0.55; }

/* verify a document */
.drop { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 30px 16px; border: 1.5px dashed var(--control);
  border-radius: 14px; background: var(--surface); text-align: center; color: var(--text); font-weight: 400; }
.drop .tile-icon { width: 44px; height: 44px; margin-bottom: 6px; }
.drop strong { font-size: 15px; }
.drop input[type="file"] { max-width: 100%; margin-top: 6px; padding: 0; border: 0; background: none; font-size: 13px; color: var(--secondary); }
.drop input[type="file"]::file-selector-button { margin-right: 10px; padding: 7px 14px; border: 1px solid var(--control); border-radius: 10px;
  background: var(--surface); color: var(--text); font: inherit; font-weight: 500; cursor: pointer; }
.or { display: flex; align-items: center; gap: 12px; margin: 20px 0; color: var(--secondary); font-size: 13px; font-weight: 400; }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--separator); }
#sigillo-doc-button { width: 100%; margin-top: 12px; }
.privacy { display: flex; gap: 6px; align-items: center; margin-top: 12px; color: var(--secondary); font-size: 13px; }
.privacy svg { width: 15px; height: 15px; }
.result { display: flex; gap: 14px; align-items: flex-start; padding: 20px; }
.result h3 { margin: 2px 0 6px; font-size: 16px; }
.result p { margin: 0 0 6px; line-height: 1.5; }
.matches { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.matches a { font-weight: 500; }
.placeholder { padding: 40px; text-align: center; color: var(--secondary); }
.prints { margin: 0; font-size: 12.5px; color: var(--label); }
.prints p { margin: 0 0 8px; }

/* not found */
.lost { padding-top: 100px; text-align: center; }
.lost .tile-icon { width: 56px; height: 56px; border-radius: 16px; margin: 0 auto 18px; }
.lost .tile-icon svg { width: 26px; height: 26px; }
.lost h1 { margin-bottom: 24px; }

/* signing in: one column in the middle */
.auth { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px 16px; background: var(--canvas); }
.auth-box { width: 100%; max-width: 360px; text-align: center; }
.auth-box > svg { width: 48px; height: 48px; margin-bottom: 14px; }
.auth-box .tile-icon { width: 56px; height: 56px; border-radius: 16px; margin: 0 auto 18px; }
.auth-box .tile-icon svg { width: 26px; height: 26px; }
.auth-box h1 { margin: 0 0 28px; font-size: 24px; }
.auth-box .message { margin: -12px 0 24px; font-size: 15px; line-height: 1.5; }
.auth-box form { display: flex; flex-direction: column; gap: 12px; margin: 0; }
.auth-box input { min-height: 44px; padding: 0 14px; border-color: var(--separator); border-radius: 10px; font-size: 15px; }
.auth-box .button, .auth-box button { width: 100%; min-height: 44px; border-radius: 10px; font-size: 15px; }
.auth-box .or { margin: 20px 0; }
.chip { display: inline-flex; gap: 8px; align-items: center; margin: -12px 0 24px; padding: 6px 12px; border-radius: 999px;
  background: var(--fill); font-size: 14px; overflow-wrap: anywhere; }
.auth-foot { display: flex; justify-content: center; gap: 8px 18px; flex-wrap: wrap; margin-top: 22px; font-size: 13px; }
.auth-box .notice { text-align: left; }
.auth-box .auth-lang { flex-direction: row; justify-content: center; gap: 4px; margin-top: 28px; }
.auth-box .auth-lang button { width: auto; min-height: 32px; padding: 0 10px; border: 0; background: none; box-shadow: none; font-size: 13px; color: var(--secondary); }
.auth-box .auth-lang button[aria-pressed="true"] { color: var(--text); font-weight: 600; }

/* narrow windows and phones: the sidebar becomes a menu, the inspector a page */
@media (max-width: 899px) {
  body { font-size: 15px; }
  .app { display: block; }
  .topbar { display: flex; position: sticky; top: 0; z-index: 5; align-items: center; justify-content: space-between; gap: 12px;
    min-height: 56px; padding: 6px 8px 6px 16px; background: var(--bg); border-bottom: 1px solid var(--separator); }
  .topbar .brand { padding: 0; min-height: 44px; font-size: 16px; }
  .topbar .brand svg { width: 26px; height: 26px; }
  .menu-open, .menu-close { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px;
    border-radius: 9px; color: var(--secondary); }
  .menu-open { background: var(--fill); }
  .menu-open svg, .menu-close svg { width: 20px; height: 20px; }
  .sidebar { display: none; }
  .sidebar:target { display: block; position: fixed; inset: 0; z-index: 20; overflow: auto; border: 0; }
  .sidebar:target .sidebar-inner { position: static; height: auto; min-height: 100%; padding: 8px 12px 24px; }
  .side-top .brand { padding: 8px 8px 14px; }
  .side-item { min-height: 44px; font-size: 15px; }
  .side-head { font-size: 13px; min-height: 44px; }
  .side-add, .icon-button { width: 44px; height: 44px; }
  .content { padding: 20px 16px 40px; }
  h1 { font-size: 24px; }
  button, .button, input, select { min-height: 44px; }
  input, select, textarea { font-size: 16px; }
  .tabs a { min-height: 44px; }
  .segmented a, .segmented button { min-height: 40px; font-size: 14px; }
  details.fold > summary, details.tech > summary { min-height: 44px; }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .cols, .cols.even { grid-template-columns: minmax(0, 1fr); }
  .fields-row { grid-template-columns: minmax(0, 1fr); }
  .sys-head { padding: 18px 16px 0; }
  .titleline .end .label-long { display: none; }
  .system-body { padding: 18px 16px 40px; }
  .studio { display: block; height: auto; }
  .studio-list { overflow: visible; }
  .toolbar { padding: 12px 68px 12px 16px; }
  details.search > summary { right: 16px; top: 12px; width: 44px; height: 44px; }
  details.search form { grid-template-columns: minmax(0, 1fr); }
  .filter-line { padding: 10px 16px 0; }
  .rows-scroll { overflow: visible; padding: 4px 6px 24px; }
  .day { margin: 14px 10px 6px; }
  .row { min-height: 56px; }
  .inspector { display: none; }
  .studio.has-selection .studio-list { display: none; }
  .studio.has-selection .inspector { display: block; border: 0; padding: 12px 16px 40px; overflow: visible; }
  .back { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; margin: 0 0 8px; font-weight: 500; }
  .back svg { width: 16px; height: 16px; }
  .facts > div, .facts > li { flex-wrap: wrap; }
  .sheet-layer:target { padding: 0; }
  .sheet { width: 100%; min-height: 100%; border-radius: 0; }
  .sheet-body { padding: 20px 16px; }
  .sheet-foot { padding: 14px 16px; }
  .sheet-foot > * { flex: 1; }
  .line { padding: 10px 14px; }
  .line-aside.system { display: none; }
  .table .head { display: none; }
  .table .line { grid-template-columns: minmax(0, 1fr) auto; }
  .table .num { display: none; }
  .table .when { grid-column: 1 / -1; text-align: left; margin-top: -8px; }
  .ways { gap: 8px; }
  .way { padding: 12px; font-size: 13px; }
  .code { font-size: 11.5px; padding: 16px; }
  .block { padding: 16px; }
  .lost { padding-top: 60px; }
  .facts a, .matches a { display: inline-flex; align-items: center; min-height: 44px; }
}
`;

/**
 * The seal: two concentric circles and a solid diamond, in the brand colour.
 * Drawn here rather than shipped as an image, because the content security
 * policy allows no image from anywhere.
 */
export const SEAL_SVG = `<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
<circle cx="24" cy="24" r="22" style="fill: none; stroke: var(--brand); stroke-width: 2"/>
<circle cx="24" cy="24" r="16" style="fill: none; stroke: var(--brand); stroke-width: 1.25"/>
<polygon points="24,15 33,24 24,33 15,24" style="fill: var(--brand)"/>
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

/** The interface's line icons, from the mockups (design/proposta-b), 24-unit grid. */
const line = (shape: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round">${shape}</svg>`;

export const ICONS = {
  home: line('<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>'),
  plus: line('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  list: line(
    '<path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  ),
  docCheck: line('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 14l2 2 4-4"/>'),
  doc: line('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>'),
  people: line(
    '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.9-3 3-4.5 5.5-4.5s4.6 1.5 5.5 4.5"/><circle cx="17" cy="8" r="2.4"/><path d="M16 13.2c2.3.1 3.9 1.6 4.5 4.3"/>',
  ),
  key: line('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9"/><path d="M17 6l3 3"/>'),
  logout: line('<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>'),
  search: line('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  download: line('<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'),
  chevronRight: line('<path d="M9 6l6 6-6 6"/>'),
  chevronLeft: line('<path d="M15 6l-6 6 6 6"/>'),
  info: line('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r=".7" style="fill: currentColor"/>'),
  seal: line('<circle cx="12" cy="12" r="9"/><path d="M12 7l5 5-5 5-5-5z"/>'),
  folder: line(
    '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v2"/><path d="M12 7v2"/><path d="M12 11v2"/><rect x="10.5" y="14" width="3" height="4" rx="1"/>',
  ),
  tag: line('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>'),
  archive: line('<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v10h14V9"/><path d="M10 13h4"/>'),
  trash: line('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>'),
  lock: line('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  code: line('<path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/><path d="M13.5 5l-3 14"/>'),
  link: line(
    '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  ),
  menu: line('<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>'),
  close: line('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>'),
  gear: line(
    '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="M4.9 4.9L7 7"/><path d="M17 17l2.1 2.1"/><path d="M4.9 19.1L7 17"/><path d="M17 7l2.1-2.1"/>',
  ),
  building: line('<path d="M4 21V4h11v17"/><path d="M15 9h5v12"/><path d="M8 8h3"/><path d="M8 12h3"/><path d="M8 16h3"/>'),
  mail: line('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
  clock: line('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  upload: line('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/>'),
  python: line(
    '<path d="M12 3c-4 0-4 2-4 3v2h5v1H6c-2 0-3 1-3 4s1 4 3 4h1v-2c0-2 1-3 3-3h5c1 0 2-1 2-2V6c0-2-2-3-5-3z"/><path d="M12 21c4 0 4-2 4-3v-2h-5v-1h7c2 0 3-1 3-4s-1-4-3-4h-1v2c0 2-1 3-3 3h-5c-1 0-2 1-2 2v4c0 2 2 3 5 3z"/>',
  ),
} as const;

/** Google's "G", in Google's own colours, as its sign-in guidelines ask for the button. */
export const GOOGLE_LOGO = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
<path style="fill: #EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
<path style="fill: #4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
<path style="fill: #FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
<path style="fill: #34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

/** One icon per kind of action, same grid: a wrench, a chip, a step, a fork, an open book. */
export const KIND_ICONS = {
  tool_call: line('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5l3 3 5.8-5.8a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
  llm_call: line(
    '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v4"/><path d="M14 3v4"/><path d="M10 17v4"/><path d="M14 17v4"/><path d="M3 10h4"/><path d="M3 14h4"/><path d="M17 10h4"/><path d="M17 14h4"/>',
  ),
  agent_step: line('<circle cx="12" cy="12" r="9"/><path d="M10.5 8l4 4-4 4"/>'),
  decision: line(
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 5-6 4-11 8.5"/>',
  ),
  genesis: line('<path d="M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4z"/><path d="M20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z"/>'),
} as const;
