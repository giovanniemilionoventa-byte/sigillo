import { createConnection, type Socket } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromHex, publicKeyFromRaw, signDigest, verifyDigestSignature } from "@sigillo/core";
import { generateKeyFile, loadKeyFile, type SignerKey } from "../src/key-file.js";
import { startSignerDaemon, type SignerDaemon } from "../src/daemon.js";

const DIGEST = "74a67e081df5c321729640090e63ca95991f9657bfaab0af51e4504cc2056241";

let directory: string;
let socketPath: string;
let key: SignerKey;
let daemon: SignerDaemon;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-daemon-"));
  socketPath = join(directory, "signer.sock");
  const keyPath = join(directory, "signer.key");
  generateKeyFile(keyPath);
  key = loadKeyFile(keyPath);
  daemon = await startSignerDaemon({ socketPath, key });
});

afterEach(async () => {
  await daemon.close();
  rmSync(directory, { recursive: true, force: true });
});

/** Sends raw bytes and collects reply lines, so malformed input can be tested. */
function exchange(payload: string, expectedLines = 1): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = "";
    const socket: Socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("no reply from the signer"));
    }, 4000);
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(lines);
    };
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
      if (lines.length >= expectedLines) finish();
    });
    socket.on("close", finish);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function request(message: unknown): Promise<Record<string, unknown>> {
  const [line] = await exchange(`${JSON.stringify(message)}\n`);
  expect(line, "the signer sent no reply").toBeDefined();
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

describe("the signer socket", () => {
  it("listens on a Unix socket that only its own user and group can reach", () => {
    expect(statSync(socketPath).mode & 0o007).toBe(0);
  });
});

describe("pubkey", () => {
  it("returns the key identifier and the raw public key", async () => {
    const reply = await request({ method: "pubkey" });
    expect(reply["ok"]).toBe(true);
    expect(reply["key_id"]).toBe(key.keyId);
    expect(reply["public_key_base64"]).toBe(key.publicKeyBase64);

    const raw = new Uint8Array(Buffer.from(String(reply["public_key_base64"]), "base64"));
    expect(raw).toHaveLength(32);
    expect(publicKeyFromRaw(raw).export({ format: "der", type: "spki" })).toEqual(
      key.publicKey.export({ format: "der", type: "spki" }),
    );
  });

  it("rejects a pubkey request carrying extra fields", async () => {
    const reply = await request({ method: "pubkey", digest: DIGEST });
    expect(reply["ok"]).toBe(false);
  });
});

describe("sign", () => {
  it("returns a signature over exactly those 32 bytes", async () => {
    const reply = await request({ method: "sign", digest: DIGEST });
    expect(reply["ok"]).toBe(true);
    const signature = String(reply["sig"]);
    expect(verifyDigestSignature(fromHex(DIGEST), signature, key.publicKey)).toBe(true);
    expect(signature).toBe(signDigest(fromHex(DIGEST), key.privateKey));
  });

  it("serves several requests on one connection", async () => {
    const other = "a".repeat(64);
    const lines = await exchange(
      `${JSON.stringify({ method: "sign", digest: DIGEST })}\n` +
        `${JSON.stringify({ method: "sign", digest: other })}\n` +
        `${JSON.stringify({ method: "pubkey" })}\n`,
      3,
    );
    // The connection stays open, so wait for all three replies to arrive.
    const replies = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(replies).toHaveLength(3);
    expect(replies.every((reply) => reply["ok"] === true)).toBe(true);
    expect(replies[0]?.["sig"]).not.toBe(replies[1]?.["sig"]);
  });

  it("serves several connections at once", async () => {
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => request({ method: "sign", digest: DIGEST })),
    );
    const signature = signDigest(fromHex(DIGEST), key.privateKey);
    for (const reply of replies) {
      expect(reply["sig"]).toBe(signature);
    }
  });
});

describe("rejecting anything that is not a 32-byte digest", () => {
  const badDigests: [string, unknown][] = [
    ["63 hex characters", DIGEST.slice(0, 63)],
    ["65 hex characters", `${DIGEST}a`],
    ["empty", ""],
    ["uppercase hex", DIGEST.toUpperCase()],
    ["not hex", "z".repeat(64)],
    ["hex with 0x prefix", `0x${DIGEST.slice(2)}`],
    ["a number", 42],
    ["null", null],
    ["an array", [DIGEST]],
    ["an object", { hex: DIGEST }],
  ];

  for (const [name, digest] of badDigests) {
    it(`refuses ${name}`, async () => {
      const reply = await request({ method: "sign", digest });
      expect(reply["ok"]).toBe(false);
      expect(String(reply["error"])).toMatch(/digest/i);
      expect(reply["sig"]).toBeUndefined();
    });
  }

  it("refuses a sign request with no digest at all", async () => {
    const reply = await request({ method: "sign" });
    expect(reply["ok"]).toBe(false);
    expect(reply["sig"]).toBeUndefined();
  });

  it("refuses a sign request carrying extra fields", async () => {
    const reply = await request({ method: "sign", digest: DIGEST, also: "please sign this" });
    expect(reply["ok"]).toBe(false);
    expect(reply["sig"]).toBeUndefined();
  });
});

