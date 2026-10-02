import { chmodSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import { unsignedReceiptSchema } from "@sigillo/core";
import type { SignerKey } from "./key-file.js";
import { Refusal, Signer } from "./signer.js";
import { StateDirectory } from "./state.js";

/**
 * The signer's socket protocol, version 2: one request per line of JSON, one
 * reply per line of JSON.
 *
 *   {"v":2,"id":"<id>","method":"PUBKEY"}
 *     -> {"v":2,"id":"<id>","ok":true,"key_id":"<16 hex>","public_key_base64":"<32 raw bytes>"}
 *   {"v":2,"id":"<id>","method":"SIGN_RECEIPT","receipt":{<unsigned receipt>}}
 *     -> {"v":2,"id":"<id>","ok":true,"sig":"<Ed25519, base64>","hash":"<64 hex>"}
 *   {"v":2,"id":"<id>","method":"CHECKPOINT","system_id":"<id>"}
 *     -> {"v":2,"id":"<id>","ok":true,"checkpoint":{<signed checkpoint>}}
 *   {"v":2,"id":"<id>","method":"GET_HEAD","system_id":"<id>"}
 *     -> {"v":2,"id":"<id>","ok":true,"head":{<signed receipt>} | null}
 *   {"v":2,"id":"<id>","method":"GET_RECEIPTS","system_id":"<id>","from_seq":<n>,"limit":<1..50>}
 *     -> {"v":2,"id":"<id>","ok":true,"receipts":[{<signed receipt>}, …]}
 *   anything refused
 *     -> {"v":2,"id":"<id>","ok":false,"code":"<code>","error":"<reason>"}
 *
 * Version 1 had a `sign` method that took any 32-byte hash. It is gone: the
 * signer now reads the receipt, hashes it itself, and signs it only if it is
 * the next receipt of its chain (signer.ts). The signature is still Ed25519
 * over the 32 bytes of that hash, so every receipt and export made before
 * stays valid.
 *
 * The attack surface is kept small on purpose. A line is at most
 * MAX_LINE_BYTES; every request is checked against a strict schema, so an
 * unknown field is a refusal rather than something ignored; and requests are
 * handled one at a time, across all connections, because handling one is
 * synchronous from the moment its line is read to the moment its reply is
 * written, state file and fsync included.
 *
 * `id` is the client's name for the request, echoed on the reply to it so a
 * reply is matched to its request by name and never by arrival order.
 */

export const PROTOCOL_VERSION = 2;
/** At most this many receipts in one GET_RECEIPTS reply. */
export const MAX_RECEIPTS_PER_REPLY = 50;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 16;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NEWLINE = 0x0a;

const id = z.string().regex(REQUEST_ID);
const systemId = z.string().min(1).max(128);
const version = z.literal(PROTOCOL_VERSION);

const requestSchema = z.discriminatedUnion("method", [
  z.object({ v: version, id, method: z.literal("PUBKEY") }).strict(),
  z.object({ v: version, id, method: z.literal("SIGN_RECEIPT"), receipt: unsignedReceiptSchema }).strict(),
  z.object({ v: version, id, method: z.literal("CHECKPOINT"), system_id: systemId }).strict(),
  z.object({ v: version, id, method: z.literal("GET_HEAD"), system_id: systemId }).strict(),
  z
    .object({
      v: version,
      id,
      method: z.literal("GET_RECEIPTS"),
      system_id: systemId,
      from_seq: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(MAX_RECEIPTS_PER_REPLY),
    })
    .strict(),
]);

export interface SignerDaemon {
  readonly socketPath: string;
  close(): Promise<void>;
}

type Reply = Record<string, unknown>;

function refusal(code: Refusal["code"], error: string, requestId?: string): Reply {
  return { v: PROTOCOL_VERSION, ...(requestId === undefined ? {} : { id: requestId }), ok: false, code, error };
}

export function handleLine(line: string, signer: Signer): Reply {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return refusal("malformed", "request is not JSON");
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return refusal("malformed", "request must be a JSON object");
  }

  const fields = request as Record<string, unknown>;
  const requestId = typeof fields["id"] === "string" && REQUEST_ID.test(fields["id"]) ? fields["id"] : undefined;
  if (requestId === undefined) {
    return refusal("malformed", "id is required: 1 to 64 characters from A-Z, a-z, 0-9, _ and -");
  }
  if (fields["v"] !== PROTOCOL_VERSION) {
    return refusal("version", `this signer speaks protocol version ${PROTOCOL_VERSION} only`, requestId);
  }

  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<request>"}: ${issue.message}`)
      .join("; ");
    return refusal("malformed", reason, requestId);
  }

  const ok = (answer: Reply): Reply => ({ v: PROTOCOL_VERSION, id: requestId, ok: true, ...answer });
  try {
    const valid = parsed.data;
    switch (valid.method) {
      case "PUBKEY":
        return ok({ key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 });
      case "SIGN_RECEIPT":
        return ok(signer.signReceipt(valid.receipt));
      case "CHECKPOINT":
        return ok({ checkpoint: signer.checkpoint(valid.system_id) });
      case "GET_HEAD":
        return ok({ head: signer.head(valid.system_id) });
      case "GET_RECEIPTS":
        return ok({ receipts: signer.receipts(valid.system_id, valid.from_seq, valid.limit) });
    }
  } catch (error) {
    if (error instanceof Refusal) return refusal(error.code, error.message, requestId);
    throw error;
  }
}

