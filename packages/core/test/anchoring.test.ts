import { describe, expect, it } from "vitest";
import { anchorTimes, type AnchoredCheckpoint, type AnchorTimeOptions } from "@sigillo/core";

/**
 * When each checkpoint, and so each receipt, is proven to have existed: by the
 * time the authority attests inside the token (genTime), never by the
 * server's own clock. Pure: every time is given here.
 */

const MINUTE = 60_000;

/** Receipts seq from..to, received one minute apart from 14:00. */
function receipts(from: number, to: number): { seq: number; ts_received: string }[] {
  const list = [];
  for (let seq = from; seq <= to; seq += 1) {
    list.push({ seq, ts_received: new Date(Date.parse("2026-03-29T14:00:00.000Z") + seq * MINUTE).toISOString() });
  }
  return list;
}

function checkpoint(line: number, treeSize: number, ts: string, ...genTimes: string[]): AnchoredCheckpoint {
  return { line, tree_size: treeSize, ts, genTimes };
}

function analyse(overrides: Partial<AnchorTimeOptions>): ReturnType<typeof anchorTimes> {
  return anchorTimes({
    receipts: receipts(0, 11),
    checkpoints: [],
    clockToleranceMs: 5 * MINUTE,
    maxAnchorDelayMs: 60 * MINUTE,
    ...overrides,
  });
}

describe("the proven time of a checkpoint", () => {
  it("is the time its token attests", () => {
    const result = analyse({ checkpoints: [checkpoint(1, 12, "2026-03-29T15:00:00.000Z", "2026-03-29T15:00:05.000Z")] });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.checkpoints).toEqual([
      { line: 1, tree_size: 12, ts: "2026-03-29T15:00:00.000Z", provenAt: "2026-03-29T15:00:05.000Z", delayMs: 5000, late: false },
    ]);
  });

  it("is the earliest of several tokens", () => {
    const result = analyse({
      checkpoints: [checkpoint(1, 12, "2026-03-29T15:00:00.000Z", "2026-03-29T15:02:00.000Z", "2026-03-29T15:00:30.000Z")],
    });
    expect(result.checkpoints[0]?.provenAt).toBe("2026-03-29T15:00:30.000Z");
  });

  it("does not exist for a checkpoint with no readable token", () => {
    const result = analyse({ checkpoints: [checkpoint(1, 12, "2026-03-29T15:00:00.000Z")] });
    expect(result.checkpoints[0]?.provenAt).toBeUndefined();
    expect(result.checkpoints[0]?.late).toBe(false);
    expect(result.ranges).toEqual([]);
    expect(result.unproven).toEqual({ count: 12, from_seq: 0, to_seq: 11 });
  });
});

describe("each receipt existed no later than the first proven checkpoint that includes it", () => {
  it("groups the receipts by the checkpoint that proves them", () => {
    const result = analyse({
      checkpoints: [
        checkpoint(2, 12, "2026-03-29T16:00:00.000Z", "2026-03-29T16:00:04.000Z"),
        checkpoint(1, 5, "2026-03-29T15:00:00.000Z", "2026-03-29T15:00:04.000Z"),
      ],
    });
    // Sorted by tree size, whatever the order of the lines.
    expect(result.checkpoints.map((entry) => entry.tree_size)).toEqual([5, 12]);
    expect(result.ranges).toEqual([
      { from_seq: 0, to_seq: 4, existedBy: "2026-03-29T15:00:04.000Z" },
      { from_seq: 5, to_seq: 11, existedBy: "2026-03-29T16:00:04.000Z" },
    ]);
    expect(result.unproven).toBeNull();
  });

  it("passes over a checkpoint with no token to the next one that has one", () => {
    const result = analyse({
      checkpoints: [
        checkpoint(1, 5, "2026-03-29T15:00:00.000Z"),
        checkpoint(2, 9, "2026-03-29T15:30:00.000Z", "2026-03-29T15:30:04.000Z"),
      ],
    });
    expect(result.ranges).toEqual([{ from_seq: 0, to_seq: 8, existedBy: "2026-03-29T15:30:04.000Z" }]);
    expect(result.unproven).toEqual({ count: 3, from_seq: 9, to_seq: 11 });
  });

  it("covers only the receipts of the window, for an export that starts after seq 0", () => {
    const result = analyse({
      receipts: receipts(4, 11),
      checkpoints: [checkpoint(1, 9, "2026-03-29T15:00:00.000Z", "2026-03-29T15:00:04.000Z")],
    });
    expect(result.ranges).toEqual([{ from_seq: 4, to_seq: 8, existedBy: "2026-03-29T15:00:04.000Z" }]);
    expect(result.unproven).toEqual({ count: 3, from_seq: 9, to_seq: 11 });
  });

  it("fails a receipt the server says it received after the authority dated a checkpoint holding it", () => {
    // Receipt seq 11 claims 14:11; the checkpoint over it was stamped at 14:05,
    // more than five minutes earlier. Seq 10, at 14:10, is within the tolerance.
    const result = analyse({
      checkpoints: [checkpoint(1, 12, "2026-03-29T14:05:00.000Z", "2026-03-29T14:05:00.000Z")],
    });
    expect(result.errors).toEqual([
      {
        check: "anchor-time",
        location: "receipts.jsonl:12",
        detail:
          "receipt seq 11 was received at 2026-03-29T14:11:00.000Z, but the checkpoint over 12 receipts that holds it " +
          "was timestamped at 2026-03-29T14:05:00.000Z: a receipt cannot be received after a timestamp that already includes it",
      },
    ]);
  });

  it("allows the clock tolerance, and no more", () => {
    const at = (genTime: string): number =>
      analyse({ checkpoints: [checkpoint(1, 12, genTime, genTime)] }).errors.length;
    // seq 11 was received at 14:11:00.
    expect(at("2026-03-29T14:06:00.000Z")).toBe(0);
    expect(at("2026-03-29T14:05:59.999Z")).toBe(1);
    expect(
      analyse({ checkpoints: [checkpoint(1, 12, "2026-03-29T14:06:00.000Z", "2026-03-29T14:06:00.000Z")], clockToleranceMs: 0 })
        .errors.length,
    ).toBe(1);
  });

  it("names one receipt per checkpoint, the first that is out of time", () => {
    const result = analyse({
      checkpoints: [
        checkpoint(1, 6, "2026-03-29T13:00:00.000Z", "2026-03-29T13:00:00.000Z"),
        checkpoint(2, 12, "2026-03-29T13:00:00.000Z", "2026-03-29T13:00:00.000Z"),
      ],
    });
    expect(result.errors.map((error) => error.location)).toEqual(["receipts.jsonl:1", "receipts.jsonl:7"]);
  });
});

