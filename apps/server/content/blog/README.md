# Blog articles

One Markdown file per article and language; the file name is the address
(`how-receipts-work.md` is served at `/blog/how-receipts-work`). The English
text is required, `how-receipts-work.it.md` is an optional Italian version.
The format of the files is described in `src/blog/posts.ts`, the Markdown they
may use in `src/blog/markdown.ts`.

The section is empty on purpose until the project owner approves drafts: with
no article here the blog has no menu entry and no sitemap line. A file with
`draft: true` in its header is never served.
