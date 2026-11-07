/**
 * Action names the server writes for the SDK heartbeat (connection/watch.ts).
 * Refused from any client: a receipt saying a connection was lost or restored
 * is worth something only if no agent can write one itself.
 */
export const CONNECTION_PREFIX = "sigillo.connection.";

/**
 * Every action name a client may not write, through the native API or OTLP:
 * the server's own connection and guard receipts (`sigillo.`, the prefix
 * above included) and the tools the model gateway saw the model ask for
 * (`model_requested.`, gateway/llm.ts). An agent holds its system's key, so
 * without this it could write a receipt that reads as the server's or the
 * gateway's own: a false alarm, or a false "the model asked for this".
 */
export const SERVER_ONLY_PREFIXES = ["sigillo.", "model_requested."] as const;

/** Whether `name` is one only the server writes (SERVER_ONLY_PREFIXES), in any case. */
export function serverOnlyName(name: string): boolean {
  const lower = name.trimStart().toLowerCase();
  return SERVER_ONLY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
