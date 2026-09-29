import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { FONT_FILES } from "./style.js";

/**
 * The web view's typefaces, served by the application itself: the content
 * security policy allows fonts from this origin only (`font-src 'self'`), and
 * no page ever asks another domain for one.
 *
 * The files are woff2, latin subset, under the SIL Open Font License, taken
 * unchanged from the @fontsource packages; each licence sits beside them in
 * apps/server/assets/fonts. They are read once, when the server starts, and
 * only the names listed in style.ts are served: the URL never reaches the
 * filesystem.
 *
 * Not under /ui: the login page needs them before there is a session, and
 * everything under /ui is sent as no-store.
 */
const FONT_DIRECTORY = new URL("../../assets/fonts/", import.meta.url);

export function registerFonts(app: FastifyInstance): void {
  const files = new Map(FONT_FILES.map((name) => [name, readFileSync(new URL(name, FONT_DIRECTORY))]));

  app.get("/fonts/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const bytes = files.get(name);
    if (bytes === undefined) return reply.code(404).send({ error: "not found" });
    return reply
      .type("font/woff2")
      .header("cache-control", "public, max-age=604800")
      .send(bytes);
  });
}
