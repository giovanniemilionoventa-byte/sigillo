#!/usr/bin/env node
import { statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import Database from "better-sqlite3";
import { Command } from "commander";
import { publicKeyFromRaw } from "@sigillo/core";
import { ApiKeyStore } from "./auth/api-keys.js";
import { parseIngestThrottleSettings, parseThrottleSettings } from "./auth/throttle.js";
import { Checkpointer } from "./checkpoint/checkpointer.js";
import { cookieSecure, port, positiveInteger, readSecret, trustProxy } from "./config.js";
import { buildArchive } from "./export/archive.js";
import { ChainHealthMonitor } from "./health/chain-health.js";
import { buildServer } from "./http/server.js";
import { SignerClient } from "./signer/client.js";
import { ReceiptStore, SystemNotDeletableError, type AdminRequest } from "./storage/store.js";
import type { TsaOptions } from "./timestamp/rfc3161.js";

/**
 * Administration and the server itself. Every command takes the database path
 * and, where a receipt has to be signed, the signer's socket — never a key.
 */

interface DatabaseOption {
  db: string;
}

const now = (): string => new Date().toISOString();

/**
 * The authority to anchor checkpoints with. In development this is FreeTSA,
 * which is not qualified under eIDAS; a production deployment points TSA_URL at
 * a qualified provider and supplies its credentials.
 */
function tsaFromOptions(url: string | undefined): TsaOptions | undefined {
  if (url === undefined || url.length === 0) return undefined;
  const username = process.env["TSA_USERNAME"];
  const password = readSecret(process.env, "TSA_PASSWORD");
  return username !== undefined && username.length > 0 && password !== undefined
    ? { url, username, password }
    : { url };
}

/** The authority's address as it may be printed: never with credentials in it. */
function printableUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return "(an address that does not parse)";
  }
}

const WEEK_MINUTES = 7 * 24 * 60;

/**
 * Who is running an administrative command, for the administrative log: the
 * operating system's user and machine. There is no sigillo account to name;
 * this is what the host itself says about who typed it.
 */
function cliRequest(): AdminRequest {
  let user = "unknown";
  try {
    user = userInfo().username;
  } catch {
    // A container user without a passwd entry has no name to give.
  }
  return { actor: `cli ${user}@${hostname()}`, ts: now() };
}

/** Opens the store for a change that signs nothing: renaming, archiving, deleting. */
async function withStore<T>(databasePath: string, work: (store: ReceiptStore) => Promise<T>): Promise<T> {
  const store = ReceiptStore.open(databasePath);
  try {
    return await work(store);
  } finally {
    store.close();
  }
}

async function withSigner<T>(
  socketPath: string,
  databasePath: string,
  work: (store: ReceiptStore) => Promise<T>,
): Promise<T> {
  const signer = await SignerClient.connect(socketPath);
  const store = ReceiptStore.open(databasePath, signer);
  try {
    return await work(store);
  } finally {
    store.close();
    signer.close();
  }
}

const program = new Command();

program
  .name("sigillo-server")
  .description("Run the sigillo ingest server and administer its systems and keys.")
  .version("0.1.0");

