/**
 * Writes the offline verifier's zip, the very file the site serves at
 * /sigillo-verify.zip (apps/server/src/http/verifier-bundle.ts), and prints
 * its SHA-256. Run after `pnpm build`:
 *
 *   pnpm tsx scripts/verifier-zip.ts out/sigillo-verify.zip
 *
 * The workflow .github/workflows/verifier-release.yml publishes the file and
 * its fingerprint on GitHub at every change of main, so that whoever
 * downloads the verifier from a sigillo server can compare it with one the
 * server did not build: a compromised server cannot hand out a verifier that
 * lies without its fingerprint differing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { verifierZip } from "../apps/server/src/http/verifier-bundle.js";

const out = process.argv[2] ?? "sigillo-verify.zip";
const { zip, sha256 } = verifierZip();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, zip);
writeFileSync(`${out}.sha256`, `${sha256}  sigillo-verify.zip\n`);
process.stdout.write(`${sha256}\n`);
