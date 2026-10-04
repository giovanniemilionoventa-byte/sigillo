import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { demoFragment, type DemoLanguage } from "./helpers/demo-snapshot.js";

describe("the demo dashboard shown before sign-in", () => {
  for (const language of ["en", "it"] as DemoLanguage[]) {
    it(`is still what the console renders now (${language}); run pnpm tsx scripts/demo-snapshot.ts when it is not`, async () => {
      const kept = readFileSync(fileURLToPath(new URL(`../assets/site/demo-${language}.html`, import.meta.url)), "utf8");
      expect(kept).toBe(await demoFragment(language));
    }, 30_000);
  }
});