program
  .command("serve")
  .description("Accept OTLP and native receipts over HTTP")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .requiredOption("--signer-socket <path>", "the signer's socket", process.env["SIGILLO_SIGNER_SOCKET"])
  .option("--host <host>", "address to bind", process.env["SIGILLO_HOST"] ?? "127.0.0.1")
  .option("--port <port>", "port to bind", process.env["SIGILLO_PORT"] ?? "8080")
  .option("--tsa-url <url>", "RFC 3161 authority to anchor checkpoints with", process.env["TSA_URL"])
  .option(
    "--checkpoint-minutes <minutes>",
    "how often to check point each chain",
    process.env["SIGILLO_CHECKPOINT_MINUTES"] ?? "60",
  )
  .option(
    "--stale-after-minutes <minutes>",
    "how long without activity before the web view's traffic light turns yellow",
    process.env["SIGILLO_STALE_AFTER_MINUTES"] ?? "1440",
  )
  .action(async (options: DatabaseOption & {
    signerSocket: string;
    host: string;
    port: string;
    tsaUrl?: string;
    checkpointMinutes: string;
    staleAfterMinutes: string;
  }) => {
    // Every setting is checked before anything is opened or connected: a bad
    // value stops the server here, with the variable's name, rather than
    // after it has started doing the wrong thing.
    const listenPort = port("SIGILLO_PORT (--port)", options.port, 8080);
    const checkpointMinutes = positiveInteger(
      "SIGILLO_CHECKPOINT_MINUTES (--checkpoint-minutes)",
      options.checkpointMinutes,
      60,
      WEEK_MINUTES,
    );
    const staleAfterMinutes = positiveInteger(
      "SIGILLO_STALE_AFTER_MINUTES (--stale-after-minutes)",
      options.staleAfterMinutes,
      1440,
      10 * 365 * 24 * 60,
    );
    const loginLimits = parseThrottleSettings(process.env);
    const ingestLimits = parseIngestThrottleSettings(process.env);
    const proxies = trustProxy(process.env["SIGILLO_TRUST_PROXY"]);
    const secureCookie = cookieSecure(process.env["SIGILLO_COOKIE_SECURE"]);
    const tsa = tsaFromOptions(options.tsaUrl);

    // The operator's view is mounted only when a password is set. An audit log
    // behind no password is worse than an audit log behind no web page.
    const adminPassword = readSecret(process.env, "SIGILLO_ADMIN_PASSWORD");
    if (adminPassword === undefined) {
      process.stdout.write("SIGILLO_ADMIN_PASSWORD is not set: the web view is not served\n");
    } else if (adminPassword.length < 12) {
      throw new Error("SIGILLO_ADMIN_PASSWORD must be at least 12 characters");
    }

    const signer = await SignerClient.connect(options.signerSocket);
    const store = ReceiptStore.open(options.db, signer);
    const keys = ApiKeyStore.open(options.db);

    const uiMounted = adminPassword !== undefined;
    const healthMonitor = uiMounted
      ? new ChainHealthMonitor(
          store,
          publicKeyFromRaw(new Uint8Array(Buffer.from(signer.publicKeyBase64, "base64"))),
          staleAfterMinutes * 60 * 1000,
        )
      : undefined;

    const checkpointer = new Checkpointer({
      store,
      now: () => new Date(),
      ...(tsa === undefined ? {} : { tsa }),
      intervalMinutes: checkpointMinutes,
      onError: (message) => process.stderr.write(`${message}\n`),
    });

    const app = buildServer({
      store,
      keys,
      logger: true,
      trustProxy: proxies,
      ingestLimits,
      signerHealthy: () => signer.healthy(),
      ...(!uiMounted || healthMonitor === undefined
        ? {}
        : {
            ui: {
              password: adminPassword,
              signerKey: {
                key_id: signer.keyId,
                public_key_base64: signer.publicKeyBase64,
              },
              healthMonitor,
              checkpointer,
              loginLimits,
              cookieSecure: secureCookie,
            },
          }),
    });
    healthMonitor?.start();
    checkpointer.start();

    const shutdown = (): void => {
      checkpointer.stop();
      healthMonitor?.stop();
      void app.close().then(() => {
        keys.close();
        store.close();
        signer.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await app.listen({ host: options.host, port: listenPort });
    process.stdout.write(`signing with key ${signer.keyId}\n`);
    process.stdout.write(
      `checkpointing every ${checkpointMinutes} minutes, anchoring with ${tsa === undefined ? "no authority" : printableUrl(tsa.url)}\n`,
    );
  });

const system = program.command("system").description("Manage AI systems and their chains");

system
  .command("create")
  .description("Register a system and write the genesis receipt of its chain")
  .argument("<system_id>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .requiredOption("--signer-socket <path>", "the signer's socket", process.env["SIGILLO_SIGNER_SOCKET"])
  .action(async (systemId: string, options: DatabaseOption & { signerSocket: string }) => {
    const genesis = await withSigner(options.signerSocket, options.db, (store) =>
      store.createSystem(systemId, now()),
    );
    process.stdout.write(`created ${systemId}\n`);
    process.stdout.write(`genesis signed by key ${genesis.key_id}\n`);
  });

system
  .command("list")
  .description("List the systems that have a chain: system_id, receipts, state, display name")
  .option("--all", "include archived systems")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((options: DatabaseOption & { all?: boolean }) => {
    const store = ReceiptStore.open(options.db);
    try {
      for (const record of store.listSystemRecords()) {
        if (record.archived_at !== null && options.all !== true) continue;
        const state = record.archived_at === null ? "active" : `archived ${record.archived_at}`;
        process.stdout.write(
          `${record.system_id}\t${record.receipts} receipts\t${state}\t${record.display_name ?? ""}\n`,
        );
      }
    } finally {
      store.close();
    }
  });

system
  .command("rename")
  .description(
    "Set the name the web view shows for a system; an empty name clears it. " +
      "The system_id, the chain and every export already made stay as they are",
  )
  .argument("<system_id>")
  .argument("<display_name>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action(async (systemId: string, displayName: string, options: DatabaseOption) => {
    await withStore(options.db, async (store) => {
      await store.renameSystem(systemId, displayName, cliRequest());
      const record = store.systemRecord(systemId);
      process.stdout.write(
        record?.display_name === null || record === null
          ? `${systemId} has no display name: the web view shows its system_id\n`
          : `${systemId} is now shown as "${record.display_name}"\n`,
      );
    });
  });

system
  .command("archive")
  .description("Take a system off the main listings. Its chain stays whole, exportable and verifiable")
  .argument("<system_id>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action(async (systemId: string, options: DatabaseOption) => {
    await withStore(options.db, async (store) => {
      await store.archiveSystem(systemId, cliRequest());
      process.stdout.write(`archived ${systemId}\n`);
    });
  });

system
  .command("unarchive")
  .description("Put an archived system back on the main listings")
  .argument("<system_id>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action(async (systemId: string, options: DatabaseOption) => {
    await withStore(options.db, async (store) => {
      await store.unarchiveSystem(systemId, cliRequest());
      process.stdout.write(`unarchived ${systemId}\n`);
    });
  });

system
  .command("delete")
  .description(
    "Delete a system whose chain holds nothing but its genesis. A system with any recorded " +
      "action cannot be deleted, by this command or any other: archive it instead",
  )
  .argument("<system_id>")
  .requiredOption("--confirm <system_id>", "the same system_id again, typed out")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action(async (systemId: string, options: DatabaseOption & { confirm: string }) => {
    if (options.confirm !== systemId) {
      throw new Error(`--confirm must repeat the system_id exactly (${systemId}): nothing was deleted`);
    }
    await withStore(options.db, async (store) => {
      try {
        const deleted = await store.deleteEmptySystem(systemId, cliRequest());
        process.stdout.write(
          `deleted ${systemId}: its genesis ${deleted.genesis_hash}, ${deleted.checkpoints} checkpoint(s), ` +
            `${deleted.timestamps} timestamp token(s) and ${deleted.api_keys.length} API key(s)\n`,
        );
        process.stdout.write("the deletion is in the administrative log (sigillo-server admin-log)\n");
      } catch (error) {
        if (error instanceof SystemNotDeletableError) {
          process.stderr.write(`${error.message}: sigillo-server system archive ${systemId}\n`);
          process.exit(1);
        }
        throw error;
      }
    });
  });

program
  .command("admin-log")
  .description("Print the administrative log: renames, archivals and deletions of systems, newest first")
  .option("--limit <n>", "how many entries", "100")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((options: DatabaseOption & { limit: string }) => {
    const limit = positiveInteger("--limit", options.limit, 100, 10_000);
    const store = ReceiptStore.open(options.db);
    try {
      for (const entry of store.adminLog(limit)) {
        process.stdout.write(
          `${entry.ts}\t${entry.action}\t${entry.system_id}\t${entry.actor}\t${JSON.stringify(entry.detail)}\n`,
        );
      }
    } finally {
      store.close();
    }
  });

const key = program.command("key").description("Manage ingest API keys");

key
  .command("create")
  .description("Issue an API key for a system. The token is shown once and not stored")
  .argument("<system_id>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((systemId: string, options: DatabaseOption) => {
    const keys = ApiKeyStore.open(options.db);
    try {
      const issued = keys.issue(systemId, now());
      process.stdout.write(`key_id ${issued.keyId}\n`);
      process.stdout.write(`${issued.token}\n`);
      process.stderr.write("this token is not recoverable: store it now\n");
    } finally {
      keys.close();
    }
  });

