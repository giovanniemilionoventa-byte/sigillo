import { constants, createDecipheriv, createPrivateKey, generateKeyPairSync, privateDecrypt, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BOX_MIN_BITS, BOX_PREFIX, isBoxed } from "@sigillo/server/gateway";

/**
 * The keyholder's half of the sealed box (the server's half, sealing, is
 * apps/server/src/gateway/key-box.ts): its RSA key, and opening.
 */

export function openBox(recipient: KeyObject, sealed: string, aad: Buffer): Buffer {
  if (!isBoxed(sealed)) throw new Error("not a sealed box");
  const bytes = Buffer.from(sealed.slice(BOX_PREFIX.length), "base64");
  if (bytes.length < 2) throw new Error("a sealed box too short");
  const wrappedLength = bytes.readUInt16BE(0);
  if (bytes.length < 2 + wrappedLength + 12 + 16) throw new Error("a sealed box too short");
  const wrapped = bytes.subarray(2, 2 + wrappedLength);
  const iv = bytes.subarray(2 + wrappedLength, 2 + wrappedLength + 12);
  const body = bytes.subarray(2 + wrappedLength + 12, bytes.length - 16);
  const tag = bytes.subarray(bytes.length - 16);
  const key = privateDecrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, wrapped);
  if (key.length !== 32) throw new Error("a sealed box with a wrong key length");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** The keyholder's RSA key, made on first start (PKCS#8 PEM, mode 0600). */
export function loadOrCreateBoxKey(path: string): KeyObject {
  if (!existsSync(path)) {
    const pair = generateKeyPairSync("rsa", { modulusLength: BOX_MIN_BITS });
    try {
      writeFileSync(path, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return createPrivateKey(readFileSync(path));
}
