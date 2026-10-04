import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The off-site copy of the backups (deploy/backup-offsite.sh), as the web
 * view sees it. The copy itself is made on the host, by rclone, where the
 * Google Drive connection and its password live; the server never sees
 * either. What the two share is the backups directory, a volume both reach:
 *
 * - offsite-settings.json, written here from Impostazioni: whether the copy
 *   is on, and how often it is made;
 * - offsite-status.json, written by the script on every hourly run: whether
 *   Drive is connected, and when the last copy succeeded and failed.
 *
 * Both are a handful of numbers. A file missing or unreadable reads as the
 * defaults and "never ran", never as an error the page cannot show.
 */

export const SETTINGS_FILE = "offsite-settings.json";
export const STATUS_FILE = "offsite-status.json";

/** How often the copy may be made, in hours: the script runs every hour. */
export const OFFSITE_FREQUENCIES = [1, 6, 12, 24] as const;
export type OffsiteFrequency = (typeof OFFSITE_FREQUENCIES)[number];

export interface OffsiteSettings {
  enabled: boolean;
  everyHours: OffsiteFrequency;
}

/** Until someone chooses, the copy is on and made every hour, as before there was a choice. */
export const DEFAULT_OFFSITE_SETTINGS: OffsiteSettings = { enabled: true, everyHours: 1 };

/** What the script last reported. Times are Unix seconds. */
export interface OffsiteStatus {
  /** The last time the script ran, whether or not it made a copy. */
  checked: number;
  /** Whether rclone on the host has the remote the copies go to. */
  drive: boolean;
  lastSuccess: number | null;
  lastFailure: number | null;
}

export function isOffsiteFrequency(value: unknown): value is OffsiteFrequency {
  return OFFSITE_FREQUENCIES.some((hours) => hours === value);
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readOffsiteSettings(directory: string): OffsiteSettings {
  const raw = readJson(join(directory, SETTINGS_FILE));
  return {
    enabled: typeof raw?.["enabled"] === "boolean" ? raw["enabled"] : DEFAULT_OFFSITE_SETTINGS.enabled,
    everyHours: isOffsiteFrequency(raw?.["every_hours"]) ? raw["every_hours"] : DEFAULT_OFFSITE_SETTINGS.everyHours,
  };
}

/**
 * Written whole and then renamed into place, so the script never reads half
 * a file. The shape is the one the script reads with sed: one line, these
 * two keys, no spaces.
 */
export function writeOffsiteSettings(directory: string, settings: OffsiteSettings): void {
  const path = join(directory, SETTINGS_FILE);
  writeFileSync(`${path}.tmp`, `{"enabled":${settings.enabled},"every_hours":${settings.everyHours}}\n`);
  renameSync(`${path}.tmp`, path);
}

export function readOffsiteStatus(directory: string): OffsiteStatus | null {
  const raw = readJson(join(directory, STATUS_FILE));
  const seconds = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);
  const checked = seconds(raw?.["checked"]);
  if (raw === null || checked === null) return null;
  return {
    checked,
    drive: raw["drive"] === true,
    lastSuccess: seconds(raw["last_success"]),
    lastFailure: seconds(raw["last_failure"]),
  };
}

/** The script runs every hour: two without a word mean it is not running. */
const SILENT_AFTER_SECONDS = 2 * 60 * 60 + 10 * 60;

/** What Impostazioni says about the copy, from the most to the least urgent. */
export type OffsiteState =
  | { kind: "off" }
  | { kind: "never-ran" }
  | { kind: "not-running"; since: Date }
  | { kind: "not-connected" }
  | { kind: "failed"; at: Date }
  | { kind: "ok"; at: Date }
  | { kind: "waiting" };

export function offsiteState(settings: OffsiteSettings, status: OffsiteStatus | null, now: Date): OffsiteState {
  if (!settings.enabled) return { kind: "off" };
  if (status === null) return { kind: "never-ran" };
  if (now.getTime() / 1000 - status.checked > SILENT_AFTER_SECONDS) return { kind: "not-running", since: new Date(status.checked * 1000) };
  if (!status.drive) return { kind: "not-connected" };
  if (status.lastFailure !== null && (status.lastSuccess === null || status.lastFailure > status.lastSuccess)) {
    return { kind: "failed", at: new Date(status.lastFailure * 1000) };
  }
  if (status.lastSuccess !== null) return { kind: "ok", at: new Date(status.lastSuccess * 1000) };
  return { kind: "waiting" };
}