key
  .command("revoke")
  .description("Revoke an API key by its id")
  .argument("<key_id>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((keyId: string, options: DatabaseOption) => {
    const keys = ApiKeyStore.open(options.db);
    try {
      if (!keys.revoke(keyId, now())) {
        process.stderr.write(`no live key with id ${keyId}\n`);
        process.exit(1);
      }
      process.stdout.write(`revoked ${keyId}\n`);
    } finally {
      keys.close();
    }
  });

key
  .command("list")
  .description("List API keys and whether they are still live")
  .option("--system <system_id>", "only this system's keys")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((options: DatabaseOption & { system?: string }) => {
    const keys = ApiKeyStore.open(options.db);
    try {
      for (const record of keys.list(options.system)) {
        const state = record.revokedAt === null ? "live" : `revoked ${record.revokedAt}`;
        process.stdout.write(`${record.keyId}\t${record.systemId}\t${state}\n`);
      }
    } finally {
      keys.close();
    }
  });

program
  .command("backup")
  .description("Write a consistent copy of the database, safe to take while the server runs")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .requiredOption("--out <path>", "where to write the copy")
  .action(async (options: DatabaseOption & { out: string }) => {
    // SQLite's own backup API, not a file copy: a copy taken with cp while a
    // write is in flight is a corrupt database that looks fine until it is read.
    const source = new Database(options.db, { readonly: true });
    try {
      await source.backup(options.out);
      const size = statSync(options.out).size;
      process.stdout.write(`wrote ${size} bytes to ${options.out}\n`);
    } finally {
      source.close();
    }
  });

