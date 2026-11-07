import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BOX_PREFIX, boxPublicKey, isBoxed, sealBox } from "../../server/src/gateway/key-box.js";
import { openBox } from "../src/box.js";

/**
 * The sealed box the server seals a customer's model key into, which only the
 * keyholder process can open (security audit 2026-11-07). Real RSA-OAEP-SHA256
 * and AES-256-GCM from node:crypto; nothing mocked.
 */

const pair = () => generateKeyPairSync("rsa", { modulusLength: 3072 });
const AAD = Buffer.from("sigillo provider key\nsys\nopenai");
const one = pair();
const two = pair();

describe("the sealed box", () => {
  it("opens with the keyholder's key, and only with the same associated data", () => {
    const sealed = sealBox(one.publicKey, Buffer.from("sk-proj-THEKEY"), AAD);
    expect(sealed.startsWith(BOX_PREFIX)).toBe(true);
    expect(isBoxed(sealed)).toBe(true);
    expect(sealed).not.toContain("THEKEY");
    expect(openBox(one.privateKey, sealed, AAD).toString()).toBe("sk-proj-THEKEY");
    expect(() => openBox(one.privateKey, sealed, Buffer.from("sigillo provider key\nother\nopenai"))).toThrow();
  });

  it("does not open with another key", () => {
    const sealed = sealBox(one.publicKey, Buffer.from("sk-proj-THEKEY"), AAD);
    expect(() => openBox(two.privateKey, sealed, AAD)).toThrow();
  });

  it("is different every time, and refuses a changed byte", () => {
    const a = sealBox(one.publicKey, Buffer.from("k"), AAD);
    const b = sealBox(one.publicKey, Buffer.from("k"), AAD);
    expect(a).not.toBe(b);
    const bytes = Buffer.from(a.slice(BOX_PREFIX.length), "base64");
    bytes[bytes.length - 20]! ^= 1;
    expect(() => openBox(one.privateKey, BOX_PREFIX + bytes.toString("base64"), AAD)).toThrow();
    expect(() => openBox(one.privateKey, "not a box", AAD)).toThrow();
    expect(() => openBox(one.privateKey, BOX_PREFIX + "AAE=", AAD)).toThrow();
  });

  it("takes only an RSA public key of 3072 bits or more from the keyholder", () => {
    const der = (key: ReturnType<typeof pair>["publicKey"]) => key.export({ format: "der", type: "spki" });
    expect(boxPublicKey(der(one.publicKey)).asymmetricKeyType).toBe("rsa");
    expect(() => boxPublicKey(der(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey))).toThrow();
    expect(() => boxPublicKey(der(generateKeyPairSync("x25519").publicKey))).toThrow();
  });
});
