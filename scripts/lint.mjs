#!/usr/bin/env node
// Dependency-free lint pass. It does not check style: it enforces the
// architectural invariants from CLAUDE.md that silently rot otherwise.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const ALLOWED_RUNTIME_DEPS = new Set([
  "fastify",
  "better-sqlite3",
  "canonicalize",
  "zod",
  "protobufjs",
  "pdfkit",
  "commander",
]);

// playwright-core drives a real browser in apps/server's "verifica un
// documento" tests, the one page whose behaviour lives in the browser. Added
// on the project owner's instruction of 2026-09-26 (PROGRESS.md, session 6).
const ALLOWED_DEV_DEPS = new Set(["typescript", "tsx", "vitest", "fast-check", "playwright-core"]);

// packages/verifier must stay auditable on its own: core plus a CLI parser.
const VERIFIER_ALLOWED_DEPS = new Set(["@sigillo/core", "commander"]);

const problems = [];

function fail(file, line, message) {
  problems.push(line === null ? `${file}: ${message}` : `${file}:${line}: ${message}`);
}

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const allFiles = walk(ROOT);
const rel = (file) => relative(ROOT, file).split(sep).join("/");
const tsFiles = allFiles.filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"));

// 1. packages/core stays pure: no I/O, no clock, no environment, no randomness.
const IMPURE_PATTERNS = [
  // zlib is computation, not I/O: it turns bytes into bytes, which is what the
  // export archive needs and what core is allowed to do.
  [/from\s+["']node:(?!crypto|zlib)([a-z/]+)["']/, "core may only import node:crypto and node:zlib"],
  [/require\(\s*["']node:(?!crypto|zlib)/, "core may only import node:crypto and node:zlib"],
  [/\bprocess\.(env|argv|cwd|exit)\b/, "core must not read the environment or process state"],
  [/\bDate\.now\s*\(/, "core must not read the clock; pass time in as a parameter"],
  [/\bnew Date\s*\(\s*\)/, "core must not read the clock; pass time in as a parameter"],
  [/\bperformance\.now\s*\(/, "core must not read the clock"],
  [/\bMath\.random\s*\(/, "core must not generate randomness internally"],
  [/\bfetch\s*\(/, "core must not perform network I/O"],
];

for (const file of tsFiles.filter((f) => rel(f).startsWith("packages/core/src/"))) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((text, index) => {
    for (const [pattern, message] of IMPURE_PATTERNS) {
      if (pattern.test(text)) fail(rel(file), index + 1, message);
    }
  });
}

// 2. The server must have no way to hold a private key: it asks the signer.
const PRIVATE_KEY_APIS = ["createPrivateKey", "generateKeyPair", "privateKey"];
for (const file of tsFiles.filter((f) => rel(f).startsWith("apps/server/src/"))) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((text, index) => {
    for (const api of PRIVATE_KEY_APIS) {
      if (text.includes(api)) {
        fail(rel(file), index + 1, `the server must not touch private key material (${api})`);
      }
    }
  });
}

// 3. No dependency outside the list approved in SPEC.md section 3.
const packageJsonFiles = allFiles.filter((f) => f.endsWith("package.json"));
for (const file of packageJsonFiles) {
  const name = rel(file);
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const isWorkspacePackage = name !== "package.json";

  if (isWorkspacePackage && pkg.type !== "module") {
    fail(name, null, 'every workspace package must set "type": "module"');
  }

  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith("@sigillo/") || ALLOWED_RUNTIME_DEPS.has(dep)) continue;
    fail(name, null, `runtime dependency "${dep}" is not in the approved list (SPEC.md section 3)`);
  }
  for (const dep of Object.keys(pkg.devDependencies ?? {})) {
    if (dep.startsWith("@sigillo/") || dep.startsWith("@types/")) continue;
    if (ALLOWED_DEV_DEPS.has(dep) || ALLOWED_RUNTIME_DEPS.has(dep)) continue;
    fail(name, null, `dev dependency "${dep}" is not in the approved list (SPEC.md section 3)`);
  }

  if (name === "packages/verifier/package.json") {
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!VERIFIER_ALLOWED_DEPS.has(dep)) {
        fail(name, null, `the verifier must depend only on core and commander, found "${dep}"`);
      }
    }
  }
}

// 4. A stray .only() silently disables the rest of a suite.
for (const file of tsFiles.filter((f) => rel(f).includes("/test/"))) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, index) => {
      if (/\b(describe|it|test)\.only\s*\(/.test(text)) {
        fail(rel(file), index + 1, "remove .only() before committing");
      }
    });
}

// 5. Explicit any defeats strict mode; opt out per line with `// lint-allow-any`.
const ANY_PATTERNS = [/:\s*any\b/, /\bas\s+any\b/, /<\s*any\s*[,>]/];
for (const file of tsFiles) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((text, index) => {
      if (text.includes("lint-allow-any")) return;
      if (ANY_PATTERNS.some((pattern) => pattern.test(text))) {
        fail(rel(file), index + 1, "explicit any (add `// lint-allow-any: reason` to override)");
      }
    });
}

// 6. The version stamped into exports must match the repository's version.
{
  const rootVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const versionFile = join(ROOT, "packages/core/src/version.ts");
  const declared = /SIGILLO_VERSION = "([^"]+)"/.exec(readFileSync(versionFile, "utf8"))?.[1];
  if (declared !== rootVersion) {
    fail("packages/core/src/version.ts", null, `declares ${declared} but package.json says ${rootVersion}`);
  }
}

// 7. Private key material must never be committed.
for (const file of allFiles) {
  if (/\.(key|pem)$/.test(file)) {
    fail(rel(file), null, "key material must not live in the repository");
  }
}

// py.typed is a marker whose contents are irrelevant, and conventionally empty.
for (const file of allFiles.filter((f) => statSync(f).size === 0)) {
  if (rel(file).endsWith("py.typed")) continue;
  fail(rel(file), null, "empty file");
}

if (problems.length > 0) {
  console.error(`lint: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`lint: ok (${tsFiles.length} source files, ${packageJsonFiles.length} manifests)`);
