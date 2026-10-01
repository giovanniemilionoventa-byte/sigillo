/**
 * The look of the operator's view: direction "B", three panes in the manner
 * of a macOS application (sidebar, content, inspector). design/DESIGN.md and
 * design/tokens.json are the source of truth; the custom properties on :root
 * below are those tokens, one for one (apps/server/test/style.test.ts checks
 * it), and nothing else in this file names a colour except the two shadows
 * and the selected row's translucent icon ground, which DESIGN.md lists.
 *
 * The theme follows the reader's operating system. The state colours are
 * never the only signal: every state carries an icon of its own shape and a
 * word.
 *
 * Everything is inline CSS: the content security policy (deploy/Caddyfile)
 * allows no stylesheet or image from anywhere. The seal and the icons are
 * inline SVG. Nothing here needs a script: the phone menu and the evidence
 * sheet open with :target, the technical details with <details>.
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

export const STYLE = `
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
  --shadow-card: 0 0 0 1px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-sheet: 0 24px 60px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.08);
  --shadow-segment: 0 1px 3px rgba(0,0,0,0.14);
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
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
    --shadow-card: 0 0 0 1px var(--separator);
    --shadow-sheet: 0 24px 60px rgba(0,0,0,0.6), 0 0 0 1px var(--separator);
    --shadow-segment: 0 1px 3px rgba(0,0,0,0.5);
  }
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { background: var(--bg); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--canvas); color: var(--text); font: 400 13px/1.45 var(--font);
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
code, .mono { font-family: var(--mono); font-size: 12px; }
p { margin: 0 0 8px; }
h1, h2, h3 { margin: 0; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.cap { display: inline-block; }
.cap::first-letter, .eyebrow::first-letter, .status-word::first-letter { text-transform: uppercase; }
.status-word { display: inline-block; }
.skip { position: absolute; left: -999px; top: 0; }
.skip:focus { left: 16px; top: 16px; z-index: 30; background: var(--surface); color: var(--text); padding: 8px 16px;
  border-radius: 8px; box-shadow: var(--shadow-card); }
svg { flex: none; }

/* the shell: sidebar and content */
.app { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
.topbar { display: none; }
.sidebar { background: var(--sidebar); border-right: 1px solid var(--sidebar-rule); }
.sidebar-inner { position: sticky; top: 0; height: 100vh; overflow: auto; display: flex; flex-direction: column; gap: 2px;
  padding: 16px 10px 14px; }
.side-top { display: flex; align-items: flex-start; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: 10px; padding: 2px 10px 14px; color: var(--text); }
.brand:hover { text-decoration: none; }
.brand svg { width: 28px; height: 28px; }
.wordmark { display: block; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.2; }
.tagline { display: block; font-size: 10.5px; color: var(--secondary); line-height: 1.3; }
.menu-close { display: none; }
.side-nav { display: flex; flex-direction: column; gap: 2px; }
.side-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.side-item { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 34px; padding: 0 10px; border: 0;
  border-radius: 8px; background: transparent; color: var(--text); font: inherit; font-size: 13px; text-align: left;
  cursor: pointer; }
.side-item:hover { background: var(--hover); text-decoration: none; }
.side-item[aria-current="page"] { background: var(--current); font-weight: 600; }
.side-item > svg { width: 16px; height: 16px; color: var(--secondary); }
.side-item > .dot svg { width: 15px; height: 15px; }
.side-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-count { font-size: 11px; color: var(--secondary); }
.side-head { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 4px; padding: 0 2px 0 10px;
  font-size: 11px; font-weight: 600; color: var(--secondary); min-height: 28px; }
.side-head a { color: inherit; }
.side-head a[aria-current="page"] { color: var(--text); }
.side-add { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border-radius: 7px;
  color: var(--link) !important; }
.side-add:hover { background: var(--hover); }
.side-add svg { width: 15px; height: 15px; }
.side-foot { margin-top: auto; padding: 12px 10px 0; border-top: 1px solid var(--sidebar-rule); display: flex;
  flex-direction: column; gap: 6px; }
.side-key { display: flex; align-items: flex-start; gap: 8px; margin: 0; color: var(--secondary); font-size: 11px;
  overflow-wrap: anywhere; }
.side-key svg { width: 14px; height: 14px; margin-top: 1px; }
.side-key code { font-size: 11px; }
.side-foot form { margin: 0; }
.side-foot .side-item { padding: 0; }
.side-foot .side-item:hover { background: transparent; text-decoration: underline; }

.content { min-width: 0; padding: 28px 32px 40px; background: var(--canvas); }

/* headings */
.eyebrow { margin: 0; font-size: 12px; font-weight: 600; color: var(--secondary); }
h1 { margin-top: 4px; font-size: 26px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.2; overflow-wrap: anywhere; }
.page-head { margin: 0 0 22px; }
.page-head-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.headline { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
.headline h1 { margin: 0; }
.lead { margin: 8px 0 0; max-width: 680px; color: var(--secondary); font-size: 14px; }
.intro { margin: 10px 0 0; max-width: 680px; color: var(--label); line-height: 1.55; }
.block { margin: 0 0 20px; min-width: 0; }
.block-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 0 4px 8px; }
.block-head h2, .block > h2 { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
.block > h2 { margin: 0 4px 8px; }
.block-meta { font-size: 12px; color: var(--secondary); }
.section-title { margin: 30px 4px 4px; font-size: 17px; font-weight: 700; letter-spacing: -0.01em; }
.section-hint { margin: 0 4px 12px; color: var(--secondary); max-width: 760px; }
.hint { color: var(--secondary); font-size: 12px; margin: 6px 0 0; }
.muted { color: var(--secondary); }
.empty { color: var(--secondary); padding: 16px; margin: 0; }

/* cards and notes */
.card { background: var(--surface); border-radius: 12px; box-shadow: var(--shadow-card); }
.card.padded { padding: 16px 18px; }
.card-list { list-style: none; margin: 0; padding: 0; overflow: hidden; }
.card-list > li + li { border-top: 1px solid var(--separator-soft); }
.note { display: flex; gap: 10px; align-items: flex-start; margin: 0; padding: 10px 12px; border-radius: 9px;
  background: var(--fill); color: var(--label); line-height: 1.5; }
.note svg { width: 16px; height: 16px; margin-top: 1px; color: var(--secondary); }
.notice { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 16px; padding: 10px 14px; border-radius: 10px;
  background: var(--surface); box-shadow: var(--shadow-card); color: var(--text); line-height: 1.5; max-width: 760px; }
.notice svg { width: 16px; height: 16px; margin-top: 1px; }
.notice.ok svg { color: var(--ok); }
.notice.bad { background: var(--bad-fill); box-shadow: none; }
.notice.bad svg { color: var(--bad); }
p.warn { margin: 0 0 16px; padding: 10px 14px; border-radius: 10px; background: var(--warn-fill); color: var(--text);
  line-height: 1.5; max-width: 760px; }
.info-line { display: flex; gap: 10px; align-items: flex-start; margin: 0 4px 16px; max-width: 680px; color: var(--label); }
.info-line svg { width: 16px; height: 16px; margin-top: 1px; color: var(--secondary); }
.info-line p { margin: 0; }
.pill-note { display: inline-flex; align-items: center; gap: 7px; margin: 10px 0 0; padding: 6px 12px; border-radius: 999px;
  background: var(--surface); box-shadow: var(--shadow-card); color: var(--label); }
.pill-note svg { width: 14px; height: 14px; color: var(--secondary); }

/* the state: always an icon of its own shape, a word, and a colour */
.stamp { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; font-size: 12px; white-space: nowrap; }
.stamp.green, .dot.green { color: var(--ok); }
.stamp.yellow, .dot.yellow { color: var(--warn); }
.stamp.red, .dot.red { color: var(--bad); }
.stamp.archived, .dot.archived { color: var(--secondary); }
.dot { display: inline-flex; flex: none; }
.dot svg { width: 15px; height: 15px; }
.pill { display: inline-flex; align-items: center; gap: 4px; flex: none; padding: 2px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; white-space: nowrap; }
.pill svg { width: 12px; height: 12px; }
.pill.green { background: var(--ok-fill); color: var(--ok); }
.pill.yellow { background: var(--warn-fill); color: var(--warn); }
.pill.red { background: var(--bad-fill); color: var(--bad); }
.pill.large { padding: 3px 10px 3px 8px; font-size: 12px; }
.pill.large svg { width: 13px; height: 13px; }
.state-disc { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: none; }
.state-disc svg { width: 22px; height: 22px; }
.state-disc.green { background: var(--ok-fill); color: var(--ok); }
.state-disc.yellow { background: var(--warn-fill); color: var(--warn); }
.state-disc.red { background: var(--bad-fill); color: var(--bad); }
.state-disc.small { width: 36px; height: 36px; }
.state-disc.small svg { width: 20px; height: 20px; }
.badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; background: var(--fill);
  color: var(--secondary); font-size: 11px; font-weight: 600; vertical-align: middle; letter-spacing: 0; }
.badge::before { content: ""; flex: none; width: 11px; height: 11px; border: 1.5px solid currentColor; border-radius: 50%;
  background: linear-gradient(currentColor, currentColor) center / 5px 1.5px no-repeat; }

/* the kind of an action: an icon in a rounded square */
.kind { width: 30px; height: 30px; flex: none; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
.kind svg { width: 16px; height: 16px; }
.kind.small { width: 28px; height: 28px; }
.kind.large { width: 46px; height: 46px; border-radius: 12px; margin-top: 14px; }
.kind.large svg { width: 22px; height: 22px; }
.kind.tool_call { background: var(--kind-tool-fill); color: var(--kind-tool); }
.kind.llm_call { background: var(--kind-model-fill); color: var(--kind-model); }
.kind.agent_step { background: var(--kind-step-fill); color: var(--kind-step); }
.kind.decision { background: var(--kind-decision-fill); color: var(--kind-decision); }
.kind.genesis { background: var(--kind-genesis-fill); color: var(--kind-genesis); }
.icon-tile { width: 32px; height: 32px; flex: none; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
.icon-tile svg { width: 18px; height: 18px; }
.icon-tile.blue { background: var(--kind-tool-fill); color: var(--kind-tool); }
.icon-tile.grey { background: var(--kind-genesis-fill); color: var(--kind-genesis); }
.icon-tile.purple { background: var(--kind-decision-fill); color: var(--kind-decision); }
.icon-tile.green { background: var(--ok-fill); color: var(--ok); }
.icon-tile.red { background: var(--bad-fill); color: var(--bad); }

/* controls */
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; padding: 0 14px;
  border: 1px solid var(--control); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit;
  font-size: 13px; font-weight: 500; cursor: pointer; text-decoration: none; }
button:hover, .button:hover { background: var(--fill); text-decoration: none; }
button svg, .button svg { width: 15px; height: 15px; }
button.primary, .button.primary, #sigillo-doc-button { background: var(--action); border-color: var(--action);
  color: var(--on-action); font-weight: 600; }
button.primary:hover, .button.primary:hover, #sigillo-doc-button:hover { background: var(--action); filter: brightness(0.92); }
button.danger { background: var(--danger); border-color: var(--danger); color: var(--on-action); font-weight: 600; }
button.danger:hover { background: var(--danger); filter: brightness(0.92); }
button:disabled, button:disabled:hover { cursor: not-allowed; opacity: 0.5; filter: none; }
button.wide, .button.wide { width: 100%; }
label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; font-weight: 600; color: var(--label); }
input, select, textarea { width: 100%; min-height: 34px; padding: 0 10px; border: 1px solid var(--control); border-radius: 8px;
  background: var(--surface); color: var(--text); font: inherit; font-size: 13px; font-weight: 400; }
