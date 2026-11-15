import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PROGRAM_ARTIFACT_LABEL } from "@sigillo/core";
import { archiveFromStore } from "../export/from-store.js";
import type { ReceiptStore } from "../storage/store.js";
import { EVIDENCE_CHECK_SOURCE } from "./evidence-check.js";
import { escape } from "./layout.js";
import type { Language } from "./locale.js";
import { systemTitle } from "./strings.js";

/**
 * The auditor's link. A company makes it in the console for one system and
 * one period ("Condividi con il revisore"); whoever opens it sees, on a page
 * of sigillo's own, whose evidence it is (the account and the agent as
 * sigillo knows them, not as a file name says), and can either check the pack
 * right there or download it to check it on their own computer:
 *
 *   GET /revisione/<secret>               the page, "Verifica qui" and "Scarica"
 *   GET /revisione/<secret>/pacchetto.zip the evidence pack, built now from the chain
 *   GET /review.js                        the page's script: the browser check
 *                                         (evidence-check.ts) and the program list
 *
 * "Verifica qui" runs in the reader's browser the same check as the public
 * "Verify" page, on the pack fetched from this server; nothing is sent back.
 * It then lists the agent programs the pack records (the `agent program`
 * fingerprints of the connection receipts), so the auditor can compare the
 * fingerprint the company reads on the agent's computer
 * (`python -m sigillo fingerprint`) without ever seeing the program.
 *
 * The secret is 32 random bytes and only its hash is stored (review_links);
 * a link works for REVIEW_TTL_MS and can be taken back. The pack names nobody
 * and opens no digest: it is the plain export of the period.
 */

export const REVIEW_PATH = "/revisione";

const TEXTS = {
  it: {
    title: "Prove di un agente AI",
    intro: "Questa pagina è di Sigillo. Mostra il registro firmato di un agente AI, condiviso con te da chi lo usa.",
    account: "Azienda (account Sigillo)",
    operator: "Gestore di questa installazione di Sigillo",
    agent: "Agente",
    agentSince: "registrato dal",
    period: "Periodo",
    whole: "tutto il registro",
    from: "dal",
    to: "al",
    expires: "Il link scade il",
    verify: "Verifica qui",
    download: "Scarica",
    downloadNote:
      "Scaricando il pacchetto lo puoi controllare da solo, sul tuo computer, con il verificatore indipendente (sigillo-verify), senza fidarti di questa pagina.",
    checking: "Verifica in corso…",
    intact: "Il pacchetto è integro",
    intactLine: "{receipts} ricevute di «{system}»: firme, catena e sigilli sono corretti.",
    altered: "Il pacchetto NON è integro",
    noPack: "Il pacchetto non si può scaricare",
    oldBrowser: "Questo browser non sa controllare le firme: scarica il pacchetto e usa il verificatore.",
    programs: "Programmi dell'agente registrati",
    programsNone: "Questo pacchetto non registra il programma dell'agente (ricevute precedenti a questa funzione).",
    programRow: "dal {from} (ricevuta {seq})",
    compare: "Confronta un'impronta",
    compareHint:
      "Sul computer dell'agente si lancia «python -m sigillo fingerprint agente.py»: stampa 64 caratteri e niente del file. Incollali qui.",
    compareButton: "Confronta",
    match: "Corrisponde: è il programma registrato dal {from}.",
    noMatch: "Non corrisponde a nessun programma registrato in questo pacchetto.",
    badFingerprint: "Un'impronta è fatta di 64 caratteri tra 0-9 e a-f.",
    gone: "Questo link non è valido",
    goneLine: "Il link è scaduto, è stato revocato o non è mai esistito. Chiedi un nuovo link a chi te l'ha mandato.",
  },
  en: {
    title: "Evidence of an AI agent",
    intro: "This page is Sigillo's. It shows the signed record of an AI agent, shared with you by whoever runs it.",
    account: "Company (Sigillo account)",
    operator: "Operator of this Sigillo installation",
    agent: "Agent",
    agentSince: "registered on",
    period: "Period",
    whole: "the whole record",
    from: "from",
    to: "to",
    expires: "The link expires on",
    verify: "Verify here",
    download: "Download",
    downloadNote:
      "Download the pack to check it yourself, on your own computer, with the independent verifier (sigillo-verify), without trusting this page.",
    checking: "Checking…",
    intact: "The pack is intact",
    intactLine: "{receipts} receipts of «{system}»: signatures, chain and seals are correct.",
    altered: "The pack is NOT intact",
    noPack: "The pack cannot be downloaded",
    oldBrowser: "This browser cannot check the signatures: download the pack and use the verifier.",
    programs: "Agent programs recorded",
    programsNone: "This pack records no agent program (receipts older than this feature).",
    programRow: "from {from} (receipt {seq})",
    compare: "Compare a fingerprint",
    compareHint:
      "On the agent's computer, run «python -m sigillo fingerprint agent.py»: it prints 64 characters and nothing of the file. Paste them here.",
    compareButton: "Compare",
    match: "It matches: it is the program recorded from {from}.",
    noMatch: "It matches no program recorded in this pack.",
    badFingerprint: "A fingerprint is 64 characters among 0-9 and a-f.",
    gone: "This link is not valid",
    goneLine: "The link has expired, was taken back or never existed. Ask whoever sent it for a new one.",
  },
} as const;

