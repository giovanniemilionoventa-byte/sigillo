/**
 * The check the public "Verify" page (site.ts) runs on an evidence pack, in
 * the reader's browser, so that the pack itself is never sent anywhere.
 *
 * It is a second implementation of `sigillo-verify` (packages/verifier), in
 * plain browser JavaScript with Web Crypto, because the browser cannot run
 * node:crypto. It applies the same checks in the same order and names a
 * failure with the same check name, and evidence-check.test.ts holds it to
 * that: real archives, doctored one way after another, must get the same
 * verdict from both. It leaves out what only the command-line verifier can
 * do, and the page says so: the receipt schema in full (here only the members
 * the checks read), the RFC 3161 tokens and the times they prove (openssl),
 * and the inputs an archive cannot carry (--key-id, --previous).
 *
 * It is source text, served as part of /verify.js, and evaluated as it is by
 * the tests: one function, sigilloCheckPack(bytes), with everything it uses
 * inside it, so that what the browser runs is exactly what was tested.
 */
export const EVIDENCE_CHECK_SOURCE = String.raw`async function sigilloCheckPack(bytes) {
  "use strict";
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const HEX64 = /^[0-9a-f]{64}$/;
  const HEX16 = /^[0-9a-f]{16}$/;
  const GENESIS_PREV_HASH = "0".repeat(64);

  class Failure {
    constructor(check, location, detail) {
      this.check = check;
      this.location = location;
      this.detail = detail;
    }
  }
  const fail = (check, location, detail) => {
    throw new Failure(check, location, detail);
  };
  const at = (line) => "receipts.jsonl:" + line;
  const atCheckpoint = (line) => "checkpoints.jsonl:" + line;
  const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
  const jsonLines = (text) => text.split("\n").filter((line) => line.trim().length > 0);

  // --- bytes ---------------------------------------------------------------

  const toHex = (data) => Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
  const fromHex = (hex) => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    return out;
  };
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };
  const sha256 = async (data) => new Uint8Array(await subtle.digest("SHA-256", data));

  // Standard base64 with padding, and only its canonical spelling (FORMAT.md,
  // section 5): decoding and encoding again must give the same characters.
  const fromBase64 = (text) => {
    if (typeof text !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
    let binary;
    try {
      binary = atob(text);
    } catch (error) {
      return null;
    }
    const out = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return btoa(binary) === text ? out : null;
  };

  // --- the zip archive (stored and deflated entries, no ZIP64) --------------

  const inflate = async (data) => {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (data) => {
    let c = 0xffffffff;
    for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const readZip = async (archive) => {
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
    let end = -1;
    for (let i = archive.length - 22; i >= Math.max(0, archive.length - 22 - 65535); i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) fail("archive", "the file", "is not a zip archive");
    const count = view.getUint16(end + 10, true);
    let cursor = view.getUint32(end + 16, true);
    const files = new Map();
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > archive.length || view.getUint32(cursor, true) !== 0x02014b50) {
        fail("archive", "the file", "its directory is damaged");
      }
      const method = view.getUint16(cursor + 10, true);
      const checksum = view.getUint32(cursor + 16, true);
      const compressedSize = view.getUint32(cursor + 20, true);
      const size = view.getUint32(cursor + 24, true);
      const nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true);
      const commentLength = view.getUint16(cursor + 32, true);
      const local = view.getUint32(cursor + 42, true);
      let name;
      try {
        name = utf8.decode(archive.subarray(cursor + 46, cursor + 46 + nameLength));
      } catch (error) {
        fail("archive", "the file", "an entry's name is not UTF-8");
      }
      if (files.has(name)) fail("archive", name, "appears twice in the archive");
      if (local + 30 > archive.length || view.getUint32(local, true) !== 0x04034b50) fail("archive", name, "has no local header");
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = archive.subarray(start, start + compressedSize);
      if (raw.length !== compressedSize) fail("archive", name, "is truncated");
      let data;
      if (method === 0) data = raw;
      else if (method === 8) {
        try {
          data = await inflate(raw);
        } catch (error) {
          fail("archive", name, "does not decompress");
        }
      } else fail("archive", name, "uses compression method " + method + ", which an export never does");
      if (data.length !== size || crc32(data) !== checksum) fail("archive", name, "fails its CRC check: the archive is damaged or altered");
      files.set(name, data);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return files;
  };

  // --- the canonical form (RFC 8785) and the hashes -------------------------

  // For the values a receipt holds, RFC 8785 is: members sorted by name in
  // UTF-16 code units (what Array.prototype.sort does), no whitespace, and
  // strings and numbers exactly as JSON.stringify writes them.
  const canonical = (value) => {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (isObject(value)) {
      return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
    }
    if (typeof value === "number" && !Number.isFinite(value)) fail("receipt-schema", "", "a number that JSON cannot hold");
    return JSON.stringify(value);
  };
  const signedHash = async (value) => {
    const unsigned = Object.assign({}, value);
    delete unsigned.sig;
    return sha256(new TextEncoder().encode(canonical(unsigned)));
  };

  const keys = new Map();
  const verifySignature = async (keyId, sig, hash) => {
    const signature = fromBase64(sig);
    if (signature === null || signature.length !== 64) return false;
    return subtle.verify("Ed25519", keys.get(keyId), signature, hash);
  };

  // --- the Merkle tree (RFC 6962, FORMAT.md section 8) ----------------------

  const leafHash = (entry) => sha256(concat(new Uint8Array([0]), entry));
  const nodeHash = (left, right) => sha256(concat(new Uint8Array([1]), left, right));
  const splitPoint = (n) => {
    let k = 1;
    while (k * 2 < n) k *= 2;
    return k;
  };
  const merkleRoot = async (entries) => {
    if (entries.length === 0) return sha256(new Uint8Array(0));
    if (entries.length === 1) return leafHash(entries[0]);
    const k = splitPoint(entries.length);
    return nodeHash(await merkleRoot(entries.slice(0, k)), await merkleRoot(entries.slice(k)));
  };
  const auditPathLength = (index, size) => {
    if (size <= 1) return 0;
    const k = splitPoint(size);
    return 1 + (index < k ? auditPathLength(index, k) : auditPathLength(index - k, size - k));
  };
  const rootFromProof = async (entry, index, size, path) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= size) throw new Error("entry " + index + " is not in a tree of " + size);
    const expected = auditPathLength(index, size);
    if (path.length !== expected) throw new Error("an audit path for entry " + index + " of " + size + " has " + expected + " steps, received " + path.length);
    let node = await leafHash(entry);
    let fn = index;
    let sn = size - 1;
    for (const step of path) {
      if (typeof step !== "string" || !HEX64.test(step)) throw new Error("a step is not a 64-character hash");
      const sibling = fromHex(step);
      if (fn === sn || fn % 2 === 1) {
        node = await nodeHash(sibling, node);
        while (fn !== 0 && fn % 2 === 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      } else node = await nodeHash(node, sibling);
      fn = Math.floor(fn / 2);
      sn = Math.floor(sn / 2);
    }
    return node;
  };

  // --- the checks, in the order of FORMAT.md section 10.5 -------------------

  const check = async (files) => {
    const textOf = (name) => {
      const data = files.get(name);
      if (data === undefined) return undefined;
      try {
        return utf8.decode(data);
      } catch (error) {
        fail(name === "manifest.json" ? "manifest" : "archive", name, "is not UTF-8 text");
      }
    };
    const manifestJson = textOf("manifest.json");
    const receiptsJsonl = textOf("receipts.jsonl");
    if (manifestJson === undefined || receiptsJsonl === undefined) {
      fail("archive", "the file", "holds no manifest.json and receipts.jsonl: it is not a Sigillo evidence pack");
    }

    // 1. The manifest, and the keys everything else is checked against.
    let manifest;
    try {
      manifest = JSON.parse(manifestJson);
    } catch (error) {
      fail("manifest", "manifest.json", "is not valid JSON");
    }
    const range = isObject(manifest) ? manifest.range : undefined;
    const counts = isObject(manifest) ? manifest.counts : undefined;
    if (
      !isObject(manifest) || typeof manifest.system_id !== "string" || !isCount(manifest.receipt_version) ||
      !isObject(range) || !isCount(range.from_seq) || !isCount(range.to_seq) ||
      typeof range.from_ts !== "string" || typeof range.to_ts !== "string" ||
      !isObject(counts) || !isCount(counts.receipts) || !isCount(counts.checkpoints) || !isCount(counts.timestamps) ||
      !Array.isArray(manifest.keys) || manifest.keys.length === 0 ||
      !manifest.keys.every((key) => isObject(key) && typeof key.key_id === "string" && HEX16.test(key.key_id) && typeof key.public_key_base64 === "string")
    ) {
      fail("manifest", "manifest.json", "is not a manifest this check understands");
    }
    for (const entry of manifest.keys) {
      const raw = fromBase64(entry.public_key_base64);
      if (raw === null) fail("manifest", "manifest.json", "key " + entry.key_id + " is not canonical base64");
      if (raw.length !== 32) fail("key", "manifest.json", "key " + entry.key_id + " is not a 32-byte public key");
      const derived = toHex(await sha256(raw)).slice(0, 16);
      if (derived !== entry.key_id) {
        fail("key", "manifest.json", "the manifest publishes a key under key_id " + entry.key_id + ", but that key's identifier is " + derived);
      }
      keys.set(entry.key_id, await subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]));
    }

    // 2. Every line is a receipt, with the members these checks read.
    const lines = jsonLines(receiptsJsonl);
    if (lines.length === 0) fail("range", "receipts.jsonl", "the export contains no receipts");
    const receipts = lines.map((line, index) => {
      let receipt;
      try {
        receipt = JSON.parse(line);
      } catch (error) {
        fail("receipt-json", at(index + 1), "is not valid JSON");
      }
      if (
        !isObject(receipt) || !Number.isSafeInteger(receipt.v) || receipt.v < 1 || receipt.v > 4 ||
        typeof receipt.system_id !== "string" || !isCount(receipt.seq) ||
        typeof receipt.prev_hash !== "string" || !HEX64.test(receipt.prev_hash) ||
        typeof receipt.key_id !== "string" || !HEX16.test(receipt.key_id) ||
        fromBase64(receipt.sig) === null || typeof receipt.ts_received !== "string" ||
        !isObject(receipt.action) || typeof receipt.action.kind !== "string" || typeof receipt.action.name !== "string" ||
        (receipt.artifacts !== undefined && !Array.isArray(receipt.artifacts))
      ) {
        fail("receipt-schema", at(index + 1), "is not a receipt this check understands");
      }
      return receipt;
    });

    // 3. Every receipt belongs to the chain the manifest names.
    receipts.forEach((receipt, index) => {
      if (receipt.system_id !== manifest.system_id) {
        fail("system", at(index + 1), "receipt seq " + receipt.seq + " belongs to system " + receipt.system_id + ", but the manifest declares " + manifest.system_id);
      }
    });

    // 4. The sequence runs from the declared start, one at a time.
    const first = receipts[0];
    if (first.seq !== range.from_seq) {
      fail("range", at(1), "the manifest declares the export starts at seq " + range.from_seq + ", but the first receipt is seq " + first.seq);
    }
    receipts.forEach((receipt, index) => {
      const expected = first.seq + index;
      if (receipt.seq !== expected) {
        const previous = receipts[index - 1];
        fail("sequence", at(index + 1), previous !== undefined && receipt.seq === previous.seq ? "seq " + receipt.seq + " appears twice" : "expected seq " + expected + ", found seq " + receipt.seq);
      }
    });

    // 5. A chain that starts at the beginning starts with a genesis receipt.
    if (first.seq === 0) {
      if (first.action.kind !== "genesis") fail("genesis", at(1), "seq 0 must be a genesis receipt, found " + first.action.kind);
      if (first.action.name !== first.system_id) fail("genesis", at(1), "a genesis receipt names its system in action.name, found " + first.action.name);
      if (first.prev_hash !== GENESIS_PREV_HASH) fail("genesis", at(1), "a genesis receipt must carry 64 zeros as prev_hash");
    }

    // 6. Each receipt commits to the one before it.
    const hashes = [];
    for (const receipt of receipts) hashes.push(toHex(await signedHash(receipt)));
    for (let index = 1; index < receipts.length; index += 1) {
      if (receipts[index].prev_hash !== hashes[index - 1]) {
        fail("chain-link", at(index + 1), "receipt seq " + receipts[index].seq + " carries prev_hash " + receipts[index].prev_hash + ", but receipt seq " + receipts[index - 1].seq + " hashes to " + hashes[index - 1] + ": one of the two has been altered");
      }
    }

    // 7. Every receipt names a key the manifest publishes, and is signed by it.
    for (const [index, receipt] of receipts.entries()) {
      if (!keys.has(receipt.key_id)) {
        fail("key", at(index + 1), "receipt seq " + receipt.seq + " is signed by key " + receipt.key_id + ", which the manifest does not publish");
      }
      if (!(await verifySignature(receipt.key_id, receipt.sig, fromHex(hashes[index])))) {
        fail("signature", at(index + 1), "receipt seq " + receipt.seq + " is not signed by key " + receipt.key_id);
      }
    }

    // 8. The document index says exactly what the receipts declare.
    const artifactKey = (seq, artifact) =>
      [seq, artifact.role, artifact.label, artifact.sha256, artifact.text ? artifact.text.canon : "", artifact.text ? artifact.text.sha256 : ""].join("\u0000");
    const declared = [];
    for (const receipt of receipts) {
      if (receipt.v === 1 || receipt.artifacts === undefined) continue;
      for (const artifact of receipt.artifacts) declared.push(artifactKey(receipt.seq, artifact));
    }
    const indexed = jsonLines(textOf("artifacts-index.jsonl") || "").map((line, index) => {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        fail("artifacts-index", "artifacts-index.jsonl:" + (index + 1), "is not valid JSON");
      }
      if (!isObject(entry) || !isCount(entry.seq) || typeof entry.sha256 !== "string" || typeof entry.role !== "string" || typeof entry.label !== "string") {
        fail("artifacts-index", "artifacts-index.jsonl:" + (index + 1), "is not an index entry");
      }
      return artifactKey(entry.seq, entry);
    });
    if (declared.slice().sort().join("\n") !== indexed.slice().sort().join("\n")) {
      fail("artifacts-index", "artifacts-index.jsonl", "the index does not match the artifacts the receipts declare: " + declared.length + " declared by the receipts, " + indexed.length + " indexed");
    }

    // 9 to 11. Every checkpoint is signed, and tied to these receipts by its
    // rebuilt root or by its inclusion proofs.
    let checkpoints = 0;
    let rootsRecomputed = 0;
    let proofsChecked = 0;
    let timestamps = 0;
    let anchoredThrough = null;
    let lastCheckpointTs = null;
    const leaves = hashes.map(fromHex);
    for (const [index, line] of jsonLines(textOf("checkpoints.jsonl") || "").entries()) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (error) {
        fail("checkpoint-json", atCheckpoint(index + 1), "is not valid JSON");
      }
      const checkpoint = isObject(entry) ? entry.checkpoint : undefined;
      if (
        !isObject(checkpoint) || typeof checkpoint.system_id !== "string" || !Number.isSafeInteger(checkpoint.tree_size) || checkpoint.tree_size < 1 ||
        typeof checkpoint.root_hash !== "string" || !HEX64.test(checkpoint.root_hash) || typeof checkpoint.key_id !== "string" ||
        typeof checkpoint.ts !== "string" || fromBase64(checkpoint.sig) === null ||
        !Array.isArray(entry.proofs) || !entry.proofs.every((proof) => isObject(proof) && isCount(proof.seq) && typeof proof.receipt_hash === "string" && Array.isArray(proof.path)) ||
        !Array.isArray(entry.timestamps)
      ) {
        fail("checkpoint-schema", atCheckpoint(index + 1), "is not a checkpoint this check understands");
      }
      if (checkpoint.system_id !== manifest.system_id) {
        fail("system", atCheckpoint(index + 1), "the checkpoint covers system " + checkpoint.system_id + ", but the manifest declares " + manifest.system_id);
      }
      if (!keys.has(checkpoint.key_id)) {
        fail("key", atCheckpoint(index + 1), "the checkpoint is signed by key " + checkpoint.key_id + ", which the manifest does not publish");
      }
      if (!(await verifySignature(checkpoint.key_id, checkpoint.sig, await signedHash(checkpoint)))) {
        fail("checkpoint-signature", atCheckpoint(index + 1), "the checkpoint over " + checkpoint.tree_size + " receipts is not signed by key " + checkpoint.key_id);
      }

      const rebuildable = first.seq === 0 && receipts.length >= checkpoint.tree_size;
      if (rebuildable || entry.proofs.length > 0) anchoredThrough = Math.max(anchoredThrough || 0, checkpoint.tree_size);
      if (rebuildable) {
        const rebuilt = toHex(await merkleRoot(leaves.slice(0, checkpoint.tree_size)));
        if (rebuilt !== checkpoint.root_hash) {
          fail("merkle-root", atCheckpoint(index + 1), "the checkpoint claims root " + checkpoint.root_hash + " over " + checkpoint.tree_size + " receipts, but those receipts build " + rebuilt);
        }
        rootsRecomputed += 1;
      }
      for (const proof of entry.proofs) {
        const position = proof.seq - first.seq;
        if (position < 0 || position >= receipts.length) {
          fail("inclusion-proof", atCheckpoint(index + 1), "the proof is for seq " + proof.seq + ", which this export does not contain");
        }
        if (hashes[position] !== proof.receipt_hash) {
          fail("inclusion-proof", atCheckpoint(index + 1), "the proof for seq " + proof.seq + " is over " + proof.receipt_hash + ", but that receipt hashes to " + hashes[position]);
        }
        let rebuilt;
        try {
          rebuilt = toHex(await rootFromProof(leaves[position], proof.seq, checkpoint.tree_size, proof.path));
        } catch (error) {
          fail("inclusion-proof", atCheckpoint(index + 1), "the proof for seq " + proof.seq + " is malformed: " + error.message);
        }
        if (rebuilt !== checkpoint.root_hash) {
          fail("inclusion-proof", atCheckpoint(index + 1), "the proof for seq " + proof.seq + " rebuilds " + rebuilt + ", not the checkpoint's root " + checkpoint.root_hash);
        }
        proofsChecked += 1;
      }
      checkpoints += 1;
      timestamps += entry.timestamps.length;
      if (rebuildable || entry.proofs.length > 0) {
        if (lastCheckpointTs === null || checkpoint.ts > lastCheckpointTs) lastCheckpointTs = checkpoint.ts;
      }
    }

    // 12. The manifest describes what is actually here.
    const last = receipts[receipts.length - 1];
    if (last.seq !== range.to_seq) {
      fail("range", "manifest.json", "the manifest declares the export ends at seq " + range.to_seq + ", but the last receipt is seq " + last.seq);
    }
    if (range.from_ts !== first.ts_received || range.to_ts !== last.ts_received) {
      const member = range.from_ts !== first.ts_received ? "from_ts" : "to_ts";
      fail("range", "manifest.json", "the manifest's range." + member + " is " + range[member] + ", but the receipts run from " + first.ts_received + " to " + last.ts_received);
    }
    if (counts.receipts !== receipts.length) fail("range", "manifest.json", "the manifest declares " + counts.receipts + " receipts, but the export holds " + receipts.length);
    if (counts.checkpoints !== checkpoints) fail("range", "manifest.json", "the manifest declares " + counts.checkpoints + " checkpoints, but the export holds " + checkpoints);
    if (counts.timestamps !== timestamps) fail("range", "manifest.json", "the manifest declares " + counts.timestamps + " timestamp tokens, but the checkpoints reference " + timestamps);
    const highest = receipts.reduce((max, receipt) => Math.max(max, receipt.v), 0);
    if (manifest.receipt_version !== highest) {
      fail("range", "manifest.json", "the manifest declares receipt_version " + manifest.receipt_version + ", but the highest version among the receipts is " + highest);
    }

    return {
      ok: true,
      summary: {
        system_id: manifest.system_id,
        receipts: receipts.length,
        first_seq: first.seq,
        last_seq: last.seq,
        checkpoints,
        roots_recomputed: rootsRecomputed,
        inclusion_proofs: proofsChecked,
        timestamps,
        unanchored_receipts: anchoredThrough === null ? 0 : receipts.filter((receipt) => receipt.seq >= anchoredThrough).length,
        last_checkpoint_ts: lastCheckpointTs,
      },
    };
  };

  try {
    if (!subtle) fail("browser", "", "this browser has no Web Crypto");
    return await check(await readZip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  } catch (error) {
    if (error instanceof Failure) return { ok: false, check: error.check, location: error.location, detail: error.detail };
    if (error && (error.name === "NotSupportedError" || /Ed25519|algorithm/i.test(String(error.message)))) {
      return { ok: false, check: "browser", location: "", detail: "this browser cannot check Ed25519 signatures" };
    }
    return { ok: false, check: "archive", location: "the file", detail: "could not be read: " + (error && error.message ? error.message : String(error)) };
  }
}`;
