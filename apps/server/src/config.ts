import { readFileSync } from "node:fs";

/**
 * Settings read from the environment, checked before anything starts.
 *
 * `Number("abc")` is NaN, and Node runs `setInterval(fn, NaN)` every
 * millisecond: an unchecked SIGILLO_CHECKPOINT_MINUTES=abc would have had the
 * checkpoint loop hammer the database and the timestamp authority (review
 * point 16). Every numeric setting goes through here instead, and a value that
 * is not a plain positive whole number stops the server with the variable's
 * name in the message. Secrets can be read from files, so that they need not
 * sit in the environment at all.
 */

export type Environment = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const WHOLE_NUMBER = /^[0-9]+$/;

/**
 * A positive whole number, from `value` or, when that is unset, `fallback`.
 * `name` is what the operator set, and is what the error names.
 */
export function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  const parsed = WHOLE_NUMBER.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ConfigError(
      `${name} must be a whole number from 1 to ${max}, received ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

/** A TCP port, 1 to 65535. */
export function port(name: string, value: string | undefined, fallback: number): number {
  return positiveInteger(name, value, fallback, 65535);
}

/**
 * Which proxies to believe about the client's address and protocol, for
 * Fastify's `trustProxy`: a comma-separated list of addresses, CIDR ranges,
 * or the names `loopback`, `linklocal` and `uniquelocal` (private ranges).
 * Unset: none, and the client is whoever opened the connection.
 *
 * `true` and hop counts are refused on purpose. Every attempt limit is keyed
 * on the client's address, and trusting X-Forwarded-For from anyone would let
 * a client pick a new address for every guess.
 */
export function trustProxy(value: string | undefined): string | false {
  if (value === undefined || value.trim().length === 0) return false;
  if (value === "true" || value === "false" || WHOLE_NUMBER.test(value)) {
    throw new ConfigError(
      "SIGILLO_TRUST_PROXY takes the addresses of the proxies to trust (for example uniquelocal behind " +
        `the supplied docker-compose.yml), not ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * A secret, from `<name>_FILE` (a file holding it, as Docker and Compose
 * secrets provide) or else from `<name>` itself. The file form keeps the value
 * out of the process environment, out of `docker inspect` and out of
 * `docker compose config`. One trailing newline is dropped, because editors
 * add one. Error messages name the variable, never the value.
 */
export function readSecret(env: Environment, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  const direct = env[name];
  if (file !== undefined && file.length > 0) {
    if (direct !== undefined && direct.length > 0) {
      throw new ConfigError(`set ${name}_FILE or ${name}, not both`);
    }
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
      throw new ConfigError(`${name}_FILE names a file that cannot be read (${code})`);
    }
    return text.replace(/\r?\n$/, "");
  }
  return direct === undefined || direct.length === 0 ? undefined : direct;
}

/** SIGILLO_COOKIE_SECURE: true, false, or unset for "auto" (Secure over HTTPS). */
export function cookieSecure(value: string | undefined): boolean | "auto" {
  if (value === undefined || value.length === 0 || value === "auto") return "auto";
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError(`SIGILLO_COOKIE_SECURE must be true, false or auto, received ${JSON.stringify(value)}`);
}
