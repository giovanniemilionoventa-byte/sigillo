import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Language } from "./locale.js";
import { SITE_TEXTS, type SiteTexts } from "./site-strings.js";
import { escape } from "./layout.js";
import { EVIDENCE_CHECK_SOURCE } from "./evidence-check.js";
import { SEAL_SVG, STATE_ICONS, THEME } from "./style.js";

/**
 * The public site at the root of the domain, for people who have not signed
 * in: one long home page (why Sigillo exists, how it works, the AI Act,
 * prices, how an agent connects, contact) and two pages of their own, Verify
 * and Privacy. The console stays at /ui, one click away ("Sign in").
 *
 * Mounted only where customers sign in (ui.ts): an installation run by its
 * operator alone keeps sending / straight to the console.
 *
 * Like the web view it is server-rendered, in the
 * reader's language (the same cookie and the same Accept-Language rule as the
 * console, locale.ts), on the console's theme tokens (THEME, style.ts). The
 * phone menu opens with :target, the ways to connect are tabs made of radio
 * buttons, the video plays in the browser's own player, and the only script,
 * site.js, adds the "Copy" buttons.
 */

/**
 * The pages of the site, which the language switch may return to. Pricing and
 * connecting are sections of the home page; their old addresses lead there.
 */
export const SITE_PATHS = ["/", "/verify", "/privacy"] as const;
type SitePath = (typeof SITE_PATHS)[number];

/** Pages that became sections of the home page, and where they are now. */
const MOVED: Record<string, string> = { "/pricing": "/#pricing", "/connect": "/#connect" };

/** Where the console's sign-in and sign-up pages are. */
const SIGN_IN = "/ui/login";
const SIGN_UP = "/ui/registrati";

const REPOSITORY = "https://github.com/giovanniemilionoventa-byte/sigillo";

/** The address the site's "Contact" links write to; with none, no link is shown. */
export const SITE_CONTACT_EMAIL: string | undefined = "giovanniemilio.noventa@gmail.com";

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
// The look: the console's tokens, and a few of the site's own for a page that
// is read rather than worked in, in the manner of Google Cloud's (chosen by
// the project owner on 2026-10-04): white ground, centred headings, cards with
// a thin border and a round icon in one of four colours, a grey band for
// every other section.

const SITE_TOKENS_DARK = `
    --page: #161618; --band: #1c1c1e; --line: #3a3a3c; --ink: #f5f5f7; --primary: #8ab4f8; --on-primary: #0b1a33;
    --blue: #8ab4f8; --blue-fill: #1d2a3f; --green: #81c995; --green-fill: #1b3022;
    --yellow: #fdd663; --yellow-fill: #3a3016; --red: #f28b82; --red-fill: #3c1f1d;
    --box: #0e0e10; --on-box: #e8eaed; --box-line: #3a3a3c; --box-k: #8ab4f8; --box-s: #81c995; --box-c: #9aa0a6;
    --cta: #1d2a3f; --on-cta: #f5f5f7;
`;

