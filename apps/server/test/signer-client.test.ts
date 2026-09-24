import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, type KeyObject, verify } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fromHex,
  keyIdFromRawPublicKey,
  parseReceipt,
  publicKeyFromRaw,
  receiptHashHex,
  verifyReceiptSignature,
} from "@sigillo/core";
import { SignerClient, SignerUnavailableError } from "../src/signer/client.js";
import { ReceiptStore } from "../src/storage/store.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const SIGNER_CLI = join(REPOSITORY_ROOT, "apps", "signer", "src", "cli.ts");
const DIGEST = "74a67e081df5c321729640090e63ca95991f9657bfaab0af51e4504cc2056241";

let directory: string;
let keyPath: string;
let socketPath: string;
let daemon: ChildProcessWithoutNullStreams | undefined;

/**
 * tsx runs the script in a child of its own, so the signer is killed by process
 * group: killing the wrapper alone would leave a signer listening.
 */
function killSigner(child: ChildProcessWithoutNullStreams | undefined): void {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/** Runs the signer CLI the way an operator would, and waits for a line of output. */
function runSignerCli(args: string[], waitFor: RegExp): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [SIGNER_CLI, ...args], { cwd: REPOSITORY_ROOT, detached: true });
    let output = "";
    let errors = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`signer did not print ${waitFor} (stdout: ${output}, stderr: ${errors})`));
    }, 30_000);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (waitFor.test(output)) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!waitFor.test(output)) {
        reject(new Error(`signer exited with ${code} (stderr: ${errors})`));
      }
    });
  });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-e2e-"));
  keyPath = join(directory, "signer.key");
  socketPath = join(directory, "signer.sock");

  const keygen = await runSignerCli(["keygen", "--key", keyPath], /public_key_base64/);
  killSigner(keygen);
  daemon = await runSignerCli(
    ["serve", "--key", keyPath, "--socket", socketPath],
    /listening on/,
  );
}, 60_000);

afterEach(() => {
  killSigner(daemon);
  daemon = undefined;
  rmSync(directory, { recursive: true, force: true });
});

/** The public key as an auditor gets it: from the signer's own key file, out of band. */
function publicKeyFromKeyFile(): KeyObject {
  return createPublicKey(createPrivateKey(readFileSync(keyPath, "utf8")));
}

