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

/** Replaces every occurrence of `from` in the archive's bytes with `to`, of the same length. */
function patch(archive: Uint8Array, from: string, to: string, only?: "first" | "last"): Uint8Array {
  const bytes = Buffer.from(archive);
  const positions: number[] = [];
  for (let at = bytes.indexOf(from); at >= 0; at = bytes.indexOf(from, at + 1)) positions.push(at);
  const chosen = only === "first" ? positions.slice(0, 1) : only === "last" ? positions.slice(-1) : positions;
  for (const at of chosen) bytes.write(to, at, "latin1");
  return new Uint8Array(bytes);
}

// Review point 17: what a reader must refuse in an archive it did not write.
// These archives are built by the writer and then edited byte by byte, the
// way someone handing over a doctored evidence file would.
describe("refusing an archive built to mislead", () => {
  it("refuses two entries with the same name, instead of letting the last one win", () => {
    const archive = createZip([
      { name: "receipts.jsonl", data: text("the real receipts") },
      { name: "receiptz.jsonl", data: text("other receipts") },
    ]);
    const doctored = patch(archive, "receiptz.jsonl", "receipts.jsonl");
    expect(() => readZip(doctored)).toThrow(/twice/);
  });

  it("refuses an entry whose local name differs from the directory's", () => {
    // Unzip tools disagree on which of the two names they show: one archive
    // could then read as different files to different people.
    const archive = createZip([{ name: "receipts.jsonl", data: text("the receipts") }]);
    const doctored = patch(archive, "receipts.jsonl", "receiptz.jsonl", "first");
    expect(() => readZip(doctored)).toThrow(/local header/);
  });

  it("refuses an entry marked as encrypted", () => {
    const archive = createZip([{ name: "a.txt", data: text("x") }]);
    const bytes = Buffer.from(archive);
    // General purpose flag: offset 6 in the local header, 8 in the directory.
    bytes.writeUInt16LE(1, 6);
    bytes.writeUInt16LE(1, bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    expect(() => readZip(new Uint8Array(bytes))).toThrow(/encrypted/);
  });

  it("refuses an entry larger than the limit before inflating it", () => {
    const large = new Uint8Array(5 * 1024 * 1024);
    const archive = createZip([{ name: "receipts.jsonl", data: large }]);
    // Five megabytes of zeros deflate to a few kilobytes: the ratio of a zip bomb.
    expect(archive.length).toBeLessThan(64 * 1024);
    expect(() => readZip(archive, { maxEntryBytes: 1024 * 1024 })).toThrow(/limit/);
    expect(readZip(archive, { maxEntryBytes: 8 * 1024 * 1024 })[0]?.data.length).toBe(large.length);
  });

  it("refuses archives whose entries add up to more than the total limit", () => {
    const archive = createZip([
      { name: "a", data: new Uint8Array(600 * 1024) },
      { name: "b", data: new Uint8Array(600 * 1024) },
    ]);
    expect(() => readZip(archive, { maxEntryBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 })).toThrow(/limit/);
  });

  it("never inflates past the size the directory declares", () => {
    // A directory that understates the size, so that a size check alone would
    // pass it: the inflater itself must stop at the declared size.
    const archive = createZip([{ name: "a", data: new Uint8Array(4 * 1024 * 1024) }]);
    const bytes = Buffer.from(archive);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(10, central + 24);
    bytes.writeUInt32LE(10, 22);
    expect(() => readZip(new Uint8Array(bytes))).toThrow(/declares|larger/);
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
