import type { Receipt } from "@sigillo/core";
import { currentLanguage, type Language } from "./locale.js";
import { EN } from "./strings-en.js";
import { IT, type AdminAction, type MatchKind, type Strings, type Texts } from "./strings-it.js";

/**
 * The text the web view shows, in the reader's language (locale.ts): the
 * words themselves are in strings-en.ts and strings-it.ts, one file per
 * language with the same shape; this file picks the one for the request
 * being answered and holds what both share, such as reading a time in the
 * display time zone.
 */

const LANGUAGES: Record<Language, Texts> = { en: EN, it: IT };

function texts(): Texts {
  return LANGUAGES[currentLanguage()];
}

/**
 * A view of the strings that reads the current language at every access, at
 * any depth: `const t = UI.account` taken once, when a module is set up, still
 * gives each later request its own language. A function is wrapped for the
 * same reason, so that one kept aside still speaks the language of the call.
 */
function localized<T extends object>(pick: () => T): T {
  return new Proxy(pick(), {
    get(_target, key) {
      const value: unknown = Reflect.get(pick(), key);
      if (typeof value === "function") {
        return (...args: unknown[]): unknown => (Reflect.get(pick(), key) as (...args: unknown[]) => unknown)(...args);
      }
      if (typeof value === "object" && value !== null) return localized(() => Reflect.get(pick(), key) as object);
      return value;
    },
    has: (_target, key) => Reflect.has(pick(), key),
    ownKeys: () => Reflect.ownKeys(pick()),
    getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(pick(), key),
  });
}

/** Every fixed piece of text of the web view, in the reader's language. */
export const UI: Strings = localized(() => texts().ui);

/** The one sentence the "verifica un documento" page shows for a match, by its kind. */
export function describeDocumentMatch(match: {
  kind: MatchKind;
  system_id: string;
  display_name?: string | null;
  ts_received: string;
  label: string | null;
  action_name: string;
  role: string;
  text_canon?: string | null;
}): string {
  return texts().describeDocumentMatch({ ...match, when: formatTs(match.ts_received) });
}

/** The words of a chain's health (health/chain-health.ts), in the reader's language. */
export function healthWords(): Texts["health"] {
  return texts().health;
}

/** A whole number of minutes as a person says it: "90 minutes", "1 hour", "24 hours", "2 days". */
export function durationWords(minutes: number): string {
  return texts().durationWords(minutes);
}

/**
 * The time zone every time on the web view is shown in. The server stores and
 * signs UTC, and the receipts, the exports and the technical details keep it;
 * only what a person reads on the page is turned into Italian time, so that a
 * receipt written at 19:55 in Rome does not read 17:55.
 */
export const DISPLAY_TIME_ZONE = "Europe/Rome";

const LOCAL_PARTS = new Intl.DateTimeFormat("it-IT", {
  timeZone: DISPLAY_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
});

interface LocalTime {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  /** 0 (Sunday) to 6, as Date.getUTCDay counts. */
  weekday: number;
  time: string;
  /** "CEST" or "CET". */
  zone: string;
}

/** A server timestamp in DISPLAY_TIME_ZONE, or null for one that is not a full ISO time. */
function localTime(iso: string): LocalTime | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(iso)) return null;
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return null;
  const parts = new Map(LOCAL_PARTS.formatToParts(instant).map((part) => [part.type, part.value]));
  const year = Number(parts.get("year"));
  const month = Number(parts.get("month"));
  const day = Number(parts.get("day"));
  return {
    year,
    month,
    day,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    time: `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`,
    zone: parts.get("timeZoneName") ?? DISPLAY_TIME_ZONE,
  };
}

/** "2 Oct 2026", "2 ott 2026": a day as the reader's language abbreviates it. */
function shortDate(local: LocalTime): string {
  return `${local.day} ${texts().months[local.month - 1]} ${local.year}`;
}

