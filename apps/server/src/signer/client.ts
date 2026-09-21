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
 * receipt format requires.
 */

const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const NEWLINE = 0x0a;
const REQUEST_TIMEOUT_MS = 5000;

interface Pending {
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class SignerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerUnavailableError";
  }
}

export class SignerClient implements SigningService {
  private readonly pending: Pending[] = [];
  private buffer = Buffer.alloc(0);
  private closed = false;
  private identity: { keyId: string; publicKeyBase64: string } | null = null;

  private constructor(private readonly socket: Socket) {
    this.socket.on("data", (chunk) => this.receive(chunk));
    this.socket.on("close", () =>
      this.failPending(new SignerUnavailableError("the signer closed the connection")),
    );
    this.socket.on("error", (error) =>
      this.failPending(new SignerUnavailableError(`the signer connection failed: ${error.message}`)),
    );
  }

  static async connect(socketPath: string): Promise<SignerClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const attempt = createConnection(socketPath);
      attempt.once("connect", () => resolve(attempt));
      attempt.once("error", (error) =>
        reject(
          new SignerUnavailableError(`cannot reach the signer at ${socketPath}: ${error.message}`),
        ),
      );
    });

    const client = new SignerClient(socket);
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
    this.closed = true;
    this.socket.destroy();
    this.failPending(new SignerUnavailableError("the signer connection was closed"));
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
    while (index >= 0) {
      const line = this.buffer.subarray(0, index).toString("utf8");
      this.buffer = this.buffer.subarray(index + 1);
      this.settle(line);
      index = this.buffer.indexOf(NEWLINE);
    }
  }

  private settle(line: string): void {
    const waiting = this.pending.shift();
    if (waiting === undefined) {
      return;
    }
    clearTimeout(waiting.timer);

    let reply: unknown;
    try {
      reply = JSON.parse(line);
    } catch {
      waiting.reject(new SignerUnavailableError("the signer returned something that is not JSON"));
      return;
    }
    if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
      waiting.reject(
        new SignerUnavailableError("the signer returned something that is not an object"),
      );
      return;
    }

    const fields = reply as Record<string, unknown>;
    if (fields["ok"] !== true) {
      waiting.reject(new SignerUnavailableError(`the signer refused: ${String(fields["error"])}`));
      return;
    }
    waiting.resolve(fields);
  }

  private failPending(error: Error): void {
    while (this.pending.length > 0) {
      const waiting = this.pending.shift();
      if (waiting !== undefined) {
        clearTimeout(waiting.timer);
        waiting.reject(error);
      }
    }
  }

  private request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new SignerUnavailableError("the signer connection is closed"));
    }
    return new Promise((resolve, reject) => {
      // Replies are matched to requests by order. A request that times out means
      // that order can no longer be trusted, so every pending request fails with it.
      const timer = setTimeout(() => {
        this.failPending(new SignerUnavailableError("the signer did not answer in time"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.push({ resolve, reject, timer });
      this.socket.write(`${JSON.stringify(message)}\n`);
    });
  }
}
