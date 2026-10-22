import type { PhraseHit } from "../assurance/privacy-check.js";
import { escape } from "./layout.js";
import { STATE_ICONS } from "./style.js";
import { UI } from "./strings.js";

/**
 * The privacy page: what sigillo keeps and never keeps, and one button that
 * proves it. The customer puts a phrase through its agent (or types one from
 * its own data) and the page searches everything stored for its account.
 * What the search may look at is decided in assurance/privacy-check.ts and
 * auth/tenancy.ts, never here.
 */

export interface PrivacyView {
  /** The phrase the field holds: a fresh one, or the one just checked. */
  phrase: string;
  /** Set once a check was made: where the phrase was found, nowhere if empty. */
  result?: PhraseHit[];
  /** A refusal to check, in words. */
  error?: string;
}

function hintFor(hit: PhraseHit): string {
  const t = UI.privacy;
  if (hit.kind === "recorded-as-sent") return t.hintLabel;
  if (hit.kind === "personal-erasable") return t.hintPersonal;
  return t.hintOther;
}

function resultBlock(view: PrivacyView): string {
  const t = UI.privacy;
  if (view.error !== undefined) {
    return `<p class="notice bad" role="alert">${STATE_ICONS.bad}<span>${escape(view.error)}</span></p>`;
  }
  if (view.result === undefined) return "";
  if (view.result.length === 0) {
    return `<div class="notice ok" role="status">${STATE_ICONS.ok}<span><strong>${escape(t.notFound)}</strong> ${escape(t.notFoundDetail)}</span></div>`;
  }
  const rows = view.result
    .map(
      (hit) =>
        `<li>${escape(t.where(t.places[hit.table] ?? hit.table, hit.rows))}<br><span class="muted">${escape(hintFor(hit))}</span></li>`,
    )
    .join("");
  return `<div class="notice warn" role="status">${STATE_ICONS.bad}<span><strong>${escape(t.found)}</strong> ${escape(t.foundDetail)}</span></div><ul>${rows}</ul>`;
}

export function privacyPage(view: PrivacyView): string {
  const t = UI.privacy;
  const list = (items: readonly string[]): string => `<ul>${items.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>`;
  return `<header class="page-head"><h1>${escape(t.heading)}</h1></header>
<p>${escape(t.intro)}</p>
<div class="cols even">
<section class="card"><h2>${escape(t.keepTitle)}</h2>${list([t.keep1, t.keep2, t.keep3])}<h2>${escape(t.neverTitle)}</h2><p>${escape(t.never)}</p></section>
<section class="card"><h2>${escape(t.checkTitle)}</h2>
<p>1. ${escape(t.step1)}</p>
<form method="post" action="/ui/privacy/check" autocomplete="off">
<label><span>${escape(t.phraseLabel)}</span><input type="text" name="phrase" value="${escape(view.phrase)}" maxlength="200" required spellcheck="false"></label>
<p>2. ${escape(t.step2)}</p>
<button type="submit" class="big">${escape(t.button)}</button>
</form>
${resultBlock(view)}
</section>
</div>
<section class="card"><h2>${escape(t.limitsTitle)}</h2>${list([t.limits1, t.limits2, t.limits3])}</section>`;
}
