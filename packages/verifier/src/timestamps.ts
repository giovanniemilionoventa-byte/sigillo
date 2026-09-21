import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { CheckpointEntry } from "@sigillo/core";

/**
 * Checks the RFC 3161 tokens, which is the one part of verification that needs
 * something outside this program: openssl, and the timestamp authority's own
 * certificate.
 *
 * Two levels are possible, and they are never confused for one another:
 *
 *   verified      the authority's certificate was supplied, so `openssl ts
 *                 -verify` checked the signature and the imprint.
 *   imprint-only  no certificate was supplied, so only the digest inside the
 *                 token was compared with the checkpoint root. That proves the
 *                 token is about this log, not that the token is genuine.
 *
 * Without openssl at all, nothing is checked and the caller is told so. A
 * missing check is reported as a missing check, never as a pass.
 */

const run = promisify(execFile);

export type TimestampStatus = "verified" | "imprint-only" | "failed" | "not-checked";

export interface TimestampCheck {
  file: string;
  tsaUrl: string;
  treeSize: number;
  expectedDigest: string;
  status: TimestampStatus;
  detail: string;
}

export interface TimestampVerification {
  checks: TimestampCheck[];
  warnings: string[];
  failed: number;
}

export interface TimestampOptions {
  checkpoints: readonly CheckpointEntry[];
  /** The DER tokens, by the path the checkpoint entry refers to. */
  tokens: ReadonlyMap<string, Uint8Array>;
  /** The authority's CA certificate. Without it only the imprint is checked. */
  caFile?: string;
}

async function opensslAvailable(): Promise<boolean> {
  try {
    await run("openssl", ["version"]);
    return true;
  } catch {
    return false;
  }
}

/** Pulls the message imprint out of `openssl ts -reply -text`. */
function imprintFrom(reply: string): string {
  const lines = reply.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Message data:");
  if (start < 0) return "";

  const bytes: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const body = /^\s+[0-9a-f]{4} - (.*)$/.exec(line)?.[1];
    if (body === undefined) break;
    // The hex column is separated from the ASCII column by three spaces; the
    // ASCII column contains letters that would otherwise look like hex.
    const hex = (body.split(/\s{3,}/)[0] ?? "").replace(/[^0-9a-f]/g, "");
    bytes.push(hex);
  }
  return bytes.join("");
}

export async function verifyTimestamps(
  options: TimestampOptions,
): Promise<TimestampVerification> {
  const checks: TimestampCheck[] = [];
  const warnings: string[] = [];

  const referenced = options.checkpoints.flatMap((entry) =>
    entry.timestamps.map((timestamp) => ({ entry, timestamp })),
  );
  if (referenced.length === 0) {
    warnings.push("the export carries no timestamp tokens: nothing anchors it in time");
    return { checks, warnings, failed: 0 };
  }

  if (!(await opensslAvailable())) {
    warnings.push(
      "openssl is not available, so no timestamp token was checked. Install openssl and run this again.",
    );
    for (const { entry, timestamp } of referenced) {
      checks.push({
        file: timestamp.file,
        tsaUrl: timestamp.tsa_url,
        treeSize: entry.checkpoint.tree_size,
        expectedDigest: entry.checkpoint.root_hash,
        status: "not-checked",
        detail: "openssl is not available",
      });
    }
    return { checks, warnings, failed: 0 };
  }

  if (options.caFile === undefined) {
    warnings.push(
      "no timestamp authority certificate was supplied (--tsa-ca), so the tokens were checked " +
        "only for the digest they carry. Their signatures were not verified.",
    );
  }

  const work = mkdtempSync(join(tmpdir(), "sigillo-verify-"));
  try {
    for (const { entry, timestamp } of referenced) {
      const expectedDigest = entry.checkpoint.root_hash;
      const base = {
        file: timestamp.file,
        tsaUrl: timestamp.tsa_url,
        treeSize: entry.checkpoint.tree_size,
        expectedDigest,
      };

      const token = options.tokens.get(timestamp.file);
      if (token === undefined) {
        checks.push({
          ...base,
          status: "failed",
          detail: `the checkpoint refers to ${timestamp.file}, which the export does not contain`,
        });
        continue;
      }

      const path = join(work, `${checks.length}.tsr`);
      writeFileSync(path, token);

      if (options.caFile !== undefined) {
        try {
          await run("openssl", [
            "ts",
            "-verify",
            "-digest",
            expectedDigest,
            "-in",
            path,
            "-CAfile",
            options.caFile,
          ]);
          checks.push({
            ...base,
            status: "verified",
            detail: `signed by the authority and taken over ${expectedDigest}`,
          });
        } catch (error) {
          checks.push({
            ...base,
            status: "failed",
            detail: `openssl ts -verify refused it: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
          });
        }
        continue;
      }

      try {
        const { stdout } = await run("openssl", ["ts", "-reply", "-in", path, "-text"]);
        const imprint = imprintFrom(stdout);
        if (imprint !== expectedDigest) {
          checks.push({
            ...base,
            status: "failed",
            detail:
              imprint === ""
                ? "the token carries no readable message imprint"
                : `the token is over ${imprint}, not over the checkpoint root ${expectedDigest}`,
          });
          continue;
        }
        if (!stdout.includes("Status: Granted.")) {
          checks.push({ ...base, status: "failed", detail: "the authority did not grant the token" });
          continue;
        }
        checks.push({
          ...base,
          status: "imprint-only",
          detail: "the token is over this checkpoint's root; its signature was not checked",
        });
      } catch (error) {
        checks.push({
          ...base,
          status: "failed",
          detail: `openssl could not read the token: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
        });
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  return { checks, warnings, failed: checks.filter((check) => check.status === "failed").length };
}
