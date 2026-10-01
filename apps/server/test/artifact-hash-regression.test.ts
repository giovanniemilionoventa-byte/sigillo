import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCUMENT_TEXT_SOURCE, documentFingerprints, textSha256 } from "@sigillo/core";
import { buildArchive } from "../src/export/archive.js";
import { VERIFY_DOCUMENT_SCRIPT } from "../src/http/ui.js";
import { adaptSpans } from "../src/ingest/adapter.js";
import { decodeJsonTraces } from "../src/ingest/otlp.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";

/**
 * Regression lock on document fingerprints, written before receipt version 4
 * (pseudonyms and salted input/output digests) and required to pass unchanged
 * after it. An artifact's `sha256` is SHA-256 of the document's exact bytes,
 * and its `text.sha256` the sigillo-text/1 digest, in every receipt version:
 * the "verifica un documento" page, `sigillo-verify doc` and every export
 * already handed out depend on that. Salting is for input and output digests
 * only; nothing here may change because of it.
 *
 * The expected digests are constants computed outside this code base
 * (`printf ... | sha256sum`), so a change to the hashing code cannot move the
 * expectation along with it.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const VERIFIER_CLI = join(REPOSITORY_ROOT, "packages", "verifier", "src", "cli.ts");
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");

const CV = "Curriculum vitae\r\nEsperienza: cinque anni  in logistica\r\n";
/** `printf 'Curriculum vitae\r\nEsperienza: cinque anni  in logistica\r\n' | sha256sum` */
const CV_SHA256 = "d369a639abf048e328adb9253da7557e43e13959301504d1e7dde7f0ce19f692";
/** `printf 'Curriculum vitae Esperienza: cinque anni in logistica' | sha256sum` */
const CV_TEXT_SHA256 = "01ac8d716bccaaf9a73c37966bd9a834236d202ad311233fd71846bca127dba2";
/** SHA-256 of the sigillo-text/1 source the browser runs, and of the page script around it. */
const DOCUMENT_TEXT_SOURCE_SHA256 = "caa894e304edce8406050ebeca15488f250222275a8931a30d7c340910bdc301";
const VERIFY_DOCUMENT_SCRIPT_SHA256 = "f5c0b25e09a70fd4028b04d81bf41937e184304964692ef5389a25dea98272a8";

const SYSTEM = "selezione-cv";
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

let directory: string;
let store: ReceiptStore;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-artifact-lock-"));
  store = ReceiptStore.open(join(directory, "sigillo.db"), createTestSigner());
  await store.createSystem(SYSTEM, "2026-10-01T08:00:00.000Z");
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * The tool span the demo agent's `leggi_curriculum` produces, carrying also
 * what receipt version 4 changes the treatment of: a person in `user.id` and
 * a raw `input.value`. Whatever happens to those, the artifact must not move.
 */
