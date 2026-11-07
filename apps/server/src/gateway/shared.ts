/**
 * What the keyholder (apps/keyholder) shares with the server's gateway, as the
 * subpath `@sigillo/server/gateway`: the catalogue of providers and paths, the
 * paths refused, the headers passed each way, how a provider takes its key,
 * the associated data binding a key to its system and provider, and the older
 * AES opening for keys sealed before the keyholder existed. Nothing here holds
 * a key.
 */
export { CATALOG, isProvider, type Provider } from "./catalog.js";
export { closedPath, FORWARDED_REQUEST_HEADERS, FORWARDED_RESPONSE_HEADER, providerAuth, UPSTREAM } from "./llm.js";
export { associatedData, open as openLegacy } from "./provider-keys.js";
export { BOX_MIN_BITS, BOX_PREFIX, isBoxed } from "./key-box.js";
export { KeyholderClient } from "./keyholder-client.js";
