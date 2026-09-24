import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { genTimeFrom } from "@sigillo/verifier";
import { genTimeOfToken } from "../src/timestamp/gentime.js";
import { createLocalTsa, type LocalTsa } from "./helpers/local-tsa.js";

/**
 * genTime, read two independent ways from real RFC 3161 tokens: by the
 * server's DER reader, and by the verifier from openssl's own decoding.
 */

let tsa: LocalTsa;
let directory: string;

beforeAll(() => {
  tsa = createLocalTsa();
  directory = mkdtempSync(join(tmpdir(), "sigillo-gentime-"));
}, 60_000);

afterAll(() => {
  tsa.close();
  rmSync(directory, { recursive: true, force: true });
});

function opensslText(token: Buffer): string {
  const path = join(directory, "token.tsr");
  writeFileSync(path, token);
  return execFileSync("openssl", ["ts", "-reply", "-in", path, "-text"], { encoding: "utf8" });
}

describe("the time a token attests", () => {
  it("is read the same by the server's DER reader and through openssl", () => {
    for (let index = 0; index < 3; index += 1) {
      const before = Date.now();
      const token = tsa.stamp(String(index).repeat(64));
      const fromDer = genTimeOfToken(new Uint8Array(token));
      const fromOpenssl = genTimeFrom(opensslText(token));
      expect(fromDer).toBeDefined();
      expect(fromDer).toBe(fromOpenssl);
      // And it is the time it was made, to the second.
      expect(Math.abs(Date.parse(fromDer ?? "") - before)).toBeLessThan(5000);
    }
  }, 30_000);

  it("is read from a bare token too, not only from a whole response", () => {
    const response = tsa.stamp("ab".repeat(32));
    const responsePath = join(directory, "response.tsr");
    const tokenPath = join(directory, "bare.tok");
    writeFileSync(responsePath, response);
    execFileSync("openssl", ["ts", "-reply", "-in", responsePath, "-token_out", "-out", tokenPath], { stdio: "pipe" });
    const bare = readFileSync(tokenPath);
    expect(genTimeOfToken(new Uint8Array(bare))).toBe(genTimeOfToken(new Uint8Array(response)));
  }, 30_000);

  it("is undefined for anything that is not a token, never a guess", () => {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]),
      new Uint8Array([0x30, 0x84, 0xff, 0xff, 0xff, 0xff]),
      new TextEncoder().encode("20260329150005Z"),
    ]) {
      expect(genTimeOfToken(bytes)).toBeUndefined();
    }
    // A real token cut short.
    const token = tsa.stamp("ef".repeat(32));
    expect(genTimeOfToken(new Uint8Array(token.subarray(0, 40)))).toBeUndefined();
  }, 30_000);

  it("parses openssl's line, with or without fractions of a second", () => {
    expect(genTimeFrom("Time stamp: Mar 29 15:00:05 2026 GMT\n")).toBe("2026-03-29T15:00:05.000Z");
    expect(genTimeFrom("Time stamp: Mar  9 15:00:05.25 2026 GMT\n")).toBe("2026-03-09T15:00:05.250Z");
    expect(genTimeFrom("no time here")).toBeUndefined();
  });
});
