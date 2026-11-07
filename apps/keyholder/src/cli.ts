#!/usr/bin/env node
import { Command } from "commander";
import { startKeyholder } from "./keyholder.js";

const program = new Command();
program
  .name("sigillo-keyholder")
  .description(
    "The one process that opens the customers' model keys and calls the providers for the model gateway, " +
      "over a Unix socket shared with the server alone",
  )
  .command("serve", { isDefault: true })
  .option("--socket <path>", "where to listen", process.env["SIGILLO_KEYHOLDER_SOCKET"] || "/run/sigillo-keyholder/keyholder.sock")
  .option("--dir <path>", "its own directory, for its keys", process.env["SIGILLO_KEYHOLDER_DIR"] || "/var/lib/sigillo-keyholder")
  .action(async (options: { socket: string; dir: string }) => {
    const holder = await startKeyholder({ socketPath: options.socket, directory: options.dir });
    process.stdout.write(`keyholder listening on ${options.socket}\n`);
    const stop = (): void => {
      void holder.close().then(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });

await program.parseAsync(process.argv);
