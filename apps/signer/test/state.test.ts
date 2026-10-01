import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyFrontier,
  frontierAppend,
  fromHex,
  parseReceipt,
  receiptHashHex,
  signReceipt,
} from "@sigillo/core";
import { generateKeyFile, loadKeyFile, type SignerKey } from "../src/key-file.js";
import { StateDirectory, type ChainState } from "../src/state.js";
import { genesis } from "./helpers.js";

/**
 * The signer's memory of each chain lives in its own volume, one file per
 * system, written so that a crash at any instant leaves either the old file
 * or the new one: never half of one, and never one the signer did not
 * finish writing before it answered.
 */

let directory: string;
let stateDir: string;
let key: SignerKey;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-state-"));
  stateDir = join(directory, "state");
  generateKeyFile(join(directory, "signer.key"));
  key = loadKeyFile(join(directory, "signer.key"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function genesisState(systemId: string): ChainState {
  const head = signReceipt(genesis(systemId, key.keyId), key.privateKey);
  const hash = receiptHashHex(head);
  return { system_id: systemId, seq: 0, hash, head, frontier: frontierAppend(emptyFrontier(), fromHex(hash)) };
}

const fileOf = (systemId: string): string =>
  join(stateDir, `${createHash("sha256").update(systemId, "utf8").digest("hex")}.json`);

describe("a state directory", () => {
  it("is created readable by its owner only, and starts empty", () => {
    const state = StateDirectory.open(stateDir);
    expect(statSync(stateDir).mode & 0o077).toBe(0);
    expect(state.get("anything")).toBeUndefined();
    expect(state.isEmpty()).toBe(true);
  });

  it("writes one file per system, owner-only, named by the hash of its id, and reads it back", () => {
    const state = StateDirectory.open(stateDir);
    state.put(genesisState("acme-support-bot"));
    expect(statSync(fileOf("acme-support-bot")).mode & 0o077).toBe(0);

    const reopened = StateDirectory.open(stateDir);
    const chain = reopened.get("acme-support-bot");
    expect(chain !== undefined && "head" in chain ? chain.head : null).toEqual(genesisState("acme-support-bot").head);
    expect(reopened.isEmpty()).toBe(false);
  });

  it("leaves no temporary file behind, and ignores one left by a crash mid-write", () => {
    const state = StateDirectory.open(stateDir);
    state.put(genesisState("acme-support-bot"));
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    writeFileSync(`${fileOf("other")}.tmp`, "{\"half\": ");
    const reopened = StateDirectory.open(stateDir);
    expect(reopened.get("other")).toBeUndefined();
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to start from a file that does not hold a consistent chain state", () => {
    const state = StateDirectory.open(stateDir);
    state.put(genesisState("acme-support-bot"));
    const stored = JSON.parse(readFileSync(fileOf("acme-support-bot"), "utf8")) as Record<string, unknown>;

    const broken: [string, Record<string, unknown>][] = [
      ["a seq that is not the head's", { ...stored, seq: 1 }],
      ["a hash that is not the head's", { ...stored, hash: "f".repeat(64) }],
      ["a frontier of the wrong size", { ...stored, frontier: { size: 2, nodes: ["a".repeat(64)] } }],
      ["an unknown member", { ...stored, extra: 1 }],
      ["a head for another system", { ...stored, head: { ...(stored["head"] as object), system_id: "x" } }],
    ];
    for (const [what, content] of broken) {
      writeFileSync(fileOf("acme-support-bot"), JSON.stringify(content));
      expect(() => StateDirectory.open(stateDir), what).toThrow(/acme-support-bot|state/);
    }
  });

  it("refuses a file whose name is not the hash of the system it holds", () => {
    const state = StateDirectory.open(stateDir);
    state.put(genesisState("acme-support-bot"));
    writeFileSync(fileOf("someone-else"), readFileSync(fileOf("acme-support-bot")));
    expect(() => StateDirectory.open(stateDir)).toThrow(/name/);
  });

  it("remembers a retired system, which is never given a chain again", () => {
    const state = StateDirectory.open(stateDir);
    state.put({ system_id: "deleted-bot", retired: { genesis_hash: "e".repeat(64) } });
    const reopened = StateDirectory.open(stateDir);
    expect(reopened.get("deleted-bot")).toEqual({ system_id: "deleted-bot", retired: { genesis_hash: "e".repeat(64) } });
    expect(parseReceipt(genesisState("x").head).seq).toBe(0);
  });
});
