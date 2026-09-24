import { createConnection, type Socket } from "node:net";
import { keyIdFromRawPublicKey } from "@sigillo/core";
import type { SigningService } from "../storage/store.js";

/**
 * The server's half of the signer protocol. It knows a socket path and nothing
 * else: there is no code path here that can read a key file, and the signing
 * key never enters this process.
 *
 * What comes back over the socket is checked, not trusted: the announced
 * key_id must match the public key, and a signature must have the shape the
 * receipt format requires. Whether a signature actually verifies over the
 * receipt it is for is checked by the store, before anything is written.
 *
 * Every request carries an id of its own, and a reply is matched to the request
 * whose id it echoes, never by arrival order. Order alone is not enough: once
 * a request has timed out, its reply can still arrive, and matched by order it
 * would complete whichever request came next — with a signature over the
 * wrong digest. By id, a reply to a request nobody is waiting for any more is
 * simply ignored. A reply that cannot be matched at all (no id, not JSON) means
 * the other end does not speak this protocol, so the connection is closed and
 * every waiting request fails with it, rather than anything being guessed.
 */

const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const NEWLINE = 0x0a;
const DEFAULT_TIMEOUT_MS = 5000;

interface Pending {
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface SignerClientOptions {
  /** How long one request may wait for its reply before it fails. */
  timeoutMs?: number;
}

export class SignerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerUnavailableError";
  }
}

export class SignerClient implements SigningService {
  /** Requests still waiting for their reply, by the id each was sent with. */
  private readonly pending = new Map<string, Pending>();
  private lastId = 0;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private identity: { keyId: string; publicKeyBase64: string } | null = null;

  private constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.socket.on("data", (chunk) => this.receive(chunk));
    this.socket.on("close", () =>
      this.shutDown(new SignerUnavailableError("the signer closed the connection")),
    );
    this.socket.on("error", (error) =>
      this.shutDown(new SignerUnavailableError(`the signer connection failed: ${error.message}`)),
    );
  }

  static async connect(socketPath: string, options: SignerClientOptions = {}): Promise<SignerClient> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`timeoutMs must be a positive number of milliseconds, received ${timeoutMs}`);
    }
    const socket = await new Promise<Socket>((resolve, reject) => {
      const attempt = createConnection(socketPath);
      attempt.once("connect", () => resolve(attempt));
      attempt.once("error", (error) =>
        reject(
          new SignerUnavailableError(`cannot reach the signer at ${socketPath}: ${error.message}`),
        ),
      );
    });

    const client = new SignerClient(socket, timeoutMs);
    try {
      await client.handshake();
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  get keyId(): string {
    return this.requireIdentity().keyId;
  }

  /** The raw 32 bytes of the signer's public key, base64. Goes into the export manifest. */
  get publicKeyBase64(): string {
    return this.requireIdentity().publicKeyBase64;
  }

  async sign(digest: Uint8Array): Promise<string> {
    if (digest.length !== 32) {
      throw new Error(`a receipt hash is 32 bytes, received ${digest.length}`);
    }
    const reply = await this.request({
      method: "sign",
      digest: Buffer.from(digest).toString("hex"),
    });
    const sig = reply["sig"];
    if (typeof sig !== "string" || !SIGNATURE.test(sig)) {
      throw new SignerUnavailableError("the signer returned a malformed signature");
    }
    return sig;
  }

  close(): void {
    this.shutDown(new SignerUnavailableError("the signer connection was closed"));
  }

  private requireIdentity(): { keyId: string; publicKeyBase64: string } {
    if (this.identity === null) {
      throw new SignerUnavailableError("the signer has not been asked for its public key yet");
    }
    return this.identity;
  }

  private async handshake(): Promise<void> {
    const reply = await this.request({ method: "pubkey" });
    const keyId = reply["key_id"];
    const publicKeyBase64 = reply["public_key_base64"];

    if (typeof keyId !== "string" || !KEY_ID.test(keyId)) {
      throw new SignerUnavailableError("the signer returned a malformed key_id");
    }
    if (typeof publicKeyBase64 !== "string") {
      throw new SignerUnavailableError("the signer returned no public key");
    }
    const raw = new Uint8Array(Buffer.from(publicKeyBase64, "base64"));
    if (raw.length !== 32) {
      throw new SignerUnavailableError("the signer's public key is not 32 bytes");
    }
    if (keyIdFromRawPublicKey(raw) !== keyId) {
      throw new SignerUnavailableError("the signer's key_id does not match its public key");
    }

    this.identity = { keyId, publicKeyBase64 };
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let index = this.buffer.indexOf(NEWLINE);
    while (index >= 0 && !this.closed) {
      const line = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      this.settle(line);
      index = this.buffer.indexOf(NEWLINE);
    }
  }

  private settle(line: string): void {
    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      this.shutDown(new SignerUnavailableError("the signer returned something that is not JSON"));
      return;
    }
    if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
      this.shutDown(new SignerUnavailableError("the signer returned something that is not an object"));
      return;
    }

    const fields = reply as Record<string, unknown>;
    const id = fields["id"];
    if (typeof id !== "string") {
      this.shutDown(
        new SignerUnavailableError(
          "the signer's reply carries no request id, so it cannot be matched to a request: " +
            "the signer is older than this server, or it is not a sigillo signer",
        ),
      );
      return;
    }

    const waiting = this.pending.get(id);
    if (waiting === undefined) {
      // The reply to a request that already timed out (or to none this client
      // sent). Nobody is waiting for it, and it must not complete anything else.
      return;
    }
    this.pending.delete(id);
    clearTimeout(waiting.timer);

    if (fields["ok"] !== true) {
      waiting.reject(new SignerUnavailableError(`the signer refused: ${String(fields["error"])}`));
      return;
    }
    waiting.resolve(fields);
  }

  /** Closes the connection for good and fails every request still waiting. */
  private shutDown(error: Error): void {
    this.closed = true;
    this.socket.destroy();
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  private request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new SignerUnavailableError("the signer connection is closed"));
    }
    this.lastId += 1;
    const id = String(this.lastId);
    return new Promise((resolve, reject) => {
      // Only this request fails at its deadline. Its reply may still arrive;
      // with its id no longer pending, it is ignored when it does.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignerUnavailableError("the signer did not answer in time"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, ...message })}\n`);
    });
  }
}
