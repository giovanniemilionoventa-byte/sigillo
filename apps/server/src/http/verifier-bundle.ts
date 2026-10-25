import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { createZip, type ZipEntry } from "@sigillo/core";

/**
 * The offline verifier, as one download: the very files the command-line
 * verifier runs from (its own build, core's build, and the three packages they
 * load), read from this installation at the moment it is asked for, so the
 * copy on the site cannot differ from the repository's. Nothing is installed
 * on the reader's side: unzip, and run it with Node 22.
 */

export const VERIFIER_ZIP_NAME = "sigillo-verify.zip";

const ROOT = "sigillo-verify";

const README = `Sigillo offline verifier

Needs Node 22 or later. For the timestamp check it also needs openssl and the
certificate of the timestamp authority (--tsa-ca). Nothing is installed and
nothing leaves your computer.

  node sigillo-verify.mjs evidence-pack.zip
  node sigillo-verify.mjs evidence-pack.zip --tsa-ca cacert.pem --key-id <the key code you were given>
  node sigillo-verify.mjs --help

The files are the open-source verifier, unchanged:
https://github.com/giovanniemilionoventa-byte/sigillo/tree/main/packages/verifier
`;

/** Runtime files of a package: no type declarations, source maps or tests. */
function runtimeFiles(directory: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "test" && name !== "__tests__") found.push(...runtimeFiles(path));
    } else if (!/\.(d\.[cm]?ts|map|ts|md)$/.test(name) || name === "LICENSE.md") {
      found.push(path);
    }
  }
  return found;
}

function packageEntries(directory: string, name: string): ZipEntry[] {
  return runtimeFiles(directory).map((file) => ({
    name: [ROOT, "node_modules", name, relative(directory, file).split(sep).join("/")].join("/"),
    data: readFileSync(file),
  }));
}

/** The directory of an installed package, found from the package that loads it. */
function packageDirectory(name: string, from: string): string {
  const require = createRequire(from);
  let directory = dirname(require.resolve(name));
  while (!statSync(join(directory, "package.json"), { throwIfNoEntry: false })?.isFile() || JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name !== name) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`package ${name} not found`);
    directory = parent;
  }
  return directory;
}

let cached: { zip: Buffer; sha256: string } | undefined;

export function verifierZip(): { zip: Buffer; sha256: string } {
  if (cached !== undefined) return cached;
  const here = import.meta.url;
  const verifier = packageDirectory("@sigillo/verifier", here);
  const core = packageDirectory("@sigillo/core", here);
  const entries: ZipEntry[] = [
    { name: `${ROOT}/README.txt`, data: Buffer.from(README) },
    { name: `${ROOT}/sigillo-verify.mjs`, data: Buffer.from('import "./node_modules/@sigillo/verifier/dist/cli.js";\n') },
    ...packageEntries(verifier, "@sigillo/verifier"),
    ...packageEntries(core, "@sigillo/core"),
    ...packageEntries(packageDirectory("commander", join(verifier, "package.json")), "commander"),
    ...packageEntries(packageDirectory("canonicalize", join(core, "package.json")), "canonicalize"),
    ...packageEntries(packageDirectory("zod", join(core, "package.json")), "zod"),
  ];
  const zip = Buffer.from(createZip(entries));
  cached = { zip, sha256: createHash("sha256").update(zip).digest("hex") };
  return cached;
}