textarea { padding: 10px 12px; min-height: 8rem; resize: vertical; line-height: 1.5; }
input[type="file"] { padding: 6px; }
input[aria-invalid="true"] { border-color: var(--bad); }
::placeholder { color: var(--secondary); opacity: 1; }
.fields { display: flex; flex-direction: column; gap: 12px; margin: 0; }
.fields-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.fields-inline { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.fields-inline > label { flex: 1; min-width: 200px; }
.actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin: 10px 4px 0; }
.actions .hint { flex: 1; min-width: 240px; margin: 0; }
form.inline { display: inline; margin: 0; }

/* disclosures folded into a form */
details.fold { margin: 0; }
details.fold > summary { display: flex; align-items: center; gap: 6px; min-height: 32px; width: fit-content; cursor: pointer;
  color: var(--link); font-weight: 500; list-style: none; }
details.fold > summary::-webkit-details-marker { display: none; }
details.fold > summary svg { width: 14px; height: 14px; transition: transform 0.1s; }
details.fold[open] > summary svg { transform: rotate(90deg); }
details.fold > .fold-body { display: flex; flex-direction: column; gap: 12px; padding-top: 6px; }

/* tabs and segmented controls */
.tabs { display: flex; gap: 22px; margin-top: 10px; }
.tabs a { display: flex; align-items: center; min-height: 40px; padding: 0 2px; border-bottom: 2px solid transparent;
  color: var(--secondary); font-weight: 500; }
