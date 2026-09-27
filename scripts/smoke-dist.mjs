#!/usr/bin/env node
// The test suite runs against packages/core/src through a vitest alias. This
// checks the built package instead, under plain Node, because that is what the
// server and the verifier will load. It has caught CommonJS interop breaking
// in a dependency once already.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const { canonicalReceiptBytes, receiptHashHex, parseReceipt, fromHex, textSha256 } = await import(
  new URL("./packages/core/dist/index.js", root).href
);

const vectorFile = JSON.parse(
  readFileSync(fileURLToPath(new URL("./packages/core/test/vectors.json", root)), "utf8"),
);

let checked = 0;
for (const vector of vectorFile.vectors) {
  parseReceipt(vector.receipt);
  const canonical = new TextDecoder().decode(canonicalReceiptBytes(vector.receipt));
  if (canonical !== vector.canonical) {
    console.error(`smoke: ${vector.name} canonical form differs in the built package`);
    process.exit(1);
  }
  const hash = receiptHashHex(vector.receipt);
  if (hash !== vector.hash) {
    console.error(`smoke: ${vector.name} digest ${hash} differs from ${vector.hash}`);
    process.exit(1);
  }
  checked += 1;
}

// sigillo-text/1 as the built package runs it.
const textFile = JSON.parse(
  readFileSync(fileURLToPath(new URL("./packages/core/test/text-vectors.json", root)), "utf8"),
);
for (const vector of textFile.vectors) {
  const digest = textSha256(fromHex(vector.input_hex));
  if (digest !== vector.sha256) {
    console.error(`smoke: text vector "${vector.name}" gives ${digest}, expected ${vector.sha256}`);
    process.exit(1);
  }
}

// The built server's page script must be the one deploy/Caddyfile allows:
// the tests check the source, and this checks what production runs.
const { VERIFY_DOCUMENT_SCRIPT } = await import(new URL("./apps/server/dist/http/ui.js", root).href);
const scriptHash = createHash("sha256").update(VERIFY_DOCUMENT_SCRIPT, "utf8").digest("base64");
const caddyfile = readFileSync(fileURLToPath(new URL("./deploy/Caddyfile", root)), "utf8");
if (!caddyfile.includes(`'sha256-${scriptHash}'`)) {
  console.error(`smoke: the built page script hashes to sha256-${scriptHash}, which deploy/Caddyfile does not allow`);
  process.exit(1);
}

console.log(
  `smoke: ok, ${checked} receipt vectors and ${textFile.vectors.length} text vectors verified against the built package; ` +
    "the built page script matches deploy/Caddyfile",
);