program
  .command("checkpoint")
  .description("Check point every chain now, and anchor what is still unanchored")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .requiredOption("--signer-socket <path>", "the signer's socket", process.env["SIGILLO_SIGNER_SOCKET"])
  .option("--tsa-url <url>", "RFC 3161 authority", process.env["TSA_URL"])
  .action(async (options: DatabaseOption & { signerSocket: string; tsaUrl?: string }) => {
    const signer = await SignerClient.connect(options.signerSocket);
    const store = ReceiptStore.open(options.db, signer);
    try {
      const tsa = tsaFromOptions(options.tsaUrl);
      const checkpointer = new Checkpointer({
        store,
        now: () => new Date(),
        ...(tsa === undefined ? {} : { tsa }),
        onError: (message) => process.stderr.write(`${message}\n`),
      });
      const run = await checkpointer.runOnce();
      for (const written of run.checkpoints) {
        process.stdout.write(
          `${written.checkpoint.system_id}\ttree_size ${written.checkpoint.tree_size}\troot ${written.checkpoint.root_hash}\n`,
        );
      }
      process.stdout.write(
        `${run.checkpoints.length} new checkpoint(s), ${run.timestamped} anchored, ${run.pending} still waiting\n`,
      );
    } finally {
      store.close();
      signer.close();
    }
  });

program
  .command("export")
  .description("Write the evidence file of a system's chain")
  .argument("<system_id>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .requiredOption("--signer-socket <path>", "the signer's socket", process.env["SIGILLO_SIGNER_SOCKET"])
  .requiredOption("--out <file>", "where to write the .zip archive")
  .action(async (systemId: string, options: DatabaseOption & { signerSocket: string; out: string }) => {
    const signer = await SignerClient.connect(options.signerSocket);
    const store = ReceiptStore.open(options.db, signer);
    try {
      const archive = await buildArchive({
        systemId,
        displayName: store.systemRecord(systemId)?.display_name ?? null,
        receipts: store.readChain(systemId),
        checkpoints: store.readCheckpoints(systemId).map((stored) => ({
          stored,
          timestamps: store.readTimestamps(stored.id),
        })),
        chainLeaves: store.readReceiptHashes(systemId),
        keys: store.signingKeys(),
        exportedAt: now(),
      });

      writeFileSync(options.out, archive.zip);
      process.stdout.write(
        `wrote ${archive.manifest.counts.receipts} receipts, ` +
          `${archive.manifest.counts.checkpoints} checkpoint(s) and ` +
          `${archive.manifest.counts.timestamps} timestamp token(s) to ${options.out}\n`,
      );
      process.stdout.write(
        archive.verification.ok
          ? "the archive verifies\n"
          : `WARNING: the archive does not verify: ${archive.verification.check} at ${archive.verification.location}: ${archive.verification.detail}\n`,
      );
      if (!archive.verification.ok) process.exitCode = 1;
    } finally {
      store.close();
      signer.close();
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
