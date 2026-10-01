/**
 * Regenerates packages/core/test/vectors.json.
 *
 * The vectors are checked twice: by the Node test suite, and by
 * scripts/crosscheck_vectors.py, which re-derives every canonical form and
 * digest with an independent JCS implementation in Python.
 *
 * Run with: pnpm tsx scripts/gen-vectors.ts
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalReceiptBytes,
  GENESIS_PREV_HASH,
  HASH_SCHEME_PLAIN,
  HASH_SCHEME_SALTED,
  parseReceipt,
  receiptHashHex,
  RECEIPT_VERSION_1,
  RECEIPT_VERSION_2,
  RECEIPT_VERSION_3,
  RECEIPT_VERSION_4,
  saltedDigest,
  sha256Hex,
  TEXT_CANON_1,
  textSha256,
  type Receipt,
} from "../packages/core/src/index.js";

// Decodes to "placeholder-signature-not-verifiable-m1-vectors-see-FORMAT.md-01".
const PLACEHOLDER_SIG =
  "cGxhY2Vob2xkZXItc2lnbmF0dXJlLW5vdC12ZXJpZmlhYmxlLW0xLXZlY3RvcnMtc2VlLUZPUk1BVC5tZC0wMQ==";

const KEY_ID = "3f2a1c9d8e7b6a5f";
const SHA_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SHA_SIGILLO = "7930b9c8f62bf831bf5d051ffa3e25051329b7148e0b8ee22a13b2d8cd0cfb1e";

// A text document as a Windows editor saves it, and its two fingerprints: the
// exact bytes, and sigillo-text/1 ("Ciao, mondo."), which docs/FORMAT.md 2.5.1
// and packages/core/test/text-vectors.json both derive by hand.
const LETTER = new TextEncoder().encode("Ciao,\r\nmondo.\r\n");
const SHA_LETTER = sha256Hex(LETTER);
const TEXT_LETTER = textSha256(LETTER) ?? "";

interface VectorInput {
  name: string;
  comment: string;
  receipt: Receipt;
}

const genesis: Receipt = {
  v: RECEIPT_VERSION_1,
  system_id: "acme-support-bot",
  seq: 0,
  ts_event: "2026-03-29T14:30:00.123Z",
  ts_received: "2026-03-29T14:30:00.456Z",
  actor: { agent: "acme-support-bot" },
  action: { kind: "genesis", name: "acme-support-bot" },
  input_hash: null,
  output_hash: null,
  outcome: "ok",
  source: { type: "api" },
  prev_hash: GENESIS_PREV_HASH,
  key_id: KEY_ID,
  sig: PLACEHOLDER_SIG,
};

const genesisHash = receiptHashHex(genesis);

const inputs: VectorInput[] = [
  {
    name: "genesis",
    comment:
      "First receipt of a chain: seq 0, action.kind genesis, action.name repeats the system, prev_hash is 64 zeros.",
    receipt: genesis,
  },
  {
    name: "tool-call-escapes-and-unicode",
    comment:
      "JSON escaping and UTF-8: quote, backslash, newline and tab are escaped; e-acute and an emoji are emitted literally.",
    receipt: {
      ...genesis,
      seq: 7,
      ts_event: "2026-03-29T14:31:02.000Z",
      ts_received: "2026-03-29T14:31:02.004Z",
      actor: { agent: "café-agent ☕", on_behalf_of: "urn:user:42" },
      action: { kind: "tool_call", name: 'quote" backslash\\ newline\n tab\t é☕' },
      input_hash: SHA_EMPTY,
      output_hash: SHA_SIGILLO,
      source: {
        type: "otlp",
        trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
        span_id: "00f067aa0ba902b7",
      },
      prev_hash: genesisHash,
    },
  },
  {
    name: "llm-call-both-hashes",
    comment: "An LLM call with both payload digests present. The prompt itself is never carried.",
    receipt: {
      ...genesis,
      seq: 8,
      ts_event: "2026-03-29T14:31:03.100Z",
      ts_received: "2026-03-29T14:31:03.140Z",
      actor: { agent: "planner" },
      action: { kind: "llm_call", name: "chat.completions" },
      input_hash: SHA_SIGILLO,
      output_hash: SHA_EMPTY,
      source: { type: "otlp", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "agent-step-on-behalf-of",
    comment: "Human oversight (AI Act art. 14): the operator the agent acted for is recorded.",
    receipt: {
      ...genesis,
      seq: 9,
      ts_event: "2026-03-29T14:31:04.000Z",
      ts_received: "2026-03-29T14:31:04.002Z",
      actor: { agent: "executor", on_behalf_of: "urn:operator:night-shift" },
      action: { kind: "agent_step", name: "plan.revise" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "decision-blocked",
    comment: "A decision stopped by a guardrail: outcome blocked, no output digest.",
    receipt: {
      ...genesis,
      seq: 10,
      ts_event: "2026-03-29T14:31:05.500Z",
      ts_received: "2026-03-29T14:31:05.501Z",
      actor: { agent: "policy" },
      action: { kind: "decision", name: "refund.approve" },
      input_hash: SHA_SIGILLO,
      outcome: "blocked",
      source: { type: "sdk" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "tool-call-error",
    comment: "A failed tool call: outcome error, input recorded, no output.",
    receipt: {
      ...genesis,
      seq: 11,
      ts_event: "2026-03-29T14:31:06.000Z",
      ts_received: "2026-03-29T14:31:06.250Z",
      actor: { agent: "executor" },
      action: { kind: "tool_call", name: "payments.charge" },
      input_hash: SHA_EMPTY,
      outcome: "error",
      source: { type: "otlp", span_id: "00f067aa0ba902b7" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "outcome-unknown-no-hashes",
    comment: "A span that ended without a status and without payloads: nulls stay in the hash.",
    receipt: {
      ...genesis,
      seq: 12,
      ts_event: "2026-03-29T14:31:07.000Z",
      ts_received: "2026-03-29T14:31:07.000Z",
      actor: { agent: "executor" },
      action: { kind: "agent_step", name: "tick" },
      outcome: "unknown",
      source: { type: "otlp" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "source-api-minimal",
    comment: "Native API ingest: no trace context at all, the smallest legal source object.",
    receipt: {
      ...genesis,
      seq: 13,
      ts_event: "2026-01-01T00:00:00.000Z",
      ts_received: "2026-01-01T00:00:00.000Z",
      actor: { agent: "batch-importer" },
      action: { kind: "tool_call", name: "import" },
      source: { type: "api" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "timestamps-year-boundary",
    comment: "Midnight on 1 January and the last millisecond of 31 December, both with .000/.999.",
    receipt: {
      ...genesis,
      seq: 14,
      ts_event: "2025-12-31T23:59:59.999Z",
      ts_received: "2026-01-01T00:00:00.000Z",
      actor: { agent: "scheduler" },
      action: { kind: "agent_step", name: "rollover" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "leap-day",
    comment: "29 February 2028 exists; a verifier that normalises dates must not shift it.",
    receipt: {
      ...genesis,
      seq: 15,
      ts_event: "2028-02-29T12:00:00.500Z",
      ts_received: "2028-02-29T12:00:00.501Z",
      actor: { agent: "scheduler" },
      action: { kind: "agent_step", name: "tick" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "maximum-length-names",
    comment: "Fields at their caps: system_id 128 characters, agent and action name 256 each.",
    receipt: {
      ...genesis,
      system_id: "s".repeat(128),
      seq: 16,
      ts_event: "2026-03-29T14:31:08.000Z",
      ts_received: "2026-03-29T14:31:08.001Z",
      actor: { agent: "a".repeat(256), on_behalf_of: "o".repeat(256) },
      action: { kind: "tool_call", name: "n".repeat(256) },
      source: { type: "sdk" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "cjk-and-astral-plane",
    comment:
      "Non-Latin text and a character outside the basic plane, to pin UTF-8 output over UTF-16 escapes.",
    receipt: {
      ...genesis,
      seq: 17,
      ts_event: "2026-03-29T14:31:09.000Z",
      ts_received: "2026-03-29T14:31:09.001Z",
      actor: { agent: "顧客サポート" },
      action: { kind: "tool_call", name: "检索订单 🧾" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "control-characters-in-name",
    comment: "Control characters are escaped as \\u00XX with lowercase hex digits, per RFC 8785.",
    receipt: {
      ...genesis,
      seq: 18,
      ts_event: "2026-03-29T14:31:10.000Z",
      ts_received: "2026-03-29T14:31:10.001Z",
      actor: { agent: "executor" },
      action: { kind: "tool_call", name: "bell\u0007 null-ish\u0001 del\u007f" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "large-sequence-number",
    comment:
      "seq at the largest integer JSON can carry exactly, to pin integer serialisation with no exponent.",
    receipt: {
      ...genesis,
      seq: Number.MAX_SAFE_INTEGER,
      ts_event: "2026-03-29T14:31:11.000Z",
      ts_received: "2026-03-29T14:31:11.001Z",
      actor: { agent: "executor" },
      action: { kind: "agent_step", name: "tick" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "v2-no-optional-fields",
    comment:
      "Version 2 with neither new member present: it canonicalises exactly like v1 except for v itself.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_2,
      seq: 19,
      ts_event: "2026-03-29T14:31:12.000Z",
      ts_received: "2026-03-29T14:31:12.001Z",
      actor: { agent: "executor" },
      action: { kind: "tool_call", name: "search_orders" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "v2-single-input-artifact",
    comment: "One input artifact: its sha256 is over the document's raw bytes, never canonicalised.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_2,
      seq: 20,
      ts_event: "2026-03-29T14:31:13.000Z",
      ts_received: "2026-03-29T14:31:13.001Z",
      actor: { agent: "selezione-cv" },
      action: { kind: "tool_call", name: "leggi_curriculum" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
      artifacts: [
        {
          role: "input",
          label: "curriculum",
          media_type: "text/plain",
          sha256: SHA_SIGILLO,
        },
      ],
    },
  },
  {
    name: "v2-two-artifacts-preserve-order",
    comment:
      "Two artifacts, input then output: RFC 8785 sorts object members but never reorders an array.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_2,
      seq: 21,
      ts_event: "2026-03-29T14:31:14.000Z",
      ts_received: "2026-03-29T14:31:14.001Z",
      actor: { agent: "selezione-cv", on_behalf_of: "urn:user:selezionatore" },
      action: { kind: "agent_step", name: "valuta_candidato" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
      artifacts: [
        { role: "input", label: "curriculum", media_type: "text/plain", sha256: SHA_EMPTY },
        { role: "output", label: "email di risposta", media_type: "text/plain", sha256: SHA_SIGILLO },
      ],
    },
  },
  {
    name: "v2-model-with-provider-and-digest",
    comment: "An llm_call naming a local model, its provider, and the digest of the model file used.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_2,
      seq: 22,
      ts_event: "2026-03-29T14:31:15.000Z",
      ts_received: "2026-03-29T14:31:15.001Z",
      actor: { agent: "planner" },
      action: { kind: "llm_call", name: "chat.completions" },
      source: { type: "otlp", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736" },
      prev_hash: genesisHash,
      model: { name: "qwen2.5:3b", provider: "ollama", digest: `sha256:${SHA_SIGILLO}` },
    },
  },
  {
    name: "v2-model-with-null-provider-and-digest",
    comment: "A model name with neither provider nor digest known: both are null, never omitted.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_2,
      seq: 23,
      ts_event: "2026-03-29T14:31:16.000Z",
      ts_received: "2026-03-29T14:31:16.001Z",
      actor: { agent: "planner" },
      action: { kind: "llm_call", name: "chat.completions" },
      source: { type: "api" },
      prev_hash: genesisHash,
      model: { name: "unknown-local-model", provider: null, digest: null },
    },
  },
  {
    name: "v2-artifact-and-model-together",
    comment: "Both new members on the same receipt: an llm_call that also produced a document.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_2,
      seq: 24,
      ts_event: "2026-03-29T14:31:17.000Z",
      ts_received: "2026-03-29T14:31:17.001Z",
      actor: { agent: "planner" },
      action: { kind: "llm_call", name: "chat.completions" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
      artifacts: [
        { role: "output", label: "email di risposta", media_type: "text/plain", sha256: SHA_EMPTY },
      ],
      model: { name: "gpt-4o", provider: "openai", digest: null },
    },
  },
  {
    name: "v3-text-artifact",
    comment:
      "Version 3: a text artifact carries its sigillo-text/1 fingerprint beside the exact one; sha256 keeps its raw-bytes meaning.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_3,
      seq: 25,
      ts_event: "2026-03-29T14:31:18.000Z",
      ts_received: "2026-03-29T14:31:18.001Z",
      actor: { agent: "selezione-cv" },
      action: { kind: "tool_call", name: "invia_email" },
      source: { type: "otlp", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7" },
      prev_hash: genesisHash,
      artifacts: [
        {
          role: "output",
          label: "email di risposta",
          media_type: "text/plain",
          sha256: SHA_LETTER,
          text: { canon: TEXT_CANON_1, sha256: TEXT_LETTER },
        },
      ],
    },
  },
  {
    name: "v3-text-and-binary-artifacts",
    comment: "A text artifact and a binary one on the same receipt: only the text one has a text member.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_3,
      seq: 26,
      ts_event: "2026-03-29T14:31:19.000Z",
      ts_received: "2026-03-29T14:31:19.001Z",
      actor: { agent: "selezione-cv" },
      action: { kind: "tool_call", name: "leggi_candidatura" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
      artifacts: [
        {
          role: "input",
          label: "lettera",
          media_type: "text/plain",
          sha256: SHA_LETTER,
          text: { canon: TEXT_CANON_1, sha256: TEXT_LETTER },
        },
        { role: "input", label: "curriculum", media_type: "application/pdf", sha256: SHA_SIGILLO },
      ],
    },
  },
  {
    name: "v3-text-artifact-and-model",
    comment: "A text artifact with its text member and a model, together on an llm_call.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_3,
      seq: 27,
      ts_event: "2026-03-29T14:31:20.000Z",
      ts_received: "2026-03-29T14:31:20.001Z",
      actor: { agent: "planner", on_behalf_of: "urn:user:42" },
      action: { kind: "llm_call", name: "chat.completions" },
      source: { type: "sdk" },
      prev_hash: genesisHash,
      artifacts: [
        {
          role: "output",
          label: "riassunto",
          media_type: "text/plain",
          sha256: SHA_EMPTY,
          text: { canon: TEXT_CANON_1, sha256: SHA_SIGILLO },
        },
      ],
      model: { name: "qwen2.5:3b", provider: "ollama", digest: null },
    },
  },
];

// Version 4: a pseudonym token instead of an identifier, and each digest
// beside its scheme. The salted digests are real ones, over the nonces and
// values listed in `salted_digests` below.
const NONCE_A = Uint8Array.from({ length: 32 }, (_, index) => index);
const NONCE_B = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const TOKEN = "psn_9f86d081884c7d659a2feaa0c55ad015";

inputs.push(
  {
    name: "v4-pseudonym-salted-input-plain-output",
    comment:
      "Version 4: on_behalf_of is a pseudonym token; the input was hashed by the server with a nonce, the output by the client.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_4,
      seq: 28,
      ts_event: "2026-10-01T09:00:00.000Z",
      ts_received: "2026-10-01T09:00:00.001Z",
      actor: { agent: "agente-cv", on_behalf_of: TOKEN },
      action: { kind: "tool_call", name: "valuta_candidato" },
      input_hash: saltedDigest(NONCE_A, "score: 7"),
      input_hash_scheme: HASH_SCHEME_SALTED,
      output_hash: sha256Hex(new TextEncoder().encode('"idoneo"')),
      output_hash_scheme: HASH_SCHEME_PLAIN,
      source: { type: "otlp", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b8" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "v4-no-digests-no-person",
    comment: "Version 4 with neither digest: both schemes are null, and there is no on_behalf_of at all.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_4,
      seq: 29,
      ts_event: "2026-10-01T09:00:01.000Z",
      ts_received: "2026-10-01T09:00:01.001Z",
      actor: { agent: "agente-cv" },
      action: { kind: "agent_step", name: "tick" },
      input_hash_scheme: null,
      output_hash_scheme: null,
      source: { type: "api" },
      prev_hash: genesisHash,
    },
  },
  {
    name: "v4-salted-both-with-text-artifact-and-model",
    comment:
      "Version 4 keeps version 3's artifacts unchanged: the exact digest and the sigillo-text/1 one are never salted.",
    receipt: {
      ...genesis,
      v: RECEIPT_VERSION_4,
      seq: 30,
      ts_event: "2026-10-01T09:00:02.000Z",
      ts_received: "2026-10-01T09:00:02.001Z",
      actor: { agent: "agente-cv", on_behalf_of: TOKEN },
      action: { kind: "llm_call", name: "chat.completions" },
      input_hash: saltedDigest(NONCE_B, { punteggio: 7, esito: "idoneo" }),
      input_hash_scheme: HASH_SCHEME_SALTED,
      output_hash: saltedDigest(NONCE_A, "è idoneo ✓"),
      output_hash_scheme: HASH_SCHEME_SALTED,
      source: { type: "sdk" },
      prev_hash: genesisHash,
      artifacts: [
        {
          role: "input",
          label: "curriculum",
          media_type: "text/plain",
          sha256: SHA_LETTER,
          text: { canon: TEXT_CANON_1, sha256: TEXT_LETTER },
        },
      ],
      model: { name: "qwen2.5:3b", provider: "ollama", digest: null },
    },
  },
);

/** Salted digests (FORMAT.md 2.7), re-derived by the Python cross-check from nonce and value alone. */
const saltedDigests = (
  [
    ["short-text", NONCE_A, "score: 7"],
    ["object-keys-sorted", NONCE_B, { punteggio: 7, esito: "idoneo" }],
    ["non-ascii-text", NONCE_A, "è idoneo ✓"],
    ["bare-number", NONCE_B, 7],
  ] as const
).map(([name, nonce, value]) => ({
  name,
  nonce_hex: Buffer.from(nonce).toString("hex"),
  value,
  digest: saltedDigest(nonce, value),
}));

