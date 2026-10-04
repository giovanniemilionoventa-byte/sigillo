#!/usr/bin/env node
/**
 * cambia-un-carattere <originale> <copia>
 *
 * Writes a copy of a file with exactly one character changed, and says which
 * one. Used on camera in scene 5 of the demo video, so that the tampering is
 * real and visible, not described:
 *
 *   - a fascicolo (.zip): in receipts.jsonl, the receipt of the
 *     `valuta_candidato` tool call that follows the reading of candidate 07's
 *     CV gets one digit of its `ts_event` seconds changed (the time of the
 *     evaluation moved by one second). Every other file and byte is the
 *     original's. Needs `unzip` and `zip` on PATH.
 *   - a text file: the first "immediata." becomes "immediata!".
 *
 * The original is never touched. No dependencies beyond Node. It reports in
 * Italian, or in English with SIGILLO_VIDEO_LANG=en (the English video shows
 * it as `change-one-character`).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const english = process.env.SIGILLO_VIDEO_LANG === "en";

const [original, copy] = process.argv.slice(2);
if (original === undefined || copy === undefined) {
  process.stderr.write("uso: cambia-un-carattere <originale> <copia>\n");
  process.exit(2);
}

const CV_07 = fileURLToPath(new URL("../demo/selezione-cv/curricula/candidato-07.txt", import.meta.url));

if (original.endsWith(".zip")) {
  const folder = mkdtempSync(join(tmpdir(), "copia-"));
  try {
    execFileSync("unzip", ["-q", resolve(original), "-d", folder]);
    const cvPrint = createHash("sha256").update(readFileSync(CV_07)).digest("hex");
    const index = readFileSync(join(folder, "artifacts-index.jsonl"), "utf8").split("\n").filter((line) => line !== "");
    const read = index.map((line) => JSON.parse(line)).find((entry) => entry.sha256 === cvPrint);
    if (read === undefined) throw new Error("questo fascicolo non contiene la lettura del curriculum del candidato 07");
    const path = join(folder, "receipts.jsonl");
    const lines = readFileSync(path, "utf8").split("\n");
    const at = lines.findIndex((line) => {
      if (line === "") return false;
      const receipt = JSON.parse(line);
      return receipt.seq > read.seq && receipt.action.name === "valuta_candidato";
    });
    if (at === -1) throw new Error("nessuna valutazione dopo la lettura del curriculum del candidato 07");
    const line = lines[at];
    const match = /"ts_event":"\d{4}-\d\d-\d\dT\d\d:\d\d:(\d)(\d)/.exec(line);
    if (match === null) throw new Error("ts_event non trovato");
    const column = match.index + match[0].length - 1;
    const before = line[column];
    const after = before === "9" ? "8" : String(Number(before) + 1);
    lines[at] = line.slice(0, column) + after + line.slice(column + 1);
    writeFileSync(path, lines.join("\n"));
    const target = resolve(copy);
    rmSync(target, { force: true });
    execFileSync("zip", ["-q", "-X", "-r", target, "."], { cwd: folder });
    const seconds = `${match[1]}${match[2]}`;
    const seq = JSON.parse(line).seq;
    process.stdout.write(
      english
        ? `${basename(copy)}: a copy of ${basename(original)} with one character changed\n` +
            `  receipts.jsonl, line ${at + 1}: candidate 07's evaluation (receipt no. ${seq})\n` +
            `  time of the action: seconds ${seconds} → ${match[1]}${after}\n`
        : `${basename(copy)}: copia di ${basename(original)} con un solo carattere diverso\n` +
            `  receipts.jsonl, riga ${at + 1}: la valutazione del candidato 07 (ricevuta n. ${seq})\n` +
            `  orario dell'azione: secondi ${seconds} → ${match[1]}${after}\n`,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
} else {
  const text = readFileSync(original, "utf8");
  const at = text.indexOf("immediata.");
  if (at === -1) throw new Error('"immediata." non trovato');
  const column = at + "immediata".length;
  writeFileSync(copy, text.slice(0, column) + "!" + text.slice(column + 1));
  const lineNumber = text.slice(0, column).split("\n").length;
  process.stdout.write(
    english
      ? `${basename(copy)}: a copy of ${basename(original)} with one character changed\n` +
          `  line ${lineNumber}: "immediata." → "immediata!"\n`
      : `${basename(copy)}: copia di ${basename(original)} con un solo carattere diverso\n` +
          `  riga ${lineNumber}: «immediata.» → «immediata!»\n`,
  );
}
