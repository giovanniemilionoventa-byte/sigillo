import { verify, X509Certificate, type KeyObject } from "node:crypto";

/**
 * Sign-in for the customers of a hosted installation, through Firebase
 * Authentication, entirely from the server.
 *
 * No Firebase script ever runs in the browser: every page of the web view
 * stays under a Content-Security-Policy that allows one inline script of
 * ours and nothing else (deploy/Caddyfile). The browser posts an email and a
 * password to this server, or is sent to Google and back here; this server
 * speaks to Firebase's REST API (Identity Toolkit) over TLS, and believes an
 * identity only from an ID token whose signature it has checked itself
 * against Google's published certificates, for this project.
 *
 * Firebase keeps the passwords, sends the verification and reset emails,
 * and runs the Google consent. Sigillo keeps the account's uid and email.
 */

export interface FirebaseSettings {
  /** The web API key: public, it identifies the project to the REST API. */
  apiKey: string;
  projectId: string;
}

/** Who Firebase says signed in, from a verified ID token. */
export interface FirebaseIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  /** "password" or "google.com". */
  provider: string;
  /** The ID token itself: needed to ask Firebase for a verification email. */
  idToken: string;
}

/**
 * Something Firebase refused, by its own code (EMAIL_EXISTS,
 * INVALID_LOGIN_CREDENTIALS, TOO_MANY_ATTEMPTS_TRY_LATER, …), or one of ours:
 * TOKEN_INVALID when a token does not verify, UNAVAILABLE when Firebase could
 * not be reached or answered something unreadable.
 */
export class FirebaseError extends Error {
  constructor(readonly code: string) {
    super(`firebase: ${code}`);
    this.name = "FirebaseError";
  }
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1";
export const SECURETOKEN_CERTS =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
/** How far the token's times may be from this server's clock. */
const CLOCK_SKEW_SECONDS = 300;
const MAX_UID = 128;

export class FirebaseAuth {
  private certs: { keys: Map<string, KeyObject>; until: number } | null = null;
  private readonly fetch: Fetch;

  constructor(
    private readonly settings: FirebaseSettings,
    private readonly now: () => Date,
    fetchImplementation: Fetch = globalThis.fetch as unknown as Fetch,
  ) {
    this.fetch = fetchImplementation;
  }

  get projectId(): string {
    return this.settings.projectId;
  }

  /** Email and password. Throws FirebaseError with Firebase's code when they are wrong. */
  async signInWithPassword(email: string, password: string): Promise<FirebaseIdentity> {
    const reply = await this.call("accounts:signInWithPassword", { email, password, returnSecureToken: true });
    return this.verifyIdToken(stringField(reply, "idToken"));
  }

  /**
   * A new email-and-password account; Firebase then sends the address a
   * verification link. `language` ("en", "it") is the email's: Firebase reads
   * it from X-Firebase-Locale and writes its own template in that language.
   */
  async signUp(email: string, password: string, language?: string): Promise<void> {
    const reply = await this.call("accounts:signUp", { email, password, returnSecureToken: true });
    await this.sendVerification(stringField(reply, "idToken"), language);
  }

  async sendVerification(idToken: string, language?: string): Promise<void> {
    await this.call("accounts:sendOobCode", { requestType: "VERIFY_EMAIL", idToken }, language);
  }

  /** Firebase emails a reset link if the address has an account, and says nothing either way. */
  async sendPasswordReset(email: string, language?: string): Promise<void> {
    await this.call("accounts:sendOobCode", { requestType: "PASSWORD_RESET", email }, language);
  }

  /**
   * Where to send the browser to sign in with Google. The authorization code
   * flow, so that Google's answer arrives in the query string, which this
   * server reads, and not in a fragment, which only a script could.
   * `sessionId` is ours, kept in a cookie, and must come back with the code.
   */
  async googleAuthUri(continueUri: string, sessionId: string): Promise<string> {
    const reply = await this.call("accounts:createAuthUri", {
      providerId: "google.com",
      continueUri,
      sessionId,
      authFlowType: "CODE_FLOW",
      oauthScope: "openid email",
    });
    return stringField(reply, "authUri");
  }

  /** Google's answer, the URL it sent the browser back to, exchanged for an identity. */
  async signInWithGoogle(requestUri: string, sessionId: string): Promise<FirebaseIdentity> {
    const reply = await this.call("accounts:signInWithIdp", {
      requestUri,
      sessionId,
      returnSecureToken: true,
      returnIdpCredential: false,
    });
    return this.verifyIdToken(stringField(reply, "idToken"));
  }