type Texts = (typeof TEXTS)[Language];

const STYLE = `body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f6f7f9;color:#14171c}
main{max-width:720px;margin:0 auto;padding:32px 20px}
.card{background:#fff;border:1px solid #dce0e6;border-radius:12px;padding:20px 24px;margin:16px 0}
h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:0 0 8px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:0}dt{color:#5b6472}dd{margin:0;font-weight:600}
.buttons{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0 8px}
.btn{display:inline-block;padding:10px 18px;border-radius:8px;border:1px solid #1d4ed8;background:#fff;color:#1d4ed8;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.btn.primary{background:#1d4ed8;color:#fff}
.ok{color:#0f7b3f}.bad{color:#b42318}.muted{color:#5b6472;font-size:14px}
code{font:13px/1.4 ui-monospace,Menlo,monospace;word-break:break-all}
input{font:13px ui-monospace,Menlo,monospace;width:100%;box-sizing:border-box;padding:8px;border:1px solid #dce0e6;border-radius:8px;margin:8px 0}
ul{padding-left:20px}`;

function page(language: Language, title: string, body: string, script: boolean): string {
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)} · Sigillo</title>
<style>${STYLE}</style>
${script ? '<script src="/review.js" defer></script>' : ""}
</head>
<body><main>${body}</main></body>
</html>`;
}

const day = (iso: string): string => iso.slice(0, 10);

export interface ReviewOptions {
  store: ReceiptStore;
  now: () => Date;
  languageOf: (request: FastifyRequest) => Language;
}

export function registerReview(app: FastifyInstance, options: ReviewOptions): void {
  const { store } = options;
  const send = (reply: FastifyReply, code: number, body: string): FastifyReply =>
    reply
      .code(code)
      .type("text/html; charset=utf-8")
      .header("cache-control", "no-store")
      // The secret is in the address: no other site may be told it.
      .header("referrer-policy", "no-referrer")
      .send(body);

  const gone = (reply: FastifyReply, t: Texts, language: Language): FastifyReply =>
    send(reply, 404, page(language, t.gone, `<div class="card"><h1>${escape(t.gone)}</h1><p>${escape(t.goneLine)}</p></div>`, false));

  app.get("/review.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").header("cache-control", "public, max-age=3600").send(REVIEW_SCRIPT),
  );

  app.get(`${REVIEW_PATH}/:secret`, async (request, reply) => {
    const language = options.languageOf(request);
    const t = TEXTS[language];
    const { secret } = request.params as { secret: string };
    const link = store.reviewLink(secret, options.now().toISOString());
    if (link === null) return gone(reply, t, language);
    const record = store.systemRecord(link.system_id);
    if (record === null) return gone(reply, t, language);
    const account = link.organization_id === null ? t.operator : (store.organization(link.organization_id)?.name ?? link.organization_id);
    const period =
      link.period_from === null && link.period_to === null
        ? t.whole
        : `${link.period_from === null ? "" : `${t.from} ${day(link.period_from)} `}${link.period_to === null ? "" : `${t.to} ${day(link.period_to)}`}`.trim();
    const packUrl = `${REVIEW_PATH}/${encodeURIComponent(secret)}/pacchetto.zip`;
    const body = `<div class="card">
