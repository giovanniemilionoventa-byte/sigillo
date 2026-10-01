/**
 * When each checkpoint, and so each receipt, is proven to have existed.
 *
 * A checkpoint carries a time (`ts`) and a signature, but both come from the
 * server: whoever holds the server and its key can rewrite a chain, re-sign it
 * with yesterday's dates and have it timestamped today. What they cannot do is
 * make an authority date a token in the past. So the time a checkpoint is
 * proven to have existed is the time its RFC 3161 token attests (genTime), and
 * a receipt existed no later than the first such time of a checkpoint whose
 * tree includes it.
 *
 * From that follow three rules, checked here for `sigillo-verify` and the PDF
 * report alike:
 *
 *   anchor-time   error    a receipt the server says it received after the
 *                          authority already dated a tree that includes it
 *                          (beyond a tolerance for the two clocks).
 *   anchor-order  error    taken in order of tree size, the attested times go
 *                          backwards: a larger tree cannot be older.
 *   anchor-delay  warning  the authority dates a checkpoint more than the
 *                          allowed delay after the checkpoint's own time:
 *                          until then only the server vouched for it, and a
 *                          chain rewritten and stamped afresh looks like this.
 *
 * Pure: the genTimes, the tolerance and the delay are all given by the caller.
 */

export interface AnchoredCheckpoint {
  /** Its line in checkpoints.jsonl, for messages. */
  line: number;
  tree_size: number;
  /** The checkpoint's own, server-declared time. */
  ts: string;
  /** The times its tokens attest (genTime), as ISO 8601. Empty when it has none. */
  genTimes: readonly string[];
}

export interface AnchorTimeOptions {
  /** The receipts of the export, in seq order. */
  receipts: readonly { seq: number; ts_received: string }[];
  /** Only the checkpoints tied to these receipts, by a rebuilt root or a proof. */
  checkpoints: readonly AnchoredCheckpoint[];
  clockToleranceMs: number;
  maxAnchorDelayMs: number;
}

export interface CheckpointProof {
  line: number;
  tree_size: number;
  ts: string;
  /** The earliest time a token on it attests; absent when it has none. */
  provenAt?: string;
  /** provenAt minus ts. */
  delayMs?: number;
  /** Timestamped more than the allowed delay after its own time. */
  late: boolean;
}

export interface AnchorTimeProblem {
  check: "anchor-time" | "anchor-order" | "anchor-delay";
  location: string;
  detail: string;
}

export interface AnchorTimes {
  /** By tree size. */
  checkpoints: CheckpointProof[];
  /** Consecutive receipts proven by the same time, in seq order. */
  ranges: { from_seq: number; to_seq: number; existedBy: string }[];
  errors: AnchorTimeProblem[];
  warnings: AnchorTimeProblem[];
  /** How many checkpoints were timestamped late. */
  late: number;
  /** The longest time between two consecutive attested times. */
  longestGap: { ms: number; from: string; to: string } | null;
  /** The receipts at the end of the export that no timestamp covers yet; null when there are none. */
  unproven: { count: number; from_seq: number; to_seq: number } | null;
}

const MINUTE = 60_000;

/** How far the server's clock may run ahead of the authority's (sigillo-verify --clock-tolerance). */
export const DEFAULT_CLOCK_TOLERANCE_MS = 5 * MINUTE;
/** How long after its own time a checkpoint may be timestamped without a warning (--max-anchor-delay). */
export const DEFAULT_MAX_ANCHOR_DELAY_MS = 60 * MINUTE;

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A duration as a person reads it: "185 days 17 h", "3 h 20 min", "4 min", "12 s". */
export function formatDuration(ms: number): string {
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) return `${days} day${days === 1 ? "" : "s"}${hours > 0 ? ` ${hours} h` : ""}`;
  if (hours > 0) return `${hours} h${minutes > 0 ? ` ${minutes} min` : ""}`;
  if (minutes > 0) return `${minutes} min`;
  return `${Math.floor(ms / 1000)} s`;
}

