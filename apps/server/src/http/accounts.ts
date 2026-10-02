import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FirebaseError, type FirebaseAuth, type FirebaseIdentity } from "../auth/firebase.js";
import type { UiSessions } from "../auth/sessions.js";
import type { AttemptThrottle } from "../auth/throttle.js";
import type { Viewer } from "../auth/tenancy.js";
import { StorageError, type ReceiptStore } from "../storage/store.js";
import { accountPage, escape, loginPage } from "./layout.js";
import { UI } from "./strings.js";

/**
 * A customer's way in: Google, or an email and a password, both through
 * Firebase (auth/firebase.ts), and the first time, the name of their company,
 * which becomes an organization waiting for the operator's approval.
 *
 * Nothing here runs in the browser. Every form posts to this server; Google
 * is reached by an ordinary redirect and comes back to /ui/login/google/back
 * with a code that this server, not the browser, exchanges.
 */

export interface AccountsContext {
  /** Every system: accounts are not seen through any organization. */
  store: ReceiptStore;
  firebase: FirebaseAuth;
  sessions: UiSessions;
  /** This installation's address as the browser reaches it, without a trailing slash: Google sends people back here. */
  publicUrl: string;
  now: () => Date;
  /** Wrong passwords, per client address, shared with the operator's password. */
  loginThrottle: AttemptThrottle;
  /** Accounts created and reset links asked for, per client address. */
  requestThrottle: AttemptThrottle;
  html: (reply: FastifyReply, body: string, status?: number) => FastifyReply;
  cookieAttributes: (request: FastifyRequest) => string;
  /** Signs `viewer` in and sends the browser to the register. */
  startSession: (request: FastifyRequest, reply: FastifyReply, viewer: Viewer) => FastifyReply;
}

/** The Google sign-in's own session id, between the redirect and the return. */
const GOOGLE_COOKIE = "sigillo_google";
const GOOGLE_PATH = "/ui/login/google";
const GOOGLE_TTL_MS = 10 * 60_000;
/** Who signed in, between Firebase and the company form. */
const SIGNUP_COOKIE = "sigillo_signup";
const SIGNUP_PATH = "/ui/registrazione";
const SIGNUP_TTL_MS = 30 * 60_000;