const SITE_STYLE = `${THEME}
:root {
  --page: #ffffff; --band: #f8f9fa; --line: #dadce0; --ink: #202124; --primary: #1a73e8; --on-primary: #ffffff;
  --blue: #1a73e8; --blue-fill: #e8f0fe; --green: #188038; --green-fill: #e6f4ea;
  --yellow: #b06000; --yellow-fill: #fef7e0; --red: #d93025; --red-fill: #fce8e6;
  --box: #f8f9fa; --on-box: #202124; --box-line: #dadce0; --box-k: #1967d2; --box-s: #188038; --box-c: #5f6368;
  --cta: #1a73e8; --on-cta: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${SITE_TOKENS_DARK}  }
}
:root[data-theme="dark"] {${SITE_TOKENS_DARK}}
* { box-sizing: border-box; }
html { background: var(--page); -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; background: var(--page); color: var(--ink); font: 400 16px/1.55 var(--font); -webkit-font-smoothing: antialiased; }
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
h1, h2, h3, h4, p { margin: 0; }
svg { flex: none; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.wrap { max-width: 1160px; margin: 0 auto; padding: 0 24px; }
.narrow { max-width: 800px; }
header { position: sticky; top: 0; z-index: 5; background: var(--page); border-bottom: 1px solid var(--line); }
.bar { display: flex; align-items: center; gap: 32px; height: 64px; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--ink); font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.brand:hover { text-decoration: none; }
.brand svg { width: 30px; height: 30px; }
nav { display: flex; gap: 4px; flex: 1; }
nav a { color: var(--ink); font-size: 15px; font-weight: 500; padding: 8px 12px; border-radius: 6px; }
nav a:hover { text-decoration: none; background: var(--band); }
nav a[aria-current="page"] { color: var(--primary); }
.menu-close, .menu-open { display: none; color: var(--ink); }
.menu-close svg, .menu-open svg { width: 24px; height: 24px; }
.tools { display: flex; align-items: center; gap: 8px; }
.lang { margin: 0; }
.lang button { display: flex; align-items: center; gap: 6px; border: 0; background: none; color: var(--ink);
  font: 500 15px var(--font); padding: 8px 10px; border-radius: 6px; cursor: pointer; }
.lang button:hover { background: var(--band); }
.lang svg { width: 18px; height: 18px; }
.signin { color: var(--ink); font-size: 15px; font-weight: 500; padding: 8px 12px; border-radius: 6px; }
.signin:hover { text-decoration: none; background: var(--band); }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 44px; padding: 0 22px;
  border-radius: 6px; font-size: 15px; font-weight: 500; white-space: nowrap; border: 1px solid transparent; }
.btn:hover { text-decoration: none; filter: brightness(0.95); }
.btn.small { height: 38px; padding: 0 16px; }
.btn.primary { background: var(--primary); color: var(--on-primary); }
.btn.outline { background: var(--page); color: var(--primary); border-color: var(--line); }
.hero { text-align: center; padding: 80px 24px 56px; }
.badge { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 500; color: var(--blue);
  background: var(--blue-fill); border-radius: 999px; padding: 6px 14px; margin-bottom: 24px; }
.badge svg { width: 16px; height: 16px; }
.hero h1 { font-size: 56px; line-height: 1.1; letter-spacing: -0.025em; font-weight: 600; max-width: 860px; margin: 0 auto; }
.hero .lead { font-size: 20px; margin: 22px auto 0; max-width: 640px; }
.ctas { display: flex; gap: 12px; justify-content: center; margin-top: 32px; }
.facts { display: flex; gap: 28px; justify-content: center; flex-wrap: wrap; margin: 28px 0 0; padding: 0; list-style: none; font-size: 15px; }
.facts li { display: flex; align-items: center; gap: 8px; }
.facts svg { width: 18px; height: 18px; color: var(--green); }
.video { max-width: 960px; margin: 0 auto; border-radius: 12px; overflow: hidden; background: #111114;
  border: 1px solid var(--line); box-shadow: 0 1px 3px rgba(60,64,67,0.15), 0 12px 40px rgba(60,64,67,0.18); aspect-ratio: 16 / 9; }
.video video, .video img { display: block; width: 100%; height: 100%; object-fit: cover; }
section { padding: 96px 0; scroll-margin-top: 64px; }
.band { background: var(--band); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.head { text-align: center; max-width: 780px; margin: 0 auto 48px; }
h2 { font-size: 40px; line-height: 1.15; letter-spacing: -0.02em; font-weight: 600; text-align: center; }
.head p { font-size: 19px; margin-top: 16px; }
h3.sub { font-size: 26px; font-weight: 600; letter-spacing: -0.01em; text-align: center; margin: 72px 0 32px; }
.grid { display: grid; gap: 24px; }
.grid.three { grid-template-columns: repeat(3, 1fr); }
.grid.four { grid-template-columns: repeat(4, 1fr); }
.card { background: var(--page); border: 1px solid var(--line); border-radius: 12px; padding: 28px; }
.card h3 { font-size: 19px; line-height: 1.3; font-weight: 600; margin: 18px 0 8px; letter-spacing: -0.01em; }
.ico { width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.ico svg { width: 24px; height: 24px; }
.ico.blue { color: var(--blue); background: var(--blue-fill); }
.ico.green { color: var(--green); background: var(--green-fill); }
.ico.yellow { color: var(--yellow); background: var(--yellow-fill); }
.ico.red { color: var(--red); background: var(--red-fill); }
.steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; counter-reset: step; }
.steps .card { position: relative; }
.num { width: 36px; height: 36px; border-radius: 50%; background: var(--primary); color: var(--on-primary);
  display: flex; align-items: center; justify-content: center; font-weight: 600; }
.ref { display: inline-block; font-size: 13px; font-weight: 600; color: var(--blue); background: var(--blue-fill);
  border-radius: 999px; padding: 4px 12px; }
.callout { display: flex; gap: 14px; align-items: flex-start; max-width: 860px; margin: 32px auto 0; padding: 18px 22px;
  border-radius: 12px; background: var(--blue-fill); }
.callout svg { width: 22px; height: 22px; color: var(--blue); margin-top: 1px; }
.plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; align-items: stretch; }
.plan { display: flex; flex-direction: column; gap: 18px; }
.plan h3 { margin: 0; font-size: 22px; }
.plan.now { border-top: 4px solid var(--primary); }
.price { font-size: 42px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; }
.price small { font-size: 16px; font-weight: 500; }
.plan ul { list-style: none; margin: 0; padding: 18px 0 0; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 12px; flex: 1; }
.plan li { display: flex; gap: 10px; }
.plan li svg { width: 18px; height: 18px; color: var(--green); margin-top: 3px; }
.tag { align-self: flex-start; font-size: 13px; font-weight: 600; border-radius: 999px; padding: 4px 12px; color: var(--ink); background: var(--band); border: 1px solid var(--line); }
.now .tag { color: var(--green); background: var(--green-fill); border-color: transparent; }
.faq { max-width: 800px; margin: 0 auto; border: 1px solid var(--line); border-radius: 12px; background: var(--page); }
details { border-top: 1px solid var(--line); padding: 20px 24px; }
details:first-child { border-top: 0; }
summary { font-weight: 600; cursor: pointer; font-size: 17px; }
details p { margin-top: 10px; }
.flow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; max-width: 860px; margin: 0 auto 40px; }
.flow div { display: flex; align-items: center; gap: 12px; font-weight: 500; }
.tabs { display: flex; flex-wrap: wrap; max-width: 860px; margin: 0 auto; border: 1px solid var(--line); border-radius: 12px; background: var(--page); overflow: hidden; }
.tabs > label { padding: 16px 24px; font-weight: 600; cursor: pointer; border-bottom: 3px solid transparent; }
.tabs > label:hover { background: var(--band); }
.tabs .panel { display: none; order: 1; flex-basis: 100%; padding: 28px; border-top: 1px solid var(--line); }
#way-python:checked + label, #way-otel:checked + label, #way-api:checked + label { color: var(--primary); border-bottom-color: var(--primary); }
#way-python:checked ~ .p-python, #way-otel:checked ~ .p-otel, #way-api:checked ~ .p-api { display: block; }
.tabs input:focus-visible + label { outline: 2px solid var(--primary); outline-offset: -4px; }
h4 { font-size: 17px; margin: 0 0 4px; }
.where { margin: 0 0 12px; }
.code { position: relative; margin: 0 0 24px; }
.code:last-child { margin-bottom: 0; }
pre { background: var(--box); color: var(--on-box); border: 1px solid var(--box-line); border-radius: 8px; padding: 18px 20px;
  font: 13.5px/1.7 var(--mono); margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
pre .c { color: var(--box-c); } pre .k { color: var(--box-k); } pre .s { color: var(--box-s); }
.code .copy { position: absolute; top: 10px; right: 10px; border: 1px solid var(--line); border-radius: 6px; padding: 4px 12px;
  background: var(--page); color: var(--primary); font: 500 13px var(--font); cursor: pointer; }
.code .copy:hover { background: var(--band); }
.code pre { padding-right: 88px; }
.keynote { text-align: center; margin-top: 24px; }
.cta { background: var(--cta); color: var(--on-cta); text-align: center; padding: 80px 0; }
.cta h2 { color: var(--on-cta); }
.cta p { font-size: 19px; margin-top: 14px; }
.cta .ctas .btn.primary { background: #ffffff; color: #1a73e8; }
.cta .ctas .btn.outline { background: transparent; color: var(--on-cta); border-color: rgba(255,255,255,0.6); }
.cta .mail { margin-top: 20px; font-size: 15px; }
.cta .mail a { color: var(--on-cta); text-decoration: underline; }
.drop { display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; cursor: pointer;
  border: 2px dashed var(--line); border-radius: 12px; background: var(--page); padding: 48px 24px; }
.drop.over { border-color: var(--primary); }
.drop b { font-size: 18px; }
.drop .ico { width: 64px; height: 64px; }
.drop .ico svg { width: 30px; height: 30px; }
.drop:focus-within { outline: 2px solid var(--primary); outline-offset: 2px; }
.page-head { text-align: center; padding: 72px 24px 40px; }
.page-head h1 { font-size: 44px; letter-spacing: -0.02em; font-weight: 600; }
#check { padding-bottom: 72px; }
#result { margin-top: 24px; }
.verdict { display: flex; gap: 14px; align-items: flex-start; }
.verdict svg { width: 32px; height: 32px; margin-top: 2px; }
.verdict h3 { margin: 0 0 4px; font-size: 22px; }
.verdict.ok { color: var(--ok); }
.verdict.bad { color: var(--bad); }
.verdict p { color: var(--ink); }
#result dl { display: grid; grid-template-columns: auto 1fr; gap: 10px 24px; margin: 22px 0 0; padding-top: 18px; border-top: 1px solid var(--line); }
#result dt { font-weight: 600; }
#result dd { margin: 0; }
#result details { padding: 0; margin-top: 18px; border: 0; }
#result code { font: 13px/1.5 var(--mono); overflow-wrap: anywhere; }
.more { text-align: center; margin-top: 24px; font-weight: 500; }
.prose h2 { text-align: left; font-size: 22px; margin: 36px 0 10px; }
.prose p { margin: 0 0 12px; }
.prose { padding-bottom: 56px; }
footer { background: var(--band); border-top: 1px solid var(--line); padding: 56px 0 32px; font-size: 15px; }
.cols { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 32px; }
.cols h4 { font-size: 14px; font-weight: 600; margin-bottom: 14px; }
.cols ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.cols a { color: var(--ink); }
.cols .brand { margin-bottom: 12px; }
.legal { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--line); font-size: 14px; }
@media (max-width: 1000px) {
  nav a { padding: 8px 8px; }
  .grid.four, .steps { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 860px) {
  .bar { gap: 8px; }
  .tools { margin-left: auto; }
  .signin, .tools .btn { display: none; }
  .menu-open { display: flex; }
  nav { display: none; }
  nav:target { display: flex; flex-direction: column; gap: 0; position: fixed; inset: 0; z-index: 10; background: var(--page); padding: 16px 24px; }
  nav:target a { font-size: 20px; padding: 14px 0; border-radius: 0; border-bottom: 1px solid var(--line); }
  nav:target .menu-close { display: flex; justify-content: flex-end; border: 0; padding: 8px 0; }
  nav:target .menu-only { display: block; }
  .hero { padding: 48px 20px 40px; }
  .hero h1 { font-size: 36px; }
  .hero .lead { font-size: 18px; }
  .ctas { flex-direction: column; align-items: stretch; }
  .facts { flex-direction: column; align-items: center; gap: 10px; }
  .grid.three, .grid.four, .steps, .plans, .flow { grid-template-columns: 1fr; }
  section { padding: 64px 0; }
  h2 { font-size: 30px; }
  h3.sub { margin-top: 56px; }
  .head p { font-size: 17px; }
  .tabs > label { padding: 14px 16px; }
  .tabs .panel { padding: 20px; }
  pre { font-size: 12px; padding: 16px; }
  .cols { grid-template-columns: 1fr 1fr; }
  .cols > div:first-child { grid-column: 1 / -1; }
  .page-head h1 { font-size: 34px; }
  .card { padding: 20px; }
  .grid .card:has(> .ico), .steps .card { display: grid; grid-template-columns: 40px 1fr; column-gap: 14px; }
  .grid .card > .ico, .steps .num { width: 40px; height: 40px; grid-row: span 2; }
  .grid .card > .ico svg { width: 20px; height: 20px; }
  .grid .card:has(> .ico) h3, .steps .card h3 { margin: 0 0 4px; align-self: center; }
  .grid .card:has(> .ico) p, .steps .card p { grid-column: 2; }
  .grid .card .ref + h3 { margin-top: 12px; }
}
.menu-only { display: none; }
`;

