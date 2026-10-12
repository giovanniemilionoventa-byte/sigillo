import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/blog/markdown.js";
import { loadPosts } from "../src/blog/posts.js";
import { isSiteBack, registerSite } from "../src/http/site.js";
import { languageFor } from "../src/http/locale.js";

/** The blog: the Markdown subset, the files it is read from, and its pages and sitemap. */

const directories: string[] = [];
function content(files: Record<string, string>): URL {
  const directory = mkdtempSync(join(tmpdir(), "sigillo-blog-"));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
  return pathToFileURL(`${directory}/`);
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

const head = (title: string, extra = "") => `---\ntitle: ${title}\ndescription: About ${title}.\ndate: 2026-10-20\n${extra}---\n`;

describe("markdown", () => {
  it("renders headings, lists, quotes, code and links", () => {
    const html = renderMarkdown("## A *title*\n\nSome **bold** and `code <b>`.\n\n- one\n- two\n\n1. first\n\n> quoted\n\n```\n<script>x</script>\n```\n\nSee [the other one](/blog/other) and [outside](https://example.com/a?b=1&c=2).");
    expect(html).toContain('<h2 id="a-title">A <em>title</em></h2>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code &lt;b&gt;</code>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>first</li></ol>");
    expect(html).toContain("<blockquote><p>quoted</p></blockquote>");
    expect(html).toContain("<pre>&lt;script&gt;x&lt;/script&gt;</pre>");
    expect(html).toContain('<a href="/blog/other">the other one</a>');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener">outside</a>');
  });

  it("lets nothing through that is not its own markup", () => {
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=y>\n\n[bad](javascript:alert(1)) [worse](//evil.example/x) [data](data:text/html,x)');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("loading the articles", () => {
  it("reads articles, their translations, and orders them newest first", () => {
    const posts = loadPosts(
      content({
        "old.md": `---\ntitle: Old\ndescription: d\ndate: 2026-01-01\n---\nBody.`,
        "new.md": `${head("New", "related: old\n")}Body of new.`,
        "new.it.md": `---\ntitle: Nuovo\ndescription: d\n---\nCorpo.`,
      }),
    );
    expect(posts.map((post) => post.slug)).toEqual(["new", "old"]);
    expect(posts[0]?.texts.it?.title).toBe("Nuovo");
    expect(posts[0]?.related).toEqual(["old"]);
  });

  it("serves no draft, and no translation of one", () => {
    const posts = loadPosts(content({ "wip.md": `${head("Wip", "draft: true\n")}Body.`, "wip.it.md": `---\ntitle: x\ndescription: d\n---\nCorpo.`, "README.md": "not an article" }));
    expect(posts).toEqual([]);
  });

  it("stops on a malformed file instead of publishing half of it", () => {
    expect(() => loadPosts(content({ "a.md": "no front matter" }))).toThrow(/---/);
    expect(() => loadPosts(content({ "a.md": `---\ntitle: A\ndescription: d\ndate: yesterday\n---\nBody` }))).toThrow(/date/);
    expect(() => loadPosts(content({ "Bad_Name.md": head("A") + "Body" }))).toThrow(/address/);
    expect(() => loadPosts(content({ "a.md": head("A", "related: nowhere\n") + "Body" }))).toThrow(/nowhere/);
  });

  it("finds no articles in a folder that is not there", () => {
    expect(loadPosts(new URL("file:///nonexistent-blog-directory/"))).toEqual([]);
  });
});

function site(blogDirectory: URL) {
  const app = Fastify();
  registerSite(app, {
    languageOf: (request) => languageFor(/sigillo_lang=(en|it)/.exec(request.headers.cookie ?? "")?.[1], request.headers["accept-language"]),
    themeOf: () => "system",
    endpoint: "https://sigillo.example.com/",
    blogDirectory,
  });
  return app;
}

describe("the blog on the site", () => {
  it("with no article: no menu entry, no sitemap line, and a page that asks to be left out of search", async () => {
    const app = site(content({}));
    const home = await app.inject("/");
    expect(home.body).not.toContain('href="/blog"');
    const index = await app.inject("/blog");
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("Nothing here yet.");
    expect(index.body).toContain('<meta name="robots" content="noindex">');
    expect((await app.inject("/blog/anything")).statusCode).toBe(404);
    const sitemap = (await app.inject("/sitemap.xml")).body;
    expect(sitemap).not.toContain("/blog");
    expect(sitemap).toContain("<loc>https://sigillo.example.com/verify</loc>");
  });

  it("with articles: list, article, related links, meta tags, sitemap", async () => {
    const app = site(
      content({
        "first.md": `${head("First <one>", "related: second\n")}Read [the second](/blog/second).\n\n## Part\n\nText.`,
        "second.md": `---\ntitle: Second\ndescription: Second one.\ndate: 2026-11-01\n---\nText.`,
        "second.it.md": `---\ntitle: Seconda\ndescription: La seconda.\n---\nTesto.`,
      }),
    );
    const home = await app.inject("/");
    expect(home.body).toContain('<a href="/blog">Blog</a>');

    const index = (await app.inject("/blog")).body;
    expect(index).toContain('href="/blog/first"');
    expect(index).toContain('href="/blog/second"');
    expect(index).not.toContain("noindex");
    expect(index.indexOf("/blog/second")).toBeLessThan(index.indexOf("/blog/first"));

    const post = (await app.inject("/blog/first")).body;
    expect(post).toContain("<title>First &lt;one&gt; · Sigillo</title>");
    expect(post).toContain('<link rel="canonical" href="https://sigillo.example.com/blog/first">');
    expect(post).toContain('<meta property="og:type" content="article">');
    expect(post).toContain('<meta name="description" content="About First &lt;one&gt;.">');
    expect(post).toContain('<a href="/blog/second">the second</a>');
    expect(post).toContain("Keep reading");
    expect(post).toContain('name="back" value="/blog/first"');
    const ld = /<script type="application\/ld\+json">(.*?)<\/script>/.exec(post)?.[1] ?? "";
    expect(JSON.parse(ld)).toMatchObject({ "@type": "BlogPosting", datePublished: "2026-10-20" });
    expect(ld).not.toContain("<");

    const sitemap = (await app.inject("/sitemap.xml")).body;
    expect(sitemap).toContain("<loc>https://sigillo.example.com/blog/first</loc><lastmod>2026-10-20</lastmod>");
    expect(sitemap).toContain("<loc>https://sigillo.example.com/blog</loc><lastmod>2026-11-01</lastmod>");
    expect((await app.inject("/robots.txt")).body).toContain("Sitemap: https://sigillo.example.com/sitemap.xml");
  });

  it("follows the reader's language, and says so when an article is not translated", async () => {
    const app = site(
      content({
        "first.md": `${head("First")}Text.`,
        "second.md": `---\ntitle: Second\ndescription: Second one.\ndate: 2026-11-01\n---\nText.`,
        "second.it.md": `---\ntitle: Seconda\ndescription: La seconda.\n---\nTesto.`,
      }),
    );
    const italian = { cookie: "sigillo_lang=it" };
    expect((await app.inject({ url: "/blog/second", headers: italian })).body).toContain("<h1>Seconda</h1>");
    const untranslated = (await app.inject({ url: "/blog/first", headers: italian })).body;
    expect(untranslated).toContain('<h1 lang="en">First</h1>');
    expect(untranslated).toContain("solo in inglese");
    expect((await app.inject("/blog/second")).body).toContain("<h1>Second</h1>");
  });
});

describe("where the language switch may return to", () => {
  it("accepts the blog's pages and nothing that looks like them", () => {
    for (const ok of ["/", "/verify", "/blog", "/blog/ai-act-logs"]) expect(isSiteBack(ok)).toBe(true);
    for (const no of ["/blog/", "/blog/../ui", "/blog/a/b", "//evil.example", "/blog/A_b", "https://evil.example"]) expect(isSiteBack(no)).toBe(false);
  });
});

describe("the articles shipped in the repository", () => {
  it("all load", () => {
    mkdirSync(new URL("../content/blog/", import.meta.url), { recursive: true });
    expect(() => loadPosts(new URL("../content/blog/", import.meta.url))).not.toThrow();
  });
});
