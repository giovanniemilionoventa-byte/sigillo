import { generateKeyPairSync } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  keyIdFromRawPublicKey,
  rawPublicKeyBytes,
  receiptHashHex,
  signReceipt,
  type Receipt,
} from "@sigillo/core";
import { verifyBundle, type Bundle, type VerificationCheck } from "../src/verify.js";
import {
  buildBundle,
  buildManifest,
  buildReceipts,
  createIdentity,
  fromLines,
  lines,
  toBundle,
} from "./helpers/chain.js";

const identity = createIdentity();

function expectFailure(bundle: Bundle, check: VerificationCheck): string {
  const result = verifyBundle(bundle);
  expect(result.ok, `expected the ${check} check to fail`).toBe(false);
  if (result.ok) return "";
  expect(result.check).toBe(check);
  expect(result.location.length).toBeGreaterThan(0);
  expect(result.detail.length).toBeGreaterThan(0);
  return `${result.check} at ${result.location}: ${result.detail}`;
}

describe("a well-formed export", () => {
  it("verifies", () => {
    const result = verifyBundle(buildBundle(12, identity));
    expect(result.ok ? "" : `${result.check}: ${result.detail}`).toBe("");
  });

  it("reports what it checked", () => {
    const result = verifyBundle(buildBundle(5, identity));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toMatchObject({
      system_id: "acme-support-bot",
      receipts: 5,
      first_seq: 0,
      last_seq: 4,
    });
    expect(result.summary.key_ids).toEqual([identity.keyId]);
  });

  it("verifies a chain of a single genesis receipt", () => {
    expect(verifyBundle(buildBundle(1, identity)).ok).toBe(true);
  });

  it("does not depend on how the lines were serialised", () => {
    const receipts = buildReceipts(4, identity);
    const manifest = buildManifest(receipts, identity);
    // Same receipts, keys written in a different order and with whitespace.
    const reserialised = receipts
      .map((receipt) => {
        const reversed = Object.fromEntries(Object.entries(receipt).reverse());
        return JSON.stringify(reversed, null, 1).replace(/\n/g, " ");
      })
      .join("\n");
    const result = verifyBundle({
      manifestJson: manifest ? JSON.stringify(manifest) : "",
      receiptsJsonl: `${reserialised}\n`,
    });
    expect(result.ok ? "" : `${result.check}: ${result.detail}`).toBe("");
  });
});