describe("the attested times run forward", () => {
  it("fails a checkpoint over more receipts that the authority dates earlier", () => {
    const result = analyse({
      checkpoints: [
        checkpoint(1, 5, "2026-03-29T15:00:00.000Z", "2026-03-29T15:00:04.000Z"),
        checkpoint(2, 9, "2026-03-29T16:00:00.000Z", "2026-03-29T15:00:03.000Z"),
      ],
    });
    expect(result.errors).toContainEqual({
      check: "anchor-order",
      location: "checkpoints.jsonl:2",
      detail:
        "the checkpoint over 9 receipts was timestamped at 2026-03-29T15:00:03.000Z, before the checkpoint over 5 " +
        "receipts (2026-03-29T15:00:04.000Z): a larger tree cannot be older than a smaller one",
    });
  });

  it("compares with the latest time before it, skipping checkpoints with no token", () => {
    const result = analyse({
      checkpoints: [
        checkpoint(1, 3, "2026-03-29T15:00:00.000Z", "2026-03-29T15:00:04.000Z"),
        checkpoint(2, 6, "2026-03-29T15:30:00.000Z"),
        checkpoint(3, 9, "2026-03-29T16:00:00.000Z", "2026-03-29T14:59:00.000Z"),
      ],
    });
    expect(result.errors.filter((error) => error.check === "anchor-order").map((error) => error.location)).toEqual([
      "checkpoints.jsonl:3",
    ]);
  });

  it("accepts two checkpoints stamped in the same second", () => {
    const result = analyse({
      checkpoints: [
        checkpoint(1, 5, "2026-03-29T15:00:00.000Z", "2026-03-29T15:00:04.000Z"),
        checkpoint(2, 12, "2026-03-29T15:00:00.000Z", "2026-03-29T15:00:04.000Z"),
      ],
    });
    expect(result.errors).toEqual([]);
  });
});

describe("a checkpoint timestamped long after its own time", () => {
  it("is a warning beyond the maximum delay, and counted", () => {
    const result = analyse({
      checkpoints: [
        checkpoint(1, 5, "2026-03-29T15:00:00.000Z", "2026-03-29T16:00:00.000Z"),
        checkpoint(2, 12, "2026-03-29T16:00:00.000Z", "2026-10-01T09:00:00.000Z"),
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.late).toBe(1);
    expect(result.checkpoints.map((entry) => entry.late)).toEqual([false, true]);
    expect(result.warnings).toEqual([
      {
        check: "anchor-delay",
        location: "checkpoints.jsonl:2",
        detail:
          "the checkpoint over 12 receipts declares 2026-03-29T16:00:00.000Z, but the authority dates it " +
          "2026-10-01T09:00:00.000Z, 185 days 17 h later (more than 60 min): until then only the server's clock vouched for it",
      },
    ]);
  });

  it("follows the maximum it is given", () => {
    const late = (maxAnchorDelayMs: number): number =>
      analyse({
        maxAnchorDelayMs,
        checkpoints: [checkpoint(1, 12, "2026-03-29T15:00:00.000Z", "2026-03-29T15:30:00.000Z")],
      }).late;
    expect(late(60 * MINUTE)).toBe(0);
    expect(late(30 * MINUTE)).toBe(0);
    expect(late(29 * MINUTE)).toBe(1);
  });
});

describe("the summary", () => {
  it("gives the longest gap between two consecutive timestamps", () => {
    const result = analyse({
      checkpoints: [
        checkpoint(1, 3, "2026-03-29T15:00:00.000Z", "2026-03-29T15:00:00.000Z"),
        checkpoint(2, 6, "2026-03-29T16:00:00.000Z", "2026-03-29T16:00:00.000Z"),
        checkpoint(3, 9, "2026-03-29T16:30:00.000Z"),
        checkpoint(4, 12, "2026-03-29T19:00:00.000Z", "2026-03-29T19:00:00.000Z"),
      ],
    });
    expect(result.longestGap).toEqual({
      ms: 3 * 60 * MINUTE,
      from: "2026-03-29T16:00:00.000Z",
      to: "2026-03-29T19:00:00.000Z",
    });
  });

  it("has no gap with fewer than two timestamps", () => {
    expect(analyse({ checkpoints: [checkpoint(1, 12, "2026-03-29T15:00:00.000Z", "2026-03-29T15:00:00.000Z")] }).longestGap).toBeNull();
    expect(analyse({}).longestGap).toBeNull();
  });

  it("counts every receipt as not yet timestamped when no checkpoint is", () => {
    expect(analyse({}).unproven).toEqual({ count: 12, from_seq: 0, to_seq: 11 });
  });
});
