import { createConnection, type Socket } from "node:net";
import { GENESIS_PREV_HASH, type UnsignedReceipt } from "@sigillo/core";

/** Sends raw bytes and collects reply lines, so malformed input can be tested. */
export function exchange(socketPath: string, payload: string, expectedLines = 1): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let buffer = "";
    const socket: Socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("no reply from the signer"));
    }, 4000);
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(lines);
    };
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        lines.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
      if (lines.length >= expectedLines) finish();
    });
    socket.on("close", finish);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

let nextId = 0;

/** One request in protocol version 2, with an id of its own, and its reply. */
export async function call(
  socketPath: string,
  method: string,
  fields: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  nextId += 1;
  const [line] = await exchange(socketPath, `${JSON.stringify({ v: 2, id: `t${nextId}`, method, ...fields })}\n`);
  if (line === undefined) throw new Error("the signer sent no reply");
  return JSON.parse(line) as Record<string, unknown>;
}

export const T0 = "2026-10-01T09:00:00.000Z";

/** A clock that reads `T0` plus however many milliseconds a test has moved it on. */
export function testClock(start = T0): { now: () => Date; advance: (ms: number) => void } {
  let at = Date.parse(start);
  return { now: () => new Date(at), advance: (ms) => (at += ms) };
}

export function genesis(systemId: string, keyId: string, ts = T0): UnsignedReceipt {
  return {
    v: 1,
    system_id: systemId,
    seq: 0,
    ts_event: ts,
    ts_received: ts,
    actor: { agent: systemId },
    action: { kind: "genesis", name: systemId },
    input_hash: null,
    output_hash: null,
    outcome: "ok",
    source: { type: "api" },
    prev_hash: GENESIS_PREV_HASH,
    key_id: keyId,
  };
}

export function action(
  systemId: string,
  keyId: string,
  seq: number,
  prevHash: string,
  options: { ts?: string; name?: string; trace_id?: string; span_id?: string } = {},
): UnsignedReceipt {
  const ts = options.ts ?? T0;
  return {
    v: 1,
    system_id: systemId,
    seq,
    ts_event: ts,
    ts_received: ts,
    actor: { agent: "support-agent" },
    action: { kind: "tool_call", name: options.name ?? `tool-${seq}` },
    input_hash: "a".repeat(64),
    output_hash: "b".repeat(64),
    outcome: "ok",
    source:
      options.trace_id === undefined
        ? { type: "api" }
        : { type: "otlp", trace_id: options.trace_id, span_id: options.span_id ?? "c".repeat(16) },
    prev_hash: prevHash,
    key_id: keyId,
  };
}
