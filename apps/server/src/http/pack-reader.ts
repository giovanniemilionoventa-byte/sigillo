import { EVIDENCE_CHECK_SOURCE } from "./evidence-check.js";

/**
 * The evidence-pack reader of the redesigned console (SIGILLO_PACK_READER):
 * the check of evidence-check.ts, and what an inspector needs next, all in
 * their browser: the key code compared with what the sender said, the actions
 * in words, a document looked up among the pack's own fingerprints, and what
 * the pack does not prove. The pack is never sent anywhere. Served as
 * /ui/pack-reader.js; the page holds its words in data-texts.
 */
export const PACK_READER_SCRIPT = `"use strict";
${EVIDENCE_CHECK_SOURCE}

(function () {
  const root = document.getElementById("reader");
  if (root === null) return;
  const t = JSON.parse(root.dataset.texts);
  const lang = document.documentElement.lang;
  const input = document.getElementById("pack");
  const out = document.getElementById("result");
  const fill = (text, values) => text.replace(/\\{(\\w+)\\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const when = (iso) => new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Rome" }).format(new Date(iso));
  const clock = (iso) => new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Rome" }).format(new Date(iso));
  const groups = (hex) => hex.replace(/(.{4})(?=.)/g, "$1 ");
  const sign = (kind, text) => {
    const span = el("span", undefined, "sign " + ({ ok: "green", bad: "red", warn: "yellow" }[kind] || kind));
    span.append(document.getElementById("icon-" + kind).content.cloneNode(true), el("span", text));
    return span;
  };
  const title = (r) => {
    const T = t.titles;
    const template = r.kind === "genesis" ? T.genesis : r.kind === "tool_call" ? (r.outcome === "ok" ? T.tool_ok : T.tool_fail) : r.kind === "llm_call" ? T.llm : r.kind === "decision" ? T.decision : T.step;
    return fill(template, { name: r.name });
  };
  const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
  const card = (...nodes) => {
    const box = el("section", undefined, "card padded");
    box.append(...nodes);
    return box;
  };

  const show = (result, pack) => {
    out.replaceChildren();
    if (!result.ok) {
      const bad = result.check === "archive";
      out.append(card(sign(bad ? "warn" : "bad", bad ? t.notPack : t.failed), el("p", bad ? "" : t.failedLine + " " + result.check + " · " + result.location + ": " + result.detail)));
      return;
    }
    const s = result.summary;
    const d = result.detail;
    out.append(card(sign("ok", t.intact), el("p", fill(t.intactLine, { receipts: s.receipts, system: s.system_id }))));

    // the key code, received separately
    const code = el("input");
    code.type = "text";
    code.id = "keycode";
    code.autocomplete = "off";
    code.spellcheck = false;
    code.className = "input code-key";
    const label = el("label", t.keyCode);
    label.htmlFor = "keycode";
    const verdict = el("p");
    const judge = () => {
      const typed = code.value.replace(/\\s+/g, "").toLowerCase();
      verdict.replaceChildren();
      if (typed === "") return;
      const all = d.receipts.every((r) => r.key_id === typed);
      verdict.append(all ? sign("ok", fill(t.keyMatches, { code: groups(typed) })) : sign("bad", t.keyDiffers));
    };
    code.addEventListener("input", judge);
    out.append(card(label, code, verdict));

    // the checks and the time
    const checks = el("dl");
    const rows = [
      [t.signatures, fill(t.signaturesValue, { n: s.receipts })],
      [t.chain, fill(t.chainValue, { first: s.first_seq, last: s.last_seq })],
      [t.seals, s.checkpoints === 0 ? t.noSeals : fill(t.sealsValue, { n: s.timestamps })],
    ];
    for (const [k, v] of rows) checks.append(el("dt", k), el("dd", v));
    const timeLines = [el("p", s.last_checkpoint_ts === null ? "" : fill(t.existedBy, { when: when(s.last_checkpoint_ts), authority: "" }).replace(/ · $/, ""))];
    timeLines.push(el("p", t.whenLimit, "t-meta"));
    out.append(card(el("h3", t.checks, "t-sec"), checks, el("h3", t.when, "t-sec"), ...timeLines));

    // the actions in words
    const list = el("ol", undefined, "act-list");
    const actions = d.receipts.filter((r) => r.kind !== "genesis");
    for (const r of actions.slice(0, 300)) {
      const li = el("li", undefined, "act");
      li.style.gridTemplateColumns = "48px minmax(0,1fr) auto";
      li.append(el("span", clock(r.ts_received), "tm"), el("span", title(r), "tx"), el("span", t.outcomes[r.outcome] || "", "out-text"));
      list.append(li);
    }
    const more = actions.length > 300 ? [el("p", fill(t.showing, { n: 300, total: actions.length }), "t-meta")] : [];
    out.append(card(el("h3", t.contents, "t-sec"), list, ...more));

    // a document, looked up among the pack's own fingerprints
    const doc = el("input");
    doc.type = "file";
    doc.id = "doc";
    const docLabel = el("label", t.docChoose);
    docLabel.htmlFor = "doc";
    const docResult = el("p");
    doc.addEventListener("change", async () => {
      docResult.replaceChildren();
      const file = doc.files[0];
      if (file === undefined) return;
      const digest = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      for (const r of d.receipts) {
        const found = r.artifacts.find((a) => a.sha256 === digest);
        if (found !== undefined) {
          docResult.append(sign("ok", fill(t.docFound, { when: when(r.ts_received), label: found.label, action: r.name })));
          return;
        }
      }
      docResult.append(sign("neutral", t.docNotFound));
    });
    out.append(card(el("h3", t.checkDocument, "t-sec"), docLabel, doc, docResult));

    // what it does not prove, and the full check
    const np = el("ul");
    for (const line of t.notProvenLines) np.append(el("li", line));
    const command = el("code", "sigillo-verify --key-id " + (d.key_ids[0] || "<key>") + " " + (pack.name || "fascicolo.zip"), "mono");
    out.append(card(el("h3", t.notProven, "t-sec"), np, el("h3", t.full, "t-sec"), el("p", t.fullHint, "t-meta"), command));
  };

  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (file === undefined) return;
    out.hidden = false;
    out.replaceChildren(el("p", "…"));
    show(await sigilloCheckPack(new Uint8Array(await file.arrayBuffer())), file);
  });
})();
`;