.tabs a:hover { color: var(--text); text-decoration: none; }
.tabs a[aria-current="page"] { border-bottom-color: var(--action); color: var(--text); font-weight: 600; }
.segmented { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 9px; background: var(--segment); }
.segmented a { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 10px; border-radius: 7px;
  color: var(--text); font-size: 12px; font-weight: 500; }
.segmented a:hover { text-decoration: none; background: var(--hover); }
.segmented a[aria-current="page"] { background: var(--segment-on); box-shadow: var(--shadow-segment); font-weight: 600; }
.segmented .count { font-size: 11px; color: var(--secondary); }
.segmented a[aria-current="page"] .count { color: var(--text); }

/* one system: header and tabs */
.system-page { padding: 0; }
.sys-head { padding: 16px 22px 0; border-bottom: 1px solid var(--separator); background: var(--bg); }
.sys-title-row { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.sys-title { flex: 1; min-width: 220px; }
.sys-title h1 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: -0.015em; }
.sys-meta { margin: 3px 0 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; color: var(--secondary); font-size: 12px; }
.sys-meta .stamp { font-size: 12px; }
.sys-meta .stamp svg { width: 13px; height: 13px; }
.sys-health { margin: 4px 0 0; color: var(--label); font-size: 12px; max-width: 680px; }
.system-body { padding: 22px 24px 40px; }
.sid { font-family: var(--mono); font-size: 12px; color: var(--secondary); overflow-wrap: anywhere; }

