import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Language } from "../http/locale.js";

/**
 * The blog's articles: Markdown files in content/blog, one per article and
 * language. `how-receipts-work.md` is the English text; `how-receipts-work.it.md`
 * is its Italian translation, optional. The file name is the article's address
 * (/blog/how-receipts-work). An article with no translation is shown in
 * English to an Italian reader, and marked as such.
 *
 * Each file starts with a block between two lines of `---`:
 *
 *   title:        the heading and the page title
 *   description:  one or two sentences, for search results and shared links
 *   date:         YYYY-MM-DD
 *   related:      addresses of other articles to link at the end (English file only)
 *   draft:        true keeps the file from being served at all
 *
 * The files are read once, when the server starts. A malformed one stops the
 * start, which the tests catch long before a deploy does.
 */

export interface PostText {
  title: string;
  description: string;
  /** Markdown, see markdown.ts. */
  body: string;
}

export interface Post {
  slug: string;
  /** YYYY-MM-DD, from the English file. */
  date: string;
  related: readonly string[];
  texts: { en: PostText } & Partial<Record<Language, PostText>>;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseFile(name: string, source: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(source.replace(/\r\n/g, "\n"));
  if (match === null) throw new Error(`blog: ${name} does not start with a --- block`);
  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error(`blog: ${name}: cannot read the line "${line}"`);
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: (match[2] ?? "").trim() };
}

export function loadPosts(directory: URL | undefined): Post[] {
  if (directory === undefined || !existsSync(directory)) return [];
  const posts = new Map<string, Post>();
  const translations: { slug: string; language: Language; text: PostText }[] = [];

  for (const file of readdirSync(directory).sort()) {
    const match = /^(.+?)(?:\.(it))?\.md$/.exec(file);
    if (match === null || file === "README.md") continue;
    const slug = match[1] ?? "";
    const language: Language = match[2] === "it" ? "it" : "en";
    if (!SLUG.test(slug)) throw new Error(`blog: ${file}: the address must be lowercase words joined by hyphens`);
    const { meta, body } = parseFile(file, readFileSync(new URL(file, directory), "utf8"));
    if (meta.draft === "true") continue;
    const { title, description, date } = meta;
    if (!title || !description || body === "") throw new Error(`blog: ${file}: title, description and a body are required`);
    const text: PostText = { title, description, body };
    if (language === "it") {
      translations.push({ slug, language, text });
      continue;
    }
    if (!date || !DATE.test(date)) throw new Error(`blog: ${file}: date must be YYYY-MM-DD`);
    const related = (meta.related ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
    posts.set(slug, { slug, date, related, texts: { en: text } });
  }

  for (const { slug, language, text } of translations) {
    const post = posts.get(slug);
    // A translation whose English file is a draft or missing is not served either.
    if (post !== undefined) post.texts[language] = text;
  }
  for (const post of posts.values()) {
    for (const other of post.related) {
      if (!posts.has(other)) throw new Error(`blog: ${post.slug}: related article "${other}" does not exist`);
    }
  }
  return [...posts.values()].sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

/** The article in the reader's language, and whether that is the language asked for. */
export function textIn(post: Post, language: Language): { text: PostText; language: Language } {
  const own = post.texts[language];
  return own === undefined ? { text: post.texts.en, language: "en" } : { text: own, language };
}

export function readingMinutes(text: PostText): number {
  return Math.max(1, Math.round(text.body.split(/\s+/).length / 200));
}