export function anchorTimes(options: AnchorTimeOptions): AnchorTimes {
  const timeErrors: AnchorTimeProblem[] = [];
  const orderErrors: AnchorTimeProblem[] = [];
  const warnings: AnchorTimeProblem[] = [];
  const receipts = options.receipts;
  const firstSeq = receipts[0]?.seq ?? 0;
  const lastSeq = receipts[receipts.length - 1]?.seq ?? -1;

  const checkpoints: CheckpointProof[] = [...options.checkpoints]
    .sort((a, b) => a.tree_size - b.tree_size)
    .map((entry) => {
      const times = entry.genTimes.map((time) => Date.parse(time)).filter((time) => !Number.isNaN(time));
      const base = { line: entry.line, tree_size: entry.tree_size, ts: entry.ts };
      if (times.length === 0) return { ...base, late: false };
      const proven = Math.min(...times);
      const delayMs = proven - Date.parse(entry.ts);
      return { ...base, provenAt: new Date(proven).toISOString(), delayMs, late: delayMs > options.maxAnchorDelayMs };
    });
  const proven = checkpoints.filter(
    (entry): entry is CheckpointProof & { provenAt: string; delayMs: number } => entry.provenAt !== undefined,
  );

  // anchor-delay: a checkpoint timestamped long after its own time.
  for (const entry of proven) {
    if (!entry.late) continue;
    warnings.push({
      check: "anchor-delay",
      location: `checkpoints.jsonl:${entry.line}`,
      detail:
        `the checkpoint over ${entry.tree_size} receipts declares ${entry.ts}, but the authority dates it ` +
        `${entry.provenAt}, ${formatDuration(entry.delayMs)} later (more than ${Math.round(options.maxAnchorDelayMs / MINUTE)} min): ` +
        "until then only the server's clock vouched for it",
    });
  }

  // anchor-order: by tree size, the attested times only go forward.
  let latest: (typeof proven)[number] | undefined;
  for (const entry of proven) {
    if (latest !== undefined && Date.parse(entry.provenAt) < Date.parse(latest.provenAt)) {
      orderErrors.push({
        check: "anchor-order",
        location: `checkpoints.jsonl:${entry.line}`,
        detail:
          `the checkpoint over ${entry.tree_size} receipts was timestamped at ${entry.provenAt}, before the checkpoint ` +
          `over ${latest.tree_size} receipts (${latest.provenAt}): a larger tree cannot be older than a smaller one`,
      });
    }
    if (latest === undefined || Date.parse(entry.provenAt) >= Date.parse(latest.provenAt)) latest = entry;
  }

  // Each receipt existed no later than the earliest attested time of a tree
  // that includes it. Walking down from the largest tree keeps that minimum.
  const ranges: AnchorTimes["ranges"] = [];
  let earliest: (typeof proven)[number] | undefined;
  for (let index = proven.length - 1; index >= 0; index -= 1) {
    const entry = proven[index] as (typeof proven)[number];
    if (earliest === undefined || Date.parse(entry.provenAt) < Date.parse(earliest.provenAt)) earliest = entry;
    const from = Math.max(firstSeq, index === 0 ? 0 : (proven[index - 1] as CheckpointProof).tree_size);
    const to = Math.min(lastSeq, entry.tree_size - 1);
    if (from > to) continue;
    ranges.unshift({ from_seq: from, to_seq: to, existedBy: earliest.provenAt });

    // anchor-time: the first receipt of the range received after that time.
    const limit = Date.parse(earliest.provenAt) + options.clockToleranceMs;
    const offending = receipts.findIndex(
      (receipt) => receipt.seq >= from && receipt.seq <= to && Date.parse(receipt.ts_received) > limit,
    );
    const receipt = receipts[offending];
    if (receipt !== undefined) {
      // Found from the largest tree down; listed in seq order.
      timeErrors.unshift({
        check: "anchor-time",
        location: `receipts.jsonl:${offending + 1}`,
        detail:
          `receipt seq ${receipt.seq} was received at ${receipt.ts_received}, but the checkpoint over ` +
          `${earliest.tree_size} receipts that holds it was timestamped at ${earliest.provenAt}: ` +
          "a receipt cannot be received after a timestamp that already includes it",
      });
    }
  }

  let longestGap: AnchorTimes["longestGap"] = null;
  for (let index = 1; index < proven.length; index += 1) {
    const from = (proven[index - 1] as (typeof proven)[number]).provenAt;
    const to = (proven[index] as (typeof proven)[number]).provenAt;
    const ms = Date.parse(to) - Date.parse(from);
    if (longestGap === null || ms > longestGap.ms) longestGap = { ms, from, to };
  }

  const coveredThrough = ranges.length === 0 ? firstSeq - 1 : (ranges[ranges.length - 1] as { to_seq: number }).to_seq;
  const unproven: AnchorTimes["unproven"] =
    coveredThrough >= lastSeq
      ? null
      : { count: lastSeq - coveredThrough, from_seq: coveredThrough + 1, to_seq: lastSeq };

  return {
    checkpoints,
    ranges,
    errors: [...timeErrors, ...orderErrors],
    warnings,
    late: proven.filter((entry) => entry.late).length,
    longestGap,
    unproven,
  };
}
