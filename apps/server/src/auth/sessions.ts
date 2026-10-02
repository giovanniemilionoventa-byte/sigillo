import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ORGANIZATION_ID } from "../storage/store.js";
import type { Viewer } from "./tenancy.js";

/**
 * The web view's sessions: a cookie that says who signed in and until when,
 * under an HMAC whose secret lives only in this process. Nothing is stored:
 * a restart signs everyone out, which for this view is the right trade.
 *
 * The cookie is `<expiry>.<who>.<mac>`, where `who` is `operator` or
 * `org_<organization_id>` (an organization identifier has no underscore and
 * no dot, so the two never meet and the cookie splits one way only).
 *
 * Signing out moves that viewer's epoch on, and every cookie issued to the
 * same viewer before, copies included, stops working (review point 12). The
 * operator signing out does not sign an organization out, nor the reverse.
 */
export class UiSessions {
  private readonly secret: Buffer;
  private readonly epochs = new Map<string, number>();

  constructor(
    readonly hours = 12,
    secret: Buffer = randomBytes(32),
  ) {
    this.secret = secret;
  }

  /** A new cookie value for `viewer`, and how long the browser should keep it. */
  issue(viewer: Viewer, nowMs: number): { value: string; maxAgeSeconds: number } {
    const expiry = String(nowMs + this.hours * 3600 * 1000);
    const who = whoOf(viewer);
    return { value: `${expiry}.${who}.${this.mac(expiry, who)}`, maxAgeSeconds: this.hours * 3600 };
  }

  /** Who a cookie value stands for, or null: absent, malformed, expired, forged, or signed out. */
  read(value: string | undefined, nowMs: number): Viewer | null {
    if (value === undefined) return null;
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const [expiry, who, given] = parts as [string, string, string];
    const deadline = Number(expiry);
    if (!/^\d+$/.test(expiry) || !Number.isFinite(deadline) || deadline < nowMs) return null;
    const viewer = viewerOf(who);
    if (viewer === null) return null;
    const expected = this.mac(expiry, who);
    if (given.length !== expected.length || !/^[0-9a-f]+$/.test(given)) return null;
    return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex")) ? viewer : null;
  }

  /** Ends every session `viewer` holds. */
  endAll(viewer: Viewer): void {
    const who = whoOf(viewer);
    this.epochs.set(who, (this.epochs.get(who) ?? 0) + 1);
  }

  private mac(expiry: string, who: string): string {
    return createHmac("sha256", this.secret)
      .update(`${expiry}.${who}.${this.epochs.get(who) ?? 0}`)
      .digest("hex");
  }
}

function whoOf(viewer: Viewer): string {
  return viewer.kind === "operator" ? "operator" : `org_${viewer.organizationId}`;
}

function viewerOf(who: string): Viewer | null {
  if (who === "operator") return { kind: "operator" };
  if (!who.startsWith("org_")) return null;
  const organizationId = who.slice("org_".length);
  return ORGANIZATION_ID.test(organizationId) ? { kind: "organization", organizationId } : null;
}
