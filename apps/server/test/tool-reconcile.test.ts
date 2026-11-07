import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolReconciler } from "../src/check/tool-reconcile.js";
import { ReceiptStore } from "../src/storage/store.js";
import { createTestSigner } from "./helpers/signer.js";

const SYSTEM = "reconciled-bot";
const MINUTE = 60_000;

let directory: string;
let store: ReceiptStore;
let clock: number;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-reconcile-"));
  store = ReceiptStore.open(join(directory, "sigillo.db"), createTestSigner());
  clock = Date.parse("2026-11-07T08:00:00.000Z");
  await store.createSystem(SYSTEM, new Date(clock).toISOString());
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

const at = (): string => new Date(clock).toISOString();
const write = (name: string, kind: "tool_call" | "llm_call" = "tool_call", type: "otlp" | "api" = "otlp") =>
  store.append({
    system_id: SYSTEM,
    ts_event: at(),
    ts_received: at(),
    actor: { agent: "hr-agent" },
    action: { kind, name },
    input_hash: null,
    output_hash: null,
    outcome: kind === "tool_call" && name.startsWith("model_requested.") ? "unknown" : "ok",
    source: { type, ...(type === "otlp" ? { trace_id: "0".repeat(31) + String(clock % 10), span_id: (clock % 1e15).toString(16).padStart(16, "0") } : {}) },
  });
const alarms = (): string[] => store.readChain(SYSTEM).map((r) => r.action.name).filter((n) => n.startsWith("sigillo.check."));

describe("the tools the model asked for, against the agent's own record", () => {
  it("writes an alarm when a tool asked for is not recorded within the grace window", async () => {
    const reconciler = new ToolReconciler({ store, now: () => new Date(clock), graceMs: 10 * MINUTE });
    await write("search_cv"); // the agent records its tools
    clock += 1000;
    await write("model_requested.send_email", "tool_call", "api");
    clock += 1000;
    await write("model_requested.search_cv", "tool_call", "api");
    clock += 2000;
    await write("search_cv");
    clock += 5 * MINUTE;
    expect(await reconciler.sweep()).toBe(0); // still inside the window
    clock += 6 * MINUTE;
    expect(await reconciler.sweep()).toBe(1);
    expect(alarms()).toEqual(["sigillo.check.tool_unrecorded.send_email"]);
    const alarm = store.readChain(SYSTEM).at(-1)!;
    expect(alarm.outcome).toBe("error");
    expect(alarm.actor.agent).toBe("hr-agent");
    clock += 20 * MINUTE;
    expect(await reconciler.sweep()).toBe(0); // judged once
  });

  it("says nothing for an agent that never records its tools (gateway only)", async () => {
    const reconciler = new ToolReconciler({ store, now: () => new Date(clock), graceMs: 10 * MINUTE });
    await write("model_requested.send_email", "tool_call", "api");
    clock += 30 * MINUTE;
    expect(await reconciler.sweep()).toBe(0);
    expect(alarms()).toEqual([]);
  });

  it("matches the agent's name for the tool loosely: case and a prefix", async () => {
    const reconciler = new ToolReconciler({ store, now: () => new Date(clock), graceMs: 10 * MINUTE });
    await write("tools.Send_Email");
    clock += 1000;
    await write("model_requested.send_email", "tool_call", "api");
    clock += 1000;
    await write("tools.SEND_EMAIL");
    clock += 30 * MINUTE;
    expect(await reconciler.sweep()).toBe(0);
  });
});