function cvSpan(): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "agente-cv" } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "b7ad6b7169203331",
                name: "leggi_curriculum",
                startTimeUnixNano: "1790841600000000000",
                endTimeUnixNano: "1790841600001000000",
                attributes: [
                  { key: "openinference.span.kind", value: { stringValue: "TOOL" } },
                  { key: "tool.name", value: { stringValue: "leggi_curriculum" } },
                  { key: "user.id", value: { stringValue: "elena.rizzo" } },
                  { key: "input.value", value: { stringValue: "score: 7" } },
                ],
                events: [
                  {
                    name: "sigillo.artifact",
                    timeUnixNano: "1790841600000000000",
                    attributes: [
                      { key: "sigillo.artifact.role", value: { stringValue: "input" } },
                      { key: "sigillo.artifact.label", value: { stringValue: "curriculum" } },
                      { key: "sigillo.artifact.media_type", value: { stringValue: "text/plain" } },
                      { key: "sigillo.artifact.sha256", value: { stringValue: CV_SHA256 } },
                      { key: "sigillo.artifact.text_canon", value: { stringValue: "sigillo-text/1" } },
                      { key: "sigillo.artifact.text_sha256", value: { stringValue: CV_TEXT_SHA256 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("document fingerprints are pinned", () => {
  it("an artifact's sha256 is SHA-256 of the exact bytes, as sha256sum computes it", () => {
    expect(sha256Hex(CV)).toBe(CV_SHA256);
    expect(documentFingerprints(encode(CV)).bytes).toBe(CV_SHA256);
  });

  it("the sigillo-text/1 digest is unchanged", () => {
    expect(textSha256(encode(CV))).toBe(CV_TEXT_SHA256);
    expect(documentFingerprints(encode(CV)).text).toBe(CV_TEXT_SHA256);
  });

  it("the code the browser runs to hash a document is byte for byte the same", () => {
    // The page's CSP allows its script by hash, and the browser's digests must
    // equal the server's: either changing would break the page.
    expect(sha256Hex(DOCUMENT_TEXT_SOURCE)).toBe(DOCUMENT_TEXT_SOURCE_SHA256);
    expect(sha256Hex(VERIFY_DOCUMENT_SCRIPT)).toBe(VERIFY_DOCUMENT_SCRIPT_SHA256);
  });
});

describe("an artifact goes from span to receipt to lookup untouched", () => {
  async function ingest(): Promise<void> {
    const batch = adaptSpans(decodeJsonTraces(cvSpan()));
    await store.appendBatch(
      batch.actions.map((action) => ({
        system_id: SYSTEM,
        ts_event: action.ts_event,
        ts_received: "2026-10-01T09:00:00.000Z",
        actor: action.actor,
        action: action.action,
        input_hash: action.input_hash,
        output_hash: action.output_hash,
        outcome: action.outcome,
        source: action.source,
        ...(action.artifacts === undefined ? {} : { artifacts: action.artifacts }),
        ...(action.model === undefined ? {} : { model: action.model }),
      })),
    );
  }

  it("the receipt carries the digests exactly as the SDK computed them", async () => {
    await ingest();
    const receipt = store.readChain(SYSTEM)[1];
    expect(receipt?.v).toBeGreaterThanOrEqual(3);
    const artifacts = receipt !== undefined && receipt.v !== 1 ? receipt.artifacts : undefined;
    expect(artifacts).toEqual([
      {
        role: "input",
        label: "curriculum",
        media_type: "text/plain",
        sha256: CV_SHA256,
        text: { canon: "sigillo-text/1", sha256: CV_TEXT_SHA256 },
      },
    ]);
  });

  it("the server finds the document by its bytes, and a respaced copy by its text", async () => {
    await ingest();
    const exact = store.findDocument(documentFingerprints(encode(CV)));
    expect(exact.map((match) => [match.kind, match.seq, match.label])).toEqual([["bytes", 1, "curriculum"]]);

    const respaced = store.findDocument(documentFingerprints(encode("Curriculum  vitae\nEsperienza: cinque anni in logistica")));
    expect(respaced.map((match) => [match.kind, match.seq])).toEqual([["text", 1]]);
  });

  it("sigillo-verify doc finds the document in an export", async () => {
    await ingest();
    const archive = await buildArchive({
      systemId: SYSTEM,
      receipts: store.readChain(SYSTEM),
      checkpoints: [],
      keys: store.signingKeys(),
      exportedAt: "2026-10-01T10:00:00.000Z",
    });
    expect(archive.verification.ok).toBe(true);
    const archivePath = join(directory, "fascicolo.zip");
    writeFileSync(archivePath, archive.zip);
    const documentPath = join(directory, "cv.txt");
    writeFileSync(documentPath, CV);

    const stdout = execFileSync(TSX, [VERIFIER_CLI, "doc", archivePath, documentPath], { encoding: "utf8" });
    expect(stdout).toContain("exactly the one used");
    expect(stdout).toContain("not been modified");
  }, 30_000);
});
