import { request as httpRequest, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { Provider } from "./catalog.js";

/**
 * The server's side of the keyholder (apps/keyholder): the one process that
 * opens the customers' model keys and calls the providers with them. The
 * server hands it the sealed box, the provider and the path over a Unix socket
 * and gets the provider's answer back, streamed.
 *
 *   GET  /public-key                     {"public_key": base64 of its RSA public key, DER}
 *   POST /adopt {"key": 64 hex}          takes over the older AES key, once
 *   ANY  /call/<provider>/<path>?<query> the call, with x-sigillo-system and x-sigillo-sealed
 */

function readBody(request: IncomingMessage, limit = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** A client for the keyholder's socket. */
export class KeyholderClient {
  constructor(readonly socketPath: string) {}

  private request(method: string, path: string, headers: Record<string, string>, body?: Buffer | string, signal?: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ socketPath: this.socketPath, method, path, headers, ...(signal === undefined ? {} : { signal }) }, resolve);
      outgoing.on("error", reject);
      if (body !== undefined) outgoing.write(body);
      outgoing.end();
    });
  }

  private async json(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const reply = await this.request(method, path, text === undefined ? {} : { "content-type": "application/json" }, text);
    return { status: reply.statusCode ?? 0, body: JSON.parse((await readBody(reply)).toString("utf8")) as Record<string, unknown> };
  }

  async publicKey(): Promise<Buffer> {
    const reply = await this.json("GET", "/public-key");
    if (reply.status !== 200 || typeof reply.body["public_key"] !== "string") throw new Error("the keyholder gave no public key");
    return Buffer.from(reply.body["public_key"], "base64");
  }

  /** Hands the older AES key over; resolves to whether the keyholder now holds this very key. */
  async adopt(key: Buffer): Promise<boolean> {
    const reply = await this.json("POST", "/adopt", { key: key.toString("hex") });
    return reply.status === 200 && reply.body["adopted"] === true;
  }

  /** One call to the provider, as a fetch Response, the key opened on the other side. */
  async call(input: {
    systemId: string;
    provider: Provider;
    rest: string;
    query: string;
    method: string;
    sealed: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  }): Promise<Response> {
    const reply = await this.request(
      input.method,
      `/call/${input.provider}/${input.rest}${input.query}`,
      { ...input.headers, "x-sigillo-system": input.systemId, "x-sigillo-sealed": input.sealed },
      input.body,
      input.signal,
    );
    const headers = new Headers();
    for (const [name, value] of Object.entries(reply.headers)) {
      if (typeof value === "string") headers.set(name, value);
    }
    const status = reply.statusCode ?? 502;
    if ([101, 204, 205, 304].includes(status)) {
      reply.resume();
      return new Response(null, { status, headers });
    }
    return new Response(Readable.toWeb(reply) as ReadableStream<Uint8Array>, { status, headers });
  }
}
