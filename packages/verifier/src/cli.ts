#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { readZip, safeParseCheckpointEntry, type CheckpointEntry } from "@sigillo/core";
import { verifyTimestamps } from "./timestamps.js";
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
  "every artifact a v2 receipt names is indexed once, and the index claims nothing more",
  "every checkpoint is signed by a key the manifest publishes",
  "every Merkle root is rebuilt from the receipts present",
  "every inclusion proof rebuilds its checkpoint's root",
  "the manifest's range and counts describe what the archive actually holds",
  "every RFC 3161 token is checked with openssl",
];

interface Archive {
  bundle: Bundle;
  tokens: Map<string, Uint8Array>;
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function readArchiveFile(target: string): Archive {
  const files = new Map<string, Uint8Array>();
  for (const entry of readZip(new Uint8Array(readFileSync(target)))) {
    files.set(entry.name, entry.data);
  }

  const manifest = files.get("manifest.json");
  const receipts = files.get("receipts.jsonl");
  if (manifest === undefined || receipts === undefined) {
    throw new Error("the archive has no manifest.json or no receipts.jsonl");
  }

  const checkpoints = files.get("checkpoints.jsonl");
  const artifactsIndex = files.get("artifacts-index.jsonl");
  const tokens = new Map<string, Uint8Array>();
  for (const [name, data] of files) {
    if (name.startsWith("timestamps/")) tokens.set(name, data);
  }

  return {
    bundle: {
      manifestJson: decode(manifest),
      receiptsJsonl: decode(receipts),
      ...(checkpoints === undefined ? {} : { checkpointsJsonl: decode(checkpoints) }),
      ...(artifactsIndex === undefined ? {} : { artifactsIndexJsonl: decode(artifactsIndex) }),
    },
    tokens,
  };
}

function readDirectory(target: string): Archive {
  const read = (name: string): string | undefined => {
    try {
      return readFileSync(join(target, name), "utf8");
    } catch {
      return undefined;
    }
  };

  const manifestJson = read("manifest.json");
  const receiptsJsonl = read("receipts.jsonl");
  if (manifestJson === undefined || receiptsJsonl === undefined) {
    throw new Error("the directory has no manifest.json or no receipts.jsonl");
  }
  const checkpointsJsonl = read("checkpoints.jsonl");
  const artifactsIndexJsonl = read("artifacts-index.jsonl");

  const tokens = new Map<string, Uint8Array>();
  try {
    for (const name of readdirSync(join(target, "timestamps"))) {
      tokens.set(`timestamps/${name}`, new Uint8Array(readFileSync(join(target, "timestamps", name))));
    }
  } catch {
    // No timestamps directory: an export that was never anchored.
  }

  return {
    bundle: {
      manifestJson,
      receiptsJsonl,
      ...(checkpointsJsonl === undefined ? {} : { checkpointsJsonl }),
      ...(artifactsIndexJsonl === undefined ? {} : { artifactsIndexJsonl }),
    },
    tokens,
  };
}

function readArchive(target: string): Archive {
  return statSync(target).isDirectory() ? readDirectory(target) : readArchiveFile(target);
}

function parseCheckpoints(bundle: Bundle): CheckpointEntry[] {
  const entries: CheckpointEntry[] = [];
  for (const line of (bundle.checkpointsJsonl ?? "").split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = safeParseCheckpointEntry(JSON.parse(line));
    if (parsed.ok) entries.push(parsed.entry);
  }
  return entries;
}

const program = new Command();

program
  .name("sigillo-verify")
  .description("Verify a sigillo evidence file: chain, signatures, checkpoints and timestamps.")
  .version("0.1.0")
  .argument("<path>", "an export archive (.zip) or an export directory")
  .option("--tsa-ca <path>", "the timestamp authority's certificate, to check token signatures")
  .option("--quiet", "print only the verdict")
  .action(async (target: string, options: { tsaCa?: string; quiet?: boolean }) => {
    let archive: Archive;
    try {
      archive = readArchive(target);
    } catch (error) {
      process.stderr.write(
        `cannot read ${target}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(2);
    }

    const result = verifyBundle(archive.bundle);
    if (!result.ok) {
      process.stderr.write(`FAILED  ${result.check} at ${result.location}\n`);
      process.stderr.write(`        ${result.detail}\n`);
      process.exit(1);
    }

    const timestamps = await verifyTimestamps({
      checkpoints: parseCheckpoints(archive.bundle),
      tokens: archive.tokens,
      ...(options.tsaCa === undefined ? {} : { caFile: options.tsaCa }),
    });

    if (timestamps.failed > 0) {
      for (const check of timestamps.checks.filter((entry) => entry.status === "failed")) {
        process.stderr.write(`FAILED  timestamp at ${check.file}\n`);
        process.stderr.write(`        ${check.detail}\n`);
      }
      process.exit(1);
    }

    const { summary } = result;
    process.stdout.write(
      `OK  ${summary.system_id}: ${summary.receipts} receipts, seq ${summary.first_seq}..${summary.last_seq}, ` +
        `signed by ${summary.key_ids.join(", ")}\n`,
    );
    if (summary.checkpoints > 0) {
      process.stdout.write(
        `    ${summary.checkpoints} checkpoint(s), ${summary.roots_recomputed} root(s) rebuilt, ` +
          `${summary.inclusion_proofs} inclusion proof(s) verified\n`,
      );
    }
    if (summary.artifacts_indexed > 0) {
      process.stdout.write(`    ${summary.artifacts_indexed} document fingerprint(s) indexed\n`);
    }
    for (const check of timestamps.checks) {
      process.stdout.write(
        `    timestamp ${check.file}: ${check.status} (${check.tsaUrl})\n`,
      );
    }
    for (const warning of timestamps.warnings) {
      process.stdout.write(`    note: ${warning}\n`);
    }

    if (options.quiet !== true) {
      process.stdout.write("\nverified:\n");
      for (const check of CHECKS) {
        process.stdout.write(`  - ${check}\n`);
      }
    }
  });

program
  .command("doc <archive> <file>")
  .description("check whether <file> is a document a receipt in <archive> names, by its fingerprint")
  .action((archivePath: string, filePath: string) => {
    let archive: Archive;
    try {
      archive = readArchive(archivePath);
    } catch (error) {
      process.stderr.write(
        `cannot read ${archivePath}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(2);
    }

    // The document lookup is only as trustworthy as the archive it is read
    // from, so the whole chain is checked first, exactly as the default
    // command would: a tampered archive never gets to report a match.
    const result = verifyBundle(archive.bundle);
    if (!result.ok) {
      process.stderr.write(`FAILED  ${result.check} at ${result.location}\n`);
      process.stderr.write(`        ${result.detail}\n`);
      process.exit(1);
    }

    let fileBytes: Buffer;
    try {
      fileBytes = readFileSync(filePath);
    } catch (error) {
      process.stderr.write(
        `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(2);
    }
    const digest = createHash("sha256").update(fileBytes).digest("hex");
    const manifest = JSON.parse(archive.bundle.manifestJson) as { system_id: string };

    const matches = result.receipts.flatMap((receipt) => {
      if (receipt.v !== 2 || receipt.artifacts === undefined) return [];
      return receipt.artifacts
        .filter((artifact) => artifact.sha256 === digest)
        .map((artifact) => ({ receipt, artifact }));
    });

    if (matches.length === 0) {
      process.stdout.write("No registered action used this document.\n");
      process.stdout.write(
        "If you have a different version of it, changing even one character changes the result.\n",
      );
      process.exit(1);
    }

    for (const { receipt, artifact } of matches) {
      process.stdout.write(
        `This document is exactly the one used by ${manifest.system_id} on ${receipt.ts_received}, ` +
          `as "${artifact.label}" (${artifact.role}), in action ${receipt.action.name} (seq ${receipt.seq}). ` +
          "It has not been modified.\n",
      );
    }
  });

await program.parseAsync(process.argv);
