import { type KeyObject, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  associatedData,
  CATALOG,
  closedPath,
  FORWARDED_REQUEST_HEADERS,
  FORWARDED_RESPONSE_HEADER,
  isBoxed,
  isProvider,
  openLegacy,
  providerAuth,
  UPSTREAM,
  type Provider,
} from "@sigillo/server/gateway";
import { loadOrCreateBoxKey, openBox } from "./box.js";

/**
 * The keyholder: the one process that can open the customers' model keys.
 *
 * Like the signer for the signing key, it keeps them away from the server,
 * which holds the database and faces the internet. The server seals each key
 * the console receives into a box only this process opens (apps/server/src/gateway/key-box.ts,
 * box.ts here),
 * and for each model call it hands over the box, the provider and the path;
 * the keyholder opens the box, calls the provider's own address (from the
 * catalogue, never from the request), and streams the answer back. A server
 * taken over can still make calls through it, as long as it holds the socket,
 * but can no longer carry a customer's key away.
 *
 * It listens on a Unix socket shared with the server alone. Its directory
 * holds its RSA key (`box.key`, PKCS#8, made on first start) and, once the server has handed it
 * over, the older AES key that opens the keys sealed before it existed
 * (`llm-gateway.key`), which the server then deletes from its own disk.
 *
 *   GET  /public-key                     {"public_key": base64 of its public key, DER}
 *   POST /adopt {"key": 64 hex}          takes over the older key, once
 *   ANY  /call/<provider>/<path>?<query> the call, with x-sigillo-system and x-sigillo-sealed
 */

export interface KeyholderOptions {
  socketPath: string;
  directory: string;
  /** The providers' addresses; tests point them at a local stand-in. */
  upstream?: Partial<Record<Provider, string>>;
}

export interface Keyholder {
  publicKeyBase64: string;
  close(): Promise<void>;
}

const LEGACY_FILE = "llm-gateway.key";
const BOX_FILE = "box.key";

function legacyKeyOf(directory: string): Buffer | null {
  const path = join(directory, LEGACY_FILE);
  if (!existsSync(path)) return null;
  const hex = readFileSync(path, "utf8").trim();
  return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : null;
}

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

function answer(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

export async function startKeyholder(options: KeyholderOptions): Promise<Keyholder> {
  const boxKey: KeyObject = loadOrCreateBoxKey(join(options.directory, BOX_FILE));
  const publicKeyBase64 = createPublicKey(boxKey).export({ format: "der", type: "spki" }).toString("base64");
  const upstreamOf = (provider: Provider): string => (options.upstream?.[provider] ?? UPSTREAM(provider)).replace(/\/+$/, "");

  const openKey = (systemId: string, provider: Provider, sealed: string): string => {
    const aad = associatedData(systemId, provider);
    if (isBoxed(sealed)) return openBox(boxKey, sealed, aad).toString("utf8");
    const legacy = legacyKeyOf(options.directory);
    if (legacy === null) throw new Error("no key to open this one");
    return openLegacy(legacy, Buffer.from(sealed, "base64"), aad).toString("utf8");
  };

  const call = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const [, , provider = "", ...parts] = url.pathname.split("/");
    const rest = parts.join("/");
    if (!isProvider(provider) || !CATALOG[provider].path.test(rest) || rest.split("/").includes("..") || closedPath(rest)) {
      return answer(response, 404, { error: "no such model endpoint" });
    }
    const systemId = request.headers["x-sigillo-system"];
    const sealed = request.headers["x-sigillo-sealed"];
    if (typeof systemId !== "string" || typeof sealed !== "string") return answer(response, 400, { error: "system and sealed key required" });
    let key: string;
    try {
      key = openKey(systemId, provider, sealed);
    } catch {
      return answer(response, 409, { error: "the key does not open" });
    }
    const headers = providerAuth(provider, rest, key);
    for (const name of [...FORWARDED_REQUEST_HEADERS, "content-type"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const body = request.method === "POST" ? await readBody(request) : undefined;
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) abort.abort();
    });
    let upstream: Response;
    try {
      upstream = await fetch(`${upstreamOf(provider)}/${rest}${url.search}`, {
        method: request.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
        signal: abort.signal,
      });
    } catch {
      return answer(response, 502, { error: `${provider} did not answer` });
    }
    const passOn: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (FORWARDED_RESPONSE_HEADER.test(name)) passOn[name] = value;
    });
    response.writeHead(upstream.status, passOn);
    if (upstream.body === null) return void response.end();
    try {
      for await (const chunk of upstream.body) response.write(chunk);
    } catch {
      // The provider broke off, or the server went away: what arrived is passed on.
    }
    response.end();
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://keyholder");
    const handle = async (): Promise<void> => {
      if (request.method === "GET" && url.pathname === "/public-key") return answer(response, 200, { public_key: publicKeyBase64 });
      if (request.method === "POST" && url.pathname === "/adopt") {
        const parsed = JSON.parse((await readBody(request, 1024)).toString("utf8")) as { key?: unknown };
        if (typeof parsed.key !== "string" || !/^[0-9a-f]{64}$/.test(parsed.key)) return answer(response, 400, { error: "a 32-byte key in hex" });
        const held = legacyKeyOf(options.directory);
        if (held !== null) return answer(response, held.toString("hex") === parsed.key ? 200 : 409, { adopted: held.toString("hex") === parsed.key });
        writeFileSync(join(options.directory, LEGACY_FILE), `${parsed.key}\n`, { mode: 0o600, flag: "wx" });
        return answer(response, 200, { adopted: true });
      }
      if (url.pathname.startsWith("/call/")) return call(request, response, url);
      return answer(response, 404, { error: "not found" });
    };
    handle().catch(() => {
      if (!response.headersSent) answer(response, 500, { error: "internal error" });
      else response.destroy();
    });
  });

  rmSync(options.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  chmodSync(options.socketPath, 0o660);
  return {
    publicKeyBase64,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
