import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Language } from "./locale.js";
import { SITE_TEXTS, type SiteTexts } from "./site-strings.js";
import { escape } from "./layout.js";
import { EVIDENCE_CHECK_SOURCE } from "./evidence-check.js";
import { SEAL_SVG, STATE_ICONS, STYLE, THEME } from "./style.js";

/**
 * The public site at the root of the domain: what Sigillo is, its demo
 * video, its prices and how an agent connects, for people who have not signed
 * in. The console stays at /ui, one click away ("Sign in").
 *
 * Mounted only where customers sign in (ui.ts): an installation run by its
 * operator alone keeps sending / straight to the console.
 *
 * Like the web view it is server-rendered, in the
 * reader's language (the same cookie and the same Accept-Language rule as the
 * console, locale.ts) and in the console's colours (THEME, style.ts). The
 * phone menu opens with :target, the video plays in the browser's own player,
 * and the only script, site.js, adds the "Copy" buttons.
 */

/** The pages of the site, which the language switch may return to. */
export const SITE_PATHS = ["/", "/about", "/pricing", "/connect", "/verify", "/privacy"] as const;
type SitePath = (typeof SITE_PATHS)[number];

/** Where the console's sign-in and sign-up pages are. */
const SIGN_IN = "/ui/login";
const SIGN_UP = "/ui/registrati";

const REPOSITORY = "https://github.com/giovanniemilionoventa-byte/sigillo";

/** The address the site's "Contact" links write to; none yet, so none is shown. */
export const SITE_CONTACT_EMAIL: string | undefined = undefined;

export interface SiteOptions {
  languageOf: (request: FastifyRequest) => Language;
  /** "light" or "dark" when the reader chose one in the console; else the system's. */
  themeOf: (request: FastifyRequest) => "light" | "dark" | "system";
  /** The address the "Contact" links write to; without it they are not shown. */
  contactEmail?: string;
  /** Where agents send their actions, as the snippets write it. */
  endpoint: string;
}

// ---------------------------------------------------------------------------
// Media: the demo video in each language, its subtitles, its still.

/**
 * The files the site serves under /media/, by name. The videos are copied
 * into the image's assets/video/ by deploy/Dockerfile; in a checkout they are
 * read from video/consegna, where the recording script writes them. A file
 * found in neither place is simply not offered: the page shows the still.
 */
const ASSETS = new URL("../../assets/", import.meta.url);
const RECORDINGS = new URL("../../../../video/consegna/", import.meta.url);

interface MediaFile {
  type: string;
  candidates: URL[];
  /** Subtitles arrive as SubRip and are served as WebVTT, which is what <track> reads. */
  subrip?: boolean;
}

const MEDIA: Record<string, MediaFile> = {
  "demo-en.mp4": { type: "video/mp4", candidates: [new URL("video/demo-en.mp4", ASSETS), new URL("en/sigillo-demo-en.mp4", RECORDINGS)] },
  "demo-it.mp4": { type: "video/mp4", candidates: [new URL("video/demo-it.mp4", ASSETS), new URL("sigillo-demo.mp4", RECORDINGS)] },
  "demo-en.vtt": { type: "text/vtt; charset=utf-8", subrip: true, candidates: [new URL("video/demo-en.srt", ASSETS), new URL("en/sigillo-demo-en.srt", RECORDINGS)] },
  "demo-it.vtt": { type: "text/vtt; charset=utf-8", subrip: true, candidates: [new URL("video/demo-it.srt", ASSETS), new URL("sigillo-demo.srt", RECORDINGS)] },
  "poster-en.jpg": { type: "image/jpeg", candidates: [new URL("site/poster-en.jpg", ASSETS)] },
  "poster-it.jpg": { type: "image/jpeg", candidates: [new URL("site/poster-it.jpg", ASSETS)] },
};

