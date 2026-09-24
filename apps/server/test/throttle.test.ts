import { describe, expect, it } from "vitest";
import { AttemptThrottle, parseThrottleSettings } from "../src/auth/throttle.js";

const MINUTE = 60_000;

function throttle(): AttemptThrottle {
  return new AttemptThrottle({
    maxFailures: 3,
    windowMs: 10 * MINUTE,
    lockoutMs: 5 * MINUTE,
    maxLockoutMs: 20 * MINUTE,
  });
}

describe("an attempt throttle", () => {
  it("locks a client out on its Nth failure inside the window, and not before", () => {
    const limiter = throttle();
    const t0 = 1_000_000;
    limiter.recordFailure("a", t0);
    limiter.recordFailure("a", t0 + 1);
    expect(limiter.isLocked("a", t0 + 2)).toBe(false);
    limiter.recordFailure("a", t0 + 2);
    expect(limiter.isLocked("a", t0 + 3)).toBe(true);
  });

  it("does not count failures that fell out of the window", () => {
    const limiter = throttle();
    const t0 = 1_000_000;
    limiter.recordFailure("a", t0);
    limiter.recordFailure("a", t0 + 1);
    limiter.recordFailure("a", t0 + 10 * MINUTE + 2);
    expect(limiter.isLocked("a", t0 + 10 * MINUTE + 3)).toBe(false);
  });

  it("keeps clients apart", () => {
    const limiter = throttle();
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("a", 1000 + i);
    expect(limiter.isLocked("a", 2000)).toBe(true);
    expect(limiter.isLocked("b", 2000)).toBe(false);
  });

  it("unlocks when the lockout has run its course", () => {
    const limiter = throttle();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("a", t0);
    expect(limiter.isLocked("a", t0 + 5 * MINUTE - 1)).toBe(true);
    expect(limiter.isLocked("a", t0 + 5 * MINUTE)).toBe(false);
  });

  it("doubles the lockout each time it has to lock the same client again, up to the cap", () => {
    const limiter = throttle();
    let t = 1_000_000;
    const lockouts: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      for (let i = 0; i < 3; i += 1) limiter.recordFailure("a", t);
      const start = t;
      while (limiter.isLocked("a", t)) t += 1000;
      lockouts.push(t - start);
    }
    expect(lockouts).toEqual([5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 20 * MINUTE, 20 * MINUTE]);
  });

  it("forgets a client after a success", () => {
    const limiter = throttle();
    let t = 1_000_000;
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("a", t);
    t += 5 * MINUTE;
    limiter.recordSuccess("a");
    // A fresh start: three more failures give the first lockout again, not a doubled one.
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("a", t);
    expect(limiter.isLocked("a", t + 5 * MINUTE - 1)).toBe(true);
    expect(limiter.isLocked("a", t + 5 * MINUTE)).toBe(false);
  });

  it("does not let failures made while locked extend the lockout", () => {
    const limiter = throttle();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i += 1) limiter.recordFailure("a", t0);
    for (let i = 0; i < 50; i += 1) limiter.recordFailure("a", t0 + i);
    expect(limiter.isLocked("a", t0 + 5 * MINUTE)).toBe(false);
  });

  it("holds a bounded number of clients in memory", () => {
    const limiter = new AttemptThrottle({
      maxFailures: 3,
      windowMs: MINUTE,
      lockoutMs: MINUTE,
      maxLockoutMs: MINUTE,
      maxEntries: 100,
    });
    for (let i = 0; i < 1000; i += 1) limiter.recordFailure(`client-${i}`, 1000);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});

describe("reading the settings from the environment", () => {
  it("uses the defaults when nothing is set", () => {
    expect(parseThrottleSettings({})).toEqual({
      maxFailures: 5,
      windowMs: 15 * MINUTE,
      lockoutMs: 5 * MINUTE,
      maxLockoutMs: 60 * MINUTE,
    });
  });

  it("takes each value from its variable", () => {
    expect(
      parseThrottleSettings({
        SIGILLO_LOGIN_MAX_FAILURES: "10",
        SIGILLO_LOGIN_WINDOW_MINUTES: "30",
        SIGILLO_LOGIN_LOCKOUT_MINUTES: "2",
        SIGILLO_LOGIN_LOCKOUT_MAX_MINUTES: "120",
      }),
    ).toEqual({ maxFailures: 10, windowMs: 30 * MINUTE, lockoutMs: 2 * MINUTE, maxLockoutMs: 120 * MINUTE });
  });

  it("refuses values that are not positive whole numbers, naming the variable", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "", " 5", "1e3"]) {
      expect(() => parseThrottleSettings({ SIGILLO_LOGIN_MAX_FAILURES: bad }), bad).toThrow(
        /SIGILLO_LOGIN_MAX_FAILURES/,
      );
    }
  });

  it("refuses a cap shorter than the first lockout", () => {
    expect(() =>
      parseThrottleSettings({ SIGILLO_LOGIN_LOCKOUT_MINUTES: "30", SIGILLO_LOGIN_LOCKOUT_MAX_MINUTES: "10" }),
    ).toThrow(/SIGILLO_LOGIN_LOCKOUT_MAX_MINUTES/);
  });
});
