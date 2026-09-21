import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const resolveFromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@sigillo/core": resolveFromRoot("./packages/core/src/index.ts"),
      "@sigillo/verifier": resolveFromRoot("./packages/verifier/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
  },
});
