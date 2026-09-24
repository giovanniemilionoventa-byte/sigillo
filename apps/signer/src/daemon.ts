import { chmodSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { fromHex, signDigest } from "@sigillo/core";
import type { SignerKey } from "./key-file.js";

/**
 * The signer speaks one request per line of JSON and answers one line of JSON.
 *
 *   {"id":"<id>","method":"pubkey"}
 *     -> {"id":"<id>","ok":true,"key_id":"<16 hex>","public_key_base64":"<32 raw bytes>"}
 *   {"id":"<id>","method":"sign","digest":"<64 lowercase hex>"}
 *     -> {"id":"<id>","ok":true,"sig":"<64-byte Ed25519 signature, standard base64>"}
 *   anything else
 *     -> {"id":"<id>","ok":false,"error":"<reason>"}
 *
 * `id` is the client's name for the request, echoed on the reply to it —
 * refusals included — so that a reply is matched to its request by name and
 * never by arrival order. Order is not enough: a client that gives up on a
 * request that timed out would otherwise hand that request's late reply to
 * whichever request came next. An id is 1 to 64 characters of [A-Za-z0-9_-];
 * one that is not is refused, and not echoed. `id` is optional, so a request
 * without one is still answered, without one.
 *
 * `sign` takes a 32-byte receipt hash and nothing else. It is not a general
 * signing oracle: it will not sign a document, a file, or a digest of the wrong
 * length, and it never reveals the private key.
 */

const DIGEST_HEX = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LINE_BYTES = 4096;
const NEWLINE = 0x0a;

export interface SignerDaemon {
  readonly socketPath: string;
  close(): Promise<void>;
}

type Reply = Record<string, unknown>;

function handleRequest(line: string, key: SignerKey): Reply {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return { ok: false, error: "request is not JSON" };
  }

  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return { ok: false, error: "request must be a JSON object" };
  }

  // The id is set aside before the request itself is checked, so each method
  // keeps its exact list of fields and the id is echoed on every answer to it.
  const { id, ...fields } = request as Record<string, unknown>;
  if (id === undefined) {
    return answer(fields, key);
  }
  if (typeof id !== "string" || !REQUEST_ID.test(id)) {
    return { ok: false, error: "id must be 1 to 64 characters from A-Z, a-z, 0-9, _ and -" };
  }
  return { id, ...answer(fields, key) };
}

function answer(fields: Record<string, unknown>, key: SignerKey): Reply {
  const method = fields["method"];

  if (method === "pubkey") {
    if (Object.keys(fields).length !== 1) {
      return { ok: false, error: "pubkey takes no other field" };
    }
    return { ok: true, key_id: key.keyId, public_key_base64: key.publicKeyBase64 };
  }

  if (method === "sign") {
    if (Object.keys(fields).length !== 2 || !("digest" in fields)) {
      return { ok: false, error: "sign takes exactly one other field, digest" };
    }
    const digest = fields["digest"];
    if (typeof digest !== "string" || !DIGEST_HEX.test(digest)) {
      return { ok: false, error: "digest must be exactly 32 bytes as 64 lowercase hex characters" };
    }
    return { ok: true, sig: signDigest(fromHex(digest), key.privateKey) };
  }

  return { ok: false, error: "unknown method" };
}

function serve(socket: Socket, key: SignerKey): void {
  let buffer = Buffer.alloc(0);

  const send = (reply: Reply): void => {
    socket.write(`${JSON.stringify(reply)}\n`);
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    let index = buffer.indexOf(NEWLINE);
    while (index >= 0) {
      const line = buffer.subarray(0, index).toString("utf8").trim();
      buffer = buffer.subarray(index + 1);
      if (line.length > 0) {
        send(handleRequest(line, key));
      }
      index = buffer.indexOf(NEWLINE);
    }

    if (buffer.length > MAX_LINE_BYTES) {
      send({ ok: false, error: "request line too long" });
      socket.end();
    }
  });

  // A client that disappears is not an error worth reporting.
  socket.on("error", () => socket.destroy());
}

/** Removes a socket file left behind by a process that is no longer listening. */
async function clearStaleSocket(socketPath: string): Promise<void> {
  const inUse = await new Promise<boolean>((resolve) => {
    const probe = createConnection(socketPath);
    probe.on("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.on("error", () => {
      probe.destroy();
      resolve(false);
    });
  });

  if (inUse) {
    throw new Error(`a signer is already listening on ${socketPath}`);
  }
  try {
    unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function startSignerDaemon(options: {
  socketPath: string;
  key: SignerKey;
}): Promise<SignerDaemon> {
  const { socketPath, key } = options;
  await clearStaleSocket(socketPath);

  const open = new Set<Socket>();
  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    serve(socket, key);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  // The server process reaches the signer through this socket and nothing else,
  // so it stays closed to everyone outside the owner's group.
  chmodSync(socketPath, 0o660);

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // An idle client must not be able to hold shutdown open.
        for (const socket of open) {
          socket.destroy();
        }
        open.clear();
      }),
  };
}