describe("tampering with a receipt", () => {
  it("detects a single changed byte", () => {
    const bundle = buildBundle(6, identity);
    const changed = lines(bundle);
    const target = changed[3];
    expect(target).toBeDefined();
    if (target === undefined) return;
    const receipt = JSON.parse(target) as Receipt;
    changed[3] = canonicalJson({ ...receipt, action: { ...receipt.action, name: "call-X" } });

    const message = expectFailure(fromLines(bundle, changed), "chain-link");
    expect(message).toMatch(/seq 4/);
    expect(message).toMatch(/seq 3/);
  });

  it("detects a changed byte in the last receipt, where no link covers it", () => {
    const bundle = buildBundle(6, identity);
    const changed = lines(bundle);
    const receipt = JSON.parse(changed[5] ?? "{}") as Receipt;
    changed[5] = canonicalJson({ ...receipt, outcome: "error" });

    const message = expectFailure(fromLines(bundle, changed), "signature");
    expect(message).toMatch(/seq 5/);
  });

  it("detects a deleted receipt", () => {
    const bundle = buildBundle(6, identity);
    const remaining = lines(bundle).filter((_unused, index) => index !== 2);
    const message = expectFailure(fromLines(bundle, remaining), "sequence");
    expect(message).toMatch(/seq 2/);
  });

  it("detects a deleted last receipt, which leaves a chain that is valid but short", () => {
    const bundle = buildBundle(6, identity);
    const remaining = lines(bundle).slice(0, 5);
    const message = expectFailure(fromLines(bundle, remaining), "range");
    expect(message).toMatch(/5/);
  });

  it("detects two receipts swapped", () => {
    const bundle = buildBundle(6, identity);
    const swapped = lines(bundle);
    const third = swapped[2];
    const fourth = swapped[3];
    expect(third).toBeDefined();
    expect(fourth).toBeDefined();
    if (third === undefined || fourth === undefined) return;
    swapped[2] = fourth;
    swapped[3] = third;

    const message = expectFailure(fromLines(bundle, swapped), "sequence");
    expect(message).toMatch(/seq 3/);
  });

  it("detects a duplicated receipt", () => {
    const bundle = buildBundle(6, identity);
    const duplicated = lines(bundle);
    const third = duplicated[2];
    expect(third).toBeDefined();
    if (third === undefined) return;
    duplicated.splice(3, 0, third);

    const message = expectFailure(fromLines(bundle, duplicated), "sequence");
    expect(message).toMatch(/seq 2/);
  });

  it("detects a receipt signed by another key", () => {
    const other = createIdentity();
    const receipts = buildReceipts(4, identity);
    const target = receipts[2];
    expect(target).toBeDefined();
    if (target === undefined) return;

    // Same content, same announced key_id, but signed by a key that is not that one.
    const { sig: _sig, ...unsigned } = target;
    receipts[2] = signReceipt(unsigned, other.privateKey);

    const message = expectFailure(
      toBundle(receipts, buildManifest(receipts, identity)),
      "signature",
    );
    expect(message).toMatch(/seq 2/);
    expect(message).toMatch(new RegExp(identity.keyId));
  });

  it("detects a key_id that the manifest does not list", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const strangerKeyId = keyIdFromRawPublicKey(rawPublicKeyBytes(publicKey));

    const receipts = buildReceipts(4, identity);
    const target = receipts[1];
    expect(target).toBeDefined();
    if (target === undefined) return;
    const { sig: _sig, ...unsigned } = target;
    receipts[1] = signReceipt({ ...unsigned, key_id: strangerKeyId }, identity.privateKey);
    // Re-link the receipts that follow, so only the unknown key is wrong.
    relink(receipts, identity);

    const message = expectFailure(
      toBundle(receipts, buildManifest(receipts, identity)),
      "key",
    );
    expect(message).toMatch(new RegExp(strangerKeyId));
  });

  it("detects a forged genesis", () => {
    const receipts = buildReceipts(4, identity);
    const genesis = receipts[0];
    expect(genesis).toBeDefined();
    if (genesis === undefined) return;
    const { sig: _sig, ...unsigned } = genesis;
    receipts[0] = signReceipt(
      { ...unsigned, action: { kind: "tool_call", name: "not-a-genesis" } },
      identity.privateKey,
    );
    relink(receipts, identity);

    expectFailure(toBundle(receipts, buildManifest(receipts, identity)), "genesis");
  });

  it("detects receipts from another system smuggled in", () => {
    const receipts = buildReceipts(4, identity);
    const target = receipts[2];
    expect(target).toBeDefined();
    if (target === undefined) return;
    const { sig: _sig, ...unsigned } = target;
    receipts[2] = signReceipt({ ...unsigned, system_id: "another-system" }, identity.privateKey);
    relink(receipts, identity);

    expectFailure(toBundle(receipts, buildManifest(receipts, identity)), "system");
  });
});

describe("tampering with the manifest", () => {
  it("detects a manifest that is not valid JSON", () => {
    const bundle = buildBundle(3, identity);
    expectFailure({ ...bundle, manifestJson: "{not json" }, "manifest");
  });

  it("detects a manifest missing a required field", () => {
    const bundle = buildBundle(3, identity);
    const manifest = JSON.parse(bundle.manifestJson) as Record<string, unknown>;
    delete manifest["counts"];
    expectFailure({ ...bundle, manifestJson: JSON.stringify(manifest) }, "manifest");
  });

  it("detects a public key swapped for another", () => {
    const bundle = buildBundle(3, identity);
    const other = createIdentity();
    const manifest = JSON.parse(bundle.manifestJson) as {
      keys: { key_id: string; public_key_base64: string }[];
    };
    // The manifest keeps the announced key_id but carries a different key.
    manifest.keys = [{ key_id: identity.keyId, public_key_base64: other.publicKeyBase64 }];
    expectFailure({ ...bundle, manifestJson: JSON.stringify(manifest) }, "key");
  });

  it("detects a count that does not match the receipts", () => {
    const bundle = buildBundle(3, identity);
    const manifest = JSON.parse(bundle.manifestJson) as { counts: { receipts: number } };
    manifest.counts.receipts = 4;
    expectFailure({ ...bundle, manifestJson: JSON.stringify(manifest) }, "range");
  });

  it("detects a system_id that does not match the receipts", () => {
    const bundle = buildBundle(3, identity);
    const manifest = JSON.parse(bundle.manifestJson) as { system_id: string };
    manifest.system_id = "someone-elses-system";
    expectFailure({ ...bundle, manifestJson: JSON.stringify(manifest) }, "system");
  });
});

