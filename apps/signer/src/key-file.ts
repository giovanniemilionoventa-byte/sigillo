import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { keyIdFromRawPublicKey, rawPublicKeyBytes } from "@sigillo/core";

export interface SignerKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly keyId: string;
  /** The raw 32 bytes of the public key, base64. This is what `key_id` is derived from. */
  readonly publicKeyBase64: string;
}

function describe(privateKey: KeyObject): SignerKey {
  const publicKey = createPublicKey(privateKey);
  const raw = rawPublicKeyBytes(publicKey);
  return {
    privateKey,
    publicKey,
    keyId: keyIdFromRawPublicKey(raw),
    publicKeyBase64: Buffer.from(raw).toString("base64"),
  };
}

/**
 * Writes a new Ed25519 private key, readable only by its owner. It refuses to
 * overwrite: losing a signing key silently would orphan every receipt already
 * signed with it.
 */
export function generateKeyFile(path: string): SignerKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  try {
    writeFileSync(path, pem, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`a key file already exists at ${path}, refusing to overwrite it`);
    }
    throw error;
  }
  // writeFileSync's mode is subject to the umask; this is not.
  chmodSync(path, 0o600);
  return describe(privateKey);
}

export function loadKeyFile(path: string): SignerKey {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no key file at ${path}, run "sigillo-signer keygen" first`);
    }
    throw error;
  }

  if ((mode & 0o077) !== 0) {
    const printed = (mode & 0o777).toString(8).padStart(3, "0");
    throw new Error(
      `key file ${path} has permission ${printed}: anyone who can read it can forge receipts. Run chmod 600 on it.`,
    );
  }

  const privateKey = createPrivateKey(readFileSync(path, "utf8"));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`key file ${path} holds a ${privateKey.asymmetricKeyType} key, expected ed25519`);
  }
  return describe(privateKey);
}
