import { renderMarkdown } from "../blog/markdown.js";
import { readingMinutes, textIn, type Post } from "../blog/posts.js";
import type { Language } from "./locale.js";
import { escape } from "./layout.js";
import type { SiteTexts } from "./site-strings.js";

/**
 * The bodies of the blog's two kinds of page, for site.ts to put inside the
 * site's header and footer: the list of articles, and one article with the
 * ones it points to at the end.
 */

/** The styles of both pages, added to the site's own (site.ts). */
export const BLOG_STYLE = `
.posts { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; }
.post-card { display: flex; flex-direction: column; gap: 10px; }
.post-card h2, .post-card h3 { text-align: left; font-size: 21px; line-height: 1.3; letter-spacing: -0.01em; margin: 0; }
.post-card h2 a, .post-card h3 a { color: var(--ink); }
.post-card p:last-child { flex: 1; }
.meta { font-size: 14px; color: var(--box-c); }
.page-head .lead { font-size: 19px; margin-top: 12px; }
.empty { text-align: center; padding-bottom: 72px; }
.article h1 { font-size: 40px; line-height: 1.15; letter-spacing: -0.02em; font-weight: 600; margin: 8px 0 12px; }
.article .meta { margin-bottom: 8px; }
.article .summary { font-size: 20px; margin-bottom: 8px; }
.article .note { background: var(--blue-fill); border-radius: 8px; padding: 10px 14px; margin: 16px 0; }
.article .body { padding: 8px 0 32px; font-size: 18px; line-height: 1.7; }
.article .body h2 { text-align: left; font-size: 28px; margin: 44px 0 12px; }
.article .body h3 { font-size: 21px; margin: 30px 0 8px; }
.article .body p, .article .body ul, .article .body ol, .article .body blockquote, .article .body pre { margin: 0 0 18px; }
.article .body ul, .article .body ol { padding-left: 26px; }
.article .body li { margin-bottom: 6px; }
.article .body blockquote { border-left: 4px solid var(--line); padding-left: 18px; color: var(--ink); }
.article .body code { font: 15px var(--mono); background: var(--band); border-radius: 4px; padding: 1px 5px; }
.article .body pre code { background: none; padding: 0; }
.article .body a { text-decoration: underline; }
.related { padding-bottom: 72px; }
.related h2 { text-align: left; font-size: 24px; margin-bottom: 20px; }
.back { display: inline-block; margin-top: 8px; font-weight: 500; }
@media (max-width: 860px) {
  .posts { grid-template-columns: 1fr; }
  .article h1 { font-size: 30px; }
  .article .body { font-size: 17px; }
}
`;

function dateLabel(date: string, language: Language): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function minutesLabel(t: SiteTexts, post: Post, language: Language): string {
  return t.blog.minutes.replace("{n}", String(readingMinutes(textIn(post, language).text)));
}

function card(post: Post, language: Language, t: SiteTexts, heading: "h2" | "h3"): string {
  const { text, language: shown } = textIn(post, language);
  const lang = shown === language ? "" : ` lang="${shown}"`;
  return `<article class="card post-card"${lang}><p class="meta">${escape(dateLabel(post.date, language))} · ${escape(minutesLabel(t, post, shown))}</p>
<${heading}><a href="/blog/${escape(post.slug)}">${escape(text.title)}</a></${heading}>
<p>${escape(text.description)}</p></article>`;
}

export function blogIndexBody(posts: readonly Post[], language: Language, t: SiteTexts): string {
  const list = posts.length === 0 ? `<p class="empty">${escape(t.blog.empty)}</p>` : `<div class="posts">\n${posts.map((post) => card(post, language, t, "h2")).join("\n")}\n</div>`;
  return `<div class="wrap page-head"><h1>${escape(t.blog.title)}</h1><p class="lead">${escape(t.blog.lead)}</p></div>
<div class="wrap" style="padding-bottom: 72px">${list}</div>`;
}

export function postBody(post: Post, posts: readonly Post[], language: Language, t: SiteTexts): string {
  const { text, language: shown } = textIn(post, language);
  const lang = shown === language ? "" : ` lang="${shown}"`;
  const related = post.related.map((slug) => posts.find((other) => other.slug === slug)).filter((other): other is Post => other !== undefined);
  return `<div class="wrap narrow article">
<div class="page-head" style="text-align: left; padding: 56px 0 8px"><a class="back" href="/blog">‹ ${escape(t.blog.all)}</a>
<h1${lang}>${escape(text.title)}</h1>
<p class="meta">${escape(dateLabel(post.date, language))} · ${escape(minutesLabel(t, post, shown))}</p>
<p class="summary"${lang}>${escape(text.description)}</p>${shown === language ? "" : `\n<p class="note">${escape(t.blog.notTranslated)}</p>`}</div>
<div class="body"${lang}>
${renderMarkdown(text.body)}
</div>
${
  related.length === 0
    ? ""
    : `<div class="related"><h2>${escape(t.blog.related)}</h2><div class="posts">\n${related.map((other) => card(other, language, t, "h3")).join("\n")}\n</div></div>`
}
</div>`;
}

/** Structured data for search engines: what the article is, who published it and when. */
export function postJsonLd(post: Post, language: Language, url: string): string {
  const { text } = textIn(post, language);
  // "<" cannot appear in the JSON, so the text can never close the script element early.
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: text.title,
    description: text.description,
    datePublished: post.date,
    mainEntityOfPage: url,
    publisher: { "@type": "Organization", name: "Sigillo" },
  }).replace(/</g, "\\u003c");
}
