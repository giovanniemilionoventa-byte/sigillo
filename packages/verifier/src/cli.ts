#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { verifyBundle, type Bundle } from "./verify.js";

/** What this build checks, in the order it checks it. Printed so the reader knows. */
const CHECKS = [
  "the manifest is well formed and each published key matches its own key_id",
  "every line is a receipt of the schema version this build implements",
  "every receipt belongs to the system the manifest names",
  "sequence numbers run from the declared start with no gap, repeat or reordering",
  "a chain that starts at seq 0 starts with a genesis receipt",
  "every receipt's prev_hash is the recomputed hash of the receipt before it",
  "every receipt is signed by a key the manifest publishes",
  "the manifest's range and counts describe the receipts actually present",
];

function readBundle(target: string): Bundle {
  if (target.endsWith(".zip")) {
    throw new Error(
      "this build reads an export directory; zip archives arrive with the full bundle",
    );
  }
  const stats = statSync(target);
  if (!stats.isDirectory()) {
    throw new Error(`${target} is not a directory`);
  }
  return {
    manifestJson: readFileSync(join(target, "manifest.json"), "utf8"),
    receiptsJsonl: readFileSync(join(target, "receipts.jsonl"), "utf8"),
  };
}

const program = new Command();

program
  .name("sigillo-verify")
  .description("Verify a sigillo export: chain, signatures and the manifest that ties them together.")
  .version("0.1.0")
  .argument("<path>", "an export directory")
  .option("--quiet", "print only the verdict")
  .action((target: string, options: { quiet?: boolean }) => {
    let bundle: Bundle;
    try {
      bundle = readBundle(target);
    } catch (error) {
      process.stderr.write(`cannot read ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    }

    const result = verifyBundle(bundle);

    if (!result.ok) {
      process.stderr.write(`FAILED  ${result.check} at ${result.location}\n`);
      process.stderr.write(`        ${result.detail}\n`);
      process.exit(1);
    }

    const { summary } = result;
    process.stdout.write(
      `OK  ${summary.system_id}: ${summary.receipts} receipts, seq ${summary.first_seq}..${summary.last_seq}, signed by ${summary.key_ids.join(", ")}\n`,
    );
    if (options.quiet !== true) {
      process.stdout.write("\nverified:\n");
      for (const check of CHECKS) {
        process.stdout.write(`  - ${check}\n`);
      }
    }
  });

program.parse(process.argv);
