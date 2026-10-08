import { execFileSync } from "node:child_process";
import { createSign, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { type Browser, chromium, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect } from "vitest";
import { it } from "./helpers/italian.js";
import { ApiKeyStore } from "../src/auth/api-keys.js";
import { FirebaseAuth, FirebaseError, SECURETOKEN_CERTS } from "../src/auth/firebase.js";
import { UiSessions } from "../src/auth/sessions.js";
import { OPERATOR, type Viewer } from "../src/auth/tenancy.js";
import { Checkpointer } from "../src/checkpoint/checkpointer.js";
import { firebaseAccounts } from "../src/config.js";
import { ChainHealthMonitor } from "../src/health/chain-health.js";
import { escape } from "../src/http/layout.js";
import { buildServer } from "../src/http/server.js";
import { UI } from "../src/http/strings.js";
import { ReceiptStore } from "../src/storage/store.js";
import { BROWSER_PATH, caddyfilePolicy } from "./helpers/browser.js";
import { createTestSigner, type TestSigner } from "./helpers/signer.js";

/**
 * Customers' accounts through Firebase, end to end against a stand-in for
 * Firebase's REST API. The stand-in signs its ID tokens with a real RSA key
 * whose certificate it publishes the way Google does, and the server checks
 * them with node:crypto as it would Google's: nothing cryptographic is mocked.
 */

const PROJECT = "sigillo-test";
const API_KEY = "AIzaSyTestTestTestTestTestTestTestTest";
const PUBLIC_URL = "https://sigillo.example.com";
const NOW = "2026-10-02T10:00:00.000Z";
const NOW_SECONDS = Date.parse(NOW) / 1000;
const ADMIN = { actor: "cli test", ts: "2026-10-01T09:00:00.000Z" };
const PASSWORD = "an administrator password";
const KID = "key-one";

interface KeyPair {
  privateKey: string;
  certificate: string;
}

let keyDirectory: string;
let google: KeyPair;
let stranger: KeyPair;

/** An RSA key and a self-signed certificate for it, made by openssl as Google's are published. */
function keyPair(name: string): KeyPair {
  const key = join(keyDirectory, `${name}.key`);
  const certificate = join(keyDirectory, `${name}.pem`);
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate, "-days", "2", "-subj", `/CN=${name}`],
    { stdio: "ignore" },
  );
  return { privateKey: readFileSync(key, "utf8"), certificate: readFileSync(certificate, "utf8") };
}

beforeAll(() => {
  keyDirectory = mkdtempSync(join(tmpdir(), "sigillo-firebase-keys-"));
  google = keyPair("google");
  stranger = keyPair("stranger");
});

