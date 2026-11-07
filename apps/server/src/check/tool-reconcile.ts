import type { Receipt } from "@sigillo/core";
import { TOOL_REQUEST_PREFIX } from "../gateway/llm.js";
import type { ReceiptStore } from "../storage/store.js";

/**
 * The gateway against the agent's own record.
 *
 * Through the model gateway, sigillo sees every tool the model asks its agent
 * to use (`model_requested.<tool>`, gateway/llm.ts), whatever the agent's own
 * code does. An agent that records its tools with the SDK should then leave a
 * receipt of that tool soon after. When it does not, something stopped its
 * record (its sigillo code switched off in memory, say, which the heartbeat
 * cannot see), or it did not use the tool. Either way it is worth a look, so
 * the server writes `sigillo.check.tool_unrecorded.<tool>`, outcome error, on
 * the system's chain: signed, sealed and exported like any receipt.
 *
 * Only for a system that has recorded a tool of its own since this process
 * started: one that never records its tools (gateway only, no SDK) would
 * raise an alarm for every request. What a restart leaves unchecked is the
 * requests of the last grace window before it: the watermark starts at each
 * chain's tip.
 */

export const TOOL_UNRECORDED = "sigillo.check.tool_unrecorded";

/** How long the agent has to record the tool the model asked for. */
export const DEFAULT_GRACE_MS = 10 * 60_000;
const SWEEP_EVERY_MS = 60_000;
/** At most this many alarms per system per sweep: a flood is one look, not a thousand receipts. */
const MAX_ALARMS_PER_SWEEP = 20;
const MAX_NAME = 256;

export interface ToolReconcilerOptions {
  store: ReceiptStore;
  now?: () => Date;
  graceMs?: number;
}

export class ToolReconciler {
  private readonly store: ReceiptStore;
  private readonly now: () => Date;
  private readonly graceMs: number;
  /** Per system, the last seq whose requests have been judged. */
  private readonly watermark = new Map<string, number>();
  /** Systems seen recording a tool of their own. */
  private readonly recordsTools = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(options: ToolReconcilerOptions) {
    this.store = options.store;
    this.now = options.now ?? ((): Date => new Date());
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    for (const systemId of this.store.listSystems()) {
      this.watermark.set(systemId, this.store.tip(systemId)?.seq ?? -1);
    }
  }

  /** Judges every request older than the grace window. Returns how many alarms it wrote. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const cutoff = this.now().getTime() - this.graceMs;
      let written = 0;
      for (const systemId of this.store.listSystems()) {
        written += await this.sweepSystem(systemId, cutoff);
      }
      return written;
    } finally {
      this.running = false;
    }
  }

  private async sweepSystem(systemId: string, cutoff: number): Promise<number> {
    const from = this.watermark.get(systemId) ?? -1;
    const receipts = this.store.readChainFrom(systemId, from);
    if (receipts.length === 0) return 0;
    for (const receipt of receipts) {
      if (ownTool(receipt)) this.recordsTools.add(systemId);
    }
    let judged = from;
    let alarms = 0;
    for (const [index, receipt] of receipts.entries()) {
      if (Date.parse(receipt.ts_received) > cutoff) break;
      judged = receipt.seq;
      if (!receipt.action.name.startsWith(TOOL_REQUEST_PREFIX) || !this.recordsTools.has(systemId)) continue;
      const tool = receipt.action.name.slice(TOOL_REQUEST_PREFIX.length);
      const until = Date.parse(receipt.ts_received) + this.graceMs;
      const recorded = receipts
        .slice(index + 1)
        .some((later) => Date.parse(later.ts_received) <= until && ownTool(later) && sameTool(later.action.name, tool));
      if (recorded || alarms >= MAX_ALARMS_PER_SWEEP) continue;
      await this.store.append({
        system_id: systemId,
        ts_event: receipt.ts_received,
        ts_received: this.now().toISOString(),
        actor: { agent: receipt.actor.agent },
        action: { kind: "agent_step", name: `${TOOL_UNRECORDED}.${tool}`.slice(0, MAX_NAME) },
        input_hash: null,
        output_hash: null,
        outcome: "error",
        source: { type: "api" },
      });
      alarms += 1;
    }
    this.watermark.set(systemId, judged);
    return alarms;
  }

  /** Same shape as ConnectionWatch.start(): a timer the process does not wait on. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      this.sweep().catch(() => undefined);
    }, SWEEP_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** A tool the agent recorded itself: a tool_call that is not a request the gateway saw. */
function ownTool(receipt: Receipt): boolean {
  return receipt.action.kind === "tool_call" && !receipt.action.name.startsWith(TOOL_REQUEST_PREFIX);
}

/** The model's name for a tool and the agent's, compared loosely: case, and a framework's prefix such as `tools.`. */
function sameTool(recorded: string, requested: string): boolean {
  const a = recorded.toLowerCase();
  const b = requested.toLowerCase();
  return a === b || a.endsWith(`.${b}`) || a.endsWith(`/${b}`) || a.endsWith(`:${b}`);
}
