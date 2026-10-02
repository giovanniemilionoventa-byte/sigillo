#!/usr/bin/env node
import { Command } from "commander";
import { hostname, userInfo } from "node:os";
import { startSignerDaemon } from "./daemon.js";
import { initFromDatabase } from "./init-from-db.js";
import { generateKeyFile, loadKeyFile } from "./key-file.js";
import { DEFAULT_CLOCK_TOLERANCE_MS } from "./signer.js";

const program = new Command();

program
  .name("sigillo-signer")
  .description("Holds the sigillo signing key and signs the next receipt of each chain over a local Unix socket.")
  .version("0.1.0");

program
  .command("keygen")
  .description("Generate a new Ed25519 signing key, readable only by its owner")
  .requiredOption("--key <path>", "where to write the private key")
  .action((options: { key: string }) => {
    const key = generateKeyFile(options.key);
    process.stdout.write(`key written to ${options.key}\n`);
    process.stdout.write(`key_id ${key.keyId}\n`);
    process.stdout.write(`public_key_base64 ${key.publicKeyBase64}\n`);
  });

/** Seconds, from the option or SIGILLO_SIGNER_CLOCK_TOLERANCE_SECONDS, as milliseconds. */
function clockTolerance(option: string | undefined): number {
  const raw = option ?? process.env["SIGILLO_SIGNER_CLOCK_TOLERANCE_SECONDS"];
  if (raw === undefined || raw === "") return DEFAULT_CLOCK_TOLERANCE_MS;
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(seconds)) {
    throw new Error(`the clock tolerance must be a whole number of seconds, received ${JSON.stringify(raw)}`);
  }
  return seconds * 1000;
}

program
  .command("serve")
  .description("Listen for signing requests on a Unix socket")
  .requiredOption("--key <path>", "the private key to load")
  .requiredOption("--socket <path>", "the Unix socket to listen on")
  .requiredOption("--state <dir>", "the directory holding the signer's state, in its own volume")
  .option(
    "--clock-tolerance-seconds <n>",
    "how far a receipt's ts_received may be from this clock (default 300, or SIGILLO_SIGNER_CLOCK_TOLERANCE_SECONDS)",
  )
  .action(async (options: { key: string; socket: string; state: string; clockToleranceSeconds?: string }) => {
    const clockToleranceMs = clockTolerance(options.clockToleranceSeconds);
    const key = loadKeyFile(options.key);
    const daemon = await startSignerDaemon({
      socketPath: options.socket,
      key,
      stateDir: options.state,
      clockToleranceMs,
      onFatal: (error) => {
        process.stderr.write(`the signer stopped: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      },
    });
    process.stdout.write(`listening on ${daemon.socketPath} with key ${key.keyId}\n`);

    const shutdown = (): void => {
      void daemon.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("init-from-db")
  .description("One time only: build the signer's state from the chains in the server's database")
  .requiredOption("--db <path>", "the server's SQLite database (server and signer both stopped)")
  .requiredOption("--state <dir>", "the directory holding the signer's state")
  .action((options: { db: string; state: string }) => {
    const report = initFromDatabase({
      databasePath: options.db,
      stateDir: options.state,
      actor: `cli ${userInfo().username}@${hostname()} (signer init-from-db)`,
      now: () => new Date(),
    });
    if (report.alreadyInitialised !== undefined) {
      process.stdout.write(
        `already initialised on ${report.alreadyInitialised}; the signer agrees with the database on all ` +
          `${report.unchanged.length} chain(s): nothing to do\n`,
      );
      return;
    }
    for (const system of report.systems) {
      process.stdout.write(`${system.system_id}: seq ${system.seq}, ${system.tree_size} receipts, head ${system.hash}\n`);
    }
    for (const systemId of report.retired) process.stdout.write(`${systemId}: deleted, its identifier stays retired\n`);
    for (const systemId of report.unchanged) process.stdout.write(`${systemId}: already known, unchanged\n`);
    process.stdout.write(
      `initialised ${report.systems.length} system(s), ${report.retired.length} retired; written to the administrative log\n`,
    );
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
