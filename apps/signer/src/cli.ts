#!/usr/bin/env node
import { Command } from "commander";
import { startSignerDaemon } from "./daemon.js";
import { generateKeyFile, loadKeyFile } from "./key-file.js";

const program = new Command();

program
  .name("sigillo-signer")
  .description("Holds the sigillo signing key and signs receipt hashes over a local Unix socket.")
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

program
  .command("serve")
  .description("Listen for signing requests on a Unix socket")
  .requiredOption("--key <path>", "the private key to load")
  .requiredOption("--socket <path>", "the Unix socket to listen on")
  .action(async (options: { key: string; socket: string }) => {
    const key = loadKeyFile(options.key);
    const daemon = await startSignerDaemon({ socketPath: options.socket, key });
    process.stdout.write(`listening on ${daemon.socketPath} with key ${key.keyId}\n`);

    const shutdown = (): void => {
      void daemon.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
