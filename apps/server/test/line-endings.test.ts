import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Files whose exact bytes matter, held to the rules in the root .gitattributes
 * (PROGRESS.md, session 7). Shell scripts must reach a Linux shell with LF:
 * deploy/Dockerfile copies deploy/backup.sh into the server image, and a
 * `#!/bin/sh\r` from a Windows checkout does not run. The protobuf fixtures
 * are read byte for byte by the ingest tests, and must never be converted,
 * whatever git's binary heuristic would make of a future one.
 *
 * Each check also runs a checkout configured the way Git for Windows
 * configures one (core.autocrlf=true), and compares what it writes with the
 * blob. Skipped outside a git checkout.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const inGitCheckout =
  spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: REPOSITORY_ROOT, encoding: "utf8" })
    .stdout?.trim() === "true";

const git = (...args: string[]): Buffer => execFileSync("git", args, { cwd: REPOSITORY_ROOT });

const tracked = (pattern: string): string[] =>
  git("ls-files", "-z", "--", pattern).toString("utf8").split("\0").filter((path) => path !== "");

function attributes(paths: string[], names: string[]): Map<string, Record<string, string>> {
  const fields = git("check-attr", "-z", ...names, "--", ...paths).toString("utf8").split("\0");
  const declared = new Map<string, Record<string, string>>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const [path, name, value] = [fields[i] ?? "", fields[i + 1] ?? "", fields[i + 2] ?? ""];
    declared.set(path, { ...declared.get(path), [name]: value });
  }
  return declared;
}

/** What a checkout with Git for Windows' settings writes for each path. */
function windowsCheckout(paths: string[]): Map<string, Buffer> {
  const directory = mkdtempSync(join(tmpdir(), "sigillo-eol-"));
  try {
    git("-c", "core.autocrlf=true", "-c", "core.eol=crlf", "checkout-index", `--prefix=${directory}/`, "--", ...paths);
    return new Map(paths.map((path) => [path, readFileSync(join(directory, path))]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const blob = (path: string): Buffer => git("cat-file", "blob", `:${path}`);
const count = (bytes: Buffer, byte: number): number => bytes.filter((b) => b === byte).length;

describe.skipIf(!inGitCheckout)("shell scripts, with LF line endings on every checkout", () => {
  const scripts = inGitCheckout ? tracked("*.sh") : [];

  it("finds the scripts the deployment and the demo run", () => {
    expect(scripts).toEqual(expect.arrayContaining(["deploy/backup.sh", "demo/selezione-cv/run_demo.sh"]));
  });

  it("declares every one text with eol=lf", () => {
    const declared = attributes(scripts, ["text", "eol"]);
    for (const path of scripts) expect({ path, ...declared.get(path) }).toEqual({ path, text: "set", eol: "lf" });
  });

  it("holds no CR, in the repository or on disk", () => {
    for (const path of scripts) {
      expect({ path, cr: count(blob(path), 13) }).toEqual({ path, cr: 0 });
      expect({ path, cr: count(readFileSync(join(REPOSITORY_ROOT, path)), 13) }).toEqual({ path, cr: 0 });
    }
  });

  it("is written with the blob's exact bytes by a checkout configured like Git for Windows", () => {
    for (const [path, written] of windowsCheckout(scripts)) expect({ path, same: written.equals(blob(path)) }).toEqual({ path, same: true });
  });
});

describe.skipIf(!inGitCheckout)("binary fixtures, never converted", () => {
  const fixtures = inGitCheckout ? tracked("*.bin") : [];

  it("finds the protobuf fixtures the ingest tests read", () => {
    expect(fixtures).toEqual(
      expect.arrayContaining([
        "apps/server/test/fixtures/openinference.protobuf.bin",
        "apps/server/test/fixtures/otel-genai.protobuf.bin",
      ]),
    );
  });

  it("declares every one binary, not left to git's heuristic", () => {
    const declared = attributes(fixtures, ["binary", "text", "diff"]);
    for (const path of fixtures) {
      expect({ path, ...declared.get(path) }).toEqual({ path, binary: "set", text: "unset", diff: "unset" });
    }
  });

  it("is written with the blob's exact bytes by a checkout configured like Git for Windows", () => {
    for (const [path, written] of windowsCheckout(fixtures)) expect({ path, same: written.equals(blob(path)) }).toEqual({ path, same: true });
  });
});