describe("a server talking to a signer in another process", () => {
  it("learns the key identity over the socket alone", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      expect(client.keyId).toMatch(/^[0-9a-f]{16}$/);
      const raw = new Uint8Array(Buffer.from(client.publicKeyBase64, "base64"));
      expect(keyIdFromRawPublicKey(raw)).toBe(client.keyId);
      expect(raw).toHaveLength(32);
    } finally {
      client.close();
    }
  });

  it("gets signatures that verify under the signer's public key", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      const signature = await client.sign(fromHex(DIGEST));
      expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
      const announced = publicKeyFromRaw(
        new Uint8Array(Buffer.from(client.publicKeyBase64, "base64")),
      );
      expect(verify(null, fromHex(DIGEST), announced, Buffer.from(signature, "base64"))).toBe(true);
      // The key the signer announced really is the key in its key file.
      expect(announced.export({ format: "der", type: "spki" })).toEqual(
        publicKeyFromKeyFile().export({ format: "der", type: "spki" }),
      );
    } finally {
      client.close();
    }
  });

  it("refuses to ask for a signature over anything but a 32-byte hash", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      await expect(client.sign(new Uint8Array(31))).rejects.toThrow(/32 bytes/);
      await expect(client.sign(new Uint8Array(64))).rejects.toThrow(/32 bytes/);
    } finally {
      client.close();
    }
  });

  it("writes a whole chain whose receipts verify, without ever holding the key", async () => {
    const client = await SignerClient.connect(socketPath);
    const store = ReceiptStore.open(join(directory, "sigillo.db"), client);
    try {
      await store.createSystem("acme-support-bot", "2026-03-29T14:30:00.000Z");
      for (let index = 0; index < 5; index += 1) {
        await store.append({
          system_id: "acme-support-bot",
          ts_event: "2026-03-29T14:30:01.000Z",
          ts_received: "2026-03-29T14:30:01.005Z",
          actor: { agent: "planner" },
          action: { kind: "tool_call", name: `call-${index}` },
          input_hash: null,
          output_hash: null,
          outcome: "ok",
          source: { type: "sdk" },
        });
      }

      const raw = new Uint8Array(Buffer.from(client.publicKeyBase64, "base64"));
      const publicKey = publicKeyFromRaw(raw);
      const chain = store.readChain("acme-support-bot");
      expect(chain).toHaveLength(6);

      let previous = "0".repeat(64);
      for (const receipt of chain) {
        expect(parseReceipt(receipt)).toEqual(receipt);
        expect(receipt.key_id).toBe(client.keyId);
        expect(receipt.prev_hash).toBe(previous);
        expect(verifyReceiptSignature(receipt, publicKey)).toBe(true);
        previous = receiptHashHex(receipt);
      }
    } finally {
      store.close();
      client.close();
    }
  }, 30_000);

  it("reports a signer that is not there instead of hanging", async () => {
    await expect(SignerClient.connect(join(directory, "absent.sock"))).rejects.toBeInstanceOf(
      SignerUnavailableError,
    );
  });

  it("fails the write rather than storing an unsigned receipt when the signer dies", async () => {
    const client = await SignerClient.connect(socketPath);
    const store = ReceiptStore.open(join(directory, "broken.db"), client);
    try {
      await store.createSystem("acme-support-bot", "2026-03-29T14:30:00.000Z");
      killSigner(daemon);
      daemon = undefined;

      await expect(
        store.append({
          system_id: "acme-support-bot",
          ts_event: "2026-03-29T14:30:01.000Z",
          ts_received: "2026-03-29T14:30:01.005Z",
          actor: { agent: "planner" },
          action: { kind: "tool_call", name: "after-the-signer-died" },
          input_hash: null,
          output_hash: null,
          outcome: "ok",
          source: { type: "sdk" },
        }),
      ).rejects.toBeInstanceOf(SignerUnavailableError);

      // The chain is still exactly the genesis receipt: no gap, no unsigned row.
      expect(store.readChain("acme-support-bot").map((receipt) => receipt.seq)).toEqual([0]);
    } finally {
      store.close();
      client.close();
    }
  }, 30_000);
});

describe("a signer that restarts under a running server", () => {
  // Review point 11: the signer container restarts (an upgrade, a crash, the
  // host rebooting it) while the server keeps running. Real signer processes,
  // the same key file, the same socket path.
  const restartSigner = async (key = keyPath): Promise<void> => {
    killSigner(daemon);
    daemon = await runSignerCli(["serve", "--key", key, "--socket", socketPath], /listening on/);
  };

  it("reconnects on the next request, and signs again with the same key", async () => {
    const client = await SignerClient.connect(socketPath);
    try {
      await client.sign(fromHex(DIGEST));
      killSigner(daemon);
      daemon = undefined;
      await expect(client.sign(fromHex(DIGEST))).rejects.toBeInstanceOf(SignerUnavailableError);
      expect(await client.healthy()).toBe(false);

      await restartSigner();
      const signature = await client.sign(fromHex(DIGEST));
      expect(verify(null, fromHex(DIGEST), publicKeyFromKeyFile(), Buffer.from(signature, "base64"))).toBe(true);
      expect(await client.healthy()).toBe(true);
    } finally {
      client.close();
    }
  }, 60_000);

  it("refuses to carry on with a signer that now holds a different key", async () => {
    const client = await SignerClient.connect(socketPath);
    const originalKeyId = client.keyId;
    try {
      const otherKey = join(directory, "other.key");
      killSigner(await runSignerCli(["keygen", "--key", otherKey], /public_key_base64/));
      await restartSigner(otherKey);

      // Signatures under a key the server never announced would be refused by
      // the store anyway; the client says why, and does not adopt the new key.
      await expect(client.sign(fromHex(DIGEST))).rejects.toThrow(/different key/);
      expect(client.keyId).toBe(originalKeyId);
      expect(await client.healthy()).toBe(false);
    } finally {
      client.close();
    }
  }, 60_000);

  it("stays closed once its owner has closed it", async () => {
    const client = await SignerClient.connect(socketPath);
    client.close();
    await expect(client.sign(fromHex(DIGEST))).rejects.toBeInstanceOf(SignerUnavailableError);
    expect(await client.healthy()).toBe(false);
  }, 30_000);
});

