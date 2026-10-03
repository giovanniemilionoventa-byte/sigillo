// Design demo "semplice": every screen of the web view as static HTML.
// Run: node build.mjs <outdir>; then shot.mjs renders PNGs.
import { writeFileSync, mkdirSync } from "node:fs";

const SEAL = `<svg viewBox="0 0 48 48" class="seal"><circle cx="24" cy="24" r="22" fill="none" stroke="var(--brand)" stroke-width="2"/><circle cx="24" cy="24" r="16" fill="none" stroke="var(--brand)" stroke-width="1.25"/><polygon points="24,15 33,24 24,33 15,24" fill="var(--brand)"/></svg>`;
const G = `<svg viewBox="0 0 48 48" width="18" height="18"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;
const ico = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  home: ico('<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  warn: ico('<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>'),
  ok: ico('<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>'),
  bad: ico('<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  doc: ico('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>'),
  people: ico('<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M16 15c3 0 5 2 5 5"/>'),
  list: ico('<path d="M8 6h13M8 12h13M8 18h13M3 6h.5M3 12h.5M3 18h.5"/>'),
  plus: ico('<path d="M12 5v14M5 12h14"/>'),
  tool: ico('<path d="M14 7a4 4 0 0 1 5 5l-8 8-4-4 8-8z"/>'),
  model: ico('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
  step: ico('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  decision: ico('<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M18 9c0 4-6 4-12 8"/>'),
  book: ico('<path d="M3 5h7a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H3zM21 5h-7a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h7z"/>'),
  copy: ico('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  py: ico('<path d="M12 3c-4 0-4 2-4 3v2h5v1H6c-2 0-3 1-3 4s1 4 3 4h1v-2c0-2 1-3 3-3h5c1 0 2-1 2-2V6c0-2-2-3-5-3z"/><path d="M12 21c4 0 4-2 4-3v-2h-5v-1h7c2 0 3-1 3-4s-1-4-3-4h-1v2c0 2-1 3-3 3h-5c-1 0-2 1-2 2v4c0 2 2 3 5 3z"/>'),
  otel: ico('<circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>'),
  api: ico('<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12"/>'),
  key: ico('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3"/>'),
  out: ico('<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>'),
  dl: ico('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  seal: ico('<circle cx="12" cy="12" r="9"/><path d="M12 7l5 5-5 5-5-5z"/>'),
  gear: ico('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>'),
  search: ico('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  chev: ico('<path d="M9 6l6 6-6 6"/>'),
  down: ico('<path d="M6 9l6 6 6-6"/>'),
  back: ico('<path d="M15 6l-6 6 6 6"/>'),
  archive: ico('<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>'),
  trash: ico('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
  menu: ico('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: ico('<path d="M6 6l12 12M18 6L6 18"/>'),
  upload: ico('<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>'),
  lock: ico('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  mail: ico('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
  clock: ico('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  building: ico('<path d="M4 21V4h11v17M15 9h5v12M8 8h3M8 12h3M8 16h3"/>'),
  user: ico('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
  filter: ico('<path d="M4 5h16l-6 8v6l-4-2v-4z"/>'),
};

const CSS = `
:root{--bg:#fff;--canvas:#fafafc;--sidebar:#f0f0f3;--surface:#fff;--fill:#f5f5f7;--current:#e2e2e7;--text:#1d1d1f;--secondary:#6e6e73;--separator:#e5e5ea;--action:#0071e3;--link:#0066cc;--brand:#8e2a24;--ok:#1b6e30;--ok-fill:#e3f3e7;--warn:#8a5a00;--warn-fill:#fbf0d9;--bad:#b3261e;--bad-fill:#fbe4e2;--scrim:rgba(0,0,0,.28);
--tool:#0066cc;--tool-f:#e5f0fc;--model:#0b6b6b;--model-f:#e2f4f4;--step:#4a4a8c;--step-f:#ececf6;--dec:#6e3fc9;--dec-f:#efe9fb;--gen:#48484a;--gen-f:#ededf0;--card:0 0 0 1px rgba(0,0,0,.07),0 1px 2px rgba(0,0,0,.04);
--font:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif;--mono:ui-monospace,Menlo,Consolas,"Liberation Mono",monospace}
.dark{--bg:#1c1c1e;--canvas:#161618;--sidebar:#1f1f21;--surface:#242426;--fill:#2c2c2e;--current:#343436;--text:#f5f5f7;--secondary:#a1a1a6;--separator:#38383a;--action:#0a6bd6;--link:#4da3ff;--brand:#e0857c;--ok:#5fd17f;--ok-fill:#1d3524;--warn:#f0b84a;--warn-fill:#3a2e12;--bad:#ff8a80;--bad-fill:#44221f;--scrim:rgba(0,0,0,.55);
--tool:#6cb2ff;--tool-f:#1b3149;--model:#4fd1c7;--model-f:#11393a;--step:#b4b4f5;--step-f:#2a2a48;--dec:#c9a8ff;--dec-f:#33264d;--gen:#d1d1d6;--gen-f:#3a3a3c;--card:0 0 0 1px #38383a}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--text);font:400 14px/1.45 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--link);text-decoration:none}
.mono{font-family:var(--mono);font-size:12.5px}
.muted{color:var(--secondary)}
/* login */
.login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
.lbox{width:100%;max-width:360px;text-align:center}
.lbox>.seal{width:48px;height:48px;margin-bottom:14px}
.lbox h1{font-size:24px;font-weight:600;letter-spacing:-.01em;margin:0 0 28px}
.lbox .msg{margin:-12px 0 24px;font-size:15px;line-height:1.5}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:44px;border-radius:10px;font:500 15px var(--font);border:0}
.btn-g{background:var(--surface);color:var(--text);box-shadow:inset 0 0 0 1px var(--separator)}
.btn-p{background:var(--action);color:#fff}
.btn-d{background:var(--bad);color:#fff}
.or{display:flex;align-items:center;gap:12px;color:var(--secondary);font-size:13px;margin:20px 0}
.or:before,.or:after{content:"";flex:1;height:1px;background:var(--separator)}
.input{width:100%;height:44px;border-radius:10px;border:1px solid var(--separator);background:var(--surface);color:var(--text);padding:0 14px;font:15px var(--font);margin-bottom:12px;text-align:left;display:flex;align-items:center}
.input.ph{color:var(--secondary)}
.input.focus{border-color:var(--action);box-shadow:0 0 0 3px rgba(0,113,227,.18)}
.input.err{border-color:var(--bad);box-shadow:0 0 0 3px rgba(179,38,30,.15)}
.errline{color:var(--bad);font-size:13px;text-align:left;margin:-4px 0 14px;display:flex;gap:6px;align-items:center}
.email-chip{display:inline-flex;gap:8px;align-items:center;padding:6px 12px;border-radius:999px;background:var(--fill);font-size:14px;margin:-12px 0 24px}
.lfoot{margin-top:22px;font-size:13px;display:flex;justify-content:center;gap:18px}
.bigicon{width:56px;height:56px;border-radius:16px;display:grid;place-items:center;margin:0 auto 18px}
.bigicon svg{width:26px;height:26px}
/* app */
.app{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
.side{background:var(--sidebar);border-right:1px solid var(--separator);padding:18px 12px;display:flex;flex-direction:column;gap:2px}
.brand{display:flex;align-items:center;gap:10px;padding:0 8px 18px;font-weight:600;font-size:17px}
.brand .seal{width:28px;height:28px}
.nav{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;color:var(--text);font-size:14px;white-space:nowrap}
.nav.on{background:var(--current);font-weight:600}
.nav .n{margin-left:auto;color:var(--secondary);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;flex:none;margin:0 4px}
.d-ok{background:var(--ok)}.d-w{background:#d99a0b}.d-bad{background:var(--bad)}.d-off{background:var(--secondary);opacity:.5}
.sect{display:flex;justify-content:space-between;align-items:center;padding:16px 10px 6px;font-size:12px;font-weight:600;color:var(--secondary)}
.sect svg{color:var(--action)}
.spacer{flex:1}
.acct{display:flex;align-items:center;gap:10px;padding:10px;border-radius:10px;border-top:1px solid var(--separator);margin-top:8px}
.avatar{width:30px;height:30px;border-radius:50%;background:var(--action);color:#fff;display:grid;place-items:center;font-weight:600;font-size:13px;flex:none}
.acct .who{line-height:1.25;min-width:0}.acct .who b{display:block;font-size:13px}.acct .who span{font-size:12px;color:var(--secondary)}
.acct .chev{margin-left:auto;color:var(--secondary)}
.main{padding:32px 40px;min-width:0}
.narrow{max-width:760px}
h1.page{font-size:26px;font-weight:600;letter-spacing:-.015em;margin:0 0 24px;display:flex;align-items:center;gap:12px}
.head{display:flex;align-items:center;gap:16px;margin-bottom:24px}
.head h1{margin:0}
.head .r{margin-left:auto;display:flex;gap:10px}
.status{display:flex;align-items:center;gap:12px;padding:16px 20px;border-radius:14px;font-weight:600;font-size:15px;margin-bottom:20px}
.s-w{background:var(--warn-fill);color:var(--warn)}.s-ok{background:var(--ok-fill);color:var(--ok)}.s-bad{background:var(--bad-fill);color:var(--bad)}
.status .more{margin-left:auto;font-weight:500;font-size:13px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}
.tile{background:var(--surface);box-shadow:var(--card);border-radius:14px;padding:14px 16px}
.tile b{display:block;font-size:24px;font-weight:600;letter-spacing:-.02em}
.tile span{font-size:13px;color:var(--secondary)}
.tile.w b{color:var(--warn)}.tile.bad b{color:var(--bad)}
.cols{display:grid;grid-template-columns:1fr 320px;gap:28px;align-items:start}
h2{font-size:17px;font-weight:600;margin:0 0 12px;display:flex;align-items:center}
h2 .r{margin-left:auto;font-size:13px;font-weight:500}
.card{background:var(--surface);border-radius:14px;box-shadow:var(--card);overflow:hidden}
.row{display:flex;align-items:center;gap:14px;padding:13px 18px;border-top:1px solid var(--separator)}
.row:first-child{border-top:0}
.row .t{font-weight:500;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .t small{font-weight:400;color:var(--secondary);font-size:13px;margin-left:6px}
.row .time{width:46px;color:var(--secondary);font-size:13px;font-variant-numeric:tabular-nums;flex:none}
.row.sel{background:var(--action);color:#fff}.row.sel .time,.row.sel .sys,.row.sel .t small{color:rgba(255,255,255,.8)}
.row.sel .k{background:rgba(255,255,255,.2);color:#fff}
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.p-w{background:var(--warn-fill);color:var(--warn)}.p-ok{background:var(--ok-fill);color:var(--ok)}.p-bad{background:var(--bad-fill);color:var(--bad)}.p-n{background:var(--fill);color:var(--secondary)}
.pill svg{width:13px;height:13px}
.k{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;flex:none}
.k-tool{background:var(--tool-f);color:var(--tool)}.k-model{background:var(--model-f);color:var(--model)}.k-step{background:var(--step-f);color:var(--step)}.k-dec{background:var(--dec-f);color:var(--dec)}.k-gen{background:var(--gen-f);color:var(--gen)}
.k-ok{background:var(--ok-fill);color:var(--ok)}.k-bad{background:var(--bad-fill);color:var(--bad)}.k-w{background:var(--warn-fill);color:var(--warn)}
.sys{color:var(--secondary);font-size:13px;flex:none}
.chev{color:var(--secondary);display:flex}
.form{padding:20px}
.lab{font-size:13px;font-weight:600;margin:0 0 6px}
.sel{height:40px;border-radius:9px;border:1px solid var(--separator);display:flex;align-items:center;padding:0 12px;margin-bottom:16px;background:var(--surface);gap:8px}
.sel .chev{margin-left:auto}
.sel.ph{color:var(--secondary)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.mt{margin-top:28px}
.b2{height:38px;padding:0 16px;border-radius:9px;display:inline-flex;align-items:center;gap:8px;font:500 14px var(--font);white-space:nowrap}
.b2.p{background:var(--action);color:#fff}.b2.s{background:var(--surface);color:var(--text);box-shadow:inset 0 0 0 1px var(--separator)}.b2.d{background:var(--bad);color:#fff}.b2.q{color:var(--link);padding:0 6px}
/* system page */
.sysapp{display:grid;grid-template-columns:240px 1fr 340px;min-height:100vh}
.mid{min-width:0;border-right:1px solid var(--separator);background:var(--bg)}
.mid .top{padding:24px 28px 0}
.titleline{display:flex;align-items:center;gap:12px}
.titleline h1{font-size:22px;font-weight:600;margin:0;letter-spacing:-.01em}
.titleline .r{margin-left:auto}
.tabs{display:flex;gap:24px;margin-top:18px;border-bottom:1px solid var(--separator)}
.tabs a{padding:10px 0;color:var(--secondary);font-weight:500;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs a.on{color:var(--text);border-color:var(--action)}
.toolbar{display:flex;align-items:center;gap:10px;padding:14px 28px;border-bottom:1px solid var(--separator)}
.seg{display:inline-flex;background:var(--fill);border-radius:9px;padding:3px}
.seg a{padding:5px 12px;border-radius:7px;color:var(--text);font-size:13px;font-weight:500}
.seg a.on{background:var(--surface);box-shadow:0 1px 3px rgba(0,0,0,.14)}
.seg a span{color:var(--secondary);margin-left:4px;font-weight:400}
.toolbar .r{margin-left:auto}
.iconbtn{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;color:var(--secondary);background:var(--fill)}
.day{padding:16px 28px 6px;font-size:13px;font-weight:600;color:var(--secondary)}
.list{padding:0 16px}
.list .row{border:0;border-radius:10px;padding:11px 12px}
.insp{background:var(--canvas);padding:24px 22px}
.insp h3{font-size:18px;font-weight:600;margin:14px 0 18px;line-height:1.3}
.insp .k{width:44px;height:44px;border-radius:12px}
.insp .k svg{width:22px;height:22px}
.kv{background:var(--surface);border-radius:12px;box-shadow:var(--card);margin-bottom:14px}
.kv div{display:flex;justify-content:space-between;gap:12px;padding:11px 14px;border-top:1px solid var(--separator);font-size:13.5px}
.kv div:first-child{border-top:0}
.kv div span:first-child{color:var(--secondary)}
.kv div span:last-child{text-align:right;font-weight:500}
.kv.tech div{display:block}.kv.tech div span{display:block;text-align:left!important}
.kv.tech .mono{word-break:break-all;font-weight:400;margin-top:3px}
.disc{display:flex;align-items:center;gap:6px;color:var(--link);font-weight:500;font-size:13.5px;padding:4px 2px}
/* filter panel */
.filters{display:flex;gap:10px;padding:14px 28px;border-bottom:1px solid var(--separator);background:var(--canvas);align-items:end}
.filters .f{flex:1}.filters .sel{margin:0}
/* sheet */
.scrim{position:fixed;inset:0;background:var(--scrim);display:flex;align-items:flex-start;justify-content:center;padding-top:90px}
.sheet{width:480px;background:var(--surface);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden}
.sheet .body{padding:24px}
.sheet h2{font-size:19px;margin-bottom:20px}
.sheet .foot{display:flex;justify-content:flex-end;gap:10px;padding:14px 24px;background:var(--canvas);border-top:1px solid var(--separator)}
/* cards w/ icon */
.blk{background:var(--surface);border-radius:14px;box-shadow:var(--card);padding:20px;margin-bottom:14px;display:flex;gap:16px}
.blk .k{width:36px;height:36px;border-radius:10px}
.blk h3{font-size:15px;margin:6px 0 12px;font-weight:600}
.blk .grow{flex:1}
.inline{display:flex;gap:10px}.inline .input{margin:0;height:40px;font-size:14px}
.lockline{display:flex;gap:10px;align-items:center;background:var(--fill);padding:12px 14px;border-radius:10px;font-size:14px}
/* sistema creato */
.keybox{display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px;background:var(--surface);box-shadow:var(--card);font:13.5px var(--mono);margin-bottom:10px}
.keybox code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.copy{display:inline-flex;gap:6px;align-items:center;font:500 13px var(--font);color:var(--action);background:var(--fill);border-radius:8px;padding:7px 12px;white-space:nowrap}
.note{display:flex;gap:8px;align-items:center;color:var(--warn);font-size:13.5px;font-weight:500;margin-bottom:30px}
.note svg{width:15px;height:15px}
.ways{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.way{background:var(--surface);border-radius:14px;box-shadow:var(--card);padding:18px;display:flex;flex-direction:column;gap:12px;font-weight:600;font-size:15px;color:var(--text)}
.way .k{width:38px;height:38px;border-radius:10px}.way .k svg{width:20px;height:20px}
.way.on{box-shadow:0 0 0 2px var(--action)}
.way .tag{font-size:12px;font-weight:600;color:var(--action)}
pre{margin:0;background:#1d1d1f;color:#e5e5ea;border-radius:14px;padding:20px 22px;font:13px/1.65 var(--mono);overflow:hidden;white-space:pre}
.dark pre{background:#0e0e10;box-shadow:0 0 0 1px #38383a}
pre .c{color:#8e8e93}pre .s{color:#9fd8a8}pre .kw{color:#ff9f6b}
.wait{display:flex;align-items:center;gap:12px;padding:14px 18px;border-radius:12px;background:var(--surface);box-shadow:var(--card);margin-top:16px;font-weight:500}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid var(--separator);border-top-color:var(--action)}
/* table */
.tbl .row .c1{flex:2;min-width:0}.tbl .row .c2{width:130px}.tbl .row .c3{width:90px;text-align:right}.tbl .row .c4{width:150px;text-align:right;color:var(--secondary);font-size:13px}
.tbl .hdr{font-size:12px;font-weight:600;color:var(--secondary);background:var(--canvas)}
.c1 b{display:block;font-weight:500}.c1 span{font-size:12.5px;color:var(--secondary)}
/* verify */
.drop{border:1.5px dashed var(--separator);border-radius:14px;padding:34px;text-align:center;background:var(--surface)}
.drop .k{width:44px;height:44px;border-radius:12px;margin:0 auto 12px}.drop b{display:block;font-size:15px;margin-bottom:4px}
textarea.ta{width:100%;height:120px;border-radius:12px;border:1px solid var(--separator);background:var(--surface);padding:12px 14px;font:14px var(--font);resize:none;color:var(--secondary)}
.result{display:flex;gap:14px;padding:20px;align-items:flex-start}
.result .k{width:40px;height:40px;border-radius:12px}
.result h3{margin:2px 0 6px;font-size:16px}
.result p{margin:0;font-size:14px;line-height:1.5}
/* settings */
.meter{height:8px;border-radius:99px;background:var(--fill);overflow:hidden;margin:10px 0 6px}.meter i{display:block;height:100%;background:var(--action);border-radius:99px}
/* phone */
.topbar{display:none}
.phone .app,.phone .sysapp{display:block}
.phone .side,.phone .insp.hide{display:none}
.phone .topbar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--separator);background:var(--bg);font-weight:600;font-size:16px}
.phone .topbar .seal{width:26px;height:26px}
.phone .topbar .r{margin-left:auto;display:flex;gap:6px}
.phone .main{padding:20px 16px}
.phone h1.page{font-size:24px;margin-bottom:18px}
.phone .cols{display:block}
.phone .tiles{grid-template-columns:1fr 1fr}
.phone .mid .top{padding:18px 16px 0}.phone .toolbar,.phone .day{padding-left:16px;padding-right:16px}.phone .list{padding:0 6px}
.phone .seg{overflow:hidden}
.phone .row .sys{display:none}
.phone .insp{padding:18px 16px}
.phone .head{flex-wrap:wrap}
.phone .ways{grid-template-columns:1fr 1fr 1fr;gap:8px}.phone .way{padding:12px;font-size:13px}
.phone pre{font-size:11.5px;padding:16px}
.drawer{position:fixed;inset:0;background:var(--scrim)}
.drawer .side{display:flex!important;position:absolute;left:0;top:0;bottom:0;width:290px}
`;

const page = (body, opts = {}) =>
  `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body class="${opts.dark ? "dark " : ""}${opts.phone ? "phone" : ""}">${body}</body></html>`;

/* ---------- pieces ---------- */
const W = (t) => `<span class="pill p-w">${I.warn}${t}</span>`;
const OK = (t) => `<span class="pill p-ok">${I.ok}${t}</span>`;
const BAD = (t) => `<span class="pill p-bad">${I.bad}${t}</span>`;
const N = (t) => `<span class="pill p-n">${t}</span>`;
const KI = { tool: ["k-tool", I.tool], model: ["k-model", I.model], dec: ["k-dec", I.decision], step: ["k-step", I.step], gen: ["k-gen", I.book] };
const kind = (k) => `<span class="k ${KI[k][0]}">${KI[k][1]}</span>`;

const sidebar = (on, opts = {}) => `<aside class="side"><div class="brand">${SEAL}sigillo</div>
<a class="nav ${on === "reg" ? "on" : ""}">${I.home}Registro</a>
<div class="sect">Sistemi ${I.plus}</div>
<a class="nav ${on === "acme" ? "on" : ""}"><span class="dot d-w"></span>Assistente clienti<span class="n">5</span></a>
<a class="nav ${on === "cv" ? "on" : ""}"><span class="dot d-w"></span>Selezione CV<span class="n">6</span></a>
<a class="nav ${on === "new" ? "on" : ""}"><span class="dot d-ok"></span>Nuovo assistente<span class="n">1</span></a>
<a class="nav ${on === "sys" ? "on" : ""}">${I.list}Tutti i sistemi</a>
<div class="sect">Strumenti</div>
<a class="nav ${on === "ver" ? "on" : ""}">${I.doc}Verifica documento</a>
<a class="nav ${on === "per" ? "on" : ""}">${I.people}Persone</a>
${opts.admin ? `<a class="nav ${on === "cli" ? "on" : ""}">${I.building}Clienti<span class="n">1</span></a>` : ""}
<div class="spacer"></div>
<a class="nav ${on === "set" ? "on" : ""}">${I.gear}Impostazioni</a>
<div class="acct"><span class="avatar">MR</span><span class="who"><b>Acme S.r.l.</b><span>mario.rossi@acme.it</span></span><span class="chev">${I.out}</span></div>
</aside>`;
const topbar = (title = "") => `<header class="topbar">${SEAL}<span>${title || "sigillo"}</span><span class="r"><span class="iconbtn">${I.menu}</span></span></header>`;
const shell = (on, main, opts = {}) => `<div class="app">${sidebar(on, opts)}${topbar()}<main class="main ${opts.narrow ? "narrow" : ""}">${main}</main></div>`;

/* ---------- 1. accesso ---------- */
const auth = (inner) => `<div class="login"><div class="lbox">${SEAL}${inner}</div></div>`;
const S = {};
S["01-accesso"] = auth(`<h1>Accedi a sigillo</h1>
<a class="btn btn-g">${G}Continua con Google</a>
<div class="or">oppure</div>
<div class="input ph">Indirizzo email</div>
<a class="btn btn-p">Continua con email</a>
<div class="lfoot"><a>Crea un account</a></div>`);
S["02-accesso-password"] = auth(`<h1>Inserisci la password</h1>
<div class="email-chip">mario.rossi@acme.it <a>Cambia</a></div>
<div class="input focus">••••••••••••</div>
<a class="btn btn-p">Accedi</a>
<div class="lfoot"><a>Password dimenticata?</a></div>`);
S["03-accesso-password-errata"] = auth(`<h1>Inserisci la password</h1>
<div class="email-chip">mario.rossi@acme.it <a>Cambia</a></div>
<div class="input err">••••••••</div>
<div class="errline">${I.bad}Password non corretta.</div>
<a class="btn btn-p">Accedi</a>
<div class="lfoot"><a>Password dimenticata?</a></div>`);
S["04-crea-account"] = auth(`<h1>Crea un account</h1>
<a class="btn btn-g">${G}Continua con Google</a>
<div class="or">oppure</div>
<div class="input ph">Indirizzo email</div>
<div class="input ph">Password (almeno 10 caratteri)</div>
<a class="btn btn-p">Crea account</a>
<div class="lfoot"><span class="muted">Hai già un account?</span><a>Accedi</a></div>`);
S["05-conferma-email"] = auth(`<h1>Controlla la posta</h1>
<p class="msg">Abbiamo mandato un link a <b>mario.rossi@acme.it</b>.<br>Aprilo per confermare l'indirizzo.</p>
<a class="btn btn-g">Torna all'accesso</a>`).replace(SEAL, `<div class="bigicon k-tool">${I.mail}</div>`);
S["06-password-dimenticata"] = auth(`<h1>Nuova password</h1>
<div class="input ph">Indirizzo email</div>
<a class="btn btn-p">Mandami il link</a>
<div class="lfoot"><a>Torna all'accesso</a></div>`);
S["07-nome-azienda"] = auth(`<h1>Come si chiama la tua azienda?</h1>
<div class="input focus">Acme S.r.l.</div>
<a class="btn btn-p">Continua</a>`);
S["08-in-attesa"] = auth(`<h1>Quasi fatto</h1>
<p class="msg">Lo spazio di <b>Acme S.r.l.</b> è in attesa di approvazione.<br>Ti scriviamo appena è pronto.</p>
<a class="btn btn-g">Esci</a>`).replace(SEAL, `<div class="bigicon k-w">${I.clock}</div>`);

/* ---------- 2. registro ---------- */
const actions = `<div class="card">
<div class="row"><span class="time">19:20</span>${kind("tool")}<span class="t">invia_email</span><span class="sys">Selezione CV</span>${BAD("Fallito")}</div>
<div class="row"><span class="time">15:05</span>${kind("dec")}<span class="t">shortlist</span><span class="sys">Selezione CV</span></div>
<div class="row"><span class="time">14:59</span>${kind("tool")}<span class="t">leggi_curriculum</span><span class="sys">Selezione CV</span></div>
<div class="row"><span class="time">14:44</span>${kind("dec")}<span class="t">escalation_operatore</span><span class="sys">Assistente clienti</span></div>
<div class="row"><span class="time">14:43</span>${kind("tool")}<span class="t">rimborsa_pagamento</span><span class="sys">Assistente clienti</span>${W("Bloccato")}</div>
<div class="row"><span class="time">14:41</span>${kind("model")}<span class="t">llama3.1:8b</span><span class="sys">Assistente clienti</span></div>
</div>`;
const tiles = `<div class="tiles">
<div class="tile"><b>142</b><span>Azioni oggi</span></div>
<div class="tile w"><b>1</b><span>Bloccate</span></div>
<div class="tile bad"><b>1</b><span>Fallite</span></div>
<div class="tile"><b>20:20</b><span>Ultimo sigillo</span></div></div>`;
const registroMain = (state) => `<h1 class="page">Registro</h1>
${state === "ok" ? `<div class="status s-ok">${I.ok}<span>Tutto a posto. Nessuna alterazione.</span></div>` : state === "bad" ? `<div class="status s-bad">${I.bad}<span>Selezione CV non supera la verifica.</span><a class="more">Apri</a></div>` : `<div class="status s-w">${I.warn}<span>Nessuna alterazione. 2 sistemi da controllare.</span><a class="more">Perché?</a></div>`}
${tiles}
<div class="cols"><div>
<h2>Sistemi</h2>
<div class="card">
<div class="row"><span class="t">Assistente clienti</span>${state === "ok" ? OK("Integro") : W("Da controllare")}<span class="chev">${I.chev}</span></div>
<div class="row"><span class="t">Selezione CV</span>${state === "ok" ? OK("Integro") : state === "bad" ? BAD("Verifica fallita") : W("Da controllare")}<span class="chev">${I.chev}</span></div>
<div class="row"><span class="t">Nuovo assistente</span>${OK("Integro")}<span class="chev">${I.chev}</span></div>
</div>
<h2 class="mt">Ultime azioni<a class="r">Vedi tutte</a></h2>
${actions}</div>
<div><h2>Fascicolo delle prove</h2>
<div class="card form">
<div class="lab">Sistema</div><div class="sel">Assistente clienti<span class="chev">${I.down}</span></div>
<div class="two"><div><div class="lab">Dal</div><div class="sel ph">Inizio</div></div><div><div class="lab">Al</div><div class="sel ph">Oggi</div></div></div>
<a class="btn btn-p" style="height:40px;font-size:14px">${I.dl}Scarica fascicolo</a>
</div>
<a class="b2 s" style="margin-top:14px;width:100%;justify-content:center">${I.seal}Sigilla adesso</a>
</div></div>`;
S["10-registro"] = shell("reg", registroMain("w"));
S["11-registro-tutto-ok"] = shell("reg", registroMain("ok"));
S["12-registro-verifica-fallita"] = shell("reg", registroMain("bad"));
S["13-registro-primo-accesso"] = shell("reg", `<h1 class="page">Benvenuto in sigillo</h1>
<div class="card">
<div class="row" style="padding:18px 20px"><span class="k k-ok">${I.ok}</span><span class="t">Account creato</span>${OK("Fatto")}</div>
<div class="row" style="padding:18px 20px"><span class="k k-tool">${I.plus}</span><span class="t">Crea il primo sistema</span><a class="b2 p">Crea sistema</a></div>
<div class="row" style="padding:18px 20px;opacity:.55"><span class="k k-gen">${I.api}</span><span class="t">Collega il tuo agente</span></div>
<div class="row" style="padding:18px 20px;opacity:.55"><span class="k k-gen">${I.seal}</span><span class="t">Ricevi la prima ricevuta</span></div>
</div>`, { narrow: true });

/* ---------- 3. sistema ---------- */
const sysHead = (tab, phone = false) => `<div class="top"><div class="titleline"><h1>Assistente clienti</h1>${W("Da controllare")}<span class="r"><a class="b2 p">${I.dl}${phone ? "" : "Fascicolo"}</a></span></div>
<nav class="tabs"><a class="${tab === "c" ? "on" : ""}">Cronologia</a><a class="${tab === "s" ? "on" : ""}">Sigilli</a><a class="${tab === "g" ? "on" : ""}">Impostazioni</a></nav></div>`;
const seg = (on) => `<div class="seg">${[["Tutte", 5], ["Strumenti", 2], ["Modelli", 1], ["Decisioni", 1]].map(([t, n]) => `<a class="${t === on ? "on" : ""}">${t}<span>${n}</span></a>`).join("")}</div>`;
const rowsAll = (sel) => [
  ["14:44", "dec", "escalation_operatore", "", 4],
  ["14:43", "tool", "rimborsa_pagamento", W("Bloccato"), 3],
  ["14:41", "model", "llama3.1:8b", "", 2],
  ["14:40", "tool", "cerca_ordine", "", 1],
  ["14:20", "gen", "Registro aperto", "", 0],
].map(([t, k, n, p, i]) => `<div class="row ${i === sel ? "sel" : ""}"><span class="time">${t}</span>${kind(k)}<span class="t">${n}</span>${p}</div>`).join("");
const rowsTools = (sel) => [["14:43", "tool", "rimborsa_pagamento", W("Bloccato"), 3], ["14:40", "tool", "cerca_ordine", "", 1]]
  .map(([t, k, n, p, i]) => `<div class="row ${i === sel ? "sel" : ""}"><span class="time">${t}</span>${kind(k)}<span class="t">${n}</span>${i === sel ? p.replace("p-w", "p-w") : p}</div>`).join("");
const insp = (r, tech = false) => `<aside class="insp">
<div class="titleline">${kind(r.k)}<span class="r">${r.pill}</span></div>
<h3>${r.title}</h3>
<div class="kv">${r.kv.map(([a, b]) => `<div><span>${a}</span><span>${b}</span></div>`).join("")}</div>
<div class="kv"><div><span>Sigillo</span><span style="color:var(--ok)">${r.sealed ? "✓ Sigillata alle 20:20" : "In attesa"}</span></div></div>
<a class="disc">${tech ? I.down : I.chev}Dettagli tecnici</a>
${tech ? `<div class="kv tech" style="margin-top:10px">
<div><span class="muted">Impronta</span><span class="mono">58427979da223aeab8bb146ab5bae9802899151af4cdc62c29bc442fd4621b8f</span></div>
<div><span class="muted">Collegata alla ricevuta n. 3</span><span class="mono">1c43aeb9034455a2f1f8332970e9146f10c908eab42687dec3762b7f26b19d20</span></div>
<div><span class="muted">Firma</span><span class="mono">Ed25519 · chiave bc33bf3ff79e7aa3</span></div>
<div><span class="muted">Marca temporale</span><span class="mono">1 ott 2026, 20:20:13 · freetsa.org</span></div>
<div><span class="muted">Ricevuta</span><span class="mono">n. 4 · versione 4</span></div></div>` : ""}
</aside>`;
const R4 = { k: "dec", pill: OK("Completato"), title: "Decisione: escalation_operatore", kv: [["Agente", "support-agent"], ["Quando", "Oggi, 14:44"], ["Arrivata da", "SDK Python"]], sealed: true };
const R3 = { k: "tool", pill: W("Bloccato"), title: "Strumento: rimborsa_pagamento", kv: [["Agente", "support-agent"], ["Per conto di", "Cliente 4821"], ["Quando", "Oggi, 14:43"], ["Arrivata da", "SDK Python"]], sealed: true };
const sysPage = (on, mid, right = "") => `<div class="sysapp">${sidebar(on)}${topbar()}<section class="mid">${mid}</section>${right}</div>`;
S["20-cronologia"] = sysPage("acme", `${sysHead("c")}<div class="toolbar">${seg("Tutte")}<span class="r"><span class="iconbtn">${I.search}</span></span></div>
<div class="day">Oggi · giovedì 1 ottobre</div><div class="list">${rowsAll(4)}</div>`, insp(R4));
S["21-cronologia-strumenti"] = sysPage("acme", `${sysHead("c")}<div class="toolbar">${seg("Strumenti")}<span class="r"><span class="iconbtn">${I.search}</span></span></div>
<div class="day">Oggi · giovedì 1 ottobre</div><div class="list">${rowsTools(3)}</div>`, insp(R3));
S["22-cronologia-cerca"] = sysPage("acme", `${sysHead("c")}<div class="toolbar">${seg("Tutte")}<span class="r"><span class="iconbtn" style="background:var(--action);color:#fff">${I.search}</span></span></div>
<div class="filters"><div class="f"><div class="lab">Nome azione</div><div class="sel">rimborsa</div></div><div class="f"><div class="lab">Dal</div><div class="sel ph">Inizio</div></div><div class="f"><div class="lab">Al</div><div class="sel ph">Oggi</div></div><a class="b2 p">Cerca</a></div>
<div class="day">Oggi · giovedì 1 ottobre</div><div class="list">${rowsTools(3).split("</div>")[0]}</div></div>`, insp(R3));
S["23-cronologia-dettagli-tecnici"] = sysPage("acme", `${sysHead("c")}<div class="toolbar">${seg("Tutte")}<span class="r"><span class="iconbtn">${I.search}</span></span></div>
<div class="day">Oggi · giovedì 1 ottobre</div><div class="list">${rowsAll(4)}</div>`, insp(R4, true));
S["24-fascicolo"] = S["20-cronologia"] + `<div class="scrim"><div class="sheet"><div class="body"><h2>Fascicolo di Assistente clienti</h2>
<div class="two"><div><div class="lab">Dal</div><div class="sel ph">Inizio</div></div><div><div class="lab">Al</div><div class="sel ph">Oggi</div></div></div>
<a class="disc">${I.chev}Includi nomi o contenuti</a></div>
<div class="foot"><a class="b2 s">Annulla</a><a class="b2 p">${I.dl}Scarica .zip</a></div></div></div>`;
S["25-sigilli"] = sysPage("acme", `${sysHead("s")}<div style="padding:20px 28px">
<div class="card">${[["20:20", 6, "Oggi"], ["19:20", 5, "Oggi"], ["15:10", 3, "Oggi"]].map(([t, n, d], i) => `<div class="row"><span class="k k-ok">${I.seal}</span><span class="t">${n} ricevute sigillate<small>${d}, ${t}</small></span>${i === 0 ? OK("Marca temporale") : OK("Marca temporale")}<span class="chev">${I.chev}</span></div>`).join("")}</div>
<a class="b2 s" style="margin-top:16px">${I.seal}Sigilla adesso</a></div>`);
S["26-impostazioni-sistema"] = sysPage("acme", `${sysHead("g")}<div style="padding:24px 28px;max-width:700px">
<div class="blk"><span class="k k-tool">${I.gear}</span><div class="grow"><h3>Nome</h3><div class="inline"><div class="input">Assistente clienti</div><a class="b2 p">Salva</a></div></div></div>
<div class="blk"><span class="k k-gen">${I.key}</span><div class="grow"><h3>Chiave</h3><div class="inline"><div class="input mono" style="color:var(--secondary)">sigillo_a3de397447d8…••••</div><a class="b2 s">Nuova chiave</a></div></div></div>
<div class="blk"><span class="k k-gen">${I.archive}</span><div class="grow"><h3>Archivia</h3><a class="b2 s">${I.archive}Archivia sistema</a></div></div>
<div class="blk"><span class="k k-bad">${I.trash}</span><div class="grow"><h3>Elimina</h3><div class="lockline">${I.lock}Contiene azioni registrate: si può solo archiviare.</div></div></div>
</div>`);

/* ---------- 4. sistemi ---------- */
S["30-sistemi"] = shell("sys", `<div class="head"><h1 class="page" style="margin:0">Sistemi</h1><span class="r"><a class="b2 p">${I.plus}Nuovo sistema</a></span></div>
<div style="margin-bottom:16px"><div class="seg"><a class="on">Attivi<span>3</span></a><a>Archiviati<span>1</span></a><a>Tutti<span>4</span></a></div></div>
<div class="card tbl">
<div class="row hdr"><span class="c1">Sistema</span><span class="c2">Stato</span><span class="c3">Ricevute</span><span class="c4">Ultima azione</span></div>
<div class="row"><span class="c1"><b>Assistente clienti</b><span>SDK Python</span></span><span class="c2">${W("Da controllare")}</span><span class="c3">5</span><span class="c4">Oggi, 14:44</span></div>
<div class="row"><span class="c1"><b>Selezione CV</b><span>OpenTelemetry</span></span><span class="c2">${W("Da controllare")}</span><span class="c3">6</span><span class="c4">Oggi, 19:20</span></div>
<div class="row"><span class="c1"><b>Nuovo assistente</b><span>Non ancora collegato</span></span><span class="c2">${OK("Integro")}</span><span class="c3">1</span><span class="c4">—</span></div>
</div>`);
S["31-sistemi-archiviati"] = shell("sys", `<div class="head"><h1 class="page" style="margin:0">Sistemi</h1><span class="r"><a class="b2 p">${I.plus}Nuovo sistema</a></span></div>
<div style="margin-bottom:16px"><div class="seg"><a>Attivi<span>3</span></a><a class="on">Archiviati<span>1</span></a><a>Tutti<span>4</span></a></div></div>
<div class="card tbl">
<div class="row hdr"><span class="c1">Sistema</span><span class="c2">Stato</span><span class="c3">Ricevute</span><span class="c4">Archiviato</span></div>
<div class="row"><span class="c1"><b>Vecchio bot 2025</b><span>SDK Python</span></span><span class="c2">${N("Archiviato")}</span><span class="c3">212</span><span class="c4">1 ott 2026</span></div>
</div>`);
S["32-nuovo-sistema"] = shell("sys", `<h1 class="page">Nuovo sistema</h1>
<div class="card form" style="padding:24px">
<div class="lab">Nome</div><div class="input focus">Assistente vendite</div>
<div class="lab" style="margin-top:6px">Identificativo</div><div class="input mono" style="font-size:14px">assistente-vendite</div>
<a class="btn btn-p" style="margin-top:8px">Crea sistema</a></div>`, { narrow: true });
const code = {
  py: `<span class="c"># pip install 'sdk-python[langchain]'</span>
<span class="kw">import</span> sigillo

sigillo.init(
    endpoint=<span class="s">"https://get-sigillo.eu"</span>,
    api_key=<span class="s">"sigillo_a3de…baf8"</span>,
    system_id=<span class="s">"assistente-vendite"</span>,
    instrument=[<span class="s">"langchain"</span>],
)`,
  otel: `<span class="c"># Punta l'esportatore OTLP/HTTP a sigillo</span>
OTEL_EXPORTER_OTLP_ENDPOINT=<span class="s">"https://get-sigillo.eu"</span>
OTEL_EXPORTER_OTLP_HEADERS=<span class="s">"Authorization=Bearer sigillo_a3de…baf8"</span>
OTEL_SERVICE_NAME=<span class="s">"assistente-vendite"</span>`,
  api: `curl -X POST <span class="s">https://get-sigillo.eu/api/v1/receipts</span> \\
  -H <span class="s">"Authorization: Bearer sigillo_a3de…baf8"</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{"actor":{"agent":"agente"},
       "action":{"kind":"decision","name":"azione"},
       "outcome":"ok"}'</span>`,
};
const creato = (w, waiting) => `<h1 class="page">Assistente vendite è pronto</h1>
<div class="lab">Chiave del sistema</div>
<div class="keybox">${I.key}<code>sigillo_a3de397447d859d4_6294314bfe7b5790f7b3e0f3017985cc94c93cc6d51131d75b285ab4bd79baf8</code><span class="copy">${I.copy}Copia</span></div>
<div class="note">${I.warn}La vedi solo ora: copiala e conservala.</div>
<h2>Collega il tuo agente</h2>
<div class="ways">
<a class="way ${w === "py" ? "on" : ""}"><span class="k k-tool">${I.py}</span>SDK Python<span class="tag">Consigliato</span></a>
<a class="way ${w === "otel" ? "on" : ""}"><span class="k k-model">${I.otel}</span>OpenTelemetry</a>
<a class="way ${w === "api" ? "on" : ""}"><span class="k k-dec">${I.api}</span>API HTTP</a>
</div>
<pre>${code[w]}</pre>
${waiting ? `<div class="wait"><span class="spin"></span>In attesa della prima ricevuta…<a style="margin-left:auto;font-size:13px" class="muted">Salta</a></div>` : `<div class="wait" style="color:var(--ok)">${I.ok}Prima ricevuta arrivata alle 10:42<a class="b2 p" style="margin-left:auto">Vai al sistema</a></div>`}
<div style="margin-top:18px"><a class="disc">${I.doc}Guida completa</a></div>`;
S["33-sistema-creato-python"] = shell("new", creato("py", true));
S["34-sistema-creato-opentelemetry"] = shell("new", creato("otel", true));
S["35-sistema-creato-api"] = shell("new", creato("api", false));

/* ---------- 5. strumenti ---------- */
const verify = (res) => `<h1 class="page">Verifica documento</h1>
<div class="cols" style="grid-template-columns:1fr 1fr"><div>
<div class="drop"><div class="k k-tool">${I.upload}</div><b>Trascina qui un file</b><a>oppure sceglilo</a></div>
<div class="or">oppure incolla il testo</div>
<textarea class="ta">${res ? "Mario Bianchi — Curriculum vitae\nSviluppatore backend junior…" : ""}</textarea>
<a class="btn btn-p" style="margin-top:12px">Verifica</a>
<div class="muted" style="font-size:13px;margin-top:12px;display:flex;gap:6px;align-items:center">${I.lock}Il documento non lascia il tuo computer.</div>
</div><div>
${res === "ok" ? `<div class="card"><div class="result"><span class="k k-ok">${I.ok}</span><div><h3>Trovato nel registro</h3><p>Usato da <b>Selezione CV</b> oggi alle 14:56, nell'azione <b>leggi_curriculum</b>.</p><a class="disc" style="margin-top:10px;padding:0">Vedi la ricevuta ${I.chev}</a></div></div></div>
<a class="disc" style="margin-top:10px">${I.chev}Dettagli tecnici</a>`
    : res === "no" ? `<div class="card"><div class="result"><span class="k k-bad">${I.bad}</span><div><h3>Non trovato</h3><p>Nessuna azione registrata ha usato questo documento.</p></div></div></div>`
    : `<div class="card" style="padding:40px;text-align:center;color:var(--secondary)">Il risultato apparirà qui.</div>`}
</div></div>`;
S["40-verifica-documento"] = shell("ver", verify(""));
S["41-verifica-trovato"] = shell("ver", verify("ok"));
S["42-verifica-non-trovato"] = shell("ver", verify("no"));
S["43-persone"] = shell("per", `<h1 class="page">Persone</h1>
<div class="inline" style="max-width:560px;margin-bottom:22px"><div class="input">cliente-4821</div><a class="b2 p">${I.search}Cerca</a></div>
<div class="cols"><div><h2>1 ricevuta</h2>
<div class="card"><div class="row">${kind("tool")}<span class="t">cerca_ordine<small>Assistente clienti · oggi, 14:40</small></span><span class="chev">${I.chev}</span></div></div></div>
<div><div class="card form"><h2 style="color:var(--bad)">${I.trash}&nbsp;Cancella la persona</h2>
<p style="margin:0 0 14px;font-size:14px">Le ricevute restano valide, ma non si potranno più collegare a lei.</p>
<div class="lab">Scrivi <span class="mono">cliente-4821</span> per confermare</div><div class="input" style="height:40px"></div>
<a class="btn btn-d" style="height:40px;font-size:14px">Cancella definitivamente</a></div></div></div>`);
S["44-clienti"] = shell("cli", `<h1 class="page">Clienti</h1>
<div class="card tbl">
<div class="row hdr"><span class="c1">Azienda</span><span class="c2">Stato</span><span class="c3">Sistemi</span><span class="c4"></span></div>
<div class="row"><span class="c1"><b>Beta Logistica S.p.A.</b><span>anna.verdi@betalog.it</span></span><span class="c2">${W("In attesa")}</span><span class="c3">0</span><span class="c4"><a class="b2 p" style="height:32px">Approva</a></span></div>
<div class="row"><span class="c1"><b>Acme S.r.l.</b><span>mario.rossi@acme.it · 2 persone</span></span><span class="c2">${OK("Attivo")}</span><span class="c3">3</span><span class="c4">dal 2 ott 2026</span></div>
</div>`, { admin: true });
S["45-impostazioni"] = shell("set", `<h1 class="page">Impostazioni</h1>
<h2>Account</h2>
<div class="card" style="margin-bottom:24px"><div class="row"><span class="avatar">MR</span><span class="t">Mario Rossi<small>mario.rossi@acme.it · Google</small></span><a class="b2 s">${I.out}Esci</a></div></div>
<h2>Organizzazione</h2>
<div class="card form" style="margin-bottom:24px"><div style="display:flex;justify-content:space-between"><b>Acme S.r.l.</b><span class="muted">3 sistemi</span></div>
<div class="meter"><i style="width:28%"></i></div><div class="muted" style="font-size:13px">2.840 di 10.000 ricevute questo mese</div></div>
<h2>Registro amministrativo<a class="r">Vedi tutto</a></h2>
<div class="card">
<div class="row"><span class="time">15:17</span><span class="t">prova-per-errore eliminato</span><span class="sys">Mario Rossi</span></div>
<div class="row"><span class="time">14:30</span><span class="t">Selezione CV rinominato</span><span class="sys">Mario Rossi</span></div>
<div class="row"><span class="time">14:25</span><span class="t">Vecchio bot 2025 archiviato</span><span class="sys">Mario Rossi</span></div>
</div>
<h2 class="mt">Chiave di firma</h2>
<div class="card"><div class="row"><span class="k k-gen">${I.key}</span><span class="t mono">bc33bf3ff79e7aa3</span><span class="copy">${I.copy}Copia</span></div></div>`, { narrow: true });
S["46-non-trovato"] = shell("", `<div style="text-align:center;padding-top:120px"><div class="bigicon k-gen" style="background:var(--fill)">${I.search}</div><h1 class="page" style="justify-content:center">Pagina non trovata</h1><a class="b2 p">Torna al registro</a></div>`);

/* ---------- phone-only ---------- */
const P = {};
P["50-telefono-accesso"] = S["01-accesso"];
P["51-telefono-registro"] = S["10-registro"];
P["52-telefono-cronologia"] = `<div class="sysapp">${topbar()}<section class="mid">${sysHead("c", true)}<div class="toolbar">${seg("Tutte")}</div>
<div class="day">Oggi · giovedì 1 ottobre</div><div class="list">${rowsAll(-1)}</div></section></div>`;
P["53-telefono-ricevuta"] = `<div>${topbar()}<div style="padding:12px 16px 0"><a class="disc">${I.back}Cronologia</a></div>${insp(R3).replace('class="insp"', 'class="insp" style="background:var(--canvas)"')}</div>`;
P["54-telefono-menu"] = S["10-registro"] + `<div class="drawer">${sidebar("reg")}</div>`;
P["55-telefono-sistema-creato"] = shell("new", creato("py", true));

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const list = [];
for (const [k, v] of Object.entries(S)) { writeFileSync(`${out}/${k}.html`, page(v)); list.push([k, 1280, false, false]); }
for (const k of ["01-accesso", "10-registro", "20-cronologia", "33-sistema-creato-python", "41-verifica-trovato"]) { writeFileSync(`${out}/${k}-scuro.html`, page(S[k], { dark: true })); list.push([`${k}-scuro`, 1280, true, false]); }
for (const [k, v] of Object.entries(P)) { writeFileSync(`${out}/${k}.html`, page(v, { phone: true })); list.push([k, 390, false, true]); }
writeFileSync(`${out}/list.json`, JSON.stringify(list));
