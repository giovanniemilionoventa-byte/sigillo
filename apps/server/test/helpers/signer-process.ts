import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The real `sigillo-signer` command, in a process of its own, as an operator runs it. */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const SIGNER_CLI = join(REPOSITORY_ROOT, "apps", "signer", "src", "cli.ts");

/**
 * Stops a signer at once, the way a crash or a power cut would: SIGKILL, so no
 * shutdown handler runs. tsx runs the script in a child of its own, so the
 * whole process group goes, or a signer would be left listening.
 */
export function killSigner(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Starts the signer CLI and waits for a line of its output. */
export function runSignerCli(args: string[], waitFor: RegExp): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [SIGNER_CLI, ...args], { cwd: REPOSITORY_ROOT, detached: true });
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      killSigner(child);
      reject(new Error(`signer did not print ${waitFor} (stdout: ${output}, stderr: ${errors})`));
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (waitFor.test(output)) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!waitFor.test(output)) {
        reject(new Error(`signer exited with ${code} (stderr: ${errors})`));
      }
    });
  });
}

/** Runs a signer command to completion: its exit code and what it printed. */
export function runSignerCommand(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const run = spawnSync(TSX, [SIGNER_CLI, ...args], { cwd: REPOSITORY_ROOT, encoding: "utf8", timeout: 60_000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}
