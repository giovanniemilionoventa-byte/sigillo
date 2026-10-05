import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { loadOrCreateSealingKey, ProviderKeyStore } from "../src/gateway/provider-keys.js";
import { buildServer } from "../src/http/server.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner } from "../test/helpers/signer.js";

const dir = mkdtempSync(join(tmpdir(), "demo-"));
const upstream = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    console.error("upstream got", req.url, req.headers.authorization, JSON.parse(b).model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "B) Sara: coordina persone." } }] }));
  });
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const db = join(dir, "s.db");
const store = ReceiptStore.open(db, createTestSigner());
await store.createSystem("demo-bot", new Date().toISOString());
const keys = ApiKeyStore.open(db);
const token = keys.issue("demo-bot", new Date().toISOString()).token;
const pk = ProviderKeyStore.open(db, loadOrCreateSealingKey(join(dir, "k")));
pk.set("demo-bot", "openai", "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123", new Date().toISOString());
const port = (upstream.address() as { port: number }).port;
const app = buildServer({ store, keys, now: () => new Date(), gateway: { keys: pk, access: "operator", upstream: { openai: `http://127.0.0.1:${port}` } } });
await app.listen({ port: 0, host: "127.0.0.1" });
const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const { spawn } = await import("node:child_process");
const code = await new Promise<number>((resolve) => {
  const child = spawn("python3", ["../../demo/centralino/agente_demo.py"], { env: { ...process.env, SIGILLO_URL: url, SIGILLO_KEY: token }, stdio: "inherit" });
  child.on("exit", (c) => resolve(c ?? 1));
});
console.error("exit", code, "chain:", store.readChain("demo-bot").map((r) => `${r.action.kind}:${r.action.name}:${r.actor.agent}`));
await app.close(); upstream.close();
