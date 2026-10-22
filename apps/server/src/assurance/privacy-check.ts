import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { readZip } from "@sigillo/core";

/**
 * What a sigillo installation keeps, for whoever runs it or reviews it
 * (docs/DATA-PROTECTION.md, last section).
 *
 * Two tools. The inventory classifies every column the schema creates, and a
 * test fails when a column appears that it does not classify, so the page
 * generated from it (docs/STORAGE-INVENTORY.md) cannot fall behind the code.
 * The scan looks for a marker sent through an agent
 * in every column of every table, in the database file's raw bytes (its write-
 * ahead log included, and so any page that was freed but not overwritten), and
 * in any other file or folder named: logs, backups, exports.
 */

/** What kind of value a column holds. */
export type StorageClass =
  | "content-digest"
  | "recorded-as-sent"
  | "personal-erasable"
  | "identifier"
  | "credential-hash"
  | "sealed"
  | "public-key"
  | "time"
  | "operational";

export const STORAGE_CLASSES: Record<StorageClass, string> = {
  "content-digest": "a SHA-256 digest or a hash tree root: no content, and salted where it digests an input or output",
  "recorded-as-sent": "text recorded exactly as the agent, operator or console sent it, and kept as a record (signed evidence, an append-only log or the export register): no command erases it",
  "personal-erasable": "personal data in clear, outside the evidence: it can be changed or deleted (the note says how)",
  identifier: "a random or operator-chosen identifier",
  "credential-hash": "a one-way hash of a secret: the secret itself is not stored",
  sealed: "encrypted (AES-256-GCM); the key is not in the database",
  "public-key": "a public key, meant to be published",
  time: "a timestamp",
  operational: "a state, a count, a flag or a size",
};

interface TableEntry {
  purpose: string;
  /** How long a row stays, and how it goes. */
  kept: string;
  columns: Record<string, [StorageClass, string]>;
}

const RECEIPT_KEPT = "for the life of the chain: append-only, enforced by database triggers";

/**
 * Every table and column the schema creates (storage/schema.ts), one line each.
 * Tables that a later schema adds may be listed before they exist; a column of
 * the live schema that is missing here fails the inventory test.
 */