const line = (shape: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round">${shape}</svg>`;

const ICON = {
  pen: line('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>'),
  chain: line('<path d="M10 13a5 5 0 007.5.5l3-3a5 5 0 00-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 00-7.5-.5l-3 3a5 5 0 007 7l1.7-1.7"/>'),
  doc: line('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 15l2 2 4-4"/>'),
  search: line('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  flag: line('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>'),
  building: line('<path d="M4 21V5a1 1 0 011-1h8a1 1 0 011 1v16M14 9h5a1 1 0 011 1v11M3 21h18M8 8h2M8 12h2M8 16h2"/>'),
  users: line('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0113 0M16 4.5a3.5 3.5 0 010 7M18 14a6 6 0 013.5 6"/>'),
  code: line('<path d="M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>'),
  lock: line('<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>'),
  eye: line('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  shield: line('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>'),
  clock: line('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  info: line('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
  globe: line('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>'),
  menu: line('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: line('<path d="M6 6l12 12M18 6L6 18"/>'),
  check: `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false" style="fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round"><path d="M4 10.5l4 4 8-9"/></svg>`,
};

/** The four colours the icons take in turn. */
const HUES = ["blue", "green", "yellow", "red"] as const;

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
// The pages: one long home page with every section, and two of their own,
// Verify and Privacy.

interface PageContext {
  language: Language;
  t: SiteTexts;
  path: SitePath | null;
  contactEmail?: string;
  endpoint: string;
  media: Set<string>;
}

/**
 * Writing to the address opens Gmail's own compose window, already addressed:
 * a mailto: link waits on whatever mail program the visitor's computer has,
 * and most visitors have none set up. The address stays on the page for those
 * who use another mail service.
 */
function mailLink(email: string, subject: string): string {
  return `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}`;
}

function sitePage(context: PageContext, title: string, body: string): string {
  const { t, path, language } = context;
  const contactHref = context.contactEmail === undefined ? undefined : mailLink(context.contactEmail, "Sigillo");
  const section = (id: string, label: string): string => `<a href="/#${id}">${escape(label)}</a>`;
  const verify = `<a href="/verify"${path === "/verify" ? ' aria-current="page"' : ""}>${escape(t.nav.verify)}</a>`;
  const external = (href: string, label: string): string => `<a href="${escape(href)}" target="_blank" rel="noopener">${escape(label)}</a>`;
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
<header><div class="wrap bar">
<a class="brand" href="/">${SEAL_SVG}<span>sigillo</span></a>
<nav id="menu"><a class="menu-close" href="#" aria-label="×">${ICON.close}</a>${section("why", t.nav.why)}${section("how", t.nav.how)}${section("ai-act", t.nav.aiAct)}${section("pricing", t.nav.pricing)}${section("connect", t.nav.connect)}${verify}<a class="menu-only" href="${SIGN_IN}">${escape(t.signIn)}</a></nav>
<div class="tools">
<form class="lang" method="post" action="/ui/lingua"><input type="hidden" name="lang" value="${language === "en" ? "it" : "en"}"><input type="hidden" name="back" value="${path ?? "/"}"><button type="submit" aria-label="${escape(t.switchLabel)}" lang="${language === "en" ? "it" : "en"}">${ICON.globe}${escape(t.switchTo)}</button></form>
<a class="signin" href="${SIGN_IN}">${escape(t.signIn)}</a>
<a class="btn primary small" href="${SIGN_UP}">${escape(t.start)}</a>
<a class="menu-open" href="#menu" aria-label="Menu">${ICON.menu}</a>
</div>
</div></header>
<main>
${body}
</main>
<footer><div class="wrap">
<div class="cols">
<div><a class="brand" href="/">${SEAL_SVG}<span>sigillo</span></a><p>${escape(t.footer.europe)}</p></div>
<div><h4>${escape(t.footer.product)}</h4><ul><li>${section("why", t.nav.why)}</li><li>${section("how", t.nav.how)}</li><li>${section("ai-act", t.nav.aiAct)}</li><li>${section("pricing", t.nav.pricing)}</li></ul></div>
<div><h4>${escape(t.footer.developers)}</h4><ul><li>${section("connect", t.nav.connect)}</li><li><a href="/verify">${escape(t.nav.verify)}</a></li><li>${external(`${REPOSITORY}/tree/main/packages/verifier`, t.footer.verifier)}</li></ul></div>
<div><h4>${escape(t.footer.company)}</h4><ul>${contactHref === undefined ? "" : `<li>${external(contactHref, t.footer.contact)}</li>`}<li><a href="/privacy">${escape(t.footer.privacy)}</a></li><li><a href="${SIGN_IN}">${escape(t.signIn)}</a></li></ul></div>
</div>
<p class="legal">© 2026 Sigillo</p>
</div></footer>
</body>
</html>`;
}

/** A centred heading, with an optional sentence under it. */
function sectionHead(title: string, lead?: string): string {
  return `<div class="head"><h2>${escape(title)}</h2>${lead === undefined ? "" : `<p>${escape(lead)}</p>`}</div>`;
}

/** Cards with a round icon each, the colours taken in turn from `start`. */
function iconCards(points: readonly { title: string; text: string }[], icons: readonly string[], columns: "three" | "four", start = 0): string {
  return `<div class="grid ${columns}">
${points
  .map((point, index) => `<div class="card"><div class="ico ${HUES[(start + index) % HUES.length]}">${icons[index] ?? ""}</div><h3>${escape(point.title)}</h3><p>${escape(point.text)}</p></div>`)
  .join("\n")}
</div>`;
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
  const contact =
    context.contactEmail === undefined
      ? ""
      : `<a class="btn outline" href="${escape(mailLink(context.contactEmail, "Sigillo"))}" target="_blank" rel="noopener">${escape(h.contact.action)}</a>`;
  return `<div class="wrap hero"><span class="badge">${ICON.shield}${escape(h.badge)}</span>
<h1>${escape(h.heading)}</h1>
<p class="lead">${escape(h.lead)}</p>
<div class="ctas"><a class="btn primary" href="${SIGN_UP}">${escape(t.start)}</a>${contact}</div>
<ul class="facts">${h.facts.map((fact) => `<li>${ICON.check}${escape(fact)}</li>`).join("")}</ul></div>
<div class="wrap" id="demo"><div class="video">${video}</div></div>
${whySection(t)}
${howSection(t)}
${aiActSection(t)}
${pricingSection(context)}
${connectSection(context)}
${contactSection(context)}`;
}

/** Why Sigillo exists: the problem, and who it is for. */
function whySection(t: SiteTexts): string {
  const w = t.home.why;
  return `<section id="why"><div class="wrap">${sectionHead(w.title, w.lead)}
${iconCards(w.problems, [ICON.pen, ICON.search, ICON.flag], "three")}
<h3 class="sub">${escape(w.audienceTitle)}</h3>
${iconCards(w.audience, [ICON.building, ICON.users, ICON.code], "three")}
</div></section>`;
}

/** How it works, in four numbered steps, and what makes it different. */
function howSection(t: SiteTexts): string {
  const h = t.home.how;
  return `<section id="how" class="band"><div class="wrap">${sectionHead(h.title)}
<div class="steps">
${h.steps.map((step, index) => `<div class="card"><div class="num">${index + 1}</div><h3>${escape(step.title)}</h3><p>${escape(step.text)}</p></div>`).join("\n")}
</div>
<h3 class="sub">${escape(h.differenceTitle)}</h3>
${iconCards(h.difference, [ICON.lock, ICON.chain, ICON.eye, ICON.shield], "four")}
</div></section>`;
}

function aiActSection(t: SiteTexts): string {
  const a = t.home.aiAct;
  return `<section id="ai-act"><div class="wrap">${sectionHead(a.title, a.lead)}
<div class="grid three">
${a.articles.map((article) => `<div class="card"><span class="ref">${escape(article.ref)}</span><h3>${escape(article.title)}</h3><p>${escape(article.text)}</p></div>`).join("\n")}
</div>
<p class="callout">${ICON.info}<span>${escape(a.note)}</span></p></div></section>`;
}

function pricingSection(context: PageContext): string {
  const { t } = context;
  const p = t.pricing;
  // Only the pilot can be started today; the other two ask to be told, by email.
  const plans = p.plans.map((plan, index) => {
    const now = index === 0;
    const href = now ? SIGN_UP : context.contactEmail === undefined ? SIGN_IN : mailLink(context.contactEmail, `Sigillo: ${plan.name}`);
    const price = index === 1 ? `${escape(plan.price)} <small>${escape(p.perMonth)}</small>` : escape(plan.price);
    return `<div class="card plan${now ? " now" : ""}"><span class="tag">${escape(now ? p.now : p.soon)}</span><h3>${escape(plan.name)}</h3>
<div class="price">${price}</div>
<ul>${plan.features.map((feature) => `<li>${ICON.check}${escape(feature)}</li>`).join("")}</ul>
<a class="btn ${now ? "primary" : "outline"}" href="${escape(href)}"${now ? "" : ' target="_blank" rel="noopener"'}>${escape(plan.action)}</a></div>`;
  });
  return `<section id="pricing" class="band"><div class="wrap">${sectionHead(p.title, p.lead)}
<div class="plans">
${plans.join("\n")}
</div>
<h3 class="sub">${escape(p.questions)}</h3>
<div class="faq">
${p.faq.map((item, index) => `<details${index === 0 ? " open" : ""}><summary>${escape(item.q)}</summary><p>${escape(item.a)}</p></details>`).join("\n")}
</div></div></section>`;
}

/** The three ways to connect an agent, as tabs that need no script (radio buttons and :checked). */
function connectSection(context: PageContext): string {
  const { t, endpoint } = context;
  const c = t.connect;
  const tab = (id: string, label: string, checked: boolean): string =>
    `<input type="radio" name="way" id="way-${id}" class="sr"${checked ? " checked" : ""}><label for="way-${id}">${escape(label)}</label>`;
  return `<section id="connect"><div class="wrap">${sectionHead(c.title)}
<div class="flow">${c.steps.map((step, index) => `<div><span class="num">${index + 1}</span>${escape(step)}</div>`).join("")}</div>
<div class="tabs">
${tab("python", c.ways.python, true)}
${tab("otel", c.ways.otel, false)}
${tab("api", c.ways.api, false)}
<div class="panel p-python">${pythonSteps(t, endpoint)}</div>
<div class="panel p-otel"><p class="where">${escape(c.otelNote)}</p>
${codeBox(t, otelSnippet(endpoint))}</div>
<div class="panel p-api"><p class="where">${escape(c.apiNote)}</p>
${codeBox(t, apiSnippet(endpoint))}</div>
</div>
<p class="keynote">${escape(c.keyNote)}</p>
</div></section>`;
}

function contactSection(context: PageContext): string {
  const { t, contactEmail } = context;
  if (contactEmail === undefined) return "";
  const c = t.home.contact;
  return `<section id="contact" class="cta"><div class="wrap"><h2>${escape(c.title)}</h2>
<p>${escape(c.text)}</p>
<div class="ctas"><a class="btn primary" href="${escape(mailLink(contactEmail, "Sigillo"))}" target="_blank" rel="noopener">${escape(c.action)}</a><a class="btn outline" href="${SIGN_UP}">${escape(t.start)}</a></div>
<p class="mail"><a href="${escape(mailLink(contactEmail, "Sigillo"))}" target="_blank" rel="noopener">${escape(contactEmail)}</a></p></div></section>`;
}

const UPLOAD_ICON = line('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3"/>');

/**
 * The check runs in the browser (verify.js); the page holds its words, in
 * the reader's language, for the script to fill in, and the two state icons
 * as templates, so the script never writes markup of its own.
 */
function verifyBody(context: PageContext): string {
  const v = context.t.verify;
  return `<div class="wrap page-head"><h1>${escape(v.title)}</h1></div>
<div class="wrap narrow" id="check" data-texts="${escape(JSON.stringify(v))}">
<label class="drop" id="drop"><span class="ico blue">${UPLOAD_ICON}</span><b>${escape(v.drop)}</b>
<span class="btn outline">${escape(v.choose)}</span><input type="file" id="pack" accept=".zip,application/zip" class="sr">
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
      : `<p><a href="${escape(mailLink(context.contactEmail, "Sigillo"))}" target="_blank" rel="noopener">${escape(context.contactEmail)}</a></p>`;
  return `<div class="wrap page-head"><h1>${escape(p.title)}</h1></div>
<div class="wrap narrow prose">
${p.sections
  .map((section) => `<h2>${escape(section.heading)}</h2>\n${section.paragraphs.map((text) => `<p>${escape(text)}</p>`).join("\n")}`)
  .join("\n")}
${contact}
<p>${escape(p.updated)}</p>
</div>`;
}

const BODIES: Record<SitePath, { title: (t: SiteTexts) => string; body: (context: PageContext) => string }> = {
  "/": { title: (t) => t.home.title, body: homeBody },
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
    let body = sitePage(context, BODIES[path].title(t), BODIES[path].body(context));
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
  for (const [from, to] of Object.entries(MOVED)) {
    app.get(from, async (_request, reply) => reply.redirect(to, 301));
  }
}