<h1>${escape(t.title)}</h1>
<p>${escape(t.intro)}</p>
<dl>
<dt>${escape(t.account)}</dt><dd>${escape(account)}</dd>
<dt>${escape(t.agent)}</dt><dd>${escape(systemTitle(record))} <span class="muted">(${escape(record.system_id)}, ${escape(t.agentSince)} ${escape(day(record.created_at))})</span></dd>
<dt>${escape(t.period)}</dt><dd>${escape(period)}</dd>
<dt>${escape(t.expires)}</dt><dd>${escape(day(link.expires_at))}</dd>
</dl>
<div class="buttons">
<button type="button" class="btn primary" id="verify">${escape(t.verify)}</button>
<a class="btn" href="${escape(packUrl)}" download>${escape(t.download)}</a>
</div>
<p class="muted">${escape(t.downloadNote)}</p>
</div>
<div class="card" id="review" data-pack="${escape(packUrl)}" data-texts="${escape(JSON.stringify(t))}" data-label="${escape(PROGRAM_ARTIFACT_LABEL)}" hidden aria-live="polite"></div>`;
    return send(reply, 200, page(language, t.title, body, true));
  });

  app.get(`${REVIEW_PATH}/:secret/pacchetto.zip`, async (request, reply) => {
    const language = options.languageOf(request);
    const t = TEXTS[language];
    const { secret } = request.params as { secret: string };
    const link = store.reviewLink(secret, options.now().toISOString());
    if (link === null) return gone(reply, t, language);
    let zip: Uint8Array;
    try {
      const archive = await archiveFromStore(store, link.system_id, {
        range: {
          ...(link.period_from === null ? {} : { from: link.period_from }),
          ...(link.period_to === null ? {} : { to: link.period_to }),
        },
        subjects: [],
        openings: [],
        exportedAt: options.now().toISOString(),
      });
      zip = archive.zip;
    } catch (error) {
      request.log.info({ system: link.system_id, error: error instanceof Error ? error.message : String(error) }, "a review link's pack could not be built");
      return send(reply, 404, page(language, t.noPack, `<div class="card"><h1>${escape(t.noPack)}</h1></div>`, false));
    }
    request.log.info({ system: link.system_id, link: link.id }, "an auditor downloaded a pack through a review link");
    const safeName = link.system_id.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    return reply
      .code(200)
      .type("application/zip")
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer")
      .header("content-disposition", `attachment; filename="sigillo-${safeName}-revisione.zip"`)
      .send(Buffer.from(zip));
  });
}

/**
 * The page's script: the browser check of the Verify page (evidence-check.ts),
 * run on the pack fetched from this server, then the programs the pack records
 * and a field to compare a fingerprint with them. textContent only.
 */
export const REVIEW_SCRIPT = `"use strict";
${EVIDENCE_CHECK_SOURCE}

