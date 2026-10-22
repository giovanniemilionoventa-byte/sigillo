import { escape } from "./layout.js";
import { UI } from "./strings.js";

/**
 * The page where an account makes, opens and locks its key vault
 * (gateway/provider-keys.ts). Plain forms, no script: the passphrase goes in a
 * password field and is never put in an address or a log.
 */

export interface VaultView {
  state: "none" | "locked" | "open";
  /** Shown once, right after the vault is made. */
  recoveryKey?: string;
  notice?: string;
  error?: string;
}

const field = (label: string, name: string): string =>
  `<label>${escape(label)} <input type="password" name="${name}" autocomplete="off" required></label>`;

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
  } else if (view.state === "locked") {
    body = `<form class="card padded fields" method="post" action="/ui/vault/unlock">
<h2>${escape(t.lockedTitle)}</h2>
<p>${escape(t.lockedText)}</p>
${field(t.unlockField, "secret")}
<button class="primary" type="submit">${escape(t.unlock)}</button>
</form>`;
  } else {
    body = `<div class="card padded">
<h2>${escape(t.openTitle)}</h2>
<p>${escape(t.openText)}</p>
<form method="post" action="/ui/vault/lock"><button type="submit">${escape(t.lock)}</button></form>
</div>
<form class="card padded fields" method="post" action="/ui/vault/passphrase">
<h2>${escape(t.changeTitle)}</h2>
${field(t.passphrase, "passphrase")}
${field(t.passphraseAgain, "again")}
<button type="submit">${escape(t.change)}</button>
</form>`;
  }
  return `<h1>${escape(t.title)}</h1>
<p>${escape(t.intro)}</p>
${messages}${body}
<p class="muted">${escape(t.limits)}</p>`;
}