afterAll(() => {
  rmSync(keyDirectory, { recursive: true, force: true });
});

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An ID token as Firebase issues one, with any field overridden. */
function idToken(
  claims: Record<string, unknown>,
  options: { header?: Record<string, unknown>; key?: KeyPair } = {},
): string {
  const header = base64url({ alg: "RS256", kid: KID, typ: "JWT", ...options.header });
  const payload = base64url({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    auth_time: NOW_SECONDS - 10,
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 3600,
    ...claims,
  });
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign((options.key ?? google).privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

interface Account {
  uid: string;
  password: string | null;
  verified: boolean;
  provider: string;
}

/**
 * Firebase's REST API as this server uses it: accounts by email, Google
 * consents by session id, and every email it would have sent.
 */
class FakeFirebase {
  readonly accounts = new Map<string, Account>();
  readonly emails: { kind: string; to: string }[] = [];
  readonly calls: { method: string; body: Record<string, unknown> }[] = [];
  certFetches = 0;
  /** The Google account that consents next, and the session id its consent was started under. */
  googleAccount = { email: "Anna@Example.com", uid: "googleuid0001" };
  private googleSessions = new Set<string>();
  down = false;

  /** `publicUrl`: where Google may send the browser back to, as the server was told. */
  constructor(private readonly publicUrl = PUBLIC_URL) {}

  fetch = async (url: string, init?: { body?: string }) => {
    if (this.down) throw new Error("network down");
    if (url === SECURETOKEN_CERTS) {
      this.certFetches += 1;
      return reply(200, { [KID]: google.certificate }, "public, max-age=600");
    }
    const match = /^https:\/\/identitytoolkit\.googleapis\.com\/v1\/(accounts:\w+)\?key=(.+)$/.exec(url);
    if (match === null || match[2] !== API_KEY) return reply(400, { error: { message: "API_KEY_INVALID" } });
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    this.calls.push({ method: match[1] ?? "", body });
    return this.answer(match[1] ?? "", body);
  };

  private answer(method: string, body: Record<string, unknown>) {
    const email = typeof body["email"] === "string" ? body["email"].toLowerCase() : "";
    switch (method) {
      case "accounts:signInWithPassword": {
        const account = this.accounts.get(email);
        if (account === undefined || account.password !== body["password"]) {
          return reply(400, { error: { message: "INVALID_LOGIN_CREDENTIALS" } });
        }
        return reply(200, { idToken: this.tokenFor(email, account) });
      }
      case "accounts:signUp": {
        if (this.accounts.has(email)) return reply(400, { error: { message: "EMAIL_EXISTS" } });
        const account = { uid: `uid${randomBytes(8).toString("hex")}`, password: String(body["password"]), verified: false, provider: "password" };
        this.accounts.set(email, account);
        return reply(200, { idToken: this.tokenFor(email, account) });
      }
      case "accounts:sendOobCode": {
        if (body["requestType"] === "PASSWORD_RESET") {
          if (!this.accounts.has(email)) return reply(400, { error: { message: "EMAIL_NOT_FOUND" } });
          this.emails.push({ kind: "reset", to: email });
        } else {
          const payload = JSON.parse(Buffer.from(String(body["idToken"]).split(".")[1] ?? "", "base64url").toString()) as { email: string };
          this.emails.push({ kind: "verify", to: payload.email });
        }
        return reply(200, {});
      }
      case "accounts:createAuthUri":
        this.googleSessions.add(String(body["sessionId"]));
        return reply(200, { authUri: `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s` });
      case "accounts:signInWithIdp": {
        const requestUri = String(body["requestUri"]);
        if (!this.googleSessions.has(String(body["sessionId"])) || !requestUri.startsWith(`${this.publicUrl}/ui/login/google/back?`)) {
          return reply(400, { error: { message: "INVALID_IDP_RESPONSE : the session does not match" } });
        }
        const { email: googleEmail, uid } = this.googleAccount;
        const account = { uid, password: null, verified: true, provider: "google.com" };
        this.accounts.set(googleEmail.toLowerCase(), account);
        return reply(200, { idToken: this.tokenFor(googleEmail, account) });
      }
      default:
        return reply(404, { error: { message: "NOT_FOUND" } });
    }
  }

  private tokenFor(email: string, account: Account): string {
    return idToken({
      sub: account.uid,
      email,
      email_verified: account.verified,
      firebase: { sign_in_provider: account.provider },
    });
  }
}

function reply(status: number, body: unknown, cacheControl?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "cache-control" ? (cacheControl ?? null) : null) },
    json: async () => body,
  };
}

