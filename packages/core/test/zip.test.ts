import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createZip, crc32, readZip, ZipError, type ZipEntry } from "@sigillo/core";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const sample: ZipEntry[] = [
  { name: "manifest.json", data: text('{"system_id":"acme-support-bot"}') },
  { name: "receipts.jsonl", data: text(`${'{"seq":0}\n'.repeat(400)}`) },
  { name: "timestamps/1.tsr", data: new Uint8Array([0x30, 0x82, 0x12, 0x15, 0x00, 0xff]) },
  { name: "VERIFY.md", data: text("# How to verify\n\nRun sigillo-verify.\n") },
];

describe("crc32", () => {
  it("matches the values every zip implementation agrees on", () => {
    // The check values from the CRC-32 specification.
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(text("123456789"))).toBe(0xcbf43926);
    expect(crc32(text("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

describe("writing and reading an archive", () => {
  it("round-trips every entry, bytes intact", () => {
    const entries = readZip(createZip(sample));
    expect(entries.map((entry) => entry.name)).toEqual(sample.map((entry) => entry.name));
    for (const [index, entry] of entries.entries()) {
      expect(entry.data).toEqual(sample[index]?.data);
    }
  });

  it("produces the same bytes for the same input", () => {
    expect(createZip(sample)).toEqual(createZip(sample));
  });

  it("compresses what compresses and stores what does not", () => {
    const repetitive = { name: "a.jsonl", data: text("x".repeat(10_000)) };
    const incompressible = { name: "b.bin", data: new Uint8Array([0x30, 0x01]) };
    const archive = createZip([repetitive, incompressible]);
    expect(archive.length).toBeLessThan(repetitive.data.length);
    expect(readZip(archive)[0]?.data).toEqual(repetitive.data);
    expect(readZip(archive)[1]?.data).toEqual(incompressible.data);
  });

  it("handles an empty archive and empty files", () => {
    expect(readZip(createZip([]))).toEqual([]);
    const withEmpty = readZip(createZip([{ name: "empty.txt", data: new Uint8Array(0) }]));
    expect(withEmpty[0]?.data).toHaveLength(0);
  });

  it("keeps non-ASCII names and contents", () => {
    const entries = readZip(
      createZip([{ name: "fascicolo/relazione.txt", data: text("caffè ☕ 検索") }]),
    );
    expect(entries[0]?.name).toBe("fascicolo/relazione.txt");
    expect(decode(entries[0]?.data ?? new Uint8Array())).toBe("caffè ☕ 検索");
  });

  it("refuses entry names that would escape the archive", () => {
    expect(() => createZip([{ name: "", data: text("x") }])).toThrow(ZipError);
    expect(() => createZip([{ name: "/etc/passwd", data: text("x") }])).toThrow(ZipError);
    expect(() => createZip([{ name: "../outside", data: text("x") }])).toThrow(ZipError);
  });

  it("refuses two entries with the same name", () => {
    expect(() =>
      createZip([
        { name: "a.txt", data: text("one") },
        { name: "a.txt", data: text("two") },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe("refusing a damaged archive", () => {
  it("rejects something that is not an archive at all", () => {
    expect(() => readZip(new Uint8Array(0))).toThrow(ZipError);
    expect(() => readZip(text("not a zip"))).toThrow(ZipError);
    expect(() => readZip(new Uint8Array(200))).toThrow(ZipError);
  });

  it("rejects an archive whose contents were altered after it was written", () => {
    const archive = createZip([{ name: "receipts.jsonl", data: text('{"seq":0,"outcome":"ok"}') }]);
    // The entry is short, so it is stored, and the payload sits in the clear.
    const text_ = Buffer.from(archive).toString("latin1");
    const position = text_.indexOf('"ok"');
    expect(position).toBeGreaterThan(0);

    const tampered = Uint8Array.from(archive);
    tampered[position + 1] = "n".charCodeAt(0);
    expect(() => readZip(tampered)).toThrow(/CRC/);
  });

  it("rejects a truncated archive", () => {
    const archive = createZip(sample);
    expect(() => readZip(archive.slice(0, archive.length - 10))).toThrow(ZipError);
  });
});

describe("what other tools see", () => {
  it("is an archive the system unzip reads", () => {
    const directory = mkdtempSync(join(tmpdir(), "sigillo-zip-"));
    try {
      const path = join(directory, "fascicolo.zip");
      writeFileSync(path, createZip(sample));

      let listing: string;
      try {
        listing = execFileSync("unzip", ["-l", path], { encoding: "utf8" });
      } catch {
        // No unzip on this machine: the round-trip tests above still hold.
        return;
      }

      for (const entry of sample) {
        expect(listing).toContain(entry.name);
      }

      execFileSync("unzip", ["-q", "-o", path, "-d", directory]);
      expect(readFileSync(join(directory, "VERIFY.md"), "utf8")).toBe(
        decode(sample[3]?.data ?? new Uint8Array()),
      );
      expect(readFileSync(join(directory, "manifest.json"), "utf8")).toBe(
        decode(sample[0]?.data ?? new Uint8Array()),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
