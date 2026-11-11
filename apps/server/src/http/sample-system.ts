import { randomBytes } from "node:crypto";
import type { ChainEvent } from "../storage/store.js";
import { UI } from "./strings.js";

/**
 * The example system a new account can open from its first steps
 * (SIGILLO_SAMPLE_SYSTEM): a register already holding one run of a made-up
 * claims assistant, so a newcomer sees a receipt, a seal and an evidence pack
 * before writing a line of code.
 *
 * Its receipts are real ones: signed by the signer, chained, sealed and
 * timestamped like any other, so the pack it gives passes the verifier. What
 * is made up is the agent and what it did, and every page of the system says
 * so. Like any customer's register it cannot be deleted, only archived; it
 * never has a key, so no agent can write to it.
 */

/** The name of the example system, under the account's prefix. A system of that name cannot be created by hand. */
export const SAMPLE_NAME = "esempio";

/** The example system's identifier for an account: `<organization>.esempio`, or `esempio` for the operator. */
export function sampleSystemId(organizationId: string | null): string {
  return organizationId === null ? SAMPLE_NAME : `${organizationId}.${SAMPLE_NAME}`;
}

/** Whether a system is an account's example system. */
export function isSampleSystem(systemId: string): boolean {
  return systemId === SAMPLE_NAME || systemId.endsWith(`.${SAMPLE_NAME}`);
}

/**
 * The example run, in the reader's language: nine actions of a claims
 * assistant over the last quarter of an hour, one of them blocked and one
 * failed, so the figures and filters have something to show. The inputs and
 * outputs are made-up sentences, passed as values: the store keeps only their
 * salted digests, as it does for any agent.
 */
export function sampleEvents(systemId: string, now: Date): ChainEvent[] {
  const t = UI.sample.run;
  const trace = randomBytes(16).toString("hex");
  const received = now.toISOString();
  const minutesAgo = (minutes: number): string => new Date(now.getTime() - minutes * 60_000).toISOString();
  const model = { name: "gpt-4o-mini", provider: "openai", digest: null };
  const lines: { at: number; kind: ChainEvent["action"]["kind"]; name: string; outcome: ChainEvent["outcome"]; input: string; output: string; llm?: boolean }[] = [
    { at: 15, kind: "agent_step", name: t.received, outcome: "ok", input: t.claim, output: t.claimOpened },
    { at: 14, kind: "llm_call", name: t.read, outcome: "ok", input: t.claim, output: t.readOut, llm: true },
    { at: 13, kind: "tool_call", name: t.policy, outcome: "ok", input: t.policyIn, output: t.policyOut },
    { at: 12, kind: "tool_call", name: t.limit, outcome: "ok", input: t.limitIn, output: t.limitOut },
    { at: 10, kind: "decision", name: t.approve, outcome: "ok", input: t.limitOut, output: t.approveOut },
    { at: 9, kind: "tool_call", name: t.pay, outcome: "ok", input: t.payIn, output: t.payOut },
    { at: 6, kind: "tool_call", name: t.pay, outcome: "blocked", input: t.payTooMuch, output: t.blockedOut },
    { at: 4, kind: "llm_call", name: t.write, outcome: "ok", input: t.approveOut, output: t.letter, llm: true },
    { at: 2, kind: "tool_call", name: t.mail, outcome: "error", input: t.letter, output: t.mailOut },
  ];
  return lines.map((line) => ({
    system_id: systemId,
    ts_event: minutesAgo(line.at),
    ts_received: received,
    actor: { agent: t.agent },
    action: { kind: line.kind, name: line.name },
    input_hash: null,
    output_hash: null,
    raw_input: { value: line.input },
    raw_output: { value: line.output },
    outcome: line.outcome,
    source: { type: "api", trace_id: trace, span_id: randomBytes(8).toString("hex") },
    ...(line.llm === true ? { model } : {}),
  }));
}