export const STORAGE_INVENTORY: Record<string, TableEntry> = {
  systems: {
    purpose: "one row per AI system (chain)",
    kept: "while the system exists; removable only once its chain is gone",
    columns: {
      system_id: ["identifier", "chosen by the operator or customer; written into every receipt"],
      created_at: ["time", ""],
      display_name: ["personal-erasable", "label shown in the console; can be changed or cleared"],
      archived_at: ["time", ""],
      organization_id: ["identifier", "the customer account the system belongs to"],
    },
  },
  organizations: {
    purpose: "customer accounts",
    kept: "while the account exists; an account with no recorded action can be deleted",
    columns: {
      organization_id: ["identifier", "random"],
      name: ["personal-erasable", "company name given at sign-up; also written in the administrative log at sign-up"],
      created_at: ["time", ""],
      approved_at: ["time", ""],
    },
  },
  users: {
    purpose: "people who sign in for a customer account",
    kept: "while the account exists",
    columns: {
      uid: ["identifier", "Firebase's id for the login"],
      email: ["personal-erasable", "the login email, removed with the account; also written in the administrative log at sign-up. No password is ever stored"],
      organization_id: ["identifier", ""],
      created_at: ["time", ""],
    },
  },
  api_keys: {
    purpose: "the keys agents use to send records",
    kept: "until revoked; revoked keys stay as a record",
    columns: {
      key_id: ["identifier", "random"],
      system_id: ["identifier", ""],
      salt: ["operational", "random salt for the hash below"],
      secret_hash: ["credential-hash", "scrypt"],
      created_at: ["time", ""],
      revoked_at: ["time", ""],
    },
  },
  transfer_links: {
    purpose: "links that hand a system to another account",
    kept: "as a record of who received what",
    columns: {
      token_hash: ["credential-hash", "SHA-256 of the secret in the link"],
      system_id: ["identifier", ""],
      created_at: ["time", ""],
      expires_at: ["time", ""],
      used_at: ["time", ""],
      used_by: ["identifier", "the receiving account"],
      revoked_at: ["time", ""],
    },
  },
  receipts: {
    purpose: "the signed, chained record of each agent action (the evidence)",
    kept: RECEIPT_KEPT,
    columns: {
      id: ["operational", ""],
      system_id: ["identifier", ""],
      seq: ["operational", "position in the chain"],
      hash: ["content-digest", "the receipt's own hash"],
      prev_hash: ["content-digest", "the previous receipt's hash"],
      canonical: [
        "recorded-as-sent",
        "the whole receipt: input/output only as digests; agent name, action name, model name, artifact labels and the pseudonym token in clear (docs/DATA-INVENTORY.md)",
      ],
      sig: ["operational", "Ed25519 signature"],
      key_id: ["identifier", "which signing key"],
      ts_event: ["time", ""],
      ts_received: ["time", ""],
      action_kind: ["recorded-as-sent", "a fixed kind such as tool_call or llm_call"],
      action_name: ["recorded-as-sent", "tool, model or step name, copied from the receipt"],
      outcome: ["operational", "ok, error or unknown"],
      source_trace_id: ["identifier", "OpenTelemetry trace id, random"],
      source_span_id: ["identifier", "OpenTelemetry span id, random"],
    },
  },
  checkpoints: {
    purpose: "signed hash-tree roots over each chain",
    kept: RECEIPT_KEPT,
    columns: {
      id: ["operational", ""],
      system_id: ["identifier", ""],
      tree_size: ["operational", ""],
      root_hash: ["content-digest", ""],
      ts: ["time", ""],
      key_id: ["identifier", ""],
      sig: ["operational", "Ed25519 signature"],
    },
  },
  timestamps: {
    purpose: "RFC 3161 timestamp tokens over checkpoints",
    kept: RECEIPT_KEPT,
    columns: {
      id: ["operational", ""],
      checkpoint_id: ["operational", ""],
      tsa_url: ["identifier", "the timestamp authority's address"],
      token_base64: ["content-digest", "the authority's signed token over a checkpoint root"],
      obtained_at: ["time", ""],
    },
  },
  artifacts: {
    purpose: "index of documents named in receipts, by fingerprint",
    kept: RECEIPT_KEPT,
    columns: {
      id: ["operational", ""],
      system_id: ["identifier", ""],
      seq: ["operational", ""],
      role: ["operational", "input or output"],
      label: ["recorded-as-sent", "a category the agent's code gives, such as 'curriculum'"],
      media_type: ["recorded-as-sent", "such as application/pdf"],
      sha256: ["content-digest", "the document's fingerprint; the document itself is never sent"],
      text_canon: ["operational", "name of the text normalisation used for text_sha256"],
      text_sha256: ["content-digest", "fingerprint of the document's normalised text"],
    },
  },
  signing_keys: {
    purpose: "every public key receipts were signed with",
    kept: "forever, so old receipts stay verifiable",
    columns: {
      key_id: ["identifier", ""],
      public_key_base64: ["public-key", ""],
      first_seen: ["time", ""],
    },
  },
  export_register: {
    purpose: "which evidence packs were handed out",
    kept: "as a record",
    columns: {
      id: ["operational", ""],
      ts: ["time", ""],
      system_id: ["identifier", ""],
      actor: ["recorded-as-sent", "who exported: 'web <address>' or 'web <email> (<account>)'"],
      period_from: ["time", ""],
      period_to: ["time", ""],
      run_trace: ["identifier", ""],
      disclosure: ["operational", "which nonces were disclosed, if any"],
      zip_sha256: ["content-digest", "the pack's fingerprint; the pack itself is not kept"],
      bytes: ["operational", ""],
    },
  },
  connections: {
    purpose: "heartbeat state of running agents",
    kept: "current state only, overwritten",
    columns: {
      system_id: ["identifier", ""],
      session_id: ["identifier", "random, chosen by the SDK"],
      state: ["operational", ""],
      started_at: ["time", ""],
      last_beat_at: ["time", ""],
      script_hash: ["content-digest", "SHA-256 of the agent's script; the script is never sent"],
      script_changed: ["operational", ""],
    },
  },
  provider_keys: {
    purpose: "the customer's own model-provider keys, for the model gateway",
    kept: "until the customer replaces or removes them",
    columns: {
      system_id: ["identifier", ""],
      provider: ["operational", "openai, anthropic, ..."],
      sealed: ["sealed", "the key, encrypted"],
      last4: ["operational", "last four characters, shown in the console"],
      created_at: ["time", ""],
      vault_owner: ["identifier", "the account whose vault seals it (schema 8, the key vault)"],
    },
  },
  vaults: {
    purpose: "each account's key vault (schema 8, the key vault)",
    kept: "while the account exists",
    columns: {
      owner: ["identifier", "the account"],
      salt: ["operational", "scrypt salt"],
      wrapped_by_pass: ["sealed", "the vault's data key, sealed under the passphrase"],
      wrapped_by_recov: ["sealed", "the vault's data key, sealed under the recovery key"],
      created_at: ["time", ""],
    },
  },
  admin_log: {
    purpose: "administrative actions outside the chains (renames, deletions, erasures, sign-ups)",
    kept: "append-only, enforced by database triggers",
    columns: {
      id: ["operational", ""],
      ts: ["time", ""],
      action: ["operational", ""],
      system_id: ["identifier", ""],
      actor: ["recorded-as-sent", "'web <address>', 'web <email> (<account>)' or 'cli <user>@<host>'"],
      detail: ["recorded-as-sent", "names before and after a rename; sign-up email and company name"],
      genesis_hash: ["content-digest", ""],
    },
  },
  subjects: {
    purpose: "which person a pseudonym token in the receipts stands for",
    kept: "until the person is erased (sigillo-server subject erase); the row is overwritten on delete",
    columns: {
      token: ["identifier", "psn_ + 128 random bits, the only thing a receipt holds"],
      identifier: ["personal-erasable", "the user id the agent sent; deleted by `sigillo-server subject erase`"],
      created_at: ["time", ""],
    },
  },
  openings: {
    purpose: "the nonces that salted input/output digests were computed under",
    kept: "until erased (sigillo-server openings erase); without it the digest can never be matched to content",
    columns: {
      system_id: ["identifier", ""],
      seq: ["operational", ""],
      role: ["operational", "input or output"],
      nonce: ["operational", "32 random bytes"],
    },
  },
};

