import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * RFC 3161 timestamping of a checkpoint's Merkle root.
 *
 * The request is built with the openssl command line, as the specification
 * requires, which keeps the ASN.1 out of this codebase and means an auditor can
 * reproduce the request with the same command. The response token is stored
 * exactly as it arrives, in DER, so that `openssl ts -verify` can check it years
 * later without sigillo being involved at all.
 *
 * A timestamp says the root existed no later than the time in the token. It
 * says nothing about what was in the tree; that is what the signatures and the
 * chain are for.
 */

const run = promisify(execFile);

const TIMESTAMP_QUERY = "application/timestamp-query";
const TIMESTAMP_REPLY = "application/timestamp-reply";
const DIGEST = /^[0-9a-f]{64}$/;

export class TimestampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimestampError";
  }
}

export interface TsaOptions {
  url: string;
  /** Some qualified providers authenticate the request. */
  username?: string;
  password?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Builds the TimeStampReq for a digest: `openssl ts -query -sha256 -digest ... -cert -no_nonce`. */
export async function buildTimestampRequest(digestHex: string): Promise<Uint8Array> {
  if (!DIGEST.test(digestHex)) {
    throw new TimestampError("a timestamp is taken over a 32-byte digest in lowercase hex");
  }
  try {
    const { stdout } = await run(
      "openssl",
      ["ts", "-query", "-sha256", "-digest", digestHex, "-cert", "-no_nonce"],
      { encoding: "buffer", maxBuffer: 64 * 1024 },
    );
    if (stdout.length === 0) {
      throw new TimestampError("openssl produced an empty timestamp request");
    }
    return new Uint8Array(stdout);
  } catch (error) {
    if (error instanceof TimestampError) throw error;
    throw new TimestampError(
      `could not build the timestamp request with openssl: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Asks the authority for a token over `digestHex`, returning it base64-encoded. */
export async function requestTimestamp(digestHex: string, options: TsaOptions): Promise<string> {
  const body = await buildTimestampRequest(digestHex);
  const headers: Record<string, string> = { "Content-Type": TIMESTAMP_QUERY };
  if (options.username !== undefined && options.password !== undefined) {
    const credentials = Buffer.from(`${options.username}:${options.password}`).toString("base64");
    headers["Authorization"] = `Basic ${credentials}`;
  }

  const send = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await send(options.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
  } catch (error) {
    throw new TimestampError(
      `the timestamp authority at ${options.url} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!response.ok) {
    throw new TimestampError(
      `the timestamp authority at ${options.url} answered ${response.status}`,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType !== "" && !contentType.includes(TIMESTAMP_REPLY)) {
    throw new TimestampError(
      `the timestamp authority answered with ${contentType}, expected ${TIMESTAMP_REPLY}`,
    );
  }

  const token = new Uint8Array(await response.arrayBuffer());
  if (token.length === 0) {
    throw new TimestampError("the timestamp authority returned an empty token");
  }
  // A DER SEQUENCE, which every TimeStampResp is. Not a full parse: openssl
  // does that on verification, and a malformed token must not pass for one.
  if (token[0] !== 0x30) {
    throw new TimestampError("the timestamp authority returned something that is not DER");
  }
  return Buffer.from(token).toString("base64");
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tries a few times with a doubling delay. A checkpoint is already stored and
 * signed by the time this runs, so a timestamp that cannot be obtained now is a
 * timestamp obtained later, not a lost checkpoint.
 */
export async function requestTimestampWithRetry(
  digestHex: string,
  options: TsaOptions,
  retry: RetryOptions = {},
): Promise<string> {
  const attempts = retry.attempts ?? 3;
  const baseDelay = retry.baseDelayMs ?? 1000;
  const sleep = retry.sleep ?? wait;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestTimestamp(digestHex, options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(baseDelay * 2 ** attempt);
      }
    }
  }
  throw new TimestampError(
    `no timestamp after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