/**
 * A server timestamp as a person reads it, in Italian time and to the second,
 * the zone named: "2 Oct 2026, 19:54:37 CEST". The exact ISO form, in UTC,
 * stays in the technical details. Anything that does not parse is shown as it is.
 */
export function formatTs(iso: string): string {
  const local = localTime(iso);
  if (local === null) return iso;
  return `${shortDate(local)}, ${local.time} ${local.zone}`;
}

/**
 * The instants a calendar day ("2026-10-02") spans in DISPLAY_TIME_ZONE, as
 * the store compares them: from its local midnight to the last millisecond
 * before the next one, so a day the clocks change on is 23 or 25 hours long.
 */
export function localDayRange(date: string): { from: string; to: string } {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return {
    from: new Date(localMidnight(year, month, day)).toISOString(),
    to: new Date(localMidnight(year, month, day + 1) - 1).toISOString(),
  };
}

/** The instant of local midnight on a day; Date.UTC carries a day past the month's end. */
function localMidnight(year: number, month: number, day: number): number {
  const utcMidnight = Date.UTC(year, month - 1, day);
  // The zone's offset is read at the guess, then again at the result, so a
  // change of clock between the two is still caught. Italy changes at 02:00
  // or 03:00, never at midnight, so two reads settle it.
  let instant = utcMidnight - offsetAt(utcMidnight);
  instant = utcMidnight - offsetAt(instant);
  return instant;
}

/** How far DISPLAY_TIME_ZONE is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number): number {
  const local = localTime(new Date(instant).toISOString());
  if (local === null) return 0;
  const [hours, minutes, seconds] = local.time.split(":").map(Number) as [number, number, number];
  const asIfUtc = Date.UTC(local.year, local.month - 1, local.day, hours, minutes, seconds);
  return asIfUtc - Math.floor(instant / 1000) * 1000;
}

/** How a system is named for a reader: its label if it has one, else its system_id. */
export function systemTitle(system: { system_id: string; display_name: string | null }): string {
  return system.display_name ?? system.system_id;
}

/** What one entry of the administrative log did, without its time or who did it. */
export function describeAdminAction(entry: AdminAction): string {
  return texts().describeAdminAction(entry);
}

/** Who did it, as the log names them: "web <address>" or "web <email> (<organization>)" loses its "web ". */
export function adminActor(actor: string): string {
  return actor.replace(/^web /, "");
}

/** One line of the administrative log, whole: when, what, who. */
export function describeAdminEntry(entry: {
  ts: string;
  action: string;
  system_id: string;
  actor: string;
  detail: Record<string, unknown>;
}): string {
  return `${formatTs(entry.ts)} — ${describeAdminAction(entry)} (${entry.actor})`;
}

/** The one sentence a non-technical reader sees for a receipt (strings-it.ts says how it is shaped). */
export function describeReceipt(receipt: Receipt): string {
  return texts().describeReceipt(receipt);
}

/** What a document was to the action: "used as input" or "produced as output". */
export function artifactRoleWords(role: "input" | "output"): string {
  return texts().artifactRoleWords(role);
}

/** A readable label for an artifact, e.g. "CV (used as input)". */
export function describeArtifact(role: "input" | "output", label: string): string {
  return `${label} (${artifactRoleWords(role)})`;
}

/** Where a model ran, for the history: "locally, with ollama", or its provider; null when unknown. */
export function modelWhere(provider: string | null): string | null {
  return texts().modelWhere(provider);
}

/** The short title of a receipt in the history's list ("Used «cerca_ordine»"). */
export function receiptTitle(receipt: Receipt): string {
  return texts().receiptTitle(receipt);
}

/** The line under a receipt's title: the agent, where its model ran, on whose behalf, which files. */
export function receiptSubtitle(receipt: Receipt): string {
  return texts().receiptSubtitle(receipt);
}

