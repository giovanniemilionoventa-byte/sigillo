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
  type ReceiptV2,
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

  // Review point 20: the period the manifest (and so the PDF) states was
  // never compared with the receipts.
  it("detects a period that does not match the receipts' own times", () => {
    const bundle = buildBundle(3, identity);
    for (const member of ["from_ts", "to_ts"] as const) {
      const manifest = JSON.parse(bundle.manifestJson) as { range: Record<string, string> };
      manifest.range[member] = "2020-01-01T00:00:00.000Z";
      const detail = expectFailure({ ...bundle, manifestJson: JSON.stringify(manifest) }, "range");
      expect(detail).toContain(member);
    }
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

describe("receipt format version 2", () => {
  it("verifies a chain mixing v1 and v2 receipts", () => {
    const receipts = buildReceipts(6, identity, undefined, [
      undefined,
      undefined,
      undefined,
      { v: 2 },
      {
        v: 2,
        artifacts: [
          { role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) },
        ],
      },
      { v: 2, model: { name: "qwen2.5:3b", provider: "ollama", digest: "sha256:deadbeef" } },
    ]);
    const bundle = toBundle(receipts, buildManifest(receipts, identity));
    const result = verifyBundle(bundle);
    expect(result.ok ? "" : `${result.check}: ${result.detail}`).toBe("");
  });

  it("verifies a chain that is entirely v2", () => {
    const receipts = buildReceipts(3, identity, undefined, [
      { v: 2 },
      {
        v: 2,
        artifacts: [
          { role: "output", label: "email di risposta", media_type: "text/plain", sha256: "b".repeat(64) },
        ],
      },
      { v: 2 },
    ]);
    const result = verifyBundle(toBundle(receipts, buildManifest(receipts, identity)));
    expect(result.ok ? "" : `${result.check}: ${result.detail}`).toBe("");
  });

  it("detects a tampered artifact digest", () => {
    const receipts = buildReceipts(5, identity, undefined, [
      undefined,
      undefined,
      {
        v: 2,
        artifacts: [
          { role: "input", label: "curriculum", media_type: "text/plain", sha256: "c".repeat(64) },
        ],
      },
      undefined,
      undefined,
    ]);
    const bundle = toBundle(receipts, buildManifest(receipts, identity));
    const changed = lines(bundle);
    const receipt = JSON.parse(changed[2] ?? "{}") as ReceiptV2;
    changed[2] = canonicalJson({
      ...receipt,
      artifacts: [{ ...receipt.artifacts![0], sha256: "d".repeat(64) }],
    });

    const message = expectFailure(fromLines(bundle, changed), "chain-link");
    expect(message).toMatch(/seq 3/);
  });

  it("detects a tampered model field in the last receipt, where only the signature covers it", () => {
    const receipts = buildReceipts(4, identity, undefined, [
      undefined,
      undefined,
      undefined,
      { v: 2, model: { name: "qwen2.5:3b", provider: "ollama", digest: null } },
    ]);
    const bundle = toBundle(receipts, buildManifest(receipts, identity));
    const changed = lines(bundle);
    const receipt = JSON.parse(changed[3] ?? "{}") as ReceiptV2;
    changed[3] = canonicalJson({
      ...receipt,
      model: { name: "gpt-4o", provider: "ollama", digest: null },
    });

    expectFailure(fromLines(bundle, changed), "signature");
  });

  it("rejects a manifest whose receipt_version understates the receipts it holds", () => {
    const receipts = buildReceipts(3, identity, undefined, [undefined, undefined, { v: 2 }]);
    const manifest = buildManifest(receipts, identity);
    expect(manifest.receipt_version).toBe(2);
    const message = expectFailure(toBundle(receipts, { ...manifest, receipt_version: 1 }), "range");
    expect(message).toMatch(/receipt_version/);
  });

  it("rejects a manifest whose receipt_version overstates the receipts it holds", () => {
    const receipts = buildReceipts(3, identity);
    const manifest = buildManifest(receipts, identity);
    expect(manifest.receipt_version).toBe(1);
    const message = expectFailure(toBundle(receipts, { ...manifest, receipt_version: 2 }), "range");
    expect(message).toMatch(/receipt_version/);
  });

  it("indexes an artifact so a document lookup can trust the count reported", () => {
    const receipts = buildReceipts(3, identity, undefined, [
      undefined,
      {
        v: 2,
        artifacts: [
          { role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) },
        ],
      },
      undefined,
    ]);
    const result = verifyBundle(toBundle(receipts, buildManifest(receipts, identity)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.artifacts_indexed).toBe(1);
    expect(result.receipts).toHaveLength(3);
  });

  it("rejects an index missing an artifact the receipts declare", () => {
    const receipts = buildReceipts(2, identity, undefined, [
      undefined,
      {
        v: 2,
        artifacts: [
          { role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) },
        ],
      },
    ]);
    const bundle = toBundle(receipts, buildManifest(receipts, identity));
    const message = expectFailure({ ...bundle, artifactsIndexJsonl: "" }, "artifacts-index");
    expect(message).toMatch(/1 declared.*0 indexed/);
  });

  it("rejects an index entry the receipts do not declare", () => {
    const bundle = buildBundle(2, identity);
    const forged = `${JSON.stringify({ sha256: "c".repeat(64), seq: 1, role: "input", label: "x" })}\n`;
    const message = expectFailure({ ...bundle, artifactsIndexJsonl: forged }, "artifacts-index");
    expect(message).toMatch(/0 declared.*1 indexed/);
  });

  it("rejects an index entry that is malformed", () => {
    const receipts = buildReceipts(2, identity, undefined, [
      undefined,
      {
        v: 2,
        artifacts: [
          { role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) },
        ],
      },
    ]);
    const bundle = toBundle(receipts, buildManifest(receipts, identity));
    const message = expectFailure({ ...bundle, artifactsIndexJsonl: "not json\n" }, "artifacts-index");
    expect(message).toMatch(/artifacts-index\.jsonl:1/);
  });

  it("rejects an index entry pointing at the right document but the wrong receipt", () => {
    const receipts = buildReceipts(3, identity, undefined, [
      undefined,
      {
        v: 2,
        artifacts: [
          { role: "input", label: "curriculum", media_type: "text/plain", sha256: "a".repeat(64) },
        ],
      },
      undefined,
    ]);
    const bundle = toBundle(receipts, buildManifest(receipts, identity));
    // Same fingerprint, same role and label, but claimed for the wrong seq.
    const wrongSeq = `${JSON.stringify({ sha256: "a".repeat(64), seq: 2, role: "input", label: "curriculum" })}\n`;
    expectFailure({ ...bundle, artifactsIndexJsonl: wrongSeq }, "artifacts-index");
  });
});

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