describe("rejecting anything that is not a known request", () => {
  it("refuses an unknown method", async () => {
    for (const method of ["export", "keygen", "SIGN", "", null, 7]) {
      const reply = await request({ method });
      expect(reply["ok"]).toBe(false);
    }
  });

  it("refuses input that is not JSON", async () => {
    const [line] = await exchange("this is not json\n");
    expect(JSON.parse(line ?? "{}")["ok"]).toBe(false);
  });

  it("refuses JSON that is not an object", async () => {
    for (const payload of ['"sign"', "42", "null", "[1,2,3]"]) {
      const [line] = await exchange(`${payload}\n`);
      expect(JSON.parse(line ?? "{}")["ok"]).toBe(false);
    }
  });

  it("ignores a blank line rather than answering it", async () => {
    const lines = await exchange(`\n${JSON.stringify({ method: "pubkey" })}\n`);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")["ok"]).toBe(true);
  });

  it("drops a connection that sends an oversized line", async () => {
    const lines = await exchange(`${"x".repeat(8192)}`);
    const reply = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(reply["ok"]).toBe(false);
    expect(String(reply["error"])).toMatch(/too long/i);
  });

  it("keeps serving after a rejected request", async () => {
    const lines = await exchange(
      `{"method":"nope"}\n${JSON.stringify({ method: "pubkey" })}\n`,
      2,
    );
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")["ok"]).toBe(false);
    expect(JSON.parse(lines[1] ?? "{}")["ok"]).toBe(true);
  });
});

describe("request ids", () => {
  // A reply is only ever matched to the request that carries the same id.
  // Without it, a client can do no better than match by arrival order, which
  // hands a reply that arrives late to whichever request is waiting next.

  it("echoes the id of a sign request, with the signature over that request's digest", async () => {
    const reply = await request({ id: "17", method: "sign", digest: DIGEST });
    expect(reply["ok"]).toBe(true);
    expect(reply["id"]).toBe("17");
    expect(verifyDigestSignature(fromHex(DIGEST), String(reply["sig"]), key.publicKey)).toBe(true);
  });

  it("echoes the id of a pubkey request", async () => {
    const reply = await request({ id: "handshake-1", method: "pubkey" });
    expect(reply["ok"]).toBe(true);
    expect(reply["id"]).toBe("handshake-1");
    expect(reply["key_id"]).toBe(key.keyId);
  });

  it("echoes the id on a refusal too, so the client can fail that one request", async () => {
    const refusals = await Promise.all([
      request({ id: "a", method: "sign", digest: "z".repeat(64) }),
      request({ id: "b", method: "sign" }),
      request({ id: "c", method: "export" }),
      request({ id: "d", method: "sign", digest: DIGEST, also: "please sign this" }),
    ]);
    expect(refusals.map((reply) => reply["ok"])).toEqual([false, false, false, false]);
    expect(refusals.map((reply) => reply["id"])).toEqual(["a", "b", "c", "d"]);
    expect(refusals.every((reply) => reply["sig"] === undefined)).toBe(true);
  });

  it("answers each request on one connection under its own id", async () => {
    const other = "a".repeat(64);
    const lines = await exchange(
      `${JSON.stringify({ id: "1", method: "sign", digest: DIGEST })}\n` +
        `${JSON.stringify({ id: "2", method: "sign", digest: other })}\n`,
      2,
    );
    const replies = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const byId = new Map(replies.map((reply) => [reply["id"], String(reply["sig"])]));
    expect(verifyDigestSignature(fromHex(DIGEST), byId.get("1") ?? "", key.publicKey)).toBe(true);
    expect(verifyDigestSignature(fromHex(other), byId.get("2") ?? "", key.publicKey)).toBe(true);
  });

  it("refuses an id that is not a short token, and does not echo it", async () => {
    const badIds: unknown[] = ["", "x".repeat(65), "has space", "new\nline", 7, null, ["1"], { id: 1 }];
    for (const id of badIds) {
      const reply = await request({ id, method: "sign", digest: DIGEST });
      expect(reply["ok"], `id ${JSON.stringify(id)}`).toBe(false);
      expect(String(reply["error"])).toMatch(/id/);
      expect(reply["id"]).toBeUndefined();
      expect(reply["sig"]).toBeUndefined();
    }
  });

  it("still answers a request without an id, as before", async () => {
    const reply = await request({ method: "sign", digest: DIGEST });
    expect(reply["ok"]).toBe(true);
    expect(reply["id"]).toBeUndefined();
  });
});
