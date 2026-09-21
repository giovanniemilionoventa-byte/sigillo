#!/usr/bin/env node
// The test suite runs against packages/core/src through a vitest alias. This
// checks the built package instead, under plain Node, because that is what the
// server and the verifier will load. It has caught CommonJS interop breaking
// in a dependency once already.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const { canonicalReceiptBytes, receiptHashHex, parseReceipt } = await import(
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

console.log(`smoke: ok, ${checked} vectors verified against the built package`);
