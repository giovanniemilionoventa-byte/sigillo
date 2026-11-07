import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes, type KeyObject } from "node:crypto";

/**
 * The server's half of the sealed box for a customer's model key: sealing.
 * Anyone holding the keyholder's public key can seal; only the keyholder
 * process (apps/keyholder) opens. The server, which receives the key once from
 * the console's form, seals it and keeps the box; it never holds anything that
 * opens it, and this file has no way to.
 *
 *   box1:<base64 of  u16 length of W | W | IV (12) | ciphertext | GCM tag (16)>
 *
 * A fresh AES-256 key encrypts the model key (AES-256-GCM, the associated data
 * binding the box to its system and provider); W is that AES key encrypted to
 * the keyholder's RSA public key with OAEP-SHA256. node:crypto only.
 */

export const BOX_PREFIX = "box1:";
/** The keyholder's RSA key is at least this long. */
export const BOX_MIN_BITS = 3072;

export function isBoxed(sealed: string): boolean {
  return sealed.startsWith(BOX_PREFIX);
}

export function sealBox(recipient: KeyObject, plain: Buffer, aad: Buffer): string {
  const key = randomBytes(32);
  const wrapped = publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(wrapped.length);
  return BOX_PREFIX + Buffer.concat([length, wrapped, iv, body, cipher.getAuthTag()]).toString("base64");
}

/** The keyholder's public key from the DER (SPKI) bytes it publishes; refuses anything but RSA of BOX_MIN_BITS or more. */
export function boxPublicKey(der: Buffer): KeyObject {
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < BOX_MIN_BITS) throw new Error(`the keyholder's key must be RSA of ${BOX_MIN_BITS} bits or more`);
  return key;
}