export interface LiveColumn {
  table: string;
  column: string;
}

/** Every column of every table in the database, SQLite's own tables left out. */
export function liveColumns(db: Database.Database): LiveColumn[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return tables.flatMap(({ name }) =>
    (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((row) => ({ table: name, column: row.name })),
  );
}

/** The columns the inventory says nothing about: none, or the inventory is out of date. */
export function unclassifiedColumns(db: Database.Database): LiveColumn[] {
  return liveColumns(db).filter(({ table, column }) => STORAGE_INVENTORY[table]?.columns[column] === undefined);
}

/** The inventory as it is printed: per table, its rows and each column's class. */
export function describeDatabase(db: Database.Database): string {
  const lines: string[] = [];
  const byTable = new Map<string, string[]>();
  for (const { table, column } of liveColumns(db)) byTable.set(table, [...(byTable.get(table) ?? []), column]);
  for (const [table, columns] of byTable) {
    const { count } = db.prepare(`SELECT count(*) AS count FROM "${table}"`).get() as { count: number };
    const entry = STORAGE_INVENTORY[table];
    lines.push(`${table} (${count} rows)${entry === undefined ? "" : `: ${entry.purpose}`}`);
    for (const column of columns) {
      const known = entry?.columns[column];
      lines.push(`  ${column.padEnd(18)} ${known === undefined ? "UNCLASSIFIED" : known[0]}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** docs/STORAGE-INVENTORY.md, which a test keeps equal to this. */
export function inventoryMarkdown(): string {
  const out = [
    "# What the sigillo database stores, column by column",
    "",
    "Generated from `apps/server/src/assurance/privacy-check.ts` (`sigillo-server privacy inventory --markdown`).",
    "A test fails if the database schema gains a column this page does not classify, so the page cannot",
    "silently fall behind the code. To see the same thing for a running installation, with row counts:",
    "`sigillo-server privacy inventory --db <file>`. Why content never reaches it, and the customer's",
    "own key, are in `docs/DATA-PROTECTION.md`. What the text members of a receipt contain is",
    "described in `docs/DATA-INVENTORY.md`.",
    "",
    "Nothing in the database holds a prompt, a model answer, a tool argument, a tool result or a",
    "document: those reach the database only as digests.",
    "",
    "## Classes",
    "",
    "| class | meaning |",
    "|---|---|",
    ...Object.entries(STORAGE_CLASSES).map(([name, meaning]) => `| \`${name}\` | ${meaning} |`),
    "",
  ];
  for (const [table, entry] of Object.entries(STORAGE_INVENTORY)) {
    out.push(`## \`${table}\``, "", `${entry.purpose}. Kept: ${entry.kept}.`, "", "| column | class | note |", "|---|---|---|");
    for (const [column, [kind, note]] of Object.entries(entry.columns)) out.push(`| \`${column}\` | ${kind} | ${note} |`);
    out.push("");
  }
  return out.join("\n");
}

/** A marker to send through an agent, and look for afterwards. */
export function newCanary(): string {
  return `sigillo-canary-${randomBytes(16).toString("hex")}`;
}

/** Shorter markers could match by accident, and say nothing when they do not. */
export const MIN_MARKER_LENGTH = 16;

export interface ColumnHit {
  table: string;
  column: string;
  rows: number;
}

/** Every column, of every table, holding the marker in at least one row. */
export function scanDatabase(db: Database.Database, marker: string): ColumnHit[] {
  const hits: ColumnHit[] = [];
  for (const { table, column } of liveColumns(db)) {
    const { rows } = db
      .prepare(`SELECT count(*) AS rows FROM "${table}" WHERE instr(CAST("${column}" AS TEXT), ?) > 0`)
      .get(marker) as { rows: number };
    if (rows > 0) hits.push({ table, column, rows });
  }
  return hits;
}

export interface FileHit {
  path: string;
  /** How many times the marker appears, in UTF-8 or UTF-16. */
  count: number;
}

function occurrences(bytes: Buffer, needles: Buffer[]): number {
  let count = 0;
  for (const needle of needles) {
    for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) count += 1;
  }
  return count;
}

/**
 * Every file under the given paths whose bytes hold the marker. A zip (an
 * export, a daily export) is opened and each entry searched as well, since
 * its compressed bytes would not show the marker.
 */
export function scanFiles(paths: string[], marker: string): { scanned: number; hits: FileHit[] } {
  const needles = [Buffer.from(marker, "utf8"), Buffer.from(marker, "utf16le")];
  const hits: FileHit[] = [];
  let scanned = 0;
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    scanned += 1;
    const bytes = readFileSync(path);
    let count = occurrences(bytes, needles);
    if (path.endsWith(".zip")) {
      try {
        for (const entry of readZip(new Uint8Array(bytes))) count += occurrences(Buffer.from(entry.data), needles);
      } catch {
        // Not a zip after all: its raw bytes were searched above.
      }
    }
    if (count > 0) hits.push({ path, count });
  };
  for (const path of paths) visit(path);
  return { scanned, hits };
}

/** The database file and the files SQLite keeps beside it. */
export function databaseFiles(databasePath: string): string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-journal`].filter((path) => existsSync(path));
}