describe("FirebaseAuth.verifyIdToken", () => {
  let now: Date;
  let fake: FakeFirebase;
  let firebase: FirebaseAuth;

  beforeEach(() => {
    now = new Date(NOW);
    fake = new FakeFirebase();
    firebase = new FirebaseAuth({ apiKey: API_KEY, projectId: PROJECT }, () => now, fake.fetch);
  });

  async function refusal(token: string): Promise<string> {
    try {
      await firebase.verifyIdToken(token);
    } catch (error) {
      return error instanceof FirebaseError ? error.code : String(error);
    }
    return "accepted";
  }

  it("accepts a token Google's key signed for this project, and lowercases the email", async () => {
    const token = idToken({ sub: "abc123", email: "Mario@Example.COM", email_verified: true, firebase: { sign_in_provider: "google.com" } });
    expect(await firebase.verifyIdToken(token)).toEqual({
      uid: "abc123",
      email: "mario@example.com",
      emailVerified: true,
      provider: "google.com",
      idToken: token,
    });
  });

  it("refuses a token for another project, from another issuer, expired, or issued in the future", async () => {
    const claims = { sub: "abc123", email: "a@example.com" };
    expect(await refusal(idToken({ ...claims, aud: "another-project" }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken({ ...claims, iss: "https://securetoken.google.com/another-project" }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken({ ...claims, exp: NOW_SECONDS - 301 }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken({ ...claims, iat: NOW_SECONDS + 301 }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken({ ...claims, auth_time: NOW_SECONDS + 301 }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken({ ...claims, exp: "never" }))).toBe("TOKEN_INVALID");
  });

  it("refuses a token without a subject or an email", async () => {
    expect(await refusal(idToken({ email: "a@example.com" }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken({ sub: "", email: "a@example.com" }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken({ sub: "x".repeat(129), email: "a@example.com" }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken({ sub: "abc123" }))).toBe("TOKEN_INVALID");
  });

  it("refuses a token signed by any other key, under an unknown key id, or with another algorithm", async () => {
    const claims = { sub: "abc123", email: "a@example.com" };
    expect(await refusal(idToken(claims, { key: stranger }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken(claims, { header: { kid: "key-two" } }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken(claims, { header: { alg: "HS256" } }))).toBe("TOKEN_INVALID");
    expect(await refusal(idToken(claims, { header: { alg: "none" } }))).toBe("TOKEN_INVALID");
    const [header, , signature] = idToken(claims).split(".");
    expect(await refusal(`${header}.${base64url({ sub: "someone-else", email: "a@example.com", aud: PROJECT })}.${signature}`)).toBe(
      "TOKEN_INVALID",
    );
    expect(await refusal(`${header}.${idToken(claims).split(".")[1]}.`)).toBe("TOKEN_INVALID");
    expect(await refusal("not a token")).toBe("TOKEN_INVALID");
  });

  it("keeps Google's certificates for as long as they say, then fetches them again", async () => {
    const token = idToken({ sub: "abc123", email: "a@example.com" });
    await firebase.verifyIdToken(token);
    await firebase.verifyIdToken(token);
    expect(fake.certFetches).toBe(1);
    now = new Date(Date.parse(NOW) + 601_000);
    await firebase.verifyIdToken(token);
    expect(fake.certFetches).toBe(2);
  });

  it("says UNAVAILABLE when Firebase cannot be reached, and passes on Firebase's own codes", async () => {
    await expect(firebase.signUp("a@example.com", "short")).resolves.toBeUndefined();
    await expect(firebase.signUp("a@example.com", "short")).rejects.toMatchObject({ code: "EMAIL_EXISTS" });
    fake.down = true;
    await expect(firebase.signInWithPassword("a@example.com", "x")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    const wrongKey = new FirebaseAuth({ apiKey: "another-key-another-key", projectId: PROJECT }, () => now, new FakeFirebase().fetch);
    await expect(wrongKey.sendPasswordReset("a@example.com")).rejects.toMatchObject({ code: "API_KEY_INVALID" });
  });
});

describe("customers' accounts in the web view", () => {
  let directory: string;
  let signer: TestSigner;
  let store: ReceiptStore;
  let keys: ApiKeyStore;
  let sessions: UiSessions;
  let fake: FakeFirebase;
  let app: FastifyInstance;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-accounts-"));
    const databasePath = join(directory, "sigillo.db");
    signer = createTestSigner();
    store = ReceiptStore.open(databasePath, signer);
    await store.createOrganization("acme", "Acme S.p.A.", ADMIN, { approved: true });
    await store.createSystem("acme.bot", "2026-10-01T09:00:00.000Z", "acme");
    await store.createSystem("operator-bot", "2026-10-01T09:00:00.000Z");
    keys = ApiKeyStore.open(databasePath);
    const healthMonitor = new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000);
    healthMonitor.check();
    sessions = new UiSessions();
    fake = new FakeFirebase();
    app = buildServer({
      store,
      keys,
      now: () => new Date(NOW),
      organizationMonthlyReceipts: 3,
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor,
        checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
        sessions,
        accounts: {
          firebase: new FirebaseAuth({ apiKey: API_KEY, projectId: PROJECT }, () => new Date(NOW), fake.fetch),
          publicUrl: `${PUBLIC_URL}/`,
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    keys.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const form = (url: string, fields: Record<string, string>, cookie?: string) =>
    app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie === undefined ? {} : { cookie }) },
      payload: new URLSearchParams(fields).toString(),
    });

  /** The `name=value` of the cookie a response set, for the next request. */
  function cookieSet(response: { headers: Record<string, unknown> }, name: string): string {
    const header = response.headers["set-cookie"];
    const all = Array.isArray(header) ? header : [header];
    const found = all.find((value): value is string => typeof value === "string" && value.startsWith(`${name}=`));
    if (found === undefined) throw new Error(`no ${name} cookie`);
    return found.split(";")[0] ?? "";
  }

  const operatorCookie = () => `sigillo_session=${sessions.issue(OPERATOR, Date.parse(NOW)).value}`;

  function account(email: string, password: string, verified: boolean): Account {
    const created = { uid: `uid${randomBytes(6).toString("hex")}`, password, verified, provider: "password" };
    fake.accounts.set(email, created);
    return created;
  }

  it("offers Google, email and sign-up on the sign-in page, and keeps the operator's password on a page of its own", async () => {
    const page = (await app.inject({ method: "GET", url: "/ui/login" })).body;
    for (const expected of ['href="/ui/login/google"', 'action="/ui/login/email"', 'href="/ui/registrati"', 'href="/ui/admin"']) {
      expect(page).toContain(expected);
    }
    // The operator's password is a link away, never a field on this page.
    expect(page).not.toContain('action="/ui/login"');
    expect(page).not.toMatch(/<script[^>]+src=/);

    const admin = (await app.inject({ method: "GET", url: "/ui/admin" })).body;
    expect(admin).toContain('<form method="post" action="/ui/login"');
    expect(admin).toContain('type="password" name="password"');
  });

  it("asks the address first, then the password on a second step, with the reset beside it", async () => {
    const step = await form("/ui/login/email", { email: "anna@rossi.it" });
    expect(step.statusCode).toBe(200);
    expect(step.headers["set-cookie"]).toBeUndefined();
    expect(step.body).toContain('<input type="hidden" name="email" value="anna@rossi.it">');
    expect(step.body).toContain('type="password" name="password"');
    expect(step.body).toContain('href="/ui/password"');
    expect(fake.calls).toEqual([]);

    const invalid = await form("/ui/login/email", { email: "not an address" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toContain('action="/ui/login/email"');
  });

  it("sends an unverified address its link again and keeps it out", async () => {
    account("nuovo@example.com", "una password lunga", false);
    const response = await form("/ui/login/email", { email: "nuovo@example.com", password: "una password lunga" });
    expect(response.statusCode).toBe(403);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(fake.emails).toEqual([{ kind: "verify", to: "nuovo@example.com" }]);
  });

  it("takes a newcomer from first sign-in to the register, through the operator's approval", async () => {
    const person = account("anna@rossi.it", "una password lunga", true);

    const first = await form("/ui/login/email", { email: "anna@rossi.it", password: "una password lunga" });
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toBe("/ui/registrazione");
    expect(first.headers["set-cookie"]).toContain("Path=/ui/registrazione");
    const ticket = cookieSet(first, "sigillo_signup");

    const company = await app.inject({ method: "GET", url: "/ui/registrazione", headers: { cookie: ticket } });
    expect(company.statusCode).toBe(200);
    expect(company.body).toContain("anna@rossi.it");

    const requested = await form("/ui/registrazione", { name: "Rossi Trasporti S.r.l." }, ticket);
    expect(requested.statusCode).toBe(200);
    expect(requested.body).toContain(escape(UI.account.waitingTitle));
    const user = store.userByUid(person.uid);
    expect(user?.email).toBe("anna@rossi.it");
    const organizationId = user?.organization_id ?? "";
    expect(organizationId).toMatch(/^rossi-trasporti-s-r-l-[0-9a-f]{4}$/);
    expect(store.organization(organizationId)?.approved_at).toBeNull();

    // A second company for the same person is refused, ticket or not.
    expect((await form("/ui/registrazione", { name: "Altra S.r.l." }, ticket)).statusCode).toBe(400);

    const waiting = await form("/ui/login/email", { email: "anna@rossi.it", password: "una password lunga" });
    expect(waiting.statusCode).toBe(403);
    expect(waiting.headers["set-cookie"]).toBeUndefined();

    const list = await app.inject({ method: "GET", url: "/ui/clienti", headers: { cookie: operatorCookie() } });
    expect(list.body).toContain("Rossi Trasporti S.r.l.");
    expect(list.body).toContain("anna@rossi.it");
    const approved = await form(`/ui/clienti/${organizationId}/approva`, {}, operatorCookie());
    expect(approved.statusCode).toBe(303);
    expect(store.organization(organizationId)?.approved_at).not.toBeNull();
    expect(store.adminLog().map((entry) => entry.action)).toEqual(["organization.approve", "user.register", "organization.create"]);

    const signedIn = await form("/ui/login/email", { email: "anna@rossi.it", password: "una password lunga" });
    expect(signedIn.statusCode).toBe(303);
    expect(signedIn.headers.location).toBe("/ui");
    const session = cookieSet(signedIn, "sigillo_session");
    const register = await app.inject({ method: "GET", url: "/ui/sistemi", headers: { cookie: session } });
    expect(register.statusCode).toBe(200);
    expect(register.body).not.toContain("acme.bot");
    expect(register.body).not.toContain("operator-bot");
    // Only the operator sees the customers.
    expect((await app.inject({ method: "GET", url: "/ui/clienti", headers: { cookie: session } })).statusCode).toBe(404);
  });

  it("takes someone who opened a transfer link, once signed in, to the link, and the system becomes theirs", async () => {
    account("bruno@acme.it", "una password lunga", true);
    const bruno = fake.accounts.get("bruno@acme.it");
    await store.registerOrganization({ uid: bruno?.uid ?? "", email: "bruno@acme.it" }, "Bruno S.r.l.", ADMIN);
    const organizationId = store.userByUid(bruno?.uid ?? "")?.organization_id ?? "";
    await store.approveOrganization(organizationId, ADMIN);

    const made = await form("/ui/systems/operator-bot/transfer", {}, operatorCookie());
    const secret = /\/ui\/trasferimento\/([A-Za-z0-9_-]{43})/.exec(made.body)?.[1] ?? "";
    expect(secret).not.toBe("");

    const opened = await app.inject({ method: "GET", url: `/ui/trasferimento/${secret}` });
    expect(opened.headers.location).toBe("/ui/login");
    const pending = cookieSet(opened, "sigillo_transfer");

    const signedIn = await form("/ui/login/email", { email: "bruno@acme.it", password: "una password lunga" }, pending);
    expect(signedIn.statusCode).toBe(303);
    expect(signedIn.headers.location).toBe(`/ui/trasferimento/${secret}`);
    const session = cookieSet(signedIn, "sigillo_session");

    // Without the cookie, the same sign-in goes to the main page; a forged one is ignored.
    const plain = await form("/ui/login/email", { email: "bruno@acme.it", password: "una password lunga" });
    expect(plain.headers.location).toBe("/ui");
    const forged = await form("/ui/login/email", { email: "bruno@acme.it", password: "una password lunga" }, "sigillo_transfer=forged");
    expect(forged.headers.location).toBe("/ui");

    const accepted = await form(`/ui/trasferimento/${secret}`, {}, session);
    expect(accepted.statusCode).toBe(303);
    expect(store.systemRecord("operator-bot")?.organization_id).toBe(organizationId);
  });

  it("refuses a sign-up ticket that was forged, expired, or sealed for something else", async () => {
    const at = Date.parse(NOW);
    const payload = JSON.stringify({ uid: "intruder1", email: "x@example.com" });
    const attempts = [
      "sigillo_signup=1.e30.00",
      `sigillo_signup=${new UiSessions().seal("signup", payload, at, 60_000)}`,
      `sigillo_signup=${sessions.seal("signup", payload, at - 120_000, 60_000)}`,
      `sigillo_signup=${sessions.seal("google", payload, at, 60_000)}`,
    ];
    for (const cookie of attempts) {
      expect((await form("/ui/registrazione", { name: "Intrusi S.p.A." }, cookie)).statusCode).toBe(401);
    }
    expect(store.userByUid("intruder1")).toBeNull();
  });

  it("does not let a member's cookie outlive their membership", async () => {
    const ghost: Viewer = { kind: "organization", organizationId: "acme", userId: "ghost1" };
    const response = await app.inject({
      method: "GET",
      url: "/ui",
      headers: { cookie: `sigillo_session=${sessions.issue(ghost, Date.parse(NOW)).value}` },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/ui/login");
  });

  it("locks the email sign-in after repeated wrong passwords, the right one included", async () => {
    account("anna@rossi.it", "una password lunga", true);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await form("/ui/login/email", { email: "anna@rossi.it", password: "sbagliata" })).statusCode).toBe(401);
    }
    const locked = await form("/ui/login/email", { email: "anna@rossi.it", password: "una password lunga" });
    expect(locked.statusCode).toBe(401);
    expect(locked.headers["set-cookie"]).toBeUndefined();
  });

  it("creates an account only with a long enough password typed twice, and sends the link", async () => {
    const short = await form("/ui/registrati", { email: "b@example.com", password: "corta", password_again: "corta" });
    expect(short.statusCode).toBe(400);
    const mismatch = await form("/ui/registrati", { email: "b@example.com", password: "una password lunga", password_again: "un'altra password" });
    expect(mismatch.statusCode).toBe(400);
    expect(fake.calls).toEqual([]);

    const created = await form("/ui/registrati", { email: "b@example.com", password: "una password lunga", password_again: "una password lunga" });
    expect(created.statusCode).toBe(200);
    expect(fake.emails).toEqual([{ kind: "verify", to: "b@example.com" }]);
    const again = await form("/ui/registrati", { email: "b@example.com", password: "una password lunga", password_again: "una password lunga" });
    expect(again.statusCode).toBe(409);
  });

  it("answers a reset request the same way whether the address has an account or not", async () => {
    account("anna@rossi.it", "una password lunga", true);
    const known = await form("/ui/password", { email: "anna@rossi.it" });
    const unknown = await form("/ui/password", { email: "nessuno@example.com" });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toBe(known.body);
    expect(fake.emails).toEqual([{ kind: "reset", to: "anna@rossi.it" }]);
  });

  it("limits sign-ups and reset requests per address, since each sends an email", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await form("/ui/password", { email: `p${attempt}@example.com` })).statusCode).toBe(200);
    }
    expect((await form("/ui/password", { email: "p9@example.com" })).statusCode).toBe(429);
    const signUp = await form("/ui/registrati", { email: "c@example.com", password: "una password lunga", password_again: "una password lunga" });
    expect(signUp.statusCode).toBe(429);
    expect(fake.accounts.has("c@example.com")).toBe(false);
  });

  it("goes to Google and back, believing only the session it started", async () => {
    const out = await app.inject({ method: "GET", url: "/ui/login/google" });
    expect(out.statusCode).toBe(302);
    expect(out.headers.location).toMatch(/^https:\/\/accounts\.google\.com\//);
    const setCookie = String(out.headers["set-cookie"]);
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/ui/login/google");
    expect(setCookie).toContain("HttpOnly");
    const started = fake.calls.find((call) => call.method === "accounts:createAuthUri")?.body;
    expect(started?.["continueUri"]).toBe(`${PUBLIC_URL}/ui/login/google/back`);
    expect(started?.["authFlowType"]).toBe("CODE_FLOW");
    const sealed = cookieSet(out, "sigillo_google");

    // Without the cookie, or with one this process did not seal, nothing is asked of Firebase.
    expect((await app.inject({ method: "GET", url: "/ui/login/google/back?code=abc" })).statusCode).toBe(400);
    const forged = `sigillo_google=${new UiSessions().seal("google", String(started?.["sessionId"]), Date.parse(NOW), 60_000)}`;
    expect((await app.inject({ method: "GET", url: "/ui/login/google/back?code=abc", headers: { cookie: forged } })).statusCode).toBe(400);
    expect(fake.calls.filter((call) => call.method === "accounts:signInWithIdp")).toEqual([]);

    const back = await app.inject({ method: "GET", url: "/ui/login/google/back?code=abc&state=s", headers: { cookie: sealed } });
    // A page that moves on by itself, not a redirect: see the browser test below.
    expect(back.statusCode).toBe(200);
    expect(back.headers.location).toBeUndefined();
    expect(back.body).toContain('<meta http-equiv="refresh" content="0; url=/ui/registrazione">');
    expect(cookieSet(back, "sigillo_signup")).toMatch(/^sigillo_signup=\d+\./);
    const exchanged = fake.calls.find((call) => call.method === "accounts:signInWithIdp")?.body;
    expect(exchanged?.["requestUri"]).toBe(`${PUBLIC_URL}/ui/login/google/back?code=abc&state=s`);
    expect(exchanged?.["sessionId"]).toBe(started?.["sessionId"]);
  });

  it("stops an organization's writes for the rest of the month at its limit, and no one else's", async () => {
    const acme = keys.issue("acme.bot", "2026-10-01T09:00:00.000Z").token;
    const operator = keys.issue("operator-bot", "2026-10-01T09:00:00.000Z").token;
    const receipt = { actor: { agent: "planner" }, action: { kind: "tool_call", name: "x" }, outcome: "ok" };
    const write = (token: string) =>
      app.inject({ method: "POST", url: "/api/v1/receipts", headers: { authorization: `Bearer ${token}` }, payload: receipt });
    for (let index = 0; index < 3; index += 1) {
      const written = await write(acme);
      expect(written.statusCode, written.body).toBe(201);
    }
    const refused = await write(acme);
    expect(refused.statusCode).toBe(429);
    // 2026-10-02T10:00Z to 2026-11-01T00:00Z.
    expect(refused.headers["retry-after"]).toBe(String(30 * 86400 - 10 * 3600));
    expect(store.readChain("acme.bot")).toHaveLength(4); // the genesis, which does not count, and three
    for (let index = 0; index < 4; index += 1) expect((await write(operator)).statusCode).toBe(201);
  });

  it("shows an organization its month: a bar in the settings, a warning near the limit, an alert at it", async () => {
    const member = `sigillo_session=${sessions.issue({ kind: "organization", organizationId: "acme" }, Date.parse(NOW)).value}`;
    const page = async (url: string): Promise<string> => (await app.inject({ method: "GET", url, headers: { cookie: member } })).body;
    const acme = keys.issue("acme.bot", "2026-10-01T09:00:00.000Z").token;
    const write = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/receipts",
        headers: { authorization: `Bearer ${acme}` },
        payload: { actor: { agent: "planner" }, action: { kind: "tool_call", name: "x" }, outcome: "ok" },
      });

    let settings = await page("/ui/impostazioni");
    expect(settings).toContain('<strong>Acme S.p.A.</strong>');
    expect(settings).toContain('role="progressbar" aria-valuemin="0" aria-valuemax="3" aria-valuenow="0"');
    expect(settings).toContain(UI.settings.quota("0", "3"));
    expect(await page("/ui")).not.toContain('class="notice');

    for (let index = 0; index < 3; index += 1) expect((await write()).statusCode).toBe(201);
    settings = await page("/ui/impostazioni");
    expect(settings).toContain('<div class="meter red" role="progressbar" aria-valuemin="0" aria-valuemax="3" aria-valuenow="3">');
    expect(await page("/ui")).toContain(`<p class="notice bad" role="alert">`);
    expect(await page("/ui")).toContain(escape(UI.home.quotaFull("3", "1 nov 2026")));

    const refused = await write();
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: expect.stringContaining("no receipt is written until 2026-11-01") });
  });
});

describe("sealed values", () => {
  const at = Date.parse(NOW);

  it("open only for the purpose and the process they were sealed for, and only in time", () => {
    const sessions = new UiSessions();
    const sealed = sessions.seal("google", "a session id", at, 60_000);
    expect(sessions.unseal("google", sealed, at + 59_000)).toBe("a session id");
    expect(sessions.unseal("google", sealed, at + 61_000)).toBeNull();
    expect(sessions.unseal("signup", sealed, at)).toBeNull();
    expect(new UiSessions().unseal("google", sealed, at)).toBeNull();
    const [expiry, body, mac] = sealed.split(".");
    expect(sessions.unseal("google", `${expiry}.${Buffer.from("another id").toString("base64url")}.${mac}`, at)).toBeNull();
    expect(sessions.unseal("google", `${Number(expiry) + 1}.${body}.${mac}`, at)).toBeNull();
    expect(sessions.unseal("google", undefined, at)).toBeNull();
  });

  it("are not session cookies, nor the other way round", () => {
    const sessions = new UiSessions();
    const session = sessions.issue({ kind: "organization", organizationId: "acme", userId: "abc123" }, at).value;
    expect(sessions.unseal("google", session, at)).toBeNull();
    expect(sessions.read(sessions.seal("google", "operator", at, 60_000), at)).toBeNull();
    expect(sessions.read(session, at)).toEqual({ kind: "organization", organizationId: "acme", userId: "abc123" });
  });
});

describe("firebaseAccounts", () => {
  const valid = {
    SIGILLO_FIREBASE_API_KEY: API_KEY,
    SIGILLO_FIREBASE_PROJECT_ID: PROJECT,
    SIGILLO_PUBLIC_URL: "https://sigillo.example.com/",
  };

  it("is off when neither is set, and needs both together", () => {
    expect(firebaseAccounts({})).toBeNull();
    expect(firebaseAccounts(valid)).toEqual({ apiKey: API_KEY, projectId: PROJECT, publicUrl: "https://sigillo.example.com" });
    expect(() => firebaseAccounts({ SIGILLO_FIREBASE_API_KEY: API_KEY })).toThrow(/go together/);
    expect(() => firebaseAccounts({ SIGILLO_FIREBASE_PROJECT_ID: PROJECT })).toThrow(/go together/);
  });

  it("wants an https origin to send Google's answers back to", () => {
    for (const address of ["", "sigillo.example.com", "http://sigillo.example.com", "https://sigillo.example.com/ui", "https://x.example.com/?a=1"]) {
      expect(() => firebaseAccounts({ ...valid, SIGILLO_PUBLIC_URL: address })).toThrow(/SIGILLO_PUBLIC_URL/);
    }
    expect(firebaseAccounts({ ...valid, SIGILLO_PUBLIC_URL: "http://localhost:8080" })?.publicUrl).toBe("http://localhost:8080");
  });

  it("refuses values that cannot be a key or a project", () => {
    expect(() => firebaseAccounts({ ...valid, SIGILLO_FIREBASE_API_KEY: "short" })).toThrow(/API key/);
    // Pasted through a chat: invisible characters inside, counted, not shown.
    expect(() => firebaseAccounts({ ...valid, SIGILLO_FIREBASE_API_KEY: `AIzaSyBp\u200b${API_KEY.slice(8)}` })).toThrow(
      /: 39 characters, 1 of them not a letter/,
    );
  });

  it("ignores spaces around the values", () => {
    expect(firebaseAccounts({ ...valid, SIGILLO_FIREBASE_API_KEY: ` ${API_KEY} `, SIGILLO_FIREBASE_PROJECT_ID: `${PROJECT}\r` })).toEqual({
      apiKey: API_KEY,
      projectId: PROJECT,
      publicUrl: "https://sigillo.example.com",
    });
    expect(() => firebaseAccounts({ ...valid, SIGILLO_FIREBASE_PROJECT_ID: "Bad Project" })).toThrow(/project id/);
  });
});

/**
 * Google's way back, in a real browser. Google sends the browser back with a
 * navigation that starts on Google's site, and a browser does not send a
 * SameSite=Strict cookie on it, nor on any redirect that follows it: a
 * session or a sign-up ticket set on that response and then redirected to
 * would arrive without its cookie. That is what happened on the first real
 * sign-in (2026-10-02, "La richiesta è scaduta"); a test without a browser
 * cannot see it. Google's page is stood in for by a page on its own origin,
 * served by Playwright; everything on Sigillo's side is real, CSP included.
 */
describe.skipIf(BROWSER_PATH === undefined)("signing in with Google, in a real browser", { timeout: 30_000 }, () => {
  let directory: string;
  let store: ReceiptStore;
  let keys: ApiKeyStore;
  let app: FastifyInstance;
  let browser: Browser;
  let base: string;
  let fake: FakeFirebase;
  let googleSite: HttpsServer;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "sigillo-google-browser-"));
    const databasePath = join(directory, "sigillo.db");
    const signer = createTestSigner();
    store = ReceiptStore.open(databasePath, signer);
    keys = ApiKeyStore.open(databasePath);
    const policy = caddyfilePolicy();
    // localhost, not 127.0.0.1: the address the server is told it is reached
    // at, which Google sends the browser back to. The port is picked first so
    // that the server can be told it.
    const port = await freePort();
    base = `http://localhost:${port}`;
    fake = new FakeFirebase(base);
    app = buildServer({
      store,
      keys,
      now: () => new Date(NOW),
      ui: {
        password: PASSWORD,
        signerKey: { key_id: signer.keyId, public_key_base64: signer.publicKeyBase64 },
        healthMonitor: new ChainHealthMonitor(store, signer.publicKey, 24 * 3600_000),
        checkpointer: new Checkpointer({ store, now: () => new Date(NOW) }),
        accounts: { firebase: new FirebaseAuth({ apiKey: API_KEY, projectId: PROJECT }, () => new Date(NOW), fake.fetch), publicUrl: base },
      },
    });
    app.addHook("onSend", async (_request, reply) => {
      void reply.header("content-security-policy", policy);
    });
    await app.listen({ host: "127.0.0.1", port });

    googleSite = createHttpsServer({ key: google.privateKey, cert: google.certificate }, (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Google</title><a id="consent" href="${base}/ui/login/google/back?code=4%2Fabc&state=s">Continua</a>`);
    });
    await new Promise<void>((resolve) => googleSite.listen(0, "127.0.0.1", resolve));
    const googlePort = (googleSite.address() as AddressInfo).port;
    browser = await chromium.launch({
      ...(BROWSER_PATH === undefined ? {} : { executablePath: BROWSER_PATH }),
      // Straight to that server, past any proxy the machine has configured.
      args: ["--no-proxy-server", `--host-resolver-rules=MAP accounts.google.com 127.0.0.1:${googlePort}`],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    googleSite?.close();
    await app?.close();
    keys?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * From the sign-in page to Google and back. Google's page is a page that
   * the browser finds at accounts.google.com (resolved to a server of this
   * test's own), whose link the person clicks: the way back starts on
   * another site, as it does for real.
   */
  async function throughGoogle(): Promise<Page> {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: "it-IT" });
    context.setDefaultTimeout(5_000);
    const page = await context.newPage();
    await page.goto(`${base}/ui/login`);
    await Promise.all([page.waitForURL(/^https:\/\/accounts\.google\.com\//), page.click('a[href="/ui/login/google"]')]);
    await page.click("#consent");
    return page;
  }

  it("takes a newcomer back from Google to the company form, then into the register once approved", async () => {
    const first = await throughGoogle();
    await first.waitForURL(`${base}/ui/registrazione`, { timeout: 5_000 });
    expect(await first.textContent("body")).toContain("anna@example.com");
    await first.fill('input[name="name"]', "Rossi Trasporti S.r.l.");
    await first.click('button[type="submit"]');
    await first.waitForSelector(`text=${UI.account.waitingTitle}`, { timeout: 5_000 });
    const user = store.userByUid(fake.googleAccount.uid);
    expect(user).not.toBeNull();
    await store.approveOrganization(user?.organization_id ?? "", ADMIN);
    await first.context().close();

    const again = await throughGoogle();
    await again.waitForURL(`${base}/ui`, { timeout: 5_000 });
    expect(await again.locator('form[action="/ui/logout"]').count()).toBe(1);
    await again.context().close();
  });
});

/** A port nothing listens on, to tell the server its own address before it starts. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
