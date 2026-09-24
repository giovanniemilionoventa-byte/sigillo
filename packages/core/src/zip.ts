import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A minimal ZIP reader and writer, so that an export archive needs no
 * dependency to produce and none to open.
 *
 * Only what an export uses: stored and deflated entries, no encryption, no
 * ZIP64, no directory entries. An archive this writes opens in any unzip
 * program, and this reader refuses anything it does not fully understand
 * rather than guessing.
 *
 * This module does no I/O: it turns bytes into bytes. Callers read and write
 * the files.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_NEEDED = 20;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
/** ZIP64 is out of scope, so an entry or an archive must fit in 32 bits. */
const MAX_SIZE = 0xffffffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds an archive. Entry order is preserved, so the same files always produce
 * the same bytes: an export can be regenerated and compared.
 */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const names = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (entry.name.length === 0 || entry.name.startsWith("/") || entry.name.includes("..")) {
      throw new ZipError(`unusable entry name ${JSON.stringify(entry.name)}`);
    }
    if (names.has(entry.name)) {
      throw new ZipError(`duplicate entry ${entry.name}`);
    }
    names.add(entry.name);

    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Only compress when it actually helps; already-compressed files grow.
    const compressed = deflated.length < raw.length ? deflated : raw;
    const method = compressed === deflated ? METHOD_DEFLATED : METHOD_STORED;

    if (raw.length > MAX_SIZE || compressed.length > MAX_SIZE) {
      throw new ZipError(`${entry.name} is too large for a non-ZIP64 archive`);
    }

    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(0, 6); // flags: no encryption, no data descriptor
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // modification time, left at zero for reproducibility
    local.writeUInt16LE(0, 12); // modification date, likewise
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4); // version made by
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no archive comment

  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

function findEndOfCentralDirectory(archive: Buffer): number {
  // No archive comment is written, so the record is last; scan back anyway for
  // archives produced elsewhere.
  const earliest = Math.max(0, archive.length - 22 - 0xffff);
  for (let index = archive.length - 22; index >= earliest; index -= 1) {
    if (archive.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) {
      return index;
    }
  }
  throw new ZipError("not a zip archive: no end of central directory record");
}

export interface ReadZipOptions {
  /** The largest entry to inflate. Default: 512 MiB. */
  maxEntryBytes?: number;
  /** The most, all entries together, to inflate. Default: 1 GiB. */
  maxTotalBytes?: number;
}

const FLAG_ENCRYPTED = 0x0001;

/**
 * Reads an archive someone else may have built. Besides damage, it refuses
 * what could make one archive read differently to different people or run a
 * reader out of memory: two entries with one name, a local header naming a
 * different file than the directory, encryption, and entries (or a total)
 * beyond the limits. Nothing is inflated past the size the directory declares.
 */
export function readZip(bytes: Uint8Array, options: ReadZipOptions = {}): ZipEntry[] {
  const maxEntryBytes = options.maxEntryBytes ?? 512 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;
  const archive = Buffer.from(bytes);
  if (archive.length < 22) {
    throw new ZipError("not a zip archive: too short");
  }

  const end = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(end + 10);
  let cursor = archive.readUInt32LE(end + 16);

  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== CENTRAL_HEADER) {
      throw new ZipError(`central directory entry ${index} is malformed`);
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const checksum = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString("utf8");

    if (names.has(name)) {
      throw new ZipError(`${name} appears twice in the archive`);
    }
    names.add(name);
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipError(`${name} is encrypted, which an export never is`);
    }
    total += uncompressedSize;
    if (uncompressedSize > maxEntryBytes || total > maxTotalBytes) {
      throw new ZipError(
        `${name} would take the archive past the limit of ${maxEntryBytes} bytes an entry, ${maxTotalBytes} in all`,
      );
    }

    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw new ZipError(`${name} has no local header where the directory says it does`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (!localName.equals(nameBytes)) {
      throw new ZipError(`${name} is called ${localName.toString("utf8")} in its local header`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) {
      throw new ZipError(`${name} is truncated`);
    }

    let data: Buffer;
    if (method === METHOD_STORED) {
      data = Buffer.from(compressed);
    } else if (method === METHOD_DEFLATED) {
      try {
        // One byte more than declared is enough to know it lies, and it is
        // where inflating stops.
        data = inflateRawSync(compressed, { maxOutputLength: uncompressedSize + 1 });
      } catch (error) {
        throw new ZipError(
          `${name} does not decompress: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      throw new ZipError(`${name} uses compression method ${method}, which is not supported`);
    }

    if (data.length !== uncompressedSize) {
      throw new ZipError(
        `${name} is ${data.length > uncompressedSize ? "larger than" : `${data.length} bytes, not`} the ${uncompressedSize} bytes the directory declares`,
      );
    }
    if (crc32(data) !== checksum) {
      throw new ZipError(`${name} fails its CRC check: the archive is damaged or altered`);
    }

    entries.push({ name, data: new Uint8Array(data) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