const vectors = inputs.map((input) => {
  parseReceipt(input.receipt);
  return {
    name: input.name,
    comment: input.comment,
    receipt: input.receipt,
    canonical: new TextDecoder().decode(canonicalReceiptBytes(input.receipt)),
    hash: receiptHashHex(input.receipt),
  };
});

const names = new Set(vectors.map((vector) => vector.name));
const hashes = new Set(vectors.map((vector) => vector.hash));
if (names.size !== vectors.length || hashes.size !== vectors.length) {
  throw new Error("vector names and hashes must be unique");
}

const output = {
  format: "sigillo receipt test vectors",
  // Derived from what the vectors actually contain, not asserted separately,
  // so this can never drift from the vectors below it.
  receipt_versions: [...new Set(vectors.map((vector) => vector.receipt.v))].sort(),
  note: [
    "canonical is the RFC 8785 form of the receipt with the sig field removed;",
    "hash is the SHA-256 of those UTF-8 bytes, lowercase hex.",
    "The sig values are a fixed placeholder: these vectors pin the wire format,",
    "not signatures. Signature vectors arrive with the signer. Versions 1 to 4",
    "are all covered; a v1 vector has no artifacts or model member at all, only",
    "a v3 or v4 artifact may carry text, and only a v4 receipt carries hash schemes.",
    "salted_digests: SHA-256 of the nonce's 32 bytes followed by the value's RFC 8785 form.",
  ].join(" "),
  vectors,
  salted_digests: saltedDigests,
};

const target = fileURLToPath(new URL("../packages/core/test/vectors.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`wrote ${vectors.length} vectors to ${target}`);
