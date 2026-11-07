import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time codes (RFC 6238, HMAC-SHA1, 30-second steps), the six
 * digits an authenticator app shows: the administrator's optional second
 * factor (ui.ts). node:crypto only. Time is passed in.
 */

const STEP_MS = 30_000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The code for one 30-second step (RFC 4226's HOTP over the step number). */
export function totpCode(secret: Buffer, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const value = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(value).padStart(digits, "0");
}

/**
 * The step a code belongs to, if it is this step's or the one either side
 * (a phone clock a little off), and later than `lastStep`, the step of the
 * last code accepted: a code is good once. Null otherwise.
 */
export function verifyTotp(secret: Buffer, given: string, nowMs: number, lastStep: number): number | null {
  const code = given.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(nowMs / STEP_MS);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  if (clean.length === 0 || /[^A-Z2-7]/.test(clean)) throw new Error("not a base32 secret");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