/** The day of a server timestamp, in Italian time, as a heading of the history: "Tuesday 29 September 2026". */
export function formatDay(iso: string): string {
  const local = localTime(iso);
  if (local === null) return iso;
  const words = texts();
  return `${words.weekdays[local.weekday]} ${local.day} ${words.monthNames[local.month - 1]} ${local.year}`;
}

/** The time of a server timestamp, in Italian time, to the second: "12:40:13". */
export function formatTime(iso: string): string {
  return localTime(iso)?.time ?? iso;
}

/** The calendar day of an instant in Italian time, as "2026-10-01"; null for a time that does not parse. */
export function localDate(iso: string): string | null {
  const local = localTime(iso);
  if (local === null) return null;
  return `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
}

/** The calendar day before `date` ("2026-10-01" gives "2026-09-30"). */
function dayBefore(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/** "Today", "Yesterday" (or "Oggi", "Ieri"), or null, for the day of `iso` seen from `now`, both in Italian time. */
function relativeDay(iso: string, now: Date): string | null {
  const day = localDate(iso);
  const today = localDate(now.toISOString());
  if (day === null || today === null) return null;
  if (day === today) return texts().today;
  return day === dayBefore(today) ? texts().yesterday : null;
}

/**
 * When something happened, as a person says it: "Today, 14:44", "Yesterday,
 * 09:12", "29 Sep 2026, 18:03". Italian time, to the minute; the exact time
 * stays in the technical details.
 */
export function formatWhen(iso: string, now: Date): string {
  const local = localTime(iso);
  if (local === null) return iso;
  const time = local.time.slice(0, 5);
  const relative = relativeDay(iso, now);
  if (relative !== null) return `${relative}, ${time}`;
  return `${shortDate(local)}, ${time}`;
}

/** A short time for a list: "14:44" today, "Yesterday" or "29 Sep" before. */
export function formatListTime(iso: string, now: Date): string {
  const local = localTime(iso);
  if (local === null) return iso;
  const relative = relativeDay(iso, now);
  if (relative === texts().today) return local.time.slice(0, 5);
  if (relative !== null) return relative;
  return `${local.day} ${texts().months[local.month - 1]}`;
}

/** The same in the middle of a sentence: "today at 14:44", "on 29 Sep 2026 at 18:03". */
export function formatWhenInline(iso: string, now: Date): string {
  const local = localTime(iso);
  if (local === null) return iso;
  return texts().inlineWhen(relativeDay(iso, now), shortDate(local), local.time.slice(0, 5));
}

/** A day of the history, as its heading: "Today · Thursday 1 October", "Tuesday 29 September 2026". */
export function formatDayHeading(iso: string, now: Date): string {
  const local = localTime(iso);
  if (local === null) return iso;
  const words = texts();
  const relative = relativeDay(iso, now);
  const day = `${words.weekdays[local.weekday]} ${local.day} ${words.monthNames[local.month - 1]}`;
  return relative === null ? `${day} ${local.year}` : `${relative} · ${day}`;
}

/** A date alone, as "1 Oct 2026". */
export function formatDate(iso: string): string {
  const local = localTime(iso);
  if (local === null) return iso;
  return shortDate(local);
}

/** The time of an instant in Italian time, to the minute: "14:44". */
export function formatClock(iso: string): string {
  return localTime(iso)?.time.slice(0, 5) ?? iso;
}

const NUMBERS: Record<Language, Intl.NumberFormat> = {
  en: new Intl.NumberFormat(EN.numberLocale, { useGrouping: "always" }),
  it: new Intl.NumberFormat(IT.numberLocale, { useGrouping: "always" }),
};

/** A count as the reader's language writes it: "10,000", or "10.000" in Italian. */
export function formatCount(value: number): string {
  return NUMBERS[currentLanguage()].format(value);
}

/** The one word for an outcome, as the receipt sentences already use it. */
export function outcomeWord(outcome: Receipt["outcome"]): string {
  return texts().outcomeWords[outcome];
}

export function actionKindLabel(kind: Receipt["action"]["kind"]): string {
  return texts().kindLabels[kind];
}
