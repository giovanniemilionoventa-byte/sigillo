import { describe, expect, it } from "vitest";
import { genTimeOfToken } from "@sigillo/core";

/**
 * The DER reader on its own, over tokens assembled byte by byte here, so that
 * every shape it must accept or refuse can be named. Real tokens, signed by a
 * real authority and decoded by openssl as well, are in
 * apps/server/test/gentime.test.ts.
 */

function length(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, n >> 8, n & 0xff];
}
function tlv(tag: number, ...body: Uint8Array[]): Uint8Array {
  const content = Buffer.concat(body);
  return new Uint8Array(Buffer.concat([Buffer.from([tag, ...length(content.length)]), content]));
}
const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

// 1.2.840.113549.1.7.2 (signedData) and 1.2.840.113549.1.9.16.1.4 (TSTInfo).
const SIGNED_DATA = tlv(0x06, bytes(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02));
const TST_INFO = tlv(0x06, bytes(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04));

function tstInfo(genTime: Uint8Array): Uint8Array {
  return tlv(
    0x30,
    tlv(0x02, bytes(1)), // version
    tlv(0x06, bytes(0x2a, 0x03, 0x04, 0x01)), // policy
    tlv(0x30, tlv(0x30, tlv(0x06, bytes(0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01))), tlv(0x04, new Uint8Array(32))),
    tlv(0x02, bytes(7)), // serialNumber
    genTime,
  );
}

/** A bare token (ContentInfo), and the same token inside a TimeStampResp. */
function token(info: Uint8Array): { bare: Uint8Array; response: Uint8Array } {
  const signedData = tlv(
    0x30,
    tlv(0x02, bytes(3)),
    tlv(0x31),
    tlv(0x30, TST_INFO, tlv(0xa0, tlv(0x04, info))),
    tlv(0x31),
  );
  const bare = tlv(0x30, SIGNED_DATA, tlv(0xa0, signedData));
  return { bare, response: tlv(0x30, tlv(0x30, tlv(0x02, bytes(0))), bare) };
}

describe("genTime, read from a token's DER", () => {
  it("reads it from a whole response and from a bare token alike", () => {
    const { bare, response } = token(tstInfo(tlv(0x18, ascii("20260329150005Z"))));
    expect(genTimeOfToken(response)).toBe("2026-03-29T15:00:05.000Z");
    expect(genTimeOfToken(bare)).toBe("2026-03-29T15:00:05.000Z");
  });

  it("keeps fractions of a second, to the millisecond", () => {
    expect(genTimeOfToken(token(tstInfo(tlv(0x18, ascii("20260329150005.25Z")))).response)).toBe(
      "2026-03-29T15:00:05.250Z",
    );
    expect(genTimeOfToken(token(tstInfo(tlv(0x18, ascii("20260329150005.1239Z")))).response)).toBe(
      "2026-03-29T15:00:05.123Z",
    );
  });

  it("reads a token long enough to need two length octets", () => {
    const padded = tlv(
      0x30,
      tlv(0x02, bytes(1)),
      tlv(0x06, bytes(0x2a, 0x03, 0x04, 0x01)),
      tlv(0x30, tlv(0x30, tlv(0x06, bytes(0x60))), tlv(0x04, new Uint8Array(300))),
      tlv(0x02, bytes(7)),
      tlv(0x18, ascii("20261001080000Z")),
    );
    expect(genTimeOfToken(token(padded).response)).toBe("2026-10-01T08:00:00.000Z");
  });

  it("gives undefined, never a guess, for anything that is not a token", () => {
    for (const candidate of [
      new Uint8Array(0),
      bytes(0x30, 0x03, 0x02, 0x01, 0x00),
      bytes(0x30, 0x84, 0xff, 0xff, 0xff, 0xff),
      ascii("20260329150005Z"),
      // genTime as UTCTime, or not in UTC, or not a date at all.
      token(tstInfo(tlv(0x17, ascii("260329150005Z")))).response,
      token(tstInfo(tlv(0x18, ascii("20260329150005+0100")))).response,
      token(tstInfo(tlv(0x18, ascii("2026032915000Z")))).response,
      token(tstInfo(tlv(0x18, ascii("20261329150005Z")))).response,
      token(tstInfo(tlv(0x18, ascii("20260230150005Z")))).response,
    ]) {
      expect(genTimeOfToken(candidate)).toBeUndefined();
    }
    // A token cut short anywhere.
    const { response } = token(tstInfo(tlv(0x18, ascii("20260329150005Z"))));
    for (let end = 0; end < response.length; end += 1) {
      expect(genTimeOfToken(response.subarray(0, end))).toBeUndefined();
    }
  });

  it("does not read a token with bytes trailing after it", () => {
    const { response } = token(tstInfo(tlv(0x18, ascii("20260329150005Z"))));
    expect(genTimeOfToken(new Uint8Array([...response, 0x00]))).toBeUndefined();
  });
});
