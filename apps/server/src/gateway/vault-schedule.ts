/**
 * The hours in which an account's key vault is kept sealed. The customer sets
 * weekly windows in their own time zone ("every night from 22:00 to 06:00",
 * "all weekend"); while one is running the vault is closed and cannot be
 * opened, so no model key passes through the server in those hours.
 *
 * Closing needs no secret, so it can happen on its own. Opening is the other
 * way round: it needs the passphrase, which the server never keeps, so the
 * end of a window opens nothing. The customer (or their own agent, with the
 * passphrase) unlocks the vault after it.
 */

export interface SealedWindow {
  /** 0 = Sunday … 6 = Saturday: the day the window starts. */
  days: number[];
  /** "HH:MM", 24-hour, local time. */
  from: string;
  /** "HH:MM". At or before `from`, the window runs past midnight into the next day. */
  to: string;
}

export interface VaultSchedule {
  timezone: string;
  windows: SealedWindow[];
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

const MAX_WINDOWS = 20;
const MINUTES_IN_WEEK = 7 * 24 * 60;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function isTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** The schedule if it is well formed, otherwise a ScheduleError that says what is wrong. */
export function checkSchedule(input: unknown): VaultSchedule {
  const raw = input as { timezone?: unknown; windows?: unknown } | null;
  if (typeof raw !== "object" || raw === null || typeof raw.timezone !== "string" || !isTimezone(raw.timezone)) {
    throw new ScheduleError("the time zone is not one we know (for example Europe/Rome)");
  }
  if (!Array.isArray(raw.windows) || raw.windows.length > MAX_WINDOWS) {
    throw new ScheduleError(`at most ${MAX_WINDOWS} windows`);
  }
  const windows = raw.windows.map((item: unknown): SealedWindow => {
    const w = item as { days?: unknown; from?: unknown; to?: unknown } | null;
    if (typeof w !== "object" || w === null) throw new ScheduleError("a window is malformed");
    const days = w.days;
    if (!Array.isArray(days) || days.length === 0 || !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
      throw new ScheduleError("a window needs at least one day");
    }
    if (typeof w.from !== "string" || typeof w.to !== "string" || !TIME.test(w.from) || !TIME.test(w.to)) {
      throw new ScheduleError("times are written HH:MM, 24-hour");
    }
    if (w.from === w.to) throw new ScheduleError("a window cannot start and end at the same time");
    return { days: [...new Set(days as number[])].sort((a, b) => a - b), from: w.from, to: w.to };
  });
  return { timezone: raw.timezone, windows };
}

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const;

/** Minutes since Sunday 00:00 in `timezone`. */
function minuteOfWeek(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  return WEEKDAY[get("weekday") as keyof typeof WEEKDAY] * 1440 + Number(get("hour")) * 60 + Number(get("minute"));
}

/** Whether `at` falls inside one of the windows. */
export function isSealedAt(schedule: VaultSchedule, at: Date): boolean {
  if (schedule.windows.length === 0) return false;
  const now = minuteOfWeek(at, schedule.timezone);
  for (const window of schedule.windows) {
    const length = (minutesOf(window.to) - minutesOf(window.from) + 1440) % 1440;
    for (const day of window.days) {
      const start = day * 1440 + minutesOf(window.from);
      if ((now - start + MINUTES_IN_WEEK) % MINUTES_IN_WEEK < length) return true;
    }
  }
  return false;
}
