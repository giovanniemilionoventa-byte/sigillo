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

/**
 * SIGILLO_INGEST_PAUSED (true, false or unset) and SIGILLO_INGEST_PAUSE_EXCEPT
 * (system identifiers, comma-separated): writes paused for maintenance, so
 * that an upgrade can be checked, and if need be undone, before any real
 * system has a receipt the previous version cannot read (DEPLOY.md). Null
 * when writes are open. An exception without a pause is refused: it would
 * read as a pause that is not there.
 */
export function ingestPause(env: Environment): { except: ReadonlySet<string> } | null {
  const paused = env["SIGILLO_INGEST_PAUSED"];
  const except = (env["SIGILLO_INGEST_PAUSE_EXCEPT"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (paused === undefined || paused.length === 0 || paused === "false") {
    if (except.length > 0) {
      throw new ConfigError("SIGILLO_INGEST_PAUSE_EXCEPT is set but SIGILLO_INGEST_PAUSED is not true");
    }
    return null;
  }
  if (paused !== "true") {
    throw new ConfigError(`SIGILLO_INGEST_PAUSED must be true or false, received ${JSON.stringify(paused)}`);
  }
  return { except: new Set(except) };
}

/**
 * SIGILLO_LLM_GATEWAY: who may use the model gateway (gateway/llm.ts). `off`
 * serves no /llm/* at all; `operator`, the default, the operator's own
 * systems only; `all`, every account's. A new feature reaches the operator's
 * account first and every customer only once the owner says so (CLAUDE.md,
 * rule 11): opening it is this one setting.
 */
export function llmGateway(env: Environment): "off" | "operator" | "all" {
  const value = env["SIGILLO_LLM_GATEWAY"];
  if (value === undefined || value.length === 0) return "operator";
  if (value === "off" || value === "operator" || value === "all") return value;
  throw new ConfigError(`SIGILLO_LLM_GATEWAY must be off, operator or all, received ${JSON.stringify(value)}`);
}

/**
 * Whether the gateway also writes a receipt for each tool a model asks for
 * (gateway/tool-requests.ts): SIGILLO_LLM_TOOL_REQUESTS, `off`, `operator`
 * (the default) or `all`. New, so for the administrator's own systems until
 * the owner says otherwise (CLAUDE.md, rule 11).
 */
export function llmToolRequests(env: Environment): "off" | "operator" | "all" {
  const value = env["SIGILLO_LLM_TOOL_REQUESTS"];
  if (value === undefined || value.length === 0) return "operator";
  if (value === "off" || value === "operator" || value === "all") return value;
  throw new ConfigError(`SIGILLO_LLM_TOOL_REQUESTS must be off, operator or all, received ${JSON.stringify(value)}`);
}

/**
 * Customers' accounts (auth/firebase.ts): SIGILLO_FIREBASE_API_KEY and
 * SIGILLO_FIREBASE_PROJECT_ID, both or neither, and SIGILLO_PUBLIC_URL, the
 * address browsers reach this installation at, to which Google sends them
 * back. Null when not configured: the web view then has the operator's
 * password only. The address must be https, except on this machine.
 */
export function firebaseAccounts(env: Environment): { apiKey: string; projectId: string; publicUrl: string } | null {
  const apiKey = (env["SIGILLO_FIREBASE_API_KEY"] ?? "").trim();
  const projectId = (env["SIGILLO_FIREBASE_PROJECT_ID"] ?? "").trim();
  const publicUrl = (env["SIGILLO_PUBLIC_URL"] ?? "").replace(/\/+$/, "");
  if (apiKey === "" && projectId === "") return null;
  if (apiKey === "" || projectId === "") {
    throw new ConfigError("SIGILLO_FIREBASE_API_KEY and SIGILLO_FIREBASE_PROJECT_ID go together: set both, or neither");
  }
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(apiKey)) {
    // Says what is wrong without repeating the value: a key pasted from a
    // chat can carry characters no one can see (2026-10-02).
    const foreign = [...apiKey].filter((character) => !/[A-Za-z0-9_-]/.test(character)).length;
    throw new ConfigError(
      `SIGILLO_FIREBASE_API_KEY does not look like a Firebase web API key: ${[...apiKey].length} characters, ` +
        `${foreign} of them not a letter, digit, "-" or "_" (a web API key is 39 characters, starting AIza)`,
    );
  }
  if (!/^[a-z0-9-]{4,40}$/.test(projectId)) {
    throw new ConfigError("SIGILLO_FIREBASE_PROJECT_ID does not look like a Firebase project id");
  }
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new ConfigError(
      `SIGILLO_PUBLIC_URL must be the address browsers reach this installation at, such as https://sigillo.example.com, received ${JSON.stringify(publicUrl)}`,
    );
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ConfigError(`SIGILLO_PUBLIC_URL must be an https origin with no path, received ${JSON.stringify(publicUrl)}`);
  }
  return { apiKey, projectId, publicUrl: url.origin };
}
