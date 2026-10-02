import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** What the browser tests share: which browser to drive, and the policy Caddy sends. */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/**
 * A Chromium or Chrome to drive. SIGILLO_TEST_BROWSER names one outright;
 * otherwise Playwright's own download, then the usual install locations. CI
 * must find one (GitHub's runners ship Google Chrome); on a machine without
 * any, the tests are skipped rather than failed.
 */
function findBrowser(): string | undefined {
  const candidates: (string | undefined)[] = [process.env.SIGILLO_TEST_BROWSER];
  try {
    candidates.push(chromium.executablePath());
  } catch {
    // no Playwright download on this machine
  }
  const downloads = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (downloads !== undefined && existsSync(downloads)) {
    for (const entry of readdirSync(downloads).filter((name) => /^chromium-\d+$/.test(name)).sort().reverse()) {
      candidates.push(join(downloads, entry, "chrome-linux64", "chrome"), join(downloads, entry, "chrome-linux", "chrome"));
    }
  }
  candidates.push(
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    `${process.env.PROGRAMFILES ?? "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
  );
  return candidates.find((path) => path !== undefined && path !== "" && existsSync(path));
}

export const BROWSER_PATH = findBrowser();
if (BROWSER_PATH === undefined && process.env.CI !== undefined) {
  throw new Error("no Chromium or Chrome found for the browser tests: set SIGILLO_TEST_BROWSER");
}

/** The policy exactly as deploy/Caddyfile writes it, so the browser enforces the production hash. */
export function caddyfilePolicy(): string {
  const caddyfile = readFileSync(join(REPOSITORY_ROOT, "deploy", "Caddyfile"), "utf8");
  const policy = /Content-Security-Policy "([^"]+)"/.exec(caddyfile)?.[1];
  if (policy === undefined) throw new Error("deploy/Caddyfile has no Content-Security-Policy line");
  return policy;
}