describe("a signer that stalls past the timeout", () => {
  // The real signer process, frozen with SIGSTOP the way a GC pause, swap or an
  // overloaded host would freeze it. Requests written meanwhile wait in the
  // socket; on SIGCONT the signer answers all of them, strictly in order —
  // including the one the server has already given up on.

  const freeze = (): void => {
    if (daemon?.pid !== undefined) process.kill(-daemon.pid, "SIGSTOP");
  };
  const thaw = (): void => {
    if (daemon?.pid !== undefined) process.kill(-daemon.pid, "SIGCONT");
  };
  const digestOf = (text: string): Uint8Array =>
    new Uint8Array(createHash("sha256").update(text).digest());
  const announcedKey = (client: SignerClient): KeyObject =>
    publicKeyFromRaw(new Uint8Array(Buffer.from(client.publicKeyBase64, "base64")));
  const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it("never hands a reply that arrived too late to the request after it", async () => {
    const client = await SignerClient.connect(socketPath, { timeoutMs: 1000 });
    const key = announcedKey(client);
    const first = digestOf("receipt A");
    const second = digestOf("receipt B");
    const third = digestOf("receipt C");
    try {
      freeze();
      const started = Date.now();
      await expect(client.sign(first)).rejects.toBeInstanceOf(SignerUnavailableError);
      // It fails within its own deadline, not whenever the signer wakes up.
      expect(Date.now() - started).toBeLessThan(3000);

      const pending = client.sign(second);
      await settle(100);
      thaw();
      // The signer now answers A (late) and then B. B must get B's signature.
      const signature = await pending;
      expect(verify(null, second, key, Buffer.from(signature, "base64"))).toBe(true);
      expect(verify(null, first, key, Buffer.from(signature, "base64"))).toBe(false);

      // And the client is still usable: nothing from A lingers to meet C.
      const after = await client.sign(third);
      expect(verify(null, third, key, Buffer.from(after, "base64"))).toBe(true);
    } finally {
      thaw();
      client.close();
    }
  }, 30_000);

  it("stores no receipt with a wrong signature when a write times out and the next one succeeds", async () => {
    const client = await SignerClient.connect(socketPath, { timeoutMs: 1000 });
    const store = ReceiptStore.open(join(directory, "stalled.db"), client);
    const write = (name: string) =>
      store.append({
        system_id: "acme-support-bot",
        ts_event: "2026-03-29T14:30:01.000Z",
        ts_received: "2026-03-29T14:30:01.005Z",
        actor: { agent: "planner" },
        action: { kind: "tool_call", name },
        input_hash: null,
        output_hash: null,
        outcome: "ok",
        source: { type: "sdk" },
      });
    try {
      await store.createSystem("acme-support-bot", "2026-03-29T14:30:00.000Z");

      freeze();
      await expect(write("timed-out")).rejects.toBeInstanceOf(SignerUnavailableError);
      const next = write("written-after");
      await settle(100);
      thaw();
      await next;

      const key = announcedKey(client);
      const chain = store.readChain("acme-support-bot");
      expect(chain.map((receipt) => [receipt.seq, receipt.action.name])).toEqual([
        [0, "acme-support-bot"],
        [1, "written-after"],
      ]);
      for (const receipt of chain) {
        expect(verifyReceiptSignature(receipt, key), `seq ${receipt.seq}`).toBe(true);
      }
    } finally {
      thaw();
      store.close();
      client.close();
    }
  }, 30_000);
});

describe("the key file", () => {
  /** Every TypeScript file the server ships. */
  function serverSources(directoryPath: string, files: string[] = []): string[] {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const full = join(directoryPath, entry.name);
      if (entry.isDirectory()) serverSources(full, files);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
    return files;
  }

  it("is never opened by the server, which has no code that could load a private key", () => {
    const sources = serverSources(join(REPOSITORY_ROOT, "apps", "server", "src"));
    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const forbidden of ["createPrivateKey", "generateKeyPair", "privateKey"]) {
        expect(text, `${file} refers to ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("is not something the signer client can even be pointed at", async () => {
    // The only address the server holds is the socket. Handing it the key file
    // instead fails, rather than quietly reading the key.
    await expect(SignerClient.connect(keyPath)).rejects.toBeInstanceOf(SignerUnavailableError);
  });
});