/* the evidence sheet, opened with :target */
.sheet-layer { display: none; }
.sheet-layer:target { display: flex; position: fixed; inset: 0; z-index: 10; align-items: flex-start; justify-content: center;
  padding: 70px 16px 16px; overflow: auto; background: var(--scrim); }
.sheet { width: min(520px, 100%); background: var(--surface); border-radius: 14px; box-shadow: var(--shadow-sheet); overflow: hidden; }
.sheet-head { display: flex; gap: 14px; align-items: flex-start; padding: 22px 24px 6px; }
.sheet-head .icon-tile { width: 40px; height: 40px; border-radius: 10px; }
.sheet-head h2 { font-size: 17px; font-weight: 700; overflow-wrap: anywhere; }
.sheet-head p { margin: 3px 0 0; color: var(--secondary); }
.sheet-body { display: flex; flex-direction: column; gap: 10px; padding: 14px 24px 4px; }
.sheet-body .group { font-size: 12px; font-weight: 600; color: var(--secondary); margin: 0; }
.sheet-body details.fold { margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--separator); }
.sheet-foot { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; padding: 14px 24px;
  background: var(--canvas); border-top: 1px solid var(--separator); }

/* the history: list and inspector side by side, each scrolling on its own */
.studio { display: grid; grid-template-columns: minmax(0, 1fr) 360px; height: 100vh; padding: 0; background: var(--bg); }
.studio-list { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.toolbar { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 10px 22px;
  border-bottom: 1px solid var(--separator-soft); }
.toolbar .list-count { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--secondary); }
details.search { padding: 0 22px; border-bottom: 1px solid var(--separator-soft); }
details.search > summary { display: flex; align-items: center; gap: 6px; min-height: 36px; width: fit-content; cursor: pointer;
  color: var(--link); font-weight: 500; list-style: none; }
