import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateSealingKey, ProviderKeyStore, VaultSealedError } from "../src/gateway/provider-keys.js";
import { checkSchedule, isSealedAt, ScheduleError } from "../src/gateway/vault-schedule.js";

/**
 * The sealed hours of a vault: the server closes it on a schedule by itself,
 * and never opens it by itself. Real scrypt and AES-GCM, never mocked.
 */

const PASSPHRASE = "correct horse battery staple";
const NIGHTS = { timezone: "Europe/Rome", windows: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "22:00", to: "06:00" }] };
// 2026-10-22 is a Thursday; Rome is UTC+2 that day (summer time ends on 2026-10-25).
const at = (iso: string): Date => new Date(iso);

describe("sealed windows", () => {
  it("runs past midnight and uses the customer's time zone", () => {
    const schedule = checkSchedule(NIGHTS);
    expect(isSealedAt(schedule, at("2026-10-22T19:59:00Z"))).toBe(false); // 21:59 in Rome
    expect(isSealedAt(schedule, at("2026-10-22T20:00:00Z"))).toBe(true); // 22:00
    expect(isSealedAt(schedule, at("2026-10-23T03:59:00Z"))).toBe(true); // 05:59
    expect(isSealedAt(schedule, at("2026-10-23T04:00:00Z"))).toBe(false); // 06:00
  });

  it("belongs to the day it starts: Friday night reaches into Saturday morning only", () => {
    const schedule = checkSchedule({ timezone: "UTC", windows: [{ days: [5], from: "22:00", to: "06:00" }] });
    expect(isSealedAt(schedule, at("2026-10-23T23:00:00Z"))).toBe(true); // Friday 23:00
    expect(isSealedAt(schedule, at("2026-10-24T05:00:00Z"))).toBe(true); // Saturday 05:00
    expect(isSealedAt(schedule, at("2026-10-24T23:00:00Z"))).toBe(false); // Saturday 23:00
    expect(isSealedAt(schedule, at("2026-10-22T23:00:00Z"))).toBe(false); // Thursday 23:00
  });

  it("follows daylight saving, since the zone is named and not an offset", () => {
    const schedule = checkSchedule(NIGHTS);
    expect(isSealedAt(schedule, at("2026-10-26T20:30:00Z"))).toBe(false); // 21:30 CET, after the clocks went back
    expect(isSealedAt(schedule, at("2026-10-26T21:00:00Z"))).toBe(true); // 22:00 CET
  });

  it("refuses what is malformed", () => {
    const bad = (w: unknown, tz = "UTC") => () => checkSchedule({ timezone: tz, windows: [w] });
    expect(bad({ days: [], from: "22:00", to: "06:00" })).toThrow(ScheduleError);
    expect(bad({ days: [7], from: "22:00", to: "06:00" })).toThrow(ScheduleError);
    expect(bad({ days: [1], from: "25:00", to: "06:00" })).toThrow(ScheduleError);
    expect(bad({ days: [1], from: "08:00", to: "08:00" })).toThrow(ScheduleError);
    expect(bad({ days: [1], from: "22:00", to: "06:00" }, "Mars/Olympus")).toThrow(ScheduleError);
  });
});

describe("a vault with sealed hours", () => {
  let directory: string;
  let keys: ProviderKeyStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-vault-schedule-"));
    keys = ProviderKeyStore.open(join(directory, "sigillo.db"), loadOrCreateSealingKey(join(directory, "llm-gateway.key")), () => "acme");
  });
  afterEach(() => {
    keys.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const DAY = at("2026-10-22T12:00:00Z"); // 14:00 in Rome
  const NIGHT = at("2026-10-22T21:00:00Z"); // 23:00 in Rome

  it("closes by itself when a window starts, and the key is refused from then on", () => {
    keys.vaults.create("acme", PASSPHRASE, DAY);
    keys.set("bot", "openai", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", DAY.toISOString(), DAY);
    keys.vaults.setSchedule("acme", NIGHTS, DAY);
    expect(keys.vaults.isUnlocked("acme", DAY)).toBe(true);
    expect(keys.get("bot", "openai", DAY)).not.toBeNull();
    expect(() => keys.get("bot", "openai", NIGHT)).toThrow(VaultSealedError);
    expect(keys.vaults.isUnlocked("acme", NIGHT)).toBe(false);
  });

  it("is swept shut at the start of the window even if no request comes", () => {
    keys.vaults.create("acme", PASSPHRASE, DAY);
    keys.vaults.setSchedule("acme", NIGHTS, DAY);
    expect(keys.vaults.sweep(DAY)).toEqual([]);
    expect(keys.vaults.sweep(NIGHT)).toEqual(["acme"]);
  });

  it("does not open when the window ends: only the passphrase does", () => {
    keys.vaults.create("acme", PASSPHRASE, DAY);
    keys.vaults.setSchedule("acme", NIGHTS, NIGHT); // saving it inside a window shuts the vault now
    const morning = at("2026-10-23T05:00:00Z"); // 07:00 in Rome
    expect(keys.vaults.isUnlocked("acme", morning)).toBe(false);
    expect(keys.vaults.unlock("acme", PASSPHRASE, morning)).toBe(true);
    expect(keys.vaults.isUnlocked("acme", morning)).toBe(true);
  });

  it("cannot be unlocked inside a window, even with the right passphrase", () => {
    keys.vaults.create("acme", PASSPHRASE, DAY);
    keys.vaults.setSchedule("acme", NIGHTS, DAY);
    expect(() => keys.vaults.unlock("acme", PASSPHRASE, NIGHT)).toThrow(VaultSealedError);
    expect(keys.vaults.isUnlocked("acme", NIGHT)).toBe(false);
  });

  it("is cleared by an empty list of windows", () => {
    keys.vaults.create("acme", PASSPHRASE, DAY);
    keys.vaults.setSchedule("acme", NIGHTS, DAY);
    keys.vaults.setSchedule("acme", { timezone: "Europe/Rome", windows: [] }, DAY);
    expect(keys.vaults.unlock("acme", PASSPHRASE, NIGHT)).toBe(true);
  });
});
