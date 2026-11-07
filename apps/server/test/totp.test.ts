import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, totpCode, verifyTotp } from "../src/auth/totp.js";

// RFC 6238, appendix B: the SHA-1 secret is the ASCII "12345678901234567890".
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("at %i s gives the RFC's 8-digit code %s", (seconds, code) => {
    expect(totpCode(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(code);
  });

  it("gives the last six digits by default", () => {
    expect(totpCode(RFC_SECRET, Math.floor(59 / 30))).toBe("287082");
  });

  it("accepts the code of this step and of the one either side, once each", () => {
    const now = 1_762_502_400_000;
    const step = Math.floor(now / 30_000);
    const code = totpCode(RFC_SECRET, step);
    expect(verifyTotp(RFC_SECRET, code, now, -1)).toBe(step);
    // Replayed: a step already used, or an earlier one, is refused.
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, -1)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, -1)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now, -1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", now, -1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, " 287 082 ", 59_000, -1)).toBe(1);
  });

  it("reads and writes base32 as authenticator apps do", () => {
    expect(base32Encode(Buffer.from("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toEqual(RFC_SECRET);
    expect(() => base32Decode("not base32!")).toThrow();
  });
});