describe("malformed input", () => {
  it("rejects an empty receipts file", () => {
    const bundle = buildBundle(3, identity);
    expectFailure({ ...bundle, receiptsJsonl: "" }, "range");
  });

  it("rejects a line that is not JSON", () => {
    const bundle = buildBundle(3, identity);
    const broken = lines(bundle);
    broken[1] = "this is not json";
    expectFailure(fromLines(bundle, broken), "receipt-json");
  });

  it("rejects a line that is JSON but not a receipt", () => {
    const bundle = buildBundle(3, identity);
    const broken = lines(bundle);
    broken[1] = JSON.stringify({ hello: "world" });
    expectFailure(fromLines(bundle, broken), "receipt-schema");
  });

  it("names the line number of the offending receipt", () => {
    const bundle = buildBundle(5, identity);
    const broken = lines(bundle);
    broken[3] = "{";
    const result = verifyBundle(fromLines(bundle, broken));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.location).toContain("receipts.jsonl:4");
  });
});

/** Re-links a chain after one receipt was rebuilt, leaving exactly one defect in place. */
function relink(receipts: Receipt[], signer: ReturnType<typeof createIdentity>): void {
  for (let index = 1; index < receipts.length; index += 1) {
    const previous = receipts[index - 1];
    const current = receipts[index];
    if (previous === undefined || current === undefined) continue;
    const { sig: _sig, ...unsigned } = current;
    receipts[index] = signReceipt(
      { ...unsigned, prev_hash: receiptHashHex(previous) },
      signer.privateKey,
    );
  }
}

describe("properties", () => {
  it("accepts every well-formed chain", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (length) => {
        return verifyBundle(buildBundle(length, identity)).ok;
      }),
      { numRuns: 25 },
    );
  });

  it("rejects any single character changed anywhere in the receipts", () => {
    const bundle = buildBundle(4, identity);
    const text = bundle.receiptsJsonl;

    fc.assert(
      fc.property(
        fc.nat({ max: text.length - 1 }),
        fc.constantFrom("0", "1", "a", "z", "Z", "-", "{"),
        (position, replacement) => {
          const original = text[position];
          fc.pre(original !== undefined && original !== replacement && original !== "\n");
          const mutated = `${text.slice(0, position)}${replacement}${text.slice(position + 1)}`;
          return !verifyBundle({ ...bundle, receiptsJsonl: mutated }).ok;
        },
      ),
      { numRuns: 300 },
    );
  });

  it("rejects the removal of any single receipt", () => {
    const bundle = buildBundle(6, identity);
    fc.assert(
      fc.property(fc.nat({ max: 5 }), (index) => {
        const remaining = lines(bundle).filter((_unused, position) => position !== index);
        return !verifyBundle(fromLines(bundle, remaining)).ok;
      }),
      { numRuns: 20 },
    );
  });

  it("rejects the duplication of any single receipt", () => {
    const bundle = buildBundle(6, identity);
    fc.assert(
      fc.property(fc.nat({ max: 5 }), (index) => {
        const duplicated = lines(bundle);
        const target = duplicated[index];
        if (target === undefined) return true;
        duplicated.splice(index, 0, target);
        return !verifyBundle(fromLines(bundle, duplicated)).ok;
      }),
      { numRuns: 20 },
    );
  });

  it("rejects any reordering that is not the original order", () => {
    const bundle = buildBundle(5, identity);
    const original = lines(bundle);
    fc.assert(
      fc.property(fc.shuffledSubarray(original, { minLength: 5, maxLength: 5 }), (shuffled) => {
        fc.pre(shuffled.join("\n") !== original.join("\n"));
        return !verifyBundle(fromLines(bundle, shuffled)).ok;
      }),
      { numRuns: 40 },
    );
  });
});