function serve(socket: Socket, signer: Signer, fail: (error: unknown) => void): void {
  let buffer = Buffer.alloc(0);

  const send = (reply: Reply): void => {
    socket.write(`${JSON.stringify(reply)}\n`);
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    let index = buffer.indexOf(NEWLINE);
    while (index >= 0) {
      if (index > MAX_LINE_BYTES) break;
      const line = buffer.subarray(0, index).toString("utf8").trim();
      buffer = buffer.subarray(index + 1);
      if (line.length > 0) {
        let reply: Reply;
        try {
          reply = handleLine(line, signer);
        } catch (error) {
          // Not a refusal: something the signer could not do, such as making
          // its new state durable. What it holds in memory may no longer be
          // what is on disk, so it answers nothing more, to anyone.
          fail(error);
          return;
        }
        send(reply);
      }
      index = buffer.indexOf(NEWLINE);
    }

    if (buffer.length > MAX_LINE_BYTES) {
      send(refusal("malformed", `request line too long: the limit is ${MAX_LINE_BYTES} bytes`));
      buffer = Buffer.alloc(0);
      socket.end();
      socket.pause();
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

export interface SignerDaemonOptions {
  socketPath: string;
  key: SignerKey;
  /** The directory that holds the signer's state: in its own volume, next to the key. */
  stateDir: string;
  /** The signer's clock; the system clock unless a test sets one. */
  now?: () => Date;
  /** How far a receipt's ts_received may be from that clock. Default 5 minutes. */
  clockToleranceMs?: number;
  /**
   * Called once if the signer has to stop: it has closed its socket and
   * dropped every connection by then. The command line exits on it.
   */
  onFatal?: (error: unknown) => void;
}

export async function startSignerDaemon(options: SignerDaemonOptions): Promise<SignerDaemon> {
  const { socketPath, key } = options;
  // The state is read, and checked, before the socket exists: a signer that
  // cannot trust its own memory must not answer anyone.
  const signer = new Signer({
    key,
    state: StateDirectory.open(options.stateDir),
    now: options.now ?? ((): Date => new Date()),
    ...(options.clockToleranceMs === undefined ? {} : { clockToleranceMs: options.clockToleranceMs }),
  });
  await clearStaleSocket(socketPath);

  const open = new Set<Socket>();
  let failed = false;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    server.close();
    for (const socket of open) socket.destroy();
    open.clear();
    options.onFatal?.(error);
  };
  const server: Server = createServer((socket) => {
    if (failed) {
      socket.destroy();
      return;
    }
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    serve(socket, signer, fail);
  });
  server.maxConnections = MAX_CONNECTIONS;

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
        if (failed) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        // An idle client must not be able to hold shutdown open.
        for (const socket of open) {
          socket.destroy();
        }
        open.clear();
      }),
  };
}
