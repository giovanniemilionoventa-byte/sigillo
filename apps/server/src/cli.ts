#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { Command } from "commander";
import { DEFAULT_MAX_ANCHOR_DELAY_MS, isPseudonym, publicKeyFromRaw, receiptHashHex } from "@sigillo/core";
import { ApiKeyStore } from "./auth/api-keys.js";
import { parseIngestThrottleSettings, parseThrottleSettings } from "./auth/throttle.js";
import { DailyExporter } from "./backup/daily-export.js";
import { Checkpointer } from "./checkpoint/checkpointer.js";
import { ConnectionWatch } from "./connection/watch.js";
import { agentProtection, agentUpload, claudeCode, cookieSecure, firebaseAccounts, ingestPause, llmGateway, llmToolRequests, plainAgents, port, positiveInteger, readSecret, scriptGuard, transfer, trustProxy } from "./config.js";
import { FirebaseAuth } from "./auth/firebase.js";
import { archiveFromStore, positionsIn, tokensIn } from "./export/from-store.js";
import { loadOrCreateSealingKey, ProviderKeyStore } from "./gateway/provider-keys.js";
import { ChainHealthMonitor } from "./health/chain-health.js";
import { buildServer } from "./http/server.js";
import { SignerClient } from "./signer/client.js";
import { SCHEMA_VERSION } from "./storage/schema.js";
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
  .option(
    "--max-anchor-delay-minutes <minutes>",
    "how long a checkpoint may wait for its timestamp before the traffic light turns yellow (as sigillo-verify --max-anchor-delay)",
    process.env["SIGILLO_MAX_ANCHOR_DELAY_MINUTES"] ?? String(DEFAULT_MAX_ANCHOR_DELAY_MS / 60_000),
  )
  .option(
    "--tsa-retry-minutes <minutes>",
    "how soon to ask the authority again for a timestamp it did not give",
    process.env["SIGILLO_TSA_RETRY_MINUTES"] ?? "5",
  )
  .action(async (options: DatabaseOption & {
    signerSocket: string;
    host: string;
    port: string;
    tsaUrl?: string;
    checkpointMinutes: string;
    staleAfterMinutes: string;
    maxAnchorDelayMinutes: string;
    tsaRetryMinutes: string;
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
    const maxAnchorDelayMinutes = positiveInteger(
      "SIGILLO_MAX_ANCHOR_DELAY_MINUTES (--max-anchor-delay-minutes)",
      options.maxAnchorDelayMinutes,
      DEFAULT_MAX_ANCHOR_DELAY_MS / 60_000,
      10 * 365 * 24 * 60,
    );
    const tsaRetryMinutes = positiveInteger(
      "SIGILLO_TSA_RETRY_MINUTES (--tsa-retry-minutes)",
      options.tsaRetryMinutes,
      5,
      24 * 60,
    );
    const loginLimits = parseThrottleSettings(process.env);
    const ingestLimits = parseIngestThrottleSettings(process.env);
    const proxies = trustProxy(process.env["SIGILLO_TRUST_PROXY"]);
    const secureCookie = cookieSecure(process.env["SIGILLO_COOKIE_SECURE"]);
    const pause = ingestPause(process.env);
    const accounts = firebaseAccounts(process.env);
    const gatewayAccess = llmGateway(process.env);
    const toolRequests = llmToolRequests(process.env);
    const agentUploadAccess = agentUpload(process.env);
    const agentProtectionAccess = agentProtection(process.env);
    // Where backup.sh writes its copies; the daily export keeps its files here too.
    const backupDirectory = process.env["SIGILLO_BACKUP_DIR"] || undefined;
    const organizationMonthlyReceipts = positiveInteger(
      "SIGILLO_ORG_MONTHLY_RECEIPTS",
      process.env["SIGILLO_ORG_MONTHLY_RECEIPTS"],
      10_000,
    );
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
    // The customers' own model keys, sealed under a key kept in a file beside
    // the database and never in it: a backup carries the sealed keys only.
    const providerKeys =
      gatewayAccess === "off"
        ? undefined
        : ProviderKeyStore.open(
            options.db,
            loadOrCreateSealingKey(process.env["SIGILLO_LLM_GATEWAY_KEY_FILE"] || join(dirname(options.db), "llm-gateway.key")),
          );

    // Every chain's tip against the signer's head, before any request is
    // served: a receipt signed and lost to a crash is written now; any other
    // disagreement turns that system red and is left for a person.
    for (const outcome of await store.reconcileWithSigner()) {
      if (outcome.status === "recovered") {
        process.stdout.write(
          outcome.count === 1
            ? `${outcome.system_id}: recovered seq ${outcome.seq} from the signer\n`
            : `${outcome.system_id}: recovered seq ${outcome.seq - outcome.count + 1} to ${outcome.seq} from the signer\n`,
        );
      } else if (outcome.status === "diverged") {
        process.stderr.write(`${outcome.system_id}: the signer and the database disagree: ${outcome.detail}\n`);
      }
    }

    const uiMounted = adminPassword !== undefined;
    const healthMonitor = uiMounted
      ? new ChainHealthMonitor(
          store,
          publicKeyFromRaw(new Uint8Array(Buffer.from(signer.publicKeyBase64, "base64"))),
          staleAfterMinutes * 60 * 1000,
          maxAnchorDelayMinutes * 60 * 1000,
          () => signer.healthy(),
        )
      : undefined;

    const checkpointer = new Checkpointer({
      store,
      now: () => new Date(),
      ...(tsa === undefined ? {} : { tsa }),
      intervalMinutes: checkpointMinutes,
      retryMinutes: tsaRetryMinutes,
      onError: (message) => process.stderr.write(`${message}\n`),
    });

    // Paused for maintenance, every heartbeat is refused: a sweep then would
    // call every agent lost for a silence that was the server's own.
    const connections = new ConnectionWatch({ store });

    const app = buildServer({
      store,
      keys,
      connections,
      scriptGuard: scriptGuard(process.env),
      claudeCode: claudeCode(process.env),
      transfer: transfer(process.env),
      plainAgents: plainAgents(process.env),
      ...(providerKeys === undefined || gatewayAccess === "off" ? {} : { gateway: { keys: providerKeys, access: gatewayAccess, toolRequests } }),
      logger: true,
      trustProxy: proxies,
      ingestLimits,
      signerHealthy: () => signer.healthy(),
      chainsIntact: () => store.divergentSystems().length === 0 && (healthMonitor?.failedSystems().length ?? 0) === 0,
      ...(pause === null ? {} : { ingestPause: pause }),
      organizationMonthlyReceipts,
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
              agentUpload: agentUploadAccess,
              agentProtection: agentProtectionAccess,
              ...(backupDirectory === undefined ? {} : { backupDirectory }),
              ...(accounts === null
                ? {}
                : {
                    accounts: {
                      firebase: new FirebaseAuth(accounts, () => new Date()),
                      publicUrl: accounts.publicUrl,
                    },
                  }),
            },
          }),
    });
    const dailyExporter =
      backupDirectory === undefined
        ? undefined
        : new DailyExporter({
            store,
            directory: backupDirectory,
            now: () => new Date(),
            onError: (message) => process.stderr.write(`${message}\n`),
          });
    healthMonitor?.start();
    checkpointer.start();
    dailyExporter?.start();
    if (pause === null) connections.start();

    const shutdown = (): void => {
      connections.stop();
      checkpointer.stop();
      dailyExporter?.stop();
      healthMonitor?.stop();
      void app.close().then(() => {
        keys.close();
        providerKeys?.close();
        store.close();
        signer.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    await app.listen({ host: options.host, port: listenPort });
    process.stdout.write(`signing with key ${signer.keyId}\n`);
    if (pause !== null) {
      const except = [...pause.except].sort().join(", ");
      process.stdout.write(
        `writes are PAUSED (SIGILLO_INGEST_PAUSED)${except.length > 0 ? `, except for ${except}` : ""}\n`,
      );
    }
    process.stdout.write(
      `checkpointing every ${checkpointMinutes} minutes, anchoring with ${tsa === undefined ? "no authority" : printableUrl(tsa.url)}\n`,
    );
  });

const system = program.command("system").description("Manage AI systems and their chains");

system
  .command("create")
  .description("Register a system and write the genesis receipt of its chain")
  .argument("<system_id>")
  .option("--organization <id>", "the organization it belongs to (sigillo-server org list); without it, the operator's alone")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .requiredOption("--signer-socket <path>", "the signer's socket", process.env["SIGILLO_SIGNER_SOCKET"])
  .action(async (systemId: string, options: DatabaseOption & { signerSocket: string; organization?: string }) => {
    const genesis = await withSigner(options.signerSocket, options.db, (store) =>
      store.createSystem(systemId, now(), options.organization ?? null),
    );
    process.stdout.write(`created ${systemId}${options.organization === undefined ? "" : ` for ${options.organization}`}\n`);
    process.stdout.write(`genesis signed by key ${genesis.key_id}\n`);
  });

system
  .command("list")
  .description(
    "List the systems that have a chain: system_id, receipts, state, display name, and the organization when there is one",
  )
  .option("--all", "include archived systems")
  .option("--organization <id>", "only this organization's systems")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((options: DatabaseOption & { all?: boolean; organization?: string }) => {
    const store = ReceiptStore.openReadOnly(options.db);
    try {
      for (const record of store.listSystemRecords()) {
        if (record.archived_at !== null && options.all !== true) continue;
        if (options.organization !== undefined && record.organization_id !== options.organization) continue;
        const state = record.archived_at === null ? "active" : `archived ${record.archived_at}`;
        process.stdout.write(
          `${record.system_id}\t${record.receipts} receipts\t${state}\t${record.display_name ?? ""}` +
            `${record.organization_id === null ? "" : `\torganization ${record.organization_id}`}\n`,
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

system
  .command("assign")
  .description(
    "Give a system to an organization, whose members then see it in the web view, or with --none take it " +
      "back to the operator alone. The chain is not touched",
  )
  .argument("<system_id>")
  .argument("[organization_id]")
  .option("--none", "the operator's alone")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action(async (systemId: string, organizationId: string | undefined, options: DatabaseOption & { none?: boolean }) => {
    if ((organizationId === undefined) === (options.none !== true)) {
      throw new Error("name exactly one: an organization, or --none");
    }
    await withStore(options.db, async (store) => {
      const before = await store.assignSystem(systemId, organizationId ?? null, cliRequest());
      process.stdout.write(
        `${systemId}: ${before ?? "the operator's alone"} -> ${organizationId ?? "the operator's alone"}\n`,
      );
    });
  });

const org = program
  .command("org")
  .description("Manage the organizations of a hosted installation: each sees only its own systems in the web view");

org
  .command("create")
  .description("Register an organization, approved: its members can sign in as soon as a login is attached")
  .argument("<organization_id>", "1 to 32 lower-case letters, digits and hyphens; its systems are named <organization_id>.<name>")
  .argument("<name>", "the name people know it by")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action(async (organizationId: string, name: string, options: DatabaseOption) => {
    await withStore(options.db, async (store) => {
      await store.createOrganization(organizationId, name, cliRequest(), { approved: true });
      process.stdout.write(`created organization ${organizationId}\n`);
    });
  });

org
  .command("approve")
  .description("Let an organization that signed itself up in: its members can sign in from now on")
  .argument("<organization_id>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action(async (organizationId: string, options: DatabaseOption) => {
    await withStore(options.db, async (store) => {
      const organization = await store.approveOrganization(organizationId, cliRequest());
      process.stdout.write(`approved ${organization.organization_id} (${organization.name})\n`);
    });
  });

org
  .command("members")
  .description("List the people who sign in for an organization: email, since when")
  .argument("<organization_id>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((organizationId: string, options: DatabaseOption) => {
    const store = ReceiptStore.openReadOnly(options.db);
    try {
      for (const user of store.usersOf(organizationId)) process.stdout.write(`${user.email}\t${user.created_at}\n`);
    } finally {
      store.close();
    }
  });

org
  .command("list")
  .description("List the organizations: identifier, state, name")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((options: DatabaseOption) => {
    const store = ReceiptStore.openReadOnly(options.db);
    try {
      for (const organization of store.listOrganizations()) {
        const state = organization.approved_at === null ? "waiting for approval" : `approved ${organization.approved_at}`;
        process.stdout.write(`${organization.organization_id}\t${state}\t${organization.name}\n`);
      }
    } finally {
      store.close();
    }
  });

program
  .command("admin-log")
  .description(
    "Print the administrative log: renames, archivals and deletions of systems, erasures of subjects and nonces, newest first",
  )
  .option("--limit <n>", "how many entries", "100")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((options: DatabaseOption & { limit: string }) => {
    const limit = positiveInteger("--limit", options.limit, 100, 10_000);
    const store = ReceiptStore.openReadOnly(options.db);
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
    const keys = ApiKeyStore.openReadOnly(options.db);
    try {
      for (const record of keys.list(options.system)) {
        const state = record.revokedAt === null ? "live" : `revoked ${record.revokedAt}`;
        process.stdout.write(`${record.keyId}\t${record.systemId}\t${state}\n`);
      }
    } finally {
      keys.close();
    }
  });

const signerCommand = program.command("signer").description("The signer's own record of every chain");

signerCommand
  .command("check")
  .description(
    "Compare the head the signer remembers for every chain with the database's last receipt; exit 1 if any differ. " +
      "Reads only: nothing is recovered or repaired",
  )
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .requiredOption("--signer-socket <path>", "the signer's socket", process.env["SIGILLO_SIGNER_SOCKET"])
  .action(async (options: DatabaseOption & { signerSocket: string }) => {
    const signer = await SignerClient.connect(options.signerSocket);
    const store = ReceiptStore.openReadOnly(options.db);
    let differ = 0;
    try {
      for (const systemId of store.listSystems()) {
        const tip = store.tip(systemId);
        const head = await signer.head(systemId);
        const same = tip !== null && head !== null && head.seq === tip.seq && receiptHashHex(head) === tip.hash;
        if (!same) differ += 1;
        process.stdout.write(
          `${systemId}\tdatabase seq ${tip?.seq ?? "none"}\tsigner seq ${head?.seq ?? "none"}\t${same ? "same" : "DIFFERENT"}\n`,
        );
      }
    } finally {
      store.close();
      signer.close();
    }
    if (differ > 0) {
      process.stderr.write(
        `${differ} chain(s) differ. After a rollback, the signer's record is ahead of the database: ` +
          "DEPLOY.md, step R4. After restoring a backup: DEPLOY.md, last section\n",
      );
      process.exit(1);
    }
  });

program
  .command("migrate")
  .description("Bring a database up to this release's schema. The server does it by itself when it starts")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((options: DatabaseOption) => {
    ReceiptStore.open(options.db).close();
    process.stdout.write(`${options.db}: schema ${SCHEMA_VERSION}\n`);
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
  .option(
    "--subject <token>",
    "name the person behind this pseudonym token in subjects.jsonl (repeatable); by default nobody is named",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
  )
  .option(
    "--open <seqs>",
    "disclose the nonces of these receipts' salted digests in openings.jsonl, such as 4 or 7-9 (repeatable); by default none",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
  )
  .action(
    async (
      systemId: string,
      options: DatabaseOption & { signerSocket: string; out: string; subject?: string[]; open?: string[] },
    ) => {
      const signer = await SignerClient.connect(options.signerSocket);
      const store = ReceiptStore.open(options.db, signer);
      try {
        const archive = await archiveFromStore(store, systemId, {
          subjects: tokensIn((options.subject ?? []).join(" ")),
          openings: positionsIn((options.open ?? []).join(" ")),
          exportedAt: now(),
        });

        writeFileSync(options.out, archive.zip);
        process.stdout.write(
          `wrote ${archive.manifest.counts.receipts} receipts, ` +
            `${archive.manifest.counts.checkpoints} checkpoint(s) and ` +
            `${archive.manifest.counts.timestamps} timestamp token(s) to ${options.out}\n`,
        );
        for (const name of ["subjects.jsonl", "openings.jsonl"]) {
          if (archive.entries.some((entry) => entry.name === name)) process.stdout.write(`disclosed on request: ${name}\n`);
        }
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
    },
  );

const subject = program
  .command("subject")
  .description("The people behind pseudonym tokens: find one, or erase one (GDPR erasure)");

subject
  .command("find")
  .description("Print the pseudonym token of an identifier, in any spelling that normalises the same")
  .argument("<identifier>")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action((identifier: string, options: DatabaseOption) => {
    const store = ReceiptStore.openReadOnly(options.db);
    try {
      const token = store.subjectToken(identifier);
      if (token === null) {
        process.stderr.write("no token for this identifier: never seen, or erased\n");
        process.exit(1);
      }
      process.stdout.write(`${token}\n`);
    } finally {
      store.close();
    }
  });

subject
  .command("erase")
  .description(
    "Erase a person: delete which identifier a token stands for. Their receipts stay valid and no longer " +
      "lead to them; the administrative log records the token only",
  )
  .option("--identifier <identifier>", "the person, by identifier")
  .option("--token <token>", "the person, by pseudonym token")
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action(async (options: DatabaseOption & { identifier?: string; token?: string }) => {
    if ((options.identifier === undefined) === (options.token === undefined)) {
      throw new Error("give exactly one of --identifier or --token");
    }
    await withStore(options.db, async (store) => {
      const token = options.token ?? store.subjectToken(options.identifier ?? "");
      // Read before the erasure: afterwards nothing says who the token was.
      const identifier = options.identifier ?? (token === null ? null : store.subjectIdentifier(token));
      const legacy = identifier === null ? 0 : store.legacyReceiptsNaming(identifier);
      const legacyWarning =
        `WARNING: ${legacy} receipt(s) written before receipt version 4 name this person in clear. ` +
        "Receipts cannot be changed, so no erasure reaches them (SECURITY.md, \"Erasing a person\")\n";
      if (token === null || !isPseudonym(token) || !(await store.eraseSubject(token, cliRequest()))) {
        process.stderr.write("nothing to erase: no such subject (never seen, or already erased)\n");
        if (legacy > 0) process.stderr.write(legacyWarning);
        process.exit(1);
      }
      process.stdout.write(
        legacy > 0
          ? `erased ${token}: its receipts from version 4 on no longer lead to anyone\n`
          : `erased ${token}: its receipts no longer lead to anyone\n`,
      );
      if (legacy > 0) process.stdout.write(legacyWarning);
      process.stdout.write("the erasure is in the administrative log (sigillo-server admin-log)\n");
    });
  });

const openings = program
  .command("openings")
  .description("The nonces of salted input and output digests");

openings
  .command("erase")
  .description(
    "Delete the nonces of some receipts, so that nobody can show any more what their input or output digests " +
      "were computed over. By position, or by a document: every receipt naming it, and the rest of their traces",
  )
  .argument("[system_id]", "the system, with --seq")
  .option(
    "--seq <seqs>",
    "positions, such as 4 or 7-9 (repeatable)",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
  )
  .option("--document <path>", "a document (a candidate's CV): found by its SHA-256, which is computed here")
  .requiredOption(
    "--confirm <system_id>",
    "each system whose receipts are affected, typed out (repeatable)",
    (value: string, previous: string[] | undefined) => [...(previous ?? []), value],
  )
  .requiredOption("--db <path>", "the sigillo database", process.env["SIGILLO_DB"])
  .action(
    async (
      systemId: string | undefined,
      options: DatabaseOption & { seq?: string[]; document?: string; confirm: string[] },
    ) => {
      if ((options.document === undefined) === (options.seq === undefined)) {
        throw new Error("give exactly one of --seq (with a system_id) or --document");
      }
      if (options.seq !== undefined && systemId === undefined) throw new Error("--seq needs a system_id");
      await withStore(options.db, async (store) => {
        const targets =
          options.document === undefined
            ? [{ system_id: systemId ?? "", seqs: positionsIn(options.seq?.join(" ")) }]
            : store.receiptsOfDocument(createHash("sha256").update(readFileSync(options.document)).digest("hex"));
        if (targets.length === 0 || targets.every((target) => target.seqs.length === 0)) {
          process.stderr.write("no receipt found: nothing was erased\n");
          process.exit(1);
        }
        const unconfirmed = targets.filter((target) => !options.confirm.includes(target.system_id));
        if (unconfirmed.length > 0) {
          throw new Error(
            `receipts of ${unconfirmed.map((target) => target.system_id).join(", ")} are affected: confirm each with ` +
              "--confirm <system_id>. Nothing was erased",
          );
        }
        for (const target of targets) {
          const erased = await store.eraseOpenings(target.system_id, target.seqs, cliRequest());
          process.stdout.write(`${target.system_id}: seq ${target.seqs.join(", ")}: ${erased} nonce(s) erased\n`);
        }
        process.stdout.write("the erasure is in the administrative log (sigillo-server admin-log)\n");
      });
    },
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