(function () {
  const out = document.getElementById("review");
  const button = document.getElementById("verify");
  if (out === null || button === null) return;
  const t = JSON.parse(out.dataset.texts);
  const label = out.dataset.label;
  const fill = (text, values) => text.replace(/\\{(\\w+)\\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className !== undefined) node.className = className;
    return node;
  };

  const programsOf = (receipts) => {
    const found = [];
    for (const receipt of receipts) {
      if (receipt.name.indexOf("sigillo.connection.") !== 0) continue;
      for (const artifact of receipt.artifacts) {
        if (artifact.label === label) found.push({ sha256: artifact.sha256, from: receipt.ts_received, seq: receipt.seq });
      }
    }
    return found;
  };

  const showPrograms = (receipts) => {
    const programs = programsOf(receipts);
    out.append(element("h2", t.programs));
    if (programs.length === 0) {
      out.append(element("p", t.programsNone, "muted"));
      return;
    }
    const list = element("ul");
    for (const program of programs) {
      const item = element("li");
      item.append(element("code", program.sha256), element("span", " " + fill(t.programRow, { from: program.from.slice(0, 16).replace("T", " "), seq: program.seq }), "muted"));
      list.append(item);
    }
    out.append(list);
    out.append(element("h2", t.compare), element("p", t.compareHint, "muted"));
    const input = element("input");
    input.setAttribute("aria-label", t.compare);
    input.setAttribute("spellcheck", "false");
    input.setAttribute("autocomplete", "off");
    const go = element("button", t.compareButton, "btn");
    go.type = "button";
    const answer = element("p");
    go.addEventListener("click", () => {
      const value = input.value.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(value)) {
        answer.className = "bad";
        answer.textContent = t.badFingerprint;
        return;
      }
      const hit = programs.find((program) => program.sha256 === value);
      answer.className = hit ? "ok" : "bad";
      answer.textContent = hit ? fill(t.match, { from: hit.from.slice(0, 16).replace("T", " ") }) : t.noMatch;
    });
    out.append(input, go, answer);
  };

  button.addEventListener("click", async () => {
    out.hidden = false;
    out.replaceChildren(element("p", t.checking));
    let bytes;
    try {
      const response = await fetch(out.dataset.pack, { credentials: "omit" });
      if (!response.ok) throw new Error(String(response.status));
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      out.replaceChildren(element("h2", t.noPack, "bad"));
      return;
    }
    const result = await sigilloCheckPack(bytes);
    out.replaceChildren();
    if (result.ok) {
      out.append(element("h2", t.intact, "ok"), element("p", fill(t.intactLine, { receipts: result.summary.receipts, system: result.summary.system_id })));
      showPrograms(result.detail.receipts);
    } else if (result.check === "browser") {
      out.append(element("h2", t.oldBrowser, "bad"));
    } else {
      out.append(element("h2", t.altered, "bad"), element("p", result.check + " · " + result.location + ": " + result.detail, "muted"));
    }
  });
})();
`;

/** The name of the receipt written on the chain when a link is made: who was shown what is part of the record. */
export const REVIEW_SHARED = "sigillo.review.shared";

const CONSOLE_TEXTS = {
  it: {
    share: "Condividi con il revisore",
    title: (name: string) => `Link per il revisore: ${name}`,
    intro:
      "Manda questo link al revisore. Apre una pagina di Sigillo con il nome dell'azienda e dell'agente, e due pulsanti: «Verifica qui» (controlla il pacchetto nel browser) e «Scarica» (per controllarlo da solo con il verificatore). Il link si vede solo adesso: copialo.",
    period: "Periodo",
    whole: "tutto il registro",
    expires: (date: string) => `Scade il ${date}. Puoi revocarlo prima.`,
    open: "Link attivi di questo agente",
    none: "Nessun link attivo.",
    row: (period: string, created: string, expires: string) => `${period} · creato il ${created} · scade il ${expires}`,
    revoke: "Revoca",
    revoked: "Link revocato.",
    back: "Torna all'agente",
  },
  en: {
    share: "Share with the auditor",
    title: (name: string) => `Auditor's link: ${name}`,
    intro:
      "Send this link to the auditor. It opens a Sigillo page with the company's and the agent's name, and two buttons: \"Verify here\" (checks the pack in the browser) and \"Download\" (to check it with the verifier). The link is shown only now: copy it.",
    period: "Period",
    whole: "the whole record",
    expires: (date: string) => `It expires on ${date}. You can take it back sooner.`,
    open: "This agent's open links",
    none: "No open link.",
    row: (period: string, created: string, expires: string) => `${period} · made on ${created} · expires on ${expires}`,
    revoke: "Take back",
    revoked: "Link taken back.",
    back: "Back to the agent",
  },
} as const;

/** The label of the console's button: in the export form, beside "download". */
export function shareButton(language: Language): string {
  return `<button type="submit" formaction="/ui/review-links">${escape(CONSOLE_TEXTS[language].share)}</button>`;
}

function periodText(language: Language, from: string | null, to: string | null): string {
  const t = TEXTS[language];
  if (from === null && to === null) return CONSOLE_TEXTS[language].whole;
  return `${from === null ? "" : `${t.from} ${day(from)} `}${to === null ? "" : `${t.to} ${day(to)}`}`.trim();
}

/** The console page after a link was made (url set: shown once) or one taken back, with the agent's open links. */
export function reviewLinksPage(
  language: Language,
  record: { system_id: string; display_name: string | null },
  links: { id: number; period_from: string | null; period_to: string | null; created_at: string; expires_at: string }[],
  made: { url: string; from: string | null; to: string | null; expiresAt: string } | null,
  systemHref: string,
): string {
  const c = CONSOLE_TEXTS[language];
  const fresh =
    made === null
      ? `<p>${escape(c.revoked)}</p>`
      : `<p>${escape(c.intro)}</p>
<code class="keybox">${escape(made.url)}</code>
<p>${escape(c.period)}: ${escape(periodText(language, made.from, made.to))}. ${escape(c.expires(day(made.expiresAt)))}</p>`;
  const rows =
    links.length === 0
      ? `<p>${escape(c.none)}</p>`
      : `<ul>${links
          .map(
            (link) => `<li>${escape(c.row(periodText(language, link.period_from, link.period_to), day(link.created_at), day(link.expires_at)))}
<form method="post" action="/ui/review-links/${link.id}/revoke" class="inline"><input type="hidden" name="system_id" value="${escape(record.system_id)}"><button type="submit">${escape(c.revoke)}</button></form></li>`,
          )
          .join("")}</ul>`;
  return `<section class="card block"><div>
<h2>${escape(c.title(systemTitle(record)))}</h2>
${fresh}
<h3>${escape(c.open)}</h3>
${rows}
<p class="section"><a href="${escape(systemHref)}">${escape(c.back)}</a></p>
</div></section>`;
}
