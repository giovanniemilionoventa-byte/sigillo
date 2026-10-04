/**
 * Writes the dashboard the public site shows before sign-in
 * (apps/server/assets/site/demo-en.html and demo-it.html), made from the real
 * web view with a demo company's data. Run it again whenever the console's
 * main page changes: apps/server/test/demo-snapshot.test.ts fails until you do.
 *
 * Run with: pnpm tsx scripts/demo-snapshot.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { demoFragment } from "../apps/server/test/helpers/demo-snapshot.js";

const directory = fileURLToPath(new URL("../apps/server/assets/site/", import.meta.url));
mkdirSync(directory, { recursive: true });
for (const language of ["en", "it"] as const) {
  const file = `${directory}demo-${language}.html`;
  writeFileSync(file, await demoFragment(language));
  process.stdout.write(`wrote ${file}\n`);
}
