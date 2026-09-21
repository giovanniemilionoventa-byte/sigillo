import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { keyIdFromRawPublicKey, rawPublicKeyBytes } from "@sigillo/core";
import type { SigningService } from "../../src/storage/store.js";

export interface TestSigner extends SigningService {
  readonly publicKey: KeyObject;
  /** Number of signatures produced, to show the store asks for exactly one per receipt. */
  readonly calls: () => number;
}

/**
 * A real Ed25519 signer, in process. Cryptography is never mocked here: the
 * signatures these tests produce are the same signatures the separate signer
 * process will produce, and they are verified with the public key.
 */
export function createTestSigner(): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let calls = 0;
  return {
    keyId: keyIdFromRawPublicKey(rawPublicKeyBytes(publicKey)),
    publicKey,
    calls: () => calls,
    sign: async (digest: Uint8Array): Promise<string> => {
      calls += 1;
      return Buffer.from(sign(null, digest, privateKey)).toString("base64");
    },
  };
}
