import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveFromStore } from "../export/from-store.js";
import { formatTime, localDate, localDayRange } from "../http/strings.js";
import type { ReceiptStore } from "../storage/store.js";

/**
 * The daily export: for each account that turned it on, at 23:59 Italian
 * time, one file per system with that day's receipts, the same verifiable
 * archive the Esporta button gives. The files are kept on the server, in the
 * backups volume, and downloaded from Impostazioni; the last KEEP_DAYS days
 * stay, older ones are removed.
 *
 * "Account" is the operator (the systems with no organization) or one
 * organization, named by its id; the operator's key is the empty string.
 * Which accounts turned it on is one small file, daily-export.json, next to
 * the files themselves: no table, so nothing in the database changes.
 */

const SETTINGS_FILE = "daily-export.json";
const EXPORTS_DIRECTORY = "exports";
export const KEEP_DAYS = 30;
/** The minute of the day, Italian time, from which the day's export is made. */
const FROM_TIME = "23:59";

/** The folder name of an account: the organization's id, or `operator`. */
const folderOf = (owner: string): string => (owner === "" ? "operator" : owner);

/** A file name an export has: `<system>--<day>.zip`. Anything else is not served. */
const FILE_NAME = /^([A-Za-z0-9._-]+)--(\d{4}-\d{2}-\d{2})\.zip$/;

export function fileNameFor(systemId: string, day: string): string {
  return `${systemId.replaceAll(/[^A-Za-z0-9._-]/g, "_")}--${day}.zip`;
}

function readEnabled(directory: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(directory, SETTINGS_FILE), "utf8"));
    const list = typeof parsed === "object" && parsed !== null ? (parsed as { enabled?: unknown }).enabled : undefined;
    return Array.isArray(list) ? list.filter((owner): owner is string => typeof owner === "string") : [];
  } catch {
    // Missing or unreadable reads as "nobody turned it on".
    return [];
  }
}

export function isDailyExportOn(directory: string, owner: string): boolean {
  return readEnabled(directory).includes(owner);
}

/** Written whole and renamed into place, so a reader never sees half a file. */
export function setDailyExport(directory: string, owner: string, on: boolean): void {
  const others = readEnabled(directory).filter((existing) => existing !== owner);
  const enabled = on ? [...others, owner] : others;
  mkdirSync(directory, { recursive: true });
  const path = join(directory, SETTINGS_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ enabled })}\n`);
  renameSync(`${path}.tmp`, path);
}

export interface StoredExport {
  systemId: string;
  day: string;
  fileName: string;
  bytes: number;
}

/** The files an account has, newest day first, for the systems it can see. */
export function listDailyExports(directory: string, owner: string, systemIds: readonly string[]): StoredExport[] {
  const folder = join(directory, EXPORTS_DIRECTORY, folderOf(owner));
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const visible = new Set(systemIds.map((id) => id.replaceAll(/[^A-Za-z0-9._-]/g, "_")));
  const found: StoredExport[] = [];
  for (const fileName of names) {
    const match = FILE_NAME.exec(fileName);
    if (match === null || !visible.has(match[1] ?? "")) continue;
    found.push({ systemId: match[1] ?? "", day: match[2] ?? "", fileName, bytes: statSync(join(folder, fileName)).size });
  }
  return found.sort((a, b) => b.day.localeCompare(a.day) || a.systemId.localeCompare(b.systemId));
}

/** The path of one of an account's files, or null when the name is not one of ours or the file is not there. */
export function dailyExportPath(directory: string, owner: string, fileName: string): string | null {
  if (!FILE_NAME.test(fileName)) return null;
  const path = join(directory, EXPORTS_DIRECTORY, folderOf(owner), fileName);
  return existsSync(path) ? path : null;
}

/**
 * Makes today's files for every account that has the export on, from 23:59
 * on, Italian time. A file that exists is left alone, so running it again in
 * the same minute, or after a restart, changes nothing; a system with no
 * receipts that day gets no file. Returns how many files it wrote.
 */
export async function runDailyExports(options: { store: ReceiptStore; directory: string; now: Date }): Promise<number> {
  const { store, directory } = options;
  const instant = options.now.toISOString();
  const day = localDate(instant);
  if (day === null || formatTime(instant).slice(0, 5) < FROM_TIME) return 0;
  const enabled = new Set(readEnabled(directory));
  if (enabled.size === 0) return 0;

  const range = localDayRange(day);
  let written = 0;
  for (const record of store.listSystemRecords()) {
    const owner = record.organization_id ?? "";
    if (!enabled.has(owner)) continue;
    const folder = join(directory, EXPORTS_DIRECTORY, folderOf(owner));
    const path = join(folder, fileNameFor(record.system_id, day));
    if (existsSync(path)) continue;
    if (store.readChainInRange(record.system_id, range.from, range.to).length === 0) continue;
    const archive = await archiveFromStore(store, record.system_id, { range, exportedAt: instant });
    mkdirSync(folder, { recursive: true });
    writeFileSync(`${path}.tmp`, archive.zip);
    renameSync(`${path}.tmp`, path);
    written += 1;
  }
  pruneDailyExports(directory, day);
  return written;
}

/** Removes the files of the days before the last KEEP_DAYS, whoever's they are. */
function pruneDailyExports(directory: string, today: string): void {
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCDate(limit.getUTCDate() - KEEP_DAYS);
  const oldest = limit.toISOString().slice(0, 10);
  const root = join(directory, EXPORTS_DIRECTORY);
  let folders: string[];
  try {
    folders = readdirSync(root);
  } catch {
    return;
  }
  for (const folder of folders) {
    for (const fileName of readdirSync(join(root, folder))) {
      const match = FILE_NAME.exec(fileName);
      if (match !== null && (match[2] ?? "") < oldest) rmSync(join(root, folder, fileName), { force: true });
    }
  }
}

/** Looks at the clock once a minute and makes the day's files when it is time. */
export class DailyExporter {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly options: {
      store: ReceiptStore;
      directory: string;
      now: () => Date;
      onError?: (message: string) => void;
    },
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look at the clock. Public so a test, or a restart that wants to catch up, can run it. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await runDailyExports({ store: this.options.store, directory: this.options.directory, now: this.options.now() });
    } catch (error) {
      this.options.onError?.(`daily export failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
