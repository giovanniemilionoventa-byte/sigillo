import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyIdFromRawPublicKey, rawPublicKeyBytes } from "@sigillo/core";
import { Refusal, Signer, StateDirectory, type SignerKey } from "../../../signer/src/index.js";
import { SignerRefusedError } from "../../src/signer/errors.js";
import type { SigningService } from "../../src/storage/store.js";

export interface TestSigner extends SigningService {
  readonly publicKey: KeyObject;
  /** The raw 32 bytes of the public key, base64, as an export manifest carries it. */
  readonly publicKeyBase64: string;
  /** Number of receipts signed, to show the store asks for exactly one per receipt. */
  readonly calls: () => number;
  /** The directory the signer keeps its state in. */
  readonly stateDir: string;
  /** The key itself, for a test that starts a second signer (a second installation) with it. */
  readonly key: SignerKey;
  /**
   * Signs any 32 bytes with the real key, bypassing every rule of the signer.
   * Only what an attacker who holds the key itself can do — the tampering
   * scenarios that forge with it — never what the socket allows.
   */
  forge(digest: Uint8Array): Promise<string>;
}

const directories: string[] = [];
process.on("exit", () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

/** A key as the signer holds it, generated in memory. */
export function createSignerKey(): SignerKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = rawPublicKeyBytes(publicKey);
  return { privateKey, publicKey, keyId: keyIdFromRawPublicKey(raw), publicKeyBase64: Buffer.from(raw).toString("base64") };
}

/**
 * The real signer, in process: the same rules, the same state directory on
 * disk and the same Ed25519 as the separate signer process, without the
 * socket between them. Cryptography is never mocked here, and neither is
 * what the signer agrees to sign.
 *
 * The clock check is off unless a test asks for it (`clockToleranceMs`):
 * most tests write receipts at fixed dates, far from the machine's clock.
 * The order check — a ts_received never earlier than the one before — stays.
 */
export function createTestSigner(
  options: { now?: () => Date; clockToleranceMs?: number; key?: SignerKey; stateDir?: string } = {},
): TestSigner {
  const key = options.key ?? createSignerKey();
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "sigillo-test-signer-"));
  if (options.stateDir === undefined) directories.push(stateDir);
  const signer = new Signer({
    key,
    state: StateDirectory.open(stateDir),
    now: options.now ?? ((): Date => new Date()),
    clockToleranceMs: options.clockToleranceMs ?? Number.POSITIVE_INFINITY,
  });
  let calls = 0;
  const refusals = <T>(work: () => T): Promise<T> => {
    try {
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error instanceof Refusal ? new SignerRefusedError(error.code, `the signer refused: ${error.message}`) : error);
    }
  };
  return {
    keyId: key.keyId,
    publicKey: key.publicKey,
    publicKeyBase64: key.publicKeyBase64,
    stateDir,
    key,
    calls: () => calls,
    signReceipt: (receipt) =>
      refusals(() => {
        calls += 1;
        return signer.signReceipt(receipt).sig;
      }),
    checkpoint: (systemId) => refusals(() => signer.checkpoint(systemId)),
    head: (systemId) => refusals(() => signer.head(systemId)),
    forge: async (digest) => Buffer.from(sign(null, digest, key.privateKey)).toString("base64"),
  };
}