/** SubRip to WebVTT: a header, and a full stop instead of a comma before the milliseconds. */
export function subripToWebVtt(subrip: string): string {
  const body = subrip.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  return `WEBVTT\n\n${body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}

/**
 * The byte range a Range header asks for, within a file of `size` bytes:
 * one range only, which is all a video player asks for. Null when there is no
 * usable header (the whole file is sent), "unsatisfiable" when it points past
 * the end.
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return null;
  let start: number;
  let end: number;
  if (from === "") {
    // The last `to` bytes.
    const length = Number(to);
    if (length === 0) return "unsatisfiable";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

function registerMedia(app: FastifyInstance): Set<string> {
  const found = new Map<string, { file: MediaFile; path: URL }>();
  for (const [name, file] of Object.entries(MEDIA)) {
    const path = file.candidates.find((candidate) => existsSync(candidate));
    if (path !== undefined) found.set(name, { file, path });
  }

  app.get("/media/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const entry = found.get(name);
    if (entry === undefined) return reply.code(404).send({ error: "not found" });
    void reply.type(entry.file.type).header("cache-control", "public, max-age=86400");
    if (entry.file.subrip === true) return reply.send(subripToWebVtt(readFileSync(entry.path, "utf8")));

    const size = statSync(entry.path).size;
    void reply.header("accept-ranges", "bytes");
    const range = byteRange(typeof request.headers.range === "string" ? request.headers.range : undefined, size);
    if (range === "unsatisfiable") return reply.code(416).header("content-range", `bytes */${size}`).send();
    if (range === null) return reply.header("content-length", size).send(createReadStream(entry.path));
    return reply
      .code(206)
      .header("content-range", `bytes ${range.start}-${range.end}/${size}`)
      .header("content-length", range.end - range.start + 1)
      .send(createReadStream(entry.path, { start: range.start, end: range.end }));
  });

  return new Set(found.keys());
}

/**
 * The seal as the browser tab's icon, for the site and the console alike. A
 * standalone file has no stylesheet, so the brand colour is written out here
 * (design/tokens.json, light theme --brand).
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="none" stroke="#8e2a24" stroke-width="2"/><circle cx="24" cy="24" r="16" fill="none" stroke="#8e2a24" stroke-width="1.25"/><polygon points="24,15 33,24 24,33 15,24" fill="#8e2a24"/></svg>`;

/** The icon at the address every browser asks for, whatever the page says. */
export function registerFavicon(app: FastifyInstance): void {
  app.get("/favicon.ico", async (_request, reply) =>
    reply.type("image/svg+xml").header("cache-control", "public, max-age=604800").send(FAVICON_SVG),
  );
}

// ---------------------------------------------------------------------------
// The look: the console's tokens, and the few rules of a page that is read
// rather than worked in.

/**
 * The header of every page of the site, the one with the dashboard included.
 * Its own class names (sh-), so that it can sit above the console's stylesheet
 * (the demo at /) as well as the site's, whose generic names it would clash with.
 */
const HEADER_STYLE = `
.sh { position: sticky; top: 0; z-index: 30; background: color-mix(in srgb, var(--canvas) 85%, transparent);
  backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid var(--separator); }
.sh-bar { display: flex; align-items: center; gap: 28px; height: 60px; max-width: 1040px; margin: 0 auto; padding: 0 24px; }
.sh-wide .sh-bar { max-width: none; }
.sh-brand { display: flex; align-items: center; gap: 10px; padding: 0; color: var(--text); font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
.sh-brand:hover { text-decoration: none; }
.sh-brand svg { width: 28px; height: 28px; }
.sh-nav { display: flex; gap: 24px; flex: 1; }
.sh-nav a { color: var(--text); font-size: 15px; }
.sh-nav a:hover { text-decoration: none; opacity: 0.7; }
.sh-nav a[aria-current="page"] { font-weight: 600; }
.sh-menu-close, .sh-menu-open { display: none; color: var(--text); }
.sh-menu-close svg, .sh-menu-open svg { width: 24px; height: 24px; }
.sh-lang { margin: 0; }
.sh-lang button { border: 0; background: none; color: var(--text); font: 500 15px var(--font); padding: 8px 6px; cursor: pointer; }
.sh-lang button:hover { text-decoration: underline; }
.sh-signin { display: inline-flex; align-items: center; justify-content: center; height: 40px; padding: 0 18px; border-radius: 999px;
  background: var(--action); color: var(--on-action); font-size: 15px; font-weight: 500; white-space: nowrap; }
.sh-signin:hover { text-decoration: none; filter: brightness(0.96); }
@media (max-width: 760px) {
  .sh-bar { gap: 12px; }
  .sh-lang { margin-left: auto; }
  .sh-menu-open { display: flex; }
  .sh-nav { display: none; }
  .sh-nav:target { display: flex; flex-direction: column; gap: 0; position: fixed; inset: 0; z-index: 40; background: var(--canvas); padding: 16px 24px; }
  .sh-nav:target a { font-size: 20px; padding: 14px 0; border-bottom: 1px solid var(--separator); }
  .sh-nav:target .sh-menu-close { display: flex; justify-content: flex-end; border: 0; padding: 8px 0; }
}
`;

const SITE_STYLE = `${THEME}${HEADER_STYLE}
* { box-sizing: border-box; }
html { background: var(--bg); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--canvas); color: var(--text); font: 400 16px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
h1, h2, h3, p { margin: 0; }
svg { flex: none; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px; }
.narrow { max-width: 760px; }
.hero { text-align: center; padding: 88px 24px 48px; }
.hero.short { padding: 72px 24px 40px; }
.hero h1 { font-size: 52px; line-height: 1.08; letter-spacing: -0.025em; font-weight: 700; max-width: 820px; margin: 0 auto; }
.hero .lead { font-size: 20px; margin: 20px auto 0; max-width: 640px; }
.ctas { display: flex; gap: 12px; justify-content: center; margin-top: 32px; }
.video { max-width: 880px; margin: 0 auto; border-radius: 18px; overflow: hidden; background: #111114;
  box-shadow: 0 24px 60px rgba(0,0,0,0.18); aspect-ratio: 16 / 9; }
.video video, .video img { display: block; width: 100%; height: 100%; object-fit: cover; }
section { padding: 80px 0; }
h2 { font-size: 34px; letter-spacing: -0.02em; font-weight: 700; text-align: center; margin-bottom: 40px; }
.three { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.card { background: var(--surface); border-radius: 16px; box-shadow: var(--shadow-card); padding: 28px; }
.card h3 { font-size: 19px; margin: 16px 0 8px; letter-spacing: -0.01em; }
.ico { width: 40px; height: 40px; border-radius: 10px; background: var(--fill); display: flex; align-items: center;
  justify-content: center; color: var(--brand); }
.ico svg { width: 22px; height: 22px; }
.band { background: var(--surface); border-top: 1px solid var(--separator); border-bottom: 1px solid var(--separator); }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; max-width: 880px; margin: 0 auto 36px; }
.step { display: flex; gap: 12px; align-items: baseline; }
.step b { flex: none; width: 28px; height: 28px; border-radius: 50%; background: var(--action); color: var(--on-action);
  display: inline-flex; align-items: center; justify-content: center; font-size: 14px; }
.code { position: relative; margin: 0 0 24px; }
pre { background: var(--code); color: var(--on-code); border-radius: 14px; padding: 22px 24px; font: 13.5px/1.7 var(--mono);
  margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.code .copy { position: absolute; top: 12px; right: 12px; border: 0; border-radius: 999px; padding: 5px 12px;
  background: rgba(255,255,255,0.14); color: var(--on-code); font: 500 13px var(--font); cursor: pointer; }
.code .copy:hover { background: rgba(255,255,255,0.24); }
.code pre { padding-right: 84px; }
.ways { max-width: 720px; margin: 0 auto; }
h4 { font-size: 16px; margin: 0 0 4px; }
.where { margin: 0 0 12px; }
pre .c { color: #8a8a8e; } pre .k { color: #ff7ab2; } pre .s { color: #fc6a5d; }
h3.way { font-size: 22px; margin: 16px 0 16px; }
.more { text-align: center; margin-top: 24px; font-weight: 500; }
.cta-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
.cta-row h2 { text-align: left; margin: 0 0 6px; font-size: 28px; }
.pilot { max-width: 560px; }
.cta-buttons { display: flex; gap: 12px; }
.note { margin: 0 0 32px; }
.center { text-align: center; }
.plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; align-items: stretch; }
.plan { display: flex; flex-direction: column; gap: 18px; }
.plan h3 { margin: 0; }
.plan.now { box-shadow: 0 0 0 2px var(--action); }
.price { font-size: 40px; font-weight: 700; letter-spacing: -0.02em; }
.price small { font-size: 16px; font-weight: 500; }
.plan ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; flex: 1; }
.plan li { display: flex; gap: 10px; }
.plan li svg { width: 18px; height: 18px; color: var(--ok); margin-top: 3px; }
.tag { font-size: 13px; font-weight: 600; color: var(--secondary); }
.now .tag { color: var(--action); }
.faq { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
details { background: var(--surface); border-radius: 12px; box-shadow: var(--shadow-card); padding: 18px 22px; }
summary { font-weight: 600; cursor: pointer; }
details p { margin-top: 10px; }
.drop { display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; cursor: pointer;
  border: 2px dashed var(--separator); border-radius: 18px; background: var(--surface); padding: 44px 24px; }
.drop.over { border-color: var(--action); }
.drop b { font-size: 18px; }
.drop .ico { width: 56px; height: 56px; border-radius: 14px; }
.drop .ico svg { width: 28px; height: 28px; }
.drop:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
#result { margin-top: 24px; }
.verdict { display: flex; gap: 14px; align-items: flex-start; }
.verdict svg { width: 32px; height: 32px; margin-top: 2px; }
.verdict h3 { margin: 0 0 4px; font-size: 22px; }
.verdict.ok { color: var(--ok); }
.verdict.bad { color: var(--bad); }
.verdict p { color: var(--text); }
#result dl { display: grid; grid-template-columns: auto 1fr; gap: 10px 24px; margin: 22px 0 0; padding-top: 18px;
  border-top: 1px solid var(--separator); }
#result dt { font-weight: 600; }
#result dd { margin: 0; }
#result details { box-shadow: none; padding: 0; margin-top: 18px; }
#result code { font: 13px/1.5 var(--mono); overflow-wrap: anywhere; }
.prose h2 { text-align: left; font-size: 22px; margin: 36px 0 10px; }
.prose p { margin: 0 0 12px; }
.prose { padding-bottom: 40px; }
footer { padding: 32px 0 48px; font-size: 14px; }
footer .row { display: flex; gap: 24px; align-items: center; }
footer .row span { flex: 1; }
footer a { color: var(--text); }
@media (max-width: 760px) {
  .hero { padding: 56px 20px 32px; }
  .hero h1 { font-size: 34px; }
  .hero .lead { font-size: 17px; }
  .ctas { flex-direction: column; align-items: stretch; }
  .three, .plans, .steps { grid-template-columns: 1fr; }
  section { padding: 56px 0; }
  h2 { font-size: 26px; }
  .cta-row { flex-direction: column; align-items: flex-start; }
  pre { font-size: 12px; padding: 18px; }
  footer .row { flex-direction: column; align-items: flex-start; gap: 10px; }
}
`;

const line = (shape: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round">${shape}</svg>`;

const ICON = {
  pen: line('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>'),
  chain: line('<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/>'),
  doc: line('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 15l2 2 4-4"/>'),
  menu: line('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: line('<path d="M6 6l12 12M18 6L6 18"/>'),
  check: `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" style="fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round"><path d="M4 10.5l4 4 8-9"/></svg>`,
};

// ---------------------------------------------------------------------------
// The snippets, the same three ways the console's connect page shows, with a
// placeholder where the console puts the system's own key.

const PIP = `pip install "sigillo[langchain] @ git+${REPOSITORY}#subdirectory=sdk-python"`;

/**
 * One command or one piece of code, in a box with a "Copy" button. The button
 * is hidden until site.js shows it, so a browser without scripts sees no
 * button that does nothing.
 */
function codeBox(t: SiteTexts, html: string): string {
  return `<div class="code"><pre>${html}</pre><button type="button" class="copy" data-copied="${escape(t.connect.copied)}" hidden>${escape(t.connect.copy)}</button></div>`;
}

/** The Python way, in its two steps: what to install, and where; what to add to the agent. */
function pythonSteps(t: SiteTexts, endpoint: string): string {
  const c = t.connect;
  const code = `<span class="k">import</span> sigillo

sigillo.init(
    endpoint=<span class="s">"${escape(endpoint)}"</span>,
    api_key=<span class="s">"sigillo_..."</span>,
    system_id=<span class="s">"customer-assistant"</span>,
    instrument=[<span class="s">"langchain"</span>],
)`;
  return `<h4>${escape(c.install)}</h4>
<p class="where">${escape(c.installWhere)}</p>
${codeBox(t, escape(PIP))}
<h4>${escape(c.inCode)}</h4>
<p class="where">${escape(c.inCodeWhere)}</p>
${codeBox(t, code)}`;
}

function otelSnippet(endpoint: string): string {
  return `OTEL_EXPORTER_OTLP_ENDPOINT=<span class="s">"${escape(endpoint)}"</span>
OTEL_EXPORTER_OTLP_HEADERS=<span class="s">"Authorization=Bearer%20sigillo_..."</span>
OTEL_SERVICE_NAME=<span class="s">"customer-assistant"</span>`;
}

function apiSnippet(endpoint: string): string {
  return `curl -X POST ${escape(endpoint)}/api/v1/receipts \\
  -H <span class="s">"Authorization: Bearer sigillo_..."</span> \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -d <span class="s">'{"actor": {"agent": "customer-assistant"},
       "action": {"kind": "decision", "name": "approve_refund"},
       "outcome": "ok"}'</span>`;
}

// ---------------------------------------------------------------------------
// The pages.

interface PageContext {
  language: Language;
  t: SiteTexts;
  path: SitePath | null;
  contactEmail?: string;
  endpoint: string;
  media: Set<string>;
}

function siteHeader(context: PageContext, wide = false): string {
  const { t, path, language } = context;
  const link = (href: SitePath, label: string): string =>
    `<a href="${href}"${path === href ? ' aria-current="page"' : ""}>${escape(label)}</a>`;
  const other = language === "en" ? "it" : "en";
  return `<header class="sh${wide ? " sh-wide" : ""}"><div class="sh-bar">
<a class="sh-brand" href="/">${SEAL_SVG}<span>sigillo</span></a>
<nav class="sh-nav" id="menu"><a class="sh-menu-close" href="#" aria-label="×">${ICON.close}</a>${link("/about", t.nav.overview)}${link("/pricing", t.nav.pricing)}${link("/connect", t.nav.connect)}${link("/verify", t.nav.verify)}</nav>
<form class="sh-lang" method="post" action="/ui/lingua"><input type="hidden" name="lang" value="${other}"><input type="hidden" name="back" value="${path ?? "/"}"><button type="submit" aria-label="${escape(t.switchLabel)}" lang="${other}">${escape(t.switchTo)}</button></form>
<a class="sh-signin" href="${SIGN_IN}">${escape(t.signIn)}</a>
<a class="sh-menu-open" href="#menu" aria-label="Menu">${ICON.menu}</a>
</div></header>`;
}

function sitePage(context: PageContext, title: string, body: string): string {
  const { t, path, language } = context;
  const contact =
    context.contactEmail === undefined ? "" : `<a href="mailto:${escape(context.contactEmail)}">${escape(t.footer.contact)}</a>`;
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<meta name="description" content="${escape(t.home.lead)}">
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<style>${SITE_STYLE}</style>
<script src="/site.js" defer></script>${path === "/verify" ? '\n<script src="/verify.js" defer></script>' : ""}
</head>
<body>
${siteHeader(context)}
<main>
${body}
</main>
<footer><div class="wrap row"><span>© 2026 Sigillo · ${escape(t.footer.europe)}</span><a href="/privacy">${escape(t.footer.privacy)}</a>${contact}</div></footer>
</body>
</html>`;
}

/**
 * The first page: the console's own main page, for a demo company with
 * sample data (test/helpers/demo-snapshot.ts makes the two files), under the
 * site's header. It is the console's stylesheet, not the site's, so it looks
 * exactly as the console does after signing in.
 */
const DEMO_FRAGMENTS: Record<Language, string> = {
  en: readFileSync(new URL("site/demo-en.html", ASSETS), "utf8"),
  it: readFileSync(new URL("site/demo-it.html", ASSETS), "utf8"),
};

const DEMO_STYLE = `
.demo-note { text-align: center; padding: 9px 16px; background: var(--fill); font-size: 14px; border-bottom: 1px solid var(--separator); }
.demo-note a { font-weight: 500; margin-left: 6px; }
.demo .app { min-height: calc(100vh - 60px - 38px); }
.demo .sidebar-inner { top: 98px; height: calc(100vh - 98px); }
@media (max-width: 899px) { .demo .sidebar-inner { top: 0; height: auto; } }
`;

function demoPage(context: PageContext): string {
  const { t, language } = context;
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(t.home.title)}</title>
<meta name="description" content="${escape(t.home.lead)}">
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<style>${STYLE}${HEADER_STYLE}${DEMO_STYLE}</style>
</head>
<body class="demo">
${siteHeader(context, true)}
<div class="demo-note">${escape(t.demo.note)}<a href="${SIGN_UP}">${escape(t.start)}</a><a href="/privacy">${escape(t.footer.privacy)}</a></div>
<div class="app">
${DEMO_FRAGMENTS[language]}</div>
</body>
</html>`;
}

function homeBody(context: PageContext): string {
  const { t, language, media } = context;
  const h = t.home;
  const poster = `/media/poster-${language}.jpg`;
  const video = media.has(`demo-${language}.mp4`)
    ? `<video controls preload="none" poster="${poster}" aria-label="${escape(h.videoLabel)}">
<source src="/media/demo-${language}.mp4" type="video/mp4">${
        media.has(`demo-${language}.vtt`)
          ? `\n<track kind="subtitles" src="/media/demo-${language}.vtt" srclang="${language}" label="${escape(h.subtitles)}">`
          : ""
      }
</video>`
    : `<img src="${poster}" alt="${escape(h.videoLabel)}">`;
  const icons = [ICON.pen, ICON.chain, ICON.doc];
  return `<div class="wrap hero"><h1>${escape(h.heading)}</h1>
<p class="lead">${escape(h.lead)}</p>
<div class="ctas"><a class="btn primary" href="${SIGN_UP}">${escape(t.start)}</a><a class="btn plain" href="#demo">${escape(t.watch)}</a></div></div>
<div class="wrap" id="demo"><div class="video">${video}</div></div>
<section><div class="wrap"><h2>${escape(h.what)}</h2><div class="three">
${h.cards.map((card, index) => `<div class="card"><div class="ico">${icons[index] ?? ""}</div><h3>${escape(card.title)}</h3><p>${escape(card.text)}</p></div>`).join("\n")}
</div></div></section>
<section class="band"><div class="wrap"><h2>${escape(h.connect)}</h2>
${stepsOf(t)}
<div class="ways">${pythonSteps(t, context.endpoint)}</div>
<p class="more"><a href="/connect">${escape(h.allWays)} ›</a></p></div></section>
<section><div class="wrap cta-row"><div class="pilot"><h2>${escape(h.pilot)}</h2><p>${escape(h.pilotText)}</p></div>
<div class="cta-buttons"><a class="btn plain" href="/pricing">${escape(h.seePricing)}</a><a class="btn primary" href="${SIGN_UP}">${escape(t.start)}</a></div></div></section>`;
}

function stepsOf(t: SiteTexts): string {
  return `<div class="steps">${t.home.steps.map((step, index) => `<div class="step"><b>${index + 1}</b>${escape(step)}</div>`).join("")}</div>`;
}

function pricingBody(context: PageContext): string {
  const { t } = context;
  const p = t.pricing;
  const contact = context.contactEmail === undefined ? SIGN_IN : `mailto:${context.contactEmail}`;
  // Only the pilot can be started today; the other two ask to be told, by email.
  const plans = p.plans.map((plan, index) => {
    const now = index === 0;
    const href = now ? SIGN_UP : contact;
    const price = index === 1 ? `${escape(plan.price)} <small>${escape(p.perMonth)}</small>` : escape(plan.price);
    return `<div class="card plan${now ? " now" : ""}"><span class="tag">${escape(now ? p.now : p.soon)}</span><h3>${escape(plan.name)}</h3>
<div class="price">${price}</div>
<ul>${plan.features.map((feature) => `<li>${ICON.check}${escape(feature)}</li>`).join("")}</ul>
<a class="btn ${now ? "primary" : "plain"}" href="${escape(href)}">${escape(plan.action)}</a></div>`;
  });
  return `<div class="wrap hero short"><h1>${escape(p.title)}</h1></div>
<div class="wrap plans">
${plans.join("\n")}
</div>
<section><div class="wrap"><h2>${escape(p.questions)}</h2><div class="faq">
${p.faq.map((item, index) => `<details${index === 0 ? " open" : ""}><summary>${escape(item.q)}</summary><p>${escape(item.a)}</p></details>`).join("\n")}
</div></div></section>`;
}

function connectBody(context: PageContext): string {
  const { t, endpoint } = context;
  const c = t.connect;
  return `<div class="wrap hero short"><h1>${escape(c.title)}</h1></div>
<div class="wrap narrow">
${stepsOf(t)}
<h3 class="way">${escape(c.ways.python)}</h3>
${pythonSteps(t, endpoint)}
<h3 class="way">${escape(c.ways.otel)}</h3>
<p class="where">${escape(c.otelNote)}</p>
${codeBox(t, otelSnippet(endpoint))}
<h3 class="way">${escape(c.ways.api)}</h3>
<p class="where">${escape(c.apiNote)}</p>
${codeBox(t, apiSnippet(endpoint))}
<p class="note">${escape(c.keyNote)}</p>
<p class="center"><a class="btn primary" href="${SIGN_UP}">${escape(t.start)}</a></p>
</div>`;
}

const UPLOAD_ICON = line('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>');

/**
 * The check runs in the browser (verify.js); the page holds its words, in
 * the reader's language, for the script to fill in, and the two state icons
 * as templates, so the script never writes markup of its own.
 */
function verifyBody(context: PageContext): string {
  const v = context.t.verify;
  return `<div class="wrap hero short"><h1>${escape(v.title)}</h1></div>
<div class="wrap narrow" id="check" data-texts="${escape(JSON.stringify(v))}">
<label class="drop" id="drop"><span class="ico">${UPLOAD_ICON}</span><b>${escape(v.drop)}</b>
<span class="btn plain">${escape(v.choose)}</span><input type="file" id="pack" accept=".zip,application/zip" class="sr">
<span>${escape(v.private)}</span></label>
<div id="result" class="card" hidden aria-live="polite"></div>
<template id="icon-ok">${STATE_ICONS.ok}</template><template id="icon-bad">${STATE_ICONS.bad}</template>
<p class="more"><a href="${REPOSITORY}/tree/main/packages/verifier">${escape(v.cli)} ›</a></p>
</div>`;
}

function privacyBody(context: PageContext): string {
  const p = context.t.privacy;
  const contact =
    context.contactEmail === undefined
      ? ""
      : `<p><a href="mailto:${escape(context.contactEmail)}">${escape(context.contactEmail)}</a></p>`;
  return `<div class="wrap hero short"><h1>${escape(p.title)}</h1></div>
<div class="wrap narrow prose">
${p.sections
  .map((section) => `<h2>${escape(section.heading)}</h2>\n${section.paragraphs.map((text) => `<p>${escape(text)}</p>`).join("\n")}`)
  .join("\n")}
${contact}
<p>${escape(p.updated)}</p>
</div>`;
}

const BODIES: Record<SitePath, { title: (t: SiteTexts) => string; body: (context: PageContext) => string }> = {
  "/": { title: (t) => t.demo.title, body: () => "" },
  "/about": { title: (t) => t.home.title, body: homeBody },
  "/pricing": { title: (t) => `${t.pricing.title} · Sigillo`, body: pricingBody },
  "/connect": { title: (t) => `${t.connect.title} · Sigillo`, body: connectBody },
  "/verify": { title: (t) => `${t.verify.title} · Sigillo`, body: verifyBody },
  "/privacy": { title: (t) => `${t.privacy.title} · Sigillo`, body: privacyBody },
};

/**
 * The site's one script, served from this origin (the CSP allows script-src
 * 'self'): the "Copy" buttons next to each command. Everything else on the
 * site works without it.
 */
export const SITE_SCRIPT = `"use strict";
for (const button of document.querySelectorAll("button.copy")) {
  if (!navigator.clipboard) continue;
  const label = button.textContent;
  button.hidden = false;
  button.addEventListener("click", () => {
    const text = button.previousElementSibling.textContent;
    navigator.clipboard.writeText(text).then(() => {
      button.textContent = button.dataset.copied;
      setTimeout(() => { button.textContent = label; }, 1500);
    });
  });
}
`;

/**
 * The "Verify" page's script: the check itself (evidence-check.ts, tested on
 * its own against sigillo-verify) and the few lines that hand it the file and
 * show its answer, with textContent only.
 */
export const VERIFY_SCRIPT = `"use strict";
${EVIDENCE_CHECK_SOURCE}

(function () {
  const root = document.getElementById("check");
  if (root === null) return;
  const t = JSON.parse(root.dataset.texts);
  const lang = document.documentElement.lang;
  const input = document.getElementById("pack");
  const drop = document.getElementById("drop");
  const out = document.getElementById("result");
  const number = (n) => n.toLocaleString(lang);
  const fill = (text, values) => text.replace(/\\{(\\w+)\\}/g, (whole, key) => (key in values ? String(values[key]) : whole));
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const verdict = (ok, title, line) => {
    const head = element("div");
    head.className = "verdict " + (ok ? "ok" : "bad");
    head.append(document.getElementById(ok ? "icon-ok" : "icon-bad").content.cloneNode(true));
    const words = element("div");
    words.append(element("h3", title), element("p", line));
    head.append(words);
    return head;
  };
  const when = (iso) => new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "short" }).format(new Date(iso));

  const show = (result) => {
    out.replaceChildren();
    if (result.ok) {
      const s = result.summary;
      out.append(verdict(true, t.intact, fill(t.intactLine, { receipts: number(s.receipts), system: s.system_id })));
      const rows = [
        [t.signatures, fill(t.signaturesValue, { n: number(s.receipts) })],
        [t.chain, t.chainValue],
        [t.seals, s.checkpoints === 0 || s.last_checkpoint_ts === null ? t.noSeals : fill(t.sealsValue, { n: number(s.checkpoints), last: when(s.last_checkpoint_ts) })],
      ];
      if (s.unanchored_receipts > 0) rows.push([t.unsealed, number(s.unanchored_receipts)]);
      if (s.timestamps > 0) rows.push([t.timestamps, fill(t.timestampsValue, { n: number(s.timestamps) })]);
      const list = element("dl");
      for (const [term, value] of rows) list.append(element("dt", term), element("dd", value));
      out.append(list);
    } else if (result.check === "archive") {
      out.append(verdict(false, t.notPack, t.notPackLine));
    } else if (result.check === "browser") {
      out.append(verdict(false, t.oldBrowser, t.oldBrowserLine));
    } else {
      out.append(verdict(false, t.altered, t.alteredLine + " " + (t.reasons[result.check] || "")));
    }
    if (!result.ok) {
      const details = element("details");
      details.append(element("summary", t.details), element("code", result.check + " · " + result.location + ": " + result.detail));
      out.append(details);
    }
  };

  const run = async (file) => {
    if (file === undefined) return;
    out.hidden = false;
    out.replaceChildren(element("p", t.checking));
    show(await sigilloCheckPack(new Uint8Array(await file.arrayBuffer())));
  };
  input.addEventListener("change", () => run(input.files[0]));
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("over");
    run(event.dataTransfer.files[0]);
  });
})();
`;

export function registerSite(app: FastifyInstance, options: SiteOptions): void {
  const media = registerMedia(app);

  app.get("/verify.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").header("cache-control", "public, max-age=3600").send(VERIFY_SCRIPT),
  );

  app.get("/site.js", async (_request, reply) =>
    reply.type("text/javascript; charset=utf-8").header("cache-control", "public, max-age=3600").send(SITE_SCRIPT),
  );

  const respond = (request: FastifyRequest, reply: FastifyReply, path: SitePath): FastifyReply => {
    const language = options.languageOf(request);
    const t = SITE_TEXTS[language];
    const context: PageContext = {
      language,
      t,
      path,
      endpoint: options.endpoint,
      media,
      ...(options.contactEmail === undefined ? {} : { contactEmail: options.contactEmail }),
    };
    let body = path === "/" ? demoPage(context) : sitePage(context, BODIES[path].title(t), BODIES[path].body(context));
    const theme = options.themeOf(request);
    if (theme !== "system") body = body.replace(/^(<!doctype html>\n<html lang="[a-z]+")>/, `$1 data-theme="${theme}">`);
    // The page depends on the language and theme cookies, so no shared cache
    // may keep one reader's copy for another.
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", "private, no-cache")
      .header("vary", "Cookie, Accept-Language")
      .send(body);
  };

  for (const path of SITE_PATHS) {
    app.get(path, async (request, reply) => respond(request, reply, path));
  }
}