export const MIN_PASSWORD = 10;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function registerAccounts(app: FastifyInstance, context: AccountsContext): void {
  const { store, firebase, sessions, html } = context;
  const t = UI.account;
  const nowMs = (): number => context.now().getTime();

  const cookie = (request: FastifyRequest, name: string): string | undefined => {
    const header = request.headers.cookie;
    if (typeof header !== "string") return undefined;
    for (const part of header.split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key === name) return rest.join("=");
    }
    return undefined;
  };

  const login = (reply: FastifyReply, extra: { notice?: string; error?: string }, status = 200): FastifyReply =>
    html(reply, loginPage(undefined, extra), status);

  const failure = (error: unknown): string => {
    if (!(error instanceof FirebaseError)) throw error;
    switch (error.code) {
      case "INVALID_LOGIN_CREDENTIALS":
      case "INVALID_PASSWORD":
      case "EMAIL_NOT_FOUND":
      case "INVALID_EMAIL":
        return t.wrong;
      case "USER_DISABLED":
        return t.disabled;
      case "TOO_MANY_ATTEMPTS_TRY_LATER":
        return t.tooMany;
      default:
        return t.unavailable;
    }
  };

  /**
   * Someone Firebase vouches for: in, if their organization is approved;
   * told to wait, if it is not; asked for their company, the first time.
   */
  const signedIn = async (request: FastifyRequest, reply: FastifyReply, identity: FirebaseIdentity): Promise<FastifyReply> => {
    if (!identity.emailVerified) {
      try {
        await firebase.sendVerification(identity.idToken);
      } catch (error) {
        return login(reply, { error: failure(error) }, 503);
      }
      return login(reply, { notice: t.unverified(identity.email) }, 403);
    }
    const user = store.userByUid(identity.uid);
    if (user === null) {
      const ticket = sessions.seal("signup", JSON.stringify({ uid: identity.uid, email: identity.email }), nowMs(), SIGNUP_TTL_MS);
      return reply
        .header("set-cookie", `${SIGNUP_COOKIE}=${ticket}; ${context.cookieAttributes(request).replace("Path=/", `Path=${SIGNUP_PATH}`)}; Max-Age=${SIGNUP_TTL_MS / 1000}`)
        .redirect(SIGNUP_PATH, 303);
    }
    const organization = store.organization(user.organization_id);
    if (organization === null || organization.approved_at === null) {
      return html(reply, accountPage(t.waitingTitle, t.waiting(organization?.name ?? user.organization_id), {}), 403);
    }
    return context.startSession(request, reply, {
      kind: "organization",
      organizationId: organization.organization_id,
      userId: user.uid,
    });
  };

  // Email and password.

  app.post("/ui/login/email", async (request, reply) => {
    const client = request.ip;
    const at = nowMs();
    if (context.loginThrottle.isLocked(client, at)) return login(reply, { error: t.wrong }, 401);
    const body = request.body as { email?: unknown; password?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    let identity: FirebaseIdentity;
    try {
      identity = await firebase.signInWithPassword(email, password);
    } catch (error) {
      const message = failure(error);
      if (message === t.wrong) context.loginThrottle.recordFailure(client, at);
      return login(reply, { error: message }, message === t.unavailable ? 503 : 401);
    }
    context.loginThrottle.recordSuccess(client);
    return signedIn(request, reply, identity);
  });

  const signUpForm = (email = ""): string => `<form method="post" action="/ui/registrati" class="fields">
<label>${escape(t.email)}
  <input type="email" name="email" value="${escape(email)}" autocomplete="email" required>
</label>
<label>${escape(t.password)}
  <input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
</label>
<label>${escape(t.passwordRepeat)}
  <input type="password" name="password_again" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
</label>
<p class="hint">${escape(t.passwordRule)}</p>
<button type="submit" class="primary">${escape(t.signUpSubmit)}</button>
</form>`;

  app.get("/ui/registrati", async (_request, reply) => html(reply, accountPage(t.signUpTitle, t.signUpLead, {}, signUpForm())));

  app.post("/ui/registrati", async (request, reply) => {
    const body = request.body as { email?: unknown; password?: unknown; password_again?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const again = typeof body?.password_again === "string" ? body.password_again : "";
    const refuse = (error: string, status = 400): FastifyReply =>
      html(reply, accountPage(t.signUpTitle, t.signUpLead, { error }, signUpForm(email)), status);
    if (!EMAIL.test(email)) return refuse(t.emailInvalid);
    if ([...password].length < MIN_PASSWORD) return refuse(t.passwordShort);
    if (password !== again) return refuse(t.passwordMismatch);

    const client = request.ip;
    const at = nowMs();
    if (context.requestThrottle.isLocked(client, at)) return refuse(t.tooMany, 429);
    context.requestThrottle.recordFailure(client, at);
    try {
      await firebase.signUp(email, password);
    } catch (error) {
      if (error instanceof FirebaseError && error.code === "EMAIL_EXISTS") return refuse(t.emailExists, 409);
      if (error instanceof FirebaseError && error.code === "INVALID_EMAIL") return refuse(t.emailInvalid);
      return refuse(failure(error), 503);
    }
    return html(reply, accountPage(t.signUpTitle, t.signedUp(email), {}));
  });

  const resetForm = `<form method="post" action="/ui/password" class="fields">
<label>${escape(t.email)}
  <input type="email" name="email" autocomplete="email" required>
</label>
<button type="submit" class="primary">${escape(t.resetSubmit)}</button>
</form>`;

  app.get("/ui/password", async (_request, reply) => html(reply, accountPage(t.resetTitle, t.resetLead, {}, resetForm)));

  app.post("/ui/password", async (request, reply) => {
    const body = request.body as { email?: unknown } | undefined;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const client = request.ip;
    const at = nowMs();
    if (context.requestThrottle.isLocked(client, at)) {
      return html(reply, accountPage(t.resetTitle, t.resetLead, { error: t.tooMany }, resetForm), 429);
    }
    context.requestThrottle.recordFailure(client, at);
    // The same answer whether the address has an account or not, and whether
    // Firebase said so: the page must not tell anyone who is a customer.
    if (EMAIL.test(email)) {
      try {
        await firebase.sendPasswordReset(email);
      } catch (error) {
        if (error instanceof FirebaseError && error.code === "UNAVAILABLE") {
          return html(reply, accountPage(t.resetTitle, t.resetLead, { error: t.unavailable }, resetForm), 503);
        }
      }
    }
    return html(reply, accountPage(t.resetTitle, t.resetSent, {}));
  });

  // Google: to Google and back, the code exchanged here.

  const googleCookie = (request: FastifyRequest, value: string, maxAge: number): string =>
    `${GOOGLE_COOKIE}=${value}; ${context.cookieAttributes(request)
      // Google sends the browser back with a top-level navigation from its own
      // site: a Strict cookie would not come with it. Lax does, and only on
      // that GET.
      .replace("SameSite=Strict", "SameSite=Lax")
      .replace("Path=/", `Path=${GOOGLE_PATH}`)}; Max-Age=${maxAge}`;

  app.get(GOOGLE_PATH, async (request, reply) => {
    const sessionId = randomBytes(32).toString("hex");
    let authUri: string;
    try {
      authUri = await firebase.googleAuthUri(`${context.publicUrl}${GOOGLE_PATH}/back`, sessionId);
    } catch (error) {
      return login(reply, { error: failure(error) }, 503);
    }
    if (!authUri.startsWith("https://accounts.google.com/")) return login(reply, { error: t.googleFailed }, 502);
    const sealed = sessions.seal("google", sessionId, nowMs(), GOOGLE_TTL_MS);
    return reply.header("set-cookie", googleCookie(request, sealed, GOOGLE_TTL_MS / 1000)).redirect(authUri, 302);
  });

  app.get(`${GOOGLE_PATH}/back`, async (request, reply) => {
    const sessionId = sessions.unseal("google", cookie(request, GOOGLE_COOKIE), nowMs());
    void reply.header("set-cookie", googleCookie(request, "", 0));
    const query = request.url.indexOf("?");
    if (sessionId === null || query < 0) return login(reply, { error: t.googleFailed }, 400);
    let identity: FirebaseIdentity;
    try {
      identity = await firebase.signInWithGoogle(`${context.publicUrl}${request.url}`, sessionId);
    } catch (error) {
      if (error instanceof FirebaseError && error.code !== "UNAVAILABLE") return login(reply, { error: t.googleFailed }, 401);
      return login(reply, { error: failure(error) }, 503);
    }
    return signedIn(request, reply, identity);
  });

  // The first time: the company.

  const ticketOf = (request: FastifyRequest): { uid: string; email: string } | null => {
    const payload = sessions.unseal("signup", cookie(request, SIGNUP_COOKIE), nowMs());
    if (payload === null) return null;
    const parsed = JSON.parse(payload) as { uid?: unknown; email?: unknown };
    return typeof parsed.uid === "string" && typeof parsed.email === "string" ? { uid: parsed.uid, email: parsed.email } : null;
  };

  const companyForm = `<form method="post" action="${SIGNUP_PATH}" class="fields">
<label>${escape(t.companyLabel)}
  <input type="text" name="name" maxlength="128" autocomplete="organization" required>
</label>
<button type="submit" class="primary">${escape(t.companySubmit)}</button>
</form>`;

  app.get(SIGNUP_PATH, async (request, reply) => {
    const ticket = ticketOf(request);
    if (ticket === null) return login(reply, { error: t.expired }, 401);
    return html(reply, accountPage(t.companyTitle, t.companyLead(ticket.email), {}, companyForm));
  });

  app.post(SIGNUP_PATH, async (request, reply) => {
    const ticket = ticketOf(request);
    if (ticket === null) return login(reply, { error: t.expired }, 401);
    const body = request.body as { name?: unknown } | undefined;
    const name = typeof body?.name === "string" ? body.name : "";
    let organization;
    try {
      organization = await store.registerOrganization(ticket, name, {
        actor: `web ${ticket.email}`,
        ts: context.now().toISOString(),
      });
    } catch (error) {
      if (!(error instanceof StorageError)) throw error;
      return html(reply, accountPage(t.companyTitle, t.companyLead(ticket.email), { error: error.message }, companyForm), 400);
    }
    request.log.info({ action: "user.register", organization: organization.organization_id }, "an organization was requested");
    return reply
      .header("set-cookie", `${SIGNUP_COOKIE}=; ${context.cookieAttributes(request).replace("Path=/", `Path=${SIGNUP_PATH}`)}; Max-Age=0`)
      .code(200)
      .type("text/html; charset=utf-8")
      .send(accountPage(t.waitingTitle, t.waiting(organization.name), {}));
  });
}
