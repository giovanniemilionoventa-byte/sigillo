import { createHash, generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keyIdFromRawPublicKey, rawPublicKeyBytes } from "@sigillo/core";
import { SignerClient, SignerUnavailableError } from "../src/signer/client.js";

/**
 * How the client matches replies to requests, tested against a peer whose
 * reply order the test decides.
 *
 * The real signer answers strictly in order, one line per request, and
 * signer-client.test.ts drives it (frozen and resumed) through the one
 * ordering it can produce. The orderings here — a later request answered
 * first, a reply nobody asked for, a reply with no id — are the ones only a
 * scripted peer can produce on demand. The socket, the client and the Ed25519
 * signatures are all real.
 */

interface HeldRequest {
  id: unknown;
  digest: string;
  /** Sends the real signature over this request's digest, under its own id. */
  answer: () => void;
}

let directory: string;
let socketPath: string;
let server: Server;
let privateKey: KeyObject;
let publicKey: KeyObject;
let held: HeldRequest[];
let peer: Socket | undefined;

const digestOf = (text: string): Uint8Array =>
  new Uint8Array(createHash("sha256").update(text).digest());

const signatureOver = (digestHex: string): string =>
  Buffer.from(sign(null, Buffer.from(digestHex, "hex"), privateKey)).toString("base64");

const verifies = (digest: Uint8Array, signature: string): boolean =>
  verify(null, digest, publicKey, Buffer.from(signature, "base64"));

const send = (line: unknown): void => {
  peer?.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
};

/** Waits until the peer holds `count` sign requests. */
async function requestsHeld(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && held.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(held).toHaveLength(count);
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-replies-"));
  socketPath = join(directory, "signer.sock");
  ({ privateKey, publicKey } = generateKeyPairSync("ed25519"));
  const raw = rawPublicKeyBytes(publicKey);
  held = [];

  server = createServer((socket) => {
    peer = socket;
    let buffer = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const request = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (request["method"] === "pubkey") {
          // The handshake is answered at once, as the real signer would.
          send({
            ...(request["id"] === undefined ? {} : { id: request["id"] }),
            ok: true,
            key_id: keyIdFromRawPublicKey(raw),
            public_key_base64: Buffer.from(raw).toString("base64"),
          });
          continue;
        }
        const digest = String(request["digest"]);
        held.push({
          id: request["id"],
          digest,
          answer: () =>
            send({
              ...(request["id"] === undefined ? {} : { id: request["id"] }),
              ok: true,
              sig: signatureOver(digest),
            }),
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  peer?.destroy();
  peer = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

describe("matching replies to requests", () => {
  it("gives each of two concurrent requests its own signature when the replies arrive in reverse", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      const a = digestOf("A");
      const b = digestOf("B");
      const first = client.sign(a);
      const second = client.sign(b);
      await requestsHeld(2);

      held[1]?.answer(); // B first
      held[0]?.answer(); // then A

      const [signatureA, signatureB] = await Promise.all([first, second]);
      expect(verifies(a, signatureA)).toBe(true);
      expect(verifies(b, signatureB)).toBe(true);
    } finally {
      client.close();
    }
  });

  it("sends a distinct id with every request", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      const requests = [client.sign(digestOf("1")), client.sign(digestOf("2")), client.sign(digestOf("3"))];
      await requestsHeld(3);
      const ids = held.map((request) => request.id);
      expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(3);
      for (const request of held) request.answer();
      await Promise.all(requests);
    } finally {
      client.close();
    }
  });

  it("does not let a late reply to a timed-out request complete the next one", async () => {
    const client = await SignerClient.connect(socketPath, { timeoutMs: 500 });
    try {
      const a = digestOf("A");
      const b = digestOf("B");
      await expect(client.sign(a)).rejects.toBeInstanceOf(SignerUnavailableError);

      const second = client.sign(b);
      await requestsHeld(2);
      held[0]?.answer(); // A, too late, arrives first
      held[1]?.answer(); // then B's own

      const signatureB = await second;
      expect(verifies(b, signatureB)).toBe(true);
      expect(verifies(a, signatureB)).toBe(false);
    } finally {
      client.close();
    }
  });

  it("ignores a late reply that arrives after the next request was already answered", async () => {
    const client = await SignerClient.connect(socketPath, { timeoutMs: 500 });
    try {
      const a = digestOf("A");
      const b = digestOf("B");
      const c = digestOf("C");
      await expect(client.sign(a)).rejects.toBeInstanceOf(SignerUnavailableError);

      const second = client.sign(b);
      await requestsHeld(2);
      held[1]?.answer();
      expect(verifies(b, await second)).toBe(true);

      held[0]?.answer(); // A's reply, now with nobody waiting for it
      const third = client.sign(c);
      await requestsHeld(3);
      held[2]?.answer();
      expect(verifies(c, await third)).toBe(true);
    } finally {
      client.close();
    }
  });

  it("times out one request without failing the others still waiting", async () => {
    const client = await SignerClient.connect(socketPath, { timeoutMs: 1000 });
    try {
      const a = digestOf("A");
      const b = digestOf("B");
      const first = client.sign(a);
      await requestsHeld(1);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const second = client.sign(b);
      await requestsHeld(2);

      // A reaches its deadline; B, sent 500 ms later, has not reached its own.
      await expect(first).rejects.toBeInstanceOf(SignerUnavailableError);
      held[1]?.answer();
      expect(verifies(b, await second)).toBe(true);
    } finally {
      client.close();
    }
  });

  it("ignores a reply carrying an id it never sent", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      const a = digestOf("A");
      const pending = client.sign(a);
      await requestsHeld(1);
      send({ id: "never-sent", ok: true, sig: signatureOver(Buffer.from(digestOf("X")).toString("hex")) });
      held[0]?.answer();
      expect(verifies(a, await pending)).toBe(true);
    } finally {
      client.close();
    }
  });

  it("fails every request, at once and for good, on a reply with no id", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      const first = client.sign(digestOf("A"));
      const second = client.sign(digestOf("B"));
      await requestsHeld(2);
      // A signer that does not echo ids (an older build) cannot be matched
      // safely: nothing is guessed from arrival order.
      send({ ok: true, sig: signatureOver(held[0]?.digest ?? "") });

      await expect(first).rejects.toThrow(/request id/);
      await expect(second).rejects.toThrow(/request id/);
      await expect(client.sign(digestOf("C"))).rejects.toBeInstanceOf(SignerUnavailableError);
    } finally {
      client.close();
    }
  });

  it("fails every request, at once and for good, on a reply that is not JSON", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      const pending = client.sign(digestOf("A"));
      await requestsHeld(1);
      send("this is not json");
      await expect(pending).rejects.toBeInstanceOf(SignerUnavailableError);
      await expect(client.sign(digestOf("B"))).rejects.toBeInstanceOf(SignerUnavailableError);
    } finally {
      client.close();
    }
  });

  it("fails just the refused request when the signer refuses it under its id", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      const first = client.sign(digestOf("A"));
      const second = client.sign(digestOf("B"));
      await requestsHeld(2);
      send({ id: held[0]?.id, ok: false, error: "refused for the test" });
      held[1]?.answer();
      await expect(first).rejects.toThrow(/refused for the test/);
      expect(verifies(digestOf("B"), await second)).toBe(true);
    } finally {
      client.close();
    }
  });
});
