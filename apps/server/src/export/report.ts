import PDFDocument from "pdfkit";
import type { CheckpointEntry, Manifest } from "@sigillo/core";
import type { Verification } from "@sigillo/verifier";

/**
 * The one part of an export meant for a person rather than a program.
 *
 * It states what the file contains, what was checked, and how to check it
 * again without trusting this report. It claims nothing the machine-readable
 * files do not already prove.
 */

const MARGIN = 56;
const RULE = "#7a7a7a";

/** Article 12(2) of Regulation (EU) 2024/1689, which is why these logs exist. */
const ARTICLE_12_PURPOSES = [
  "identifying situations that may result in the high-risk AI system presenting a risk " +
    "within the meaning of Article 79(1), or in a substantial modification",
  "facilitating the post-market monitoring referred to in Article 72",
  "monitoring the operation of high-risk AI systems referred to in Article 26(5)",
];

export interface ReportInput {
  manifest: Manifest;
  checkpoints: readonly CheckpointEntry[];
  verification: Verification;
  /** How many receipts of each kind, for the summary table. */
  actionCounts: ReadonlyMap<string, number>;
}

export function buildReportPdf(input: ReportInput): Promise<Uint8Array> {
  const { manifest, checkpoints, verification } = input;
  const document = new PDFDocument({
    size: "A4",
    margin: MARGIN,
    info: {
      Title: `sigillo evidence file — ${manifest.system_id}`,
      Author: "sigillo",
      Subject: "Record of AI system actions, with the means to verify it",
    },
  });

  const chunks: Buffer[] = [];
  const finished = new Promise<Uint8Array>((resolve, reject) => {
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    document.on("error", reject);
  });

  const heading = (text: string): void => {
    document.moveDown(1).fontSize(13).font("Helvetica-Bold").text(text);
    document.moveDown(0.4).fontSize(10).font("Helvetica");
  };

  const row = (label: string, value: string): void => {
    document.font("Helvetica-Bold").text(`${label}  `, { continued: true });
    document.font("Helvetica").text(value);
  };

  const rule = (): void => {
    const y = document.y + 4;
    document
      .moveTo(MARGIN, y)
      .lineTo(document.page.width - MARGIN, y)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    document.moveDown(0.6);
  };

  document.fontSize(20).font("Helvetica-Bold").text("sigillo evidence file");
  document.moveDown(0.2).fontSize(10).font("Helvetica").fillColor("#444444");
  document.text(
    "A record of what an AI system did, signed at the time and chained so that nothing " +
      "can be changed, removed or reordered without this file failing to verify.",
  );
  document.fillColor("black");
  rule();

  heading("The system and the period");
  row("System", manifest.system_id);
  row("Receipts", `${manifest.counts.receipts}`);
  row(
    "Positions",
    `seq ${manifest.range.from_seq} to ${manifest.range.to_seq}`,
  );
  row("First recorded", manifest.range.from_ts);
  row("Last recorded", manifest.range.to_ts);
  row("Exported", manifest.exported_at);
  row("Schema", `receipt version ${manifest.receipt_version}, sigillo ${manifest.sigillo_version}`);

  heading("What was recorded");
  if (input.actionCounts.size === 0) {
    document.text("No actions.");
  } else {
    for (const [kind, count] of [...input.actionCounts].sort()) {
      row(`${kind}`, `${count}`);
    }
  }

  heading("Verification at the time of export");
  if (verification.ok) {
    document.text(
      `Passed. ${verification.summary.receipts} receipts form an unbroken chain, each signed by a ` +
        `key published in this file. ${verification.summary.checkpoints} checkpoint(s) were checked, ` +
        `${verification.summary.roots_recomputed} of them with the Merkle root rebuilt from these ` +
        `receipts, and ${verification.summary.inclusion_proofs} inclusion proof(s) verified.`,
    );
    document.moveDown(0.4);
    document.text(`Signing key(s): ${verification.summary.key_ids.join(", ")}`);
  } else {
    document.fillColor("#a11").text(
      `FAILED at the ${verification.check} check, ${verification.location}: ${verification.detail}`,
    );
    document.fillColor("black");
  }
  document.moveDown(0.4);
  document.fontSize(9).fillColor("#444444");
  document.text(
    "This is the exporter's own check, and it is not evidence by itself. The section below " +
      "explains how to repeat it with software that has nothing to do with the system that " +
      "produced this file.",
  );
  document.fontSize(10).fillColor("black");

  heading("Checkpoints and their timestamps");
  if (checkpoints.length === 0) {
    document.text("No checkpoint covers this period, so nothing anchors it to an external clock.");
  } else {
    for (const entry of checkpoints) {
      row(`Tree of ${entry.checkpoint.tree_size} receipts`, entry.checkpoint.ts);
      document.fontSize(8).font("Courier").text(`root ${entry.checkpoint.root_hash}`);
      document.fontSize(10).font("Helvetica");
      if (entry.timestamps.length === 0) {
        document.fillColor("#a11").text("  not anchored: no timestamp token").fillColor("black");
      } else {
        for (const timestamp of entry.timestamps) {
          document.text(`  anchored ${timestamp.obtained_at} by ${timestamp.tsa_url}`);
          document.text(`  token: ${timestamp.file}`);
        }
      }
      document.moveDown(0.3);
    }
  }

  heading("How to verify this file yourself");
  document.text(
    "Do not take this report's word for anything. The archive contains everything needed to " +
      "check it independently:",
  );
  document.moveDown(0.3);
  document.font("Courier").fontSize(9);
  document.text("  sigillo-verify <this archive>");
  document.font("Helvetica").fontSize(10).moveDown(0.3);
  document.text(
    "sigillo-verify is open source and depends only on the format described in VERIFY.md and " +
      "docs/FORMAT.md. It recomputes every hash, checks every signature against the public keys " +
      "in manifest.json, rebuilds the Merkle roots and checks the inclusion proofs. " +
      "VERIFY.md also shows how to check the timestamp tokens with openssl alone, and how to " +
      "verify a single receipt by hand.",
  );

  heading("Why this record exists");
  document.text(
    "Regulation (EU) 2024/1689 (the AI Act), Article 12(2), requires that the logging " +
      "capabilities of a high-risk AI system enable the recording of events relevant for:",
  );
  document.moveDown(0.3);
  for (const [index, purpose] of ARTICLE_12_PURPOSES.entries()) {
    document.text(`  (${"abc"[index]})  ${purpose}`, { indent: 6 });
    document.moveDown(0.2);
  }
  document.moveDown(0.3);
  document.fontSize(9).fillColor("#444444");
  document.text(
    "sigillo records the actions it is given and makes them tamper-evident. It does not " +
      "establish that everything the system did was recorded: that depends on the " +
      "instrumentation of the system itself. What this file proves is that these records " +
      "existed at the times stated and have not been altered since.",
  );

  document.end();
  return finished;
}
