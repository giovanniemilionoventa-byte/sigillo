import { escape } from "../http/layout.js";

/**
 * The small subset of Markdown the blog's articles are written in, turned
 * into HTML. Everything the author writes is escaped; the only markup that
 * comes out is the markup below, so an article cannot carry a script.
 *
 *   ## heading, ### sub-heading     - bullet list      1. numbered list
 *   > quote        ``` fenced code ```       a blank line between paragraphs
 *   **bold**   *emphasis*   `code`   [text](/blog/other-article)
 *
 * A link goes to a page of this site ("/..."), to "#anchor", or to "https://...".
 */

const SAFE_LINK = /^(\/(?!\/)[^\s]*|#[\w-]+|https:\/\/[^\s]+)$/;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function emphasis(raw: string): string {
  return escape(raw)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function links(raw: string): string {
  let out = "";
  let rest = raw;
  for (;;) {
    const match = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (match === null) return out + emphasis(rest);
    out += emphasis(rest.slice(0, match.index));
    const [whole, label = "", href = ""] = match;
    if (SAFE_LINK.test(href)) {
      const external = href.startsWith("https://");
      out += `<a href="${escape(href)}"${external ? ' target="_blank" rel="noopener"' : ""}>${emphasis(label)}</a>`;
    } else {
      out += emphasis(label);
    }
    rest = rest.slice(match.index + whole.length);
  }
}

/** One line of running text: code spans first, so nothing inside them is touched. */
export function inline(raw: string): string {
  return raw
    .split(/(`[^`]+`)/)
    .map((part) => (part.length > 2 && part.startsWith("`") && part.endsWith("`") ? `<code>${escape(part.slice(1, -1))}</code>` : links(part)))
    .join("");
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) code.push(lines[index++] ?? "");
      index += 1;
      html.push(`<pre>${escape(code.join("\n"))}</pre>`);
      continue;
    }
    const heading = /^(#{2,3}) (.+)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "##").length;
      const text = heading[2] ?? "";
      html.push(`<h${level} id="${slugify(text)}">${inline(text)}</h${level}>`);
      index += 1;
      continue;
    }
    const list = /^(-|\d+\.) /.exec(line);
    if (list !== null) {
      const ordered = list[1] !== "-";
      const items: string[] = [];
      while (index < lines.length && /^(-|\d+\.) /.test(lines[index] ?? "")) {
        items.push(`<li>${inline((lines[index++] ?? "").replace(/^(-|\d+\.) /, ""))}</li>`);
      }
      html.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").startsWith("> ")) quote.push((lines[index++] ?? "").slice(2));
      html.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() !== "" && !/^(#{2,3} |```|> |- |\d+\. )/.test(lines[index] ?? "")) {
      paragraph.push(lines[index++] ?? "");
    }
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
  }
  return html.join("\n");
}
