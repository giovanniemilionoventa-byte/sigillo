/**
 * Action names the server writes for the SDK heartbeat (connection/watch.ts).
 * Refused from any client: a receipt saying a connection was lost or restored
 * is worth something only if no agent can write one itself.
 */
export const CONNECTION_PREFIX = "sigillo.connection.";
