import { escape } from "./layout.js";
import type { VaultSchedule } from "../gateway/vault-schedule.js";
import { UI } from "./strings.js";

/**
 * The page where an account makes, opens and locks its key vault
 * (gateway/provider-keys.ts). Plain forms, no script: the passphrase goes in a
 * password field and is never put in an address or a log.
 */

export interface VaultView {
  state: "none" | "locked" | "open";
  /** The owner's sealed hours, if any; and whether one is running now. */
  schedule?: VaultSchedule | null;
  sealedNow?: boolean;
  /** Shown once, right after the vault is made. */
  recoveryKey?: string;
  notice?: string;
  error?: string;
}

const field = (label: string, name: string): string =>
  `<label>${escape(label)} <input type="password" name="${name}" autocomplete="off" required></label>`;

function schedulePart(view: VaultView): string {
  const t = UI.vault;
  const schedule = view.schedule ?? null;
  const rows = (schedule?.windows ?? [])
    .map(
      (window, index) => `<li>${escape(window.days.map((d) => t.day(d)).join(", "))}: ${escape(window.from)}–${escape(window.to)}
<form method="post" action="/ui/vault/schedule/remove" class="inline"><input type="hidden" name="index" value="${index}"><button type="submit">${escape(t.scheduleRemove)}</button></form></li>`,
    )
    .join("\n");
  const days = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => `<label class="inline"><input type="checkbox" name="day${d}" value="1"> ${escape(t.day(d))}</label>`)
    .join(" ");
  return `<div class="card padded">
<h2>${escape(t.scheduleTitle)}</h2>
<p>${escape(t.scheduleText)}</p>
${rows === "" ? `<p class="muted">${escape(t.scheduleNone)}</p>` : `<ul>\n${rows}\n</ul>`}
<form class="fields" method="post" action="/ui/vault/schedule/add">
<fieldset><legend>${escape(t.scheduleDays)}</legend>${days}</fieldset>
<label>${escape(t.scheduleFrom)} <input type="time" name="from" value="22:00" required></label>
<label>${escape(t.scheduleTo)} <input type="time" name="to" value="06:00" required></label>
<label>${escape(t.scheduleZone)} <input type="text" name="timezone" value="${escape(schedule?.timezone ?? "Europe/Rome")}" required></label>
<button type="submit">${escape(t.scheduleAdd)}</button>
</form>
<p class="muted">${escape(t.scheduleLimit)}</p>
</div>`;
}

export function vaultPage(view: VaultView): string {
  const t = UI.vault;
  const messages =
    (view.error === undefined ? "" : `<p class="notice warn" role="alert">${escape(view.error)}</p>\n`) +
    (view.notice === undefined ? "" : `<p class="notice ok" role="status">${escape(view.notice)}</p>\n`);
  let body: string;
  if (view.recoveryKey !== undefined) {
    body = `<div class="card padded">
<h2>${escape(t.recoveryTitle)}</h2>
<p>${escape(t.recoveryText)}</p>
<p><code>${escape(view.recoveryKey)}</code></p>
<a class="button primary" href="/ui/vault">${escape(t.recoveryDone)}</a>
</div>`;
  } else if (view.state === "none") {
    body = `<form class="card padded fields" method="post" action="/ui/vault/create">
<h2>${escape(t.createTitle)}</h2>
${field(t.passphrase, "passphrase")}
${field(t.passphraseAgain, "again")}
<button class="primary" type="submit">${escape(t.create)}</button>
</form>`;
  } else if (view.state === "locked" && view.sealedNow === true) {
    body = `<div class="card padded">
<h2>${escape(t.sealedTitle)}</h2>
<p>${escape(t.sealedText)}</p>
</div>
${schedulePart(view)}`;
  } else if (view.state === "locked") {
    body = `<form class="card padded fields" method="post" action="/ui/vault/unlock">
<h2>${escape(t.lockedTitle)}</h2>
<p>${escape(t.lockedText)}</p>
${field(t.unlockField, "secret")}
<button class="primary" type="submit">${escape(t.unlock)}</button>
</form>
${schedulePart(view)}`;
  } else {
    body = `<div class="card padded">
<h2>${escape(t.openTitle)}</h2>
<p>${escape(t.openText)}</p>
<form method="post" action="/ui/vault/lock"><button type="submit">${escape(t.lock)}</button></form>
</div>
${schedulePart(view)}
<details class="card padded">
<summary>${escape(t.changeTitle)}</summary>
<form class="fields" method="post" action="/ui/vault/passphrase">
${field(t.passphrase, "passphrase")}
${field(t.passphraseAgain, "again")}
<button type="submit">${escape(t.change)}</button>
</form>
</details>`;
  }
  return `<h1>${escape(t.title)}</h1>
<p>${escape(t.intro)}</p>
${messages}${body}
<p class="muted">${escape(t.limits)}</p>`;
}