  /**
   * An ID token checked as Firebase documents it: RS256, signed by one of
   * Google's current keys, for this project (`aud`) and issued by it (`iss`),
   * within its lifetime, naming a user (`sub`) with an email.
   */
  async verifyIdToken(idToken: string): Promise<FirebaseIdentity> {
    const parts = idToken.split(".");
    if (parts.length !== 3) throw new FirebaseError("TOKEN_INVALID");
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeJson(headerPart);
    const payload = decodeJson(payloadPart);
    if (header === null || payload === null) throw new FirebaseError("TOKEN_INVALID");
    if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") throw new FirebaseError("TOKEN_INVALID");

    const key = (await this.keys()).get(header["kid"]);
    if (key === undefined) throw new FirebaseError("TOKEN_INVALID");
    const signed = verify(
      "RSA-SHA256",
      Buffer.from(`${headerPart}.${payloadPart}`),
      key,
      Buffer.from(signaturePart, "base64url"),
    );
    if (!signed) throw new FirebaseError("TOKEN_INVALID");

    const now = Math.floor(this.now().getTime() / 1000);
    const projectId = this.settings.projectId;
    const number = (name: string): number => (typeof payload[name] === "number" ? (payload[name] as number) : Number.NaN);
    const valid =
      payload["aud"] === projectId &&
      payload["iss"] === `https://securetoken.google.com/${projectId}` &&
      typeof payload["sub"] === "string" &&
      payload["sub"].length > 0 &&
      payload["sub"].length <= MAX_UID &&
      number("exp") > now - CLOCK_SKEW_SECONDS &&
      number("iat") <= now + CLOCK_SKEW_SECONDS &&
      number("auth_time") <= now + CLOCK_SKEW_SECONDS &&
      typeof payload["email"] === "string" &&
      payload["email"].length > 0;
    if (!valid) throw new FirebaseError("TOKEN_INVALID");

    const firebase = payload["firebase"];
    const provider =
      typeof firebase === "object" && firebase !== null && typeof (firebase as Record<string, unknown>)["sign_in_provider"] === "string"
        ? ((firebase as Record<string, unknown>)["sign_in_provider"] as string)
        : "unknown";
    return {
      uid: payload["sub"] as string,
      email: (payload["email"] as string).toLowerCase(),
      emailVerified: payload["email_verified"] === true,
      provider,
      idToken,
    };
  }

  /** Google's signing certificates, fetched again when their Cache-Control says they have expired. */
  private async keys(): Promise<Map<string, KeyObject>> {
    const now = this.now().getTime();
    if (this.certs !== null && this.certs.until > now) return this.certs.keys;
    let response;
    try {
      response = await this.fetch(SECURETOKEN_CERTS);
    } catch {
      throw new FirebaseError("UNAVAILABLE");
    }
    if (!response.ok) throw new FirebaseError("UNAVAILABLE");
    const body = await response.json().catch(() => null);
    if (typeof body !== "object" || body === null) throw new FirebaseError("UNAVAILABLE");
    const keys = new Map<string, KeyObject>();
    for (const [kid, pem] of Object.entries(body as Record<string, unknown>)) {
      if (typeof pem !== "string") continue;
      try {
        keys.set(kid, new X509Certificate(pem).publicKey);
      } catch {
        // A certificate that does not parse signs nothing here.
      }
    }
    const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "");
    this.certs = { keys, until: now + Math.min(Number(maxAge?.[1] ?? 3600), 24 * 3600) * 1000 };
    return keys;
  }

  private async call(method: string, body: Record<string, unknown>, language?: string): Promise<Record<string, unknown>> {
    let response;
    try {
      response = await this.fetch(`${IDENTITY_TOOLKIT}/${method}?key=${encodeURIComponent(this.settings.apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(language === undefined ? {} : { "x-firebase-locale": language }) },
        body: JSON.stringify(body),
      });
    } catch {
      throw new FirebaseError("UNAVAILABLE");
    }
    const reply = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (reply === null || typeof reply !== "object") throw new FirebaseError("UNAVAILABLE");
    if (!response.ok) {
      const error = reply["error"];
      const message =
        typeof error === "object" && error !== null && typeof (error as Record<string, unknown>)["message"] === "string"
          ? ((error as Record<string, unknown>)["message"] as string)
          : "UNAVAILABLE";
      // "WEAK_PASSWORD : Password should be at least 6 characters": the code is the first word.
      throw new FirebaseError(message.split(/[\s:]/)[0] ?? "UNAVAILABLE");
    }
    return reply;
  }
}

function stringField(reply: Record<string, unknown>, name: string): string {
  const value = reply[name];
  if (typeof value !== "string" || value.length === 0) throw new FirebaseError("UNAVAILABLE");
  return value;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
