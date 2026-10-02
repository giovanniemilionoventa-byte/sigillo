import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ORGANIZATION_ID } from "../storage/store.js";
import type { Viewer } from "./tenancy.js";

/**
 * The web view's sessions: a cookie that says who signed in and until when,
 * under an HMAC whose secret lives only in this process. Nothing is stored:
 * a restart signs everyone out, which for this view is the right trade.
 *
 * The cookie is `<expiry>.<who>.<mac>`, where `who` is `operator`,
 * `org_<organization_id>`, or `org_<organization_id>_<uid>` for a member who
 * signed in (an organization identifier has no underscore and no dot, and a
 * Firebase uid only letters and digits, so the cookie splits one way only).
 *
 * Signing out moves that viewer's epoch on, and every cookie issued to the
 * same viewer before, copies included, stops working (review point 12). One
 * member signing out signs out nobody else.
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

  /**
   * A short-lived value only this process can have issued: the Google
   * sign-in's session id between the redirect and the return, and who signed
   * in between Firebase and the "your company" form. `purpose` keeps one kind
   * from being replayed as the other, and none of them is a session.
   */
  seal(purpose: string, payload: string, nowMs: number, ttlMs: number): string {
    const expiry = String(nowMs + ttlMs);
    const body = Buffer.from(payload, "utf8").toString("base64url");
    return `${expiry}.${body}.${this.sealMac(purpose, expiry, body)}`;
  }

  /** The payload of a sealed value, or null: absent, malformed, expired, or not sealed here for `purpose`. */
  unseal(purpose: string, value: string | undefined, nowMs: number): string | null {
    if (value === undefined) return null;
    const parts = value.split(".");
    if (parts.length !== 3) return null;
    const [expiry, body, given] = parts as [string, string, string];
    if (!/^\d+$/.test(expiry) || Number(expiry) < nowMs || !/^[0-9a-f]{64}$/.test(given)) return null;
    const expected = this.sealMac(purpose, expiry, body);
    if (!timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"))) return null;
    return Buffer.from(body, "base64url").toString("utf8");
  }

  private sealMac(purpose: string, expiry: string, body: string): string {
    return createHmac("sha256", this.secret).update(`seal:${purpose}.${expiry}.${body}`).digest("hex");
  }

  private mac(expiry: string, who: string): string {
    return createHmac("sha256", this.secret)
      .update(`${expiry}.${who}.${this.epochs.get(who) ?? 0}`)
      .digest("hex");
  }
}

const UID = /^[A-Za-z0-9]{1,128}$/;

function whoOf(viewer: Viewer): string {
  if (viewer.kind === "operator") return "operator";
  return viewer.userId === undefined ? `org_${viewer.organizationId}` : `org_${viewer.organizationId}_${viewer.userId}`;
}

function viewerOf(who: string): Viewer | null {
  if (who === "operator") return { kind: "operator" };
  if (!who.startsWith("org_")) return null;
  const [organizationId, userId, ...rest] = who.slice("org_".length).split("_");
  if (organizationId === undefined || !ORGANIZATION_ID.test(organizationId) || rest.length > 0) return null;
  if (userId === undefined) return { kind: "organization", organizationId };
  return UID.test(userId) ? { kind: "organization", organizationId, userId } : null;
}