details.search > summary::-webkit-details-marker { display: none; }
details.search > summary svg { width: 15px; height: 15px; }
details.search form { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px;
  align-items: end; padding: 4px 0 12px; }
.filter-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 0 0 10px; color: var(--secondary); font-size: 12px; }
.rows-scroll { flex: 1; min-height: 0; overflow: auto; padding: 8px 12px 24px; }
.day { margin: 8px 10px; font-size: 12px; font-weight: 600; color: var(--secondary); }
.day::first-letter { text-transform: uppercase; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.row { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 12px; border-radius: 10px;
  color: var(--text); scroll-margin: 12px; }
.row:hover { background: var(--fill); text-decoration: none; }
.row-time { width: 58px; flex: none; font-size: 12px; color: var(--secondary); }
.row-text { flex: 1; min-width: 0; }
.row-title, .row-sub { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-title { font-size: 14px; font-weight: 600; }
.row-sub { font-size: 12px; color: var(--secondary); }
.row-seq { flex: none; min-width: 38px; text-align: right; font-family: var(--mono); font-size: 11px; color: var(--secondary); white-space: nowrap; }
.row[aria-current="true"] { background: var(--selection); color: var(--on-action); }
.row[aria-current="true"] .row-time, .row[aria-current="true"] .row-sub, .row[aria-current="true"] .row-seq { color: var(--on-action); }
.row[aria-current="true"] .kind { background: rgba(255,255,255,0.2); color: var(--on-action); }
.row[aria-current="true"] .pill { background: var(--surface); }
.row[aria-current="true"]:focus-visible { outline-color: var(--focus); }
.empty-state { padding: 44px 20px; text-align: center; color: var(--secondary); }
.empty-state strong { display: block; color: var(--text); font-size: 15px; }
.empty-state p { margin: 6px 0 0; }

.inspector { min-height: 0; overflow: auto; padding: 22px 20px 28px; background: var(--canvas); border-left: 1px solid var(--separator); }
.back { display: none; }
.insp-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.insp-no { margin: 0; font-size: 11px; font-weight: 600; color: var(--secondary); }
.insp-sentence { margin: 12px 0 0; font-size: 16px; line-height: 1.35; font-weight: 600; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.insp-note { margin: 12px 0 0; padding: 11px 13px; border-radius: 12px; background: var(--surface); box-shadow: var(--shadow-card);
  color: var(--label); line-height: 1.5; }
.group-label { margin: 20px 0 6px 4px; font-size: 11px; font-weight: 600; color: var(--secondary); }
.facts { margin: 0; padding: 0; list-style: none; background: var(--surface); border-radius: 12px; box-shadow: var(--shadow-card); }
.facts > div, .facts > li { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 10px 14px;
  border-top: 1px solid var(--separator-soft); }
.facts > :first-child { border-top: 0; }
.facts dt { color: var(--secondary); flex: none; }
.facts dd { margin: 0; min-width: 0; text-align: right; overflow-wrap: anywhere; }
.facts .stack { display: block; }
.facts .stack dd { margin-top: 3px; text-align: left; }
.facts .sub { display: block; font-size: 11px; color: var(--secondary); }
.facts .note-row { color: var(--secondary); font-size: 12px; }
.hash-full { display: block; font-family: var(--mono); font-size: 11px; line-height: 1.5; word-break: break-all; color: var(--label); }
.file-row { display: flex; align-items: center; gap: 10px; }
.file-row > svg { width: 18px; height: 18px; color: var(--link); }
.file-row .file-name { flex: 1; min-width: 0; }
.file-row code { display: block; overflow-wrap: anywhere; }
details.tech { margin-top: 16px; }
details.tech > summary { display: flex; align-items: center; min-height: 34px; padding: 0 4px; width: fit-content; cursor: pointer;
  color: var(--link); list-style: none; }
details.tech > summary::-webkit-details-marker { display: none; }
details.tech .when-open, details.tech[open] .when-closed { display: none; }
details.tech[open] .when-open { display: inline; }
details.tech .facts { margin-top: 4px; }

/* the main page */
.split { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 20px; align-items: start; }
.split > .side-panel { position: sticky; top: 20px; }
.split.even { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.sys-row { display: flex; align-items: center; gap: 12px; padding: 12px 16px; color: var(--text); }
.sys-row:hover { background: var(--fill); text-decoration: none; }
.sys-row-text { flex: 1; min-width: 0; }
.sys-row-name { display: block; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.sys-row-meta { display: block; font-size: 12px; color: var(--secondary); }
.sys-row-meta code { font-size: 11px; }
.chevron { width: 14px; height: 14px; color: var(--secondary); }
.activity { display: flex; align-items: center; gap: 12px; padding: 10px 16px; color: var(--text); }
.activity:hover { background: var(--fill); text-decoration: none; }
.activity-time { width: 48px; flex: none; font-size: 12px; color: var(--secondary); }
.activity-time span { display: block; font-size: 11px; }
.activity-text { flex: 1; min-width: 0; }
.activity-who { display: block; font-size: 11px; font-weight: 600; color: var(--secondary); }
.activity-what { display: block; font-size: 13px; overflow-wrap: anywhere; }

/* the systems page */
.systems-grid { display: grid; grid-template-columns: minmax(0, 2.2fr) 1fr 0.7fr 1.5fr minmax(150px, auto); gap: 12px; align-items: center; }
.systems-head { padding: 10px 16px; border-bottom: 1px solid var(--separator); font-size: 11px; font-weight: 600; color: var(--secondary); }
.systems-list { list-style: none; margin: 0; padding: 0; }
.systems-list > li { padding: 12px 16px; }
.systems-list > li + li { border-top: 1px solid var(--separator-soft); }
.systems-list .cell-label { display: none; }
.systems-list .system-name { display: block; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.systems-list .system-name a { color: var(--text); }
.systems-list .connection { display: block; font-size: 12px; color: var(--secondary); }
.systems-list .connection code { font-size: 11px; }
.systems-list .when { font-size: 12px; color: var(--secondary); }
.systems-list .links { display: flex; gap: 12px; flex-wrap: wrap; }
.systems-list .links a { display: inline-flex; align-items: center; min-height: 24px; }
.systems-list .archived-on { display: block; font-size: 11px; color: var(--secondary); }
.ways { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.way { padding: 16px; }
.way h3 { margin: 10px 0 4px; font-size: 14px; font-weight: 700; }
.way p { margin: 0; color: var(--secondary); line-height: 1.5; }
.create-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 12px; align-items: end; }
.log { list-style: none; margin: 0; padding: 0; }
.log li { padding: 10px 16px; font-size: 12px; overflow-wrap: anywhere; }
.log li + li { border-top: 1px solid var(--separator-soft); }
.token-box { margin: 8px 0 16px; padding: 12px 16px; border-radius: 10px; background: var(--surface); box-shadow: var(--shadow-card);
  font-family: var(--mono); font-size: 14px; word-break: break-all; }
pre.code { margin: 8px 0 0; padding: 14px 16px; border-radius: 10px; background: var(--fill); overflow-x: auto;
  font: 12px/1.5 var(--mono); }
.created-way { margin: 0 0 14px; padding: 16px 18px; }
.created-way h3 { margin: 0 0 4px; font-size: 14px; font-weight: 700; }
.created-way p { color: var(--secondary); margin: 0; line-height: 1.5; }

/* manage */
.stack-cards { display: flex; flex-direction: column; gap: 14px; max-width: 720px; }
.manage-card { display: flex; gap: 14px; align-items: flex-start; padding: 18px 20px; }
.manage-card > div { flex: 1; min-width: 0; }
.manage-card h2 { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
.manage-card .card-text { margin: 4px 0 12px; color: var(--secondary); line-height: 1.5; }
.manage-card .note { margin-top: 8px; }

/* checkpoints */
.checkpoints { list-style: none; margin: 0; padding: 0; }
.checkpoints > li { display: grid; grid-template-columns: 120px minmax(0, 1fr) minmax(0, 1.2fr); gap: 18px; padding: 16px 18px; }
.checkpoints > li + li { border-top: 1px solid var(--separator-soft); }
.cp-size { display: block; font-size: 24px; font-weight: 700; line-height: 1.1; }
.cp-caption { display: block; font-size: 12px; color: var(--secondary); }
.cp-caption + .hash-full { margin-top: 0; }
.cp-value { display: block; }
.cp-gap { margin-top: 8px; }
.cp-time { display: block; margin-top: 4px; font-size: 15px; font-weight: 600; }
.cp-tsa { display: block; margin-top: 6px; font-size: 12px; color: var(--secondary); overflow-wrap: anywhere; }

/* verify a document */
.drop { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 22px 16px; border: 1.5px dashed var(--control);
  border-radius: 12px; background: var(--canvas); text-align: center; color: var(--text); font-size: 13px; font-weight: 400; }
.drop > svg { width: 28px; height: 28px; color: var(--link); }
.drop strong { font-size: 14px; }
.drop input[type="file"] { max-width: 100%; margin-top: 6px; background: var(--surface); }
.or { display: flex; align-items: center; gap: 10px; color: var(--secondary); font-size: 12px; font-weight: 400; }
.or::before, .or::after { content: ""; flex: 1; height: 1px; background: var(--separator); }
.text-field { gap: 10px; margin-top: 16px; }
#sigillo-doc-button { width: 100%; margin-top: 14px; }
.result-head { display: flex; gap: 12px; align-items: flex-start; }
.result-head h3 { font-size: 15px; font-weight: 700; }
.result-matches { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; line-height: 1.5; }
.result-matches .match-links { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 6px; }
.result-matches .match-links a { font-weight: 600; }
.result-prints { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--separator-soft); font-size: 12px; color: var(--secondary); }
.result-prints p { margin: 0 0 8px; }
.result-prints .hash { display: block; color: var(--text); font-family: var(--mono); font-size: 11px; word-break: break-all; }

/* people */
.token-head { display: flex; align-items: center; gap: 12px; }
.token-head code { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
.person-receipts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.person-receipt a { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 10px; background: var(--fill); color: var(--text); }
.person-receipt a:hover { text-decoration: none; background: var(--hover); }

/* the login page */
.login { display: grid; grid-template-columns: 480px minmax(0, 1fr); min-height: 100vh; background: var(--bg); }
.login-id { display: flex; flex-direction: column; padding: 52px; background: var(--sidebar); border-right: 1px solid var(--sidebar-rule); }
.login-brand { display: flex; align-items: center; gap: 12px; }
.login-brand svg { width: 44px; height: 44px; }
.login-brand .wordmark { font-size: 22px; letter-spacing: -0.015em; line-height: 1.15; }
.login-brand .tagline { font-size: 12px; }
.login-pitch { margin: auto 0 28px; font-size: 27px; line-height: 1.22; font-weight: 700; letter-spacing: -0.02em; }
.login-points { list-style: none; margin: 0 0 auto; padding: 0; display: flex; flex-direction: column; gap: 20px; font-size: 14px; }
.login-points li { display: flex; gap: 14px; align-items: flex-start; }
.login-points .icon-tile { width: 34px; height: 34px; border-radius: 9px; }
.login-points strong { display: block; font-weight: 600; }
.login-points span.muted { display: block; }
.login-main { display: flex; align-items: center; justify-content: center; padding: 48px; }
.login-form { width: 340px; max-width: 100%; }
.login-form h1 { margin: 0 0 6px; }
.login-form .lead { margin: 0 0 28px; }
.login-form input { min-height: 44px; padding: 0 12px; border-radius: 9px; font-size: 15px; }
.login-form button { width: 100%; min-height: 44px; margin-top: 16px; border-radius: 9px; font-size: 15px; }
.field-error { display: flex; gap: 8px; align-items: flex-start; margin: 10px 0 0; color: var(--bad); font-size: 13px; line-height: 1.45; }
.field-error svg { width: 16px; height: 16px; margin-top: 1px; }
.login-note { margin: 22px 0 0; font-size: 12px; color: var(--secondary); }

/* narrow windows and phones: the sidebar becomes a menu, the inspector a page */
@media (max-width: 899px) {
  body { font-size: 15px; }
  .app { display: block; }
  .topbar { display: flex; position: sticky; top: 0; z-index: 5; align-items: center; justify-content: space-between; gap: 12px;
    min-height: 56px; padding: 6px 8px 6px 16px; background: var(--sidebar); border-bottom: 1px solid var(--sidebar-rule); }
  .topbar .brand { padding: 0; min-height: 44px; }
  .topbar .tagline { display: none; }
  .menu-open, .menu-close { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding: 0 12px;
    border-radius: 8px; color: var(--link); font-weight: 600; }
  .menu-open svg, .menu-close svg { width: 18px; height: 18px; }
  .sidebar { display: none; }
  .sidebar:target { display: block; position: fixed; inset: 0; z-index: 20; overflow: auto; border: 0; }
  .sidebar:target .sidebar-inner { position: static; height: auto; min-height: 100%; padding: 8px 12px 24px; }
  .side-top .brand { padding: 8px 10px 14px; }
  .side-item { min-height: 44px; font-size: 15px; }
  .side-head { font-size: 13px; min-height: 44px; }
  .side-add { width: 44px; height: 44px; }
  .side-key, .side-key code { font-size: 13px; }
  .content { padding: 20px 16px 40px; }
  h1 { font-size: 24px; }
  button, .button, input, select { min-height: 44px; }
  input, select, textarea { font-size: 16px; }
  .tabs a { min-height: 44px; }
  .segmented a { min-height: 44px; font-size: 14px; padding: 0 12px; }
  .segmented .count { font-size: 13px; }
  details.fold > summary, details.search > summary, details.tech > summary { min-height: 44px; }
  .split, .split.even { grid-template-columns: minmax(0, 1fr); }
  .split > .side-panel { position: static; }
  .fields-row { grid-template-columns: minmax(0, 1fr); }
  .sys-head { padding: 14px 16px 0; }
  .sys-title h1 { font-size: 20px; }
  .sys-title-row > .button { width: 100%; }
  .system-body { padding: 18px 16px 40px; }
  .studio { display: block; height: auto; }
  .studio-list { overflow: visible; }
  .toolbar { padding: 10px 16px; }
  details.search { padding: 0 16px; }
  details.search form { grid-template-columns: minmax(0, 1fr); }
  .rows-scroll { overflow: visible; padding: 8px 8px 24px; }
  .row { min-height: 64px; gap: 10px; padding: 10px; }
  .row-time { width: auto; min-width: 44px; font-size: 12px; }
  .row-title { font-size: 15px; white-space: normal; }
  .row-sub { font-size: 13px; white-space: normal; }
  .inspector { display: none; }
  .studio.has-selection .studio-list { display: none; }
  .studio.has-selection .inspector { display: block; border: 0; padding: 16px 16px 40px; overflow: visible; }
  .back { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; margin: 0 0 8px; font-weight: 600; }
  .back svg { width: 16px; height: 16px; }
  .facts > div, .facts > li { flex-wrap: wrap; }
  .sheet-layer:target { padding: 0; }
  .sheet { width: 100%; min-height: 100%; border-radius: 0; }
  .sheet-head, .sheet-body { padding-left: 16px; padding-right: 16px; }
  .sheet-foot { padding: 14px 16px; }
  .sheet-foot > * { flex: 1; }
  .sys-row, .activity { padding: 12px; }
  .activity { align-items: flex-start; }
  .systems-head { display: none; }
  .systems-grid { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .systems-list .cell-label { display: inline; font-size: 12px; font-weight: 600; color: var(--secondary); margin-right: 6px; }
  .systems-list .links a { min-height: 44px; }
  .ways { grid-template-columns: minmax(0, 1fr); }
  .create-grid { grid-template-columns: minmax(0, 1fr); }
  .checkpoints > li { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .manage-card { padding: 16px; }
  .login { grid-template-columns: minmax(0, 1fr); }
  .login-id { padding: 24px 16px 8px; border: 0; }
  .login-pitch, .login-points { display: none; }
  .login-main { align-items: flex-start; padding: 24px 16px 40px; }
  .login-form { width: 100%; }
  .person-receipt a, .sys-row, .activity { min-height: 44px; }
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
} as const;

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
