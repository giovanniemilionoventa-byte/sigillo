import type { Receipt } from "@sigillo/core";
import { isLocalProvider, type AdminAction, type DocumentMatch, type Strings, type Texts } from "./strings-it.js";

/**
 * Every piece of English text the web view shows: the same keys and the same
 * sentence templates as strings-it.ts, which the compiler holds this file to.
 * English is the default language (locale.ts).
 */

const ui: Strings = {
  nav: {
    registro: "Ledger",
    sistemi: "Systems",
    persone: "People",
    clienti: "Customers",
    verificaDocumento: "Verify document",
    impostazioni: "Settings",
    esci: "Sign out",
    label: "Sections",
    allSystems: "All systems",
    tools: "Tools",
    menu: "Menu",
    close: "Close",
    newSystem: "New system",
  },
  brand: {
    skip: "Skip to content",
  },
  login: {
    title: "Sign in to sigillo",
    adminTitle: "Administrator sign-in",
    label: "Administrator password",
    placeholder: "Password",
    submit: "Sign in",
    wrong: "Wrong password. After too many attempts, signing in is paused for a few minutes.",
  },
  account: {
    google: "Continue with Google",
    or: "or",
    email: "Email address",
    password: "Password",
    passwordNew: "Password (at least 10 characters)",
    passwordRepeat: "Repeat the password",
    continueEmail: "Continue with email",
    passwordTitle: "Enter your password",
    change: "Change",
    signIn: "Sign in",
    toSignUp: "Create an account",
    haveAccount: "Already have an account?",
    toReset: "Forgot your password?",
    toLogin: "Back to sign-in",
    toAdmin: "Sign in as administrator",
    wrong: "Wrong email or password. After too many attempts, signing in is paused for a few minutes.",
    unavailable: "The sign-in service is not responding. Try again in a few minutes.",
    googleFailed: "Signing in with Google did not work. Try again.",
    disabled: "This account has been disabled.",
    tooMany: "Too many attempts from this address. Try again in a few minutes.",
    unverifiedTitle: "Confirm your address",
    unverified: (email: string) => `We sent the link to ${email} again. Open it, then sign in.`,
    signUpTitle: "Create an account",
    signUpSubmit: "Create account",
    passwordShort: "The password must be at least 10 characters long.",
    passwordMismatch: "The two passwords do not match.",
    emailInvalid: "This email address does not look valid.",
    emailExists: "An account with this email already exists: sign in, or reset the password.",
    checkMailTitle: "Check your email",
    signedUp: (email: string) => `We sent a link to ${email}. Open it to confirm the address.`,
    resetTitle: "New password",
    resetSubmit: "Send me the link",
    resetSent: "If the address has an account, the link is on its way. Check your spam folder too.",
    companyTitle: "What is your company called?",
    companyLabel: "Company name",
    companySubmit: "Continue",
    expired: "The request has expired: sign in again.",
    continueTitle: "Signing in",
    continueLink: "Continue",
    waitingTitle: "Almost done",
    waiting: (name: string) => `The space for ${name} is waiting for approval. We will write to you as soon as it is ready.`,
  },
  organizations: {
    title: "Customers",
    heading: "Customers",
    none: "No customers yet.",
    columns: { name: "Company", state: "Status", systems: "Systems" },
    waiting: "Waiting",
    active: "Active",
    since: (when: string): string => `since ${when}`,
    approve: "Approve",
    people: (count: number): string => `${count} ${count === 1 ? "person" : "people"}`,
    noMembers: "Created by the administrator",
    approved: (name: string) => `${name} is approved: its people can sign in.`,
  },
  home: {
    heading: "Ledger",
    welcome: "Welcome to sigillo",
    steps: {
      account: "Account created",
      create: "Create your first system",
      connect: "Connect your agent",
      receive: "Receive the first receipt",
      done: "Done",
      createButton: "Create system",
      connectButton: "Connect",
    },
    summary: {
      green: "All good. No tampering.",
      yellow: (count: number): string =>
        `No tampering. ${count === 1 ? "One system to check" : `${count} systems to check`}.`,
      red: (count: number): string =>
        count === 1 ? "One ledger fails verification." : `${count} ledgers fail verification.`,
      why: "Why?",
      open: "Open",
    },
    tiles: { today: "Actions today", blocked: "Blocked", failed: "Failed", lastSeal: "Last seal" },
    systems: "Systems",
    recent: "Latest actions",
    noActions: "No actions yet.",
    evidence: "Evidence pack",
    chooseSystem: "System",
    fromDate: "From",
    toDate: "To",
    generate: "Download evidence pack",
    disclose: {
      summary: "Include names or contents",
      hint:
        "By default the evidence pack names nobody and opens no fingerprint. Fill in these fields only if whoever receives it needs to know more.",
      subjectsLabel: "People to name (psn_…, separated by spaces)",
      openingsLabel: "Receipts whose nonces to include (for example 4 7-9)",
    },
    checkpointNow: "Seal now",
    checkpointDone: "Done: every system with new actions has been sealed.",
    archivedGroup: "Archived",
    archivedBadge: "Archived",
    archivedRed: "verification failed",
    archivedActive: "received actions after it was archived",
    quotaFull: (limit: string, resume: string): string =>
      `Limit of ${limit} receipts reached: new actions are not recorded until ${resume}.`,
    quotaNear: (used: string, limit: string): string => `You have used ${used} of ${limit} receipts this month.`,
  },
  chain: {
    green: "Intact",
    yellow: "To check",
    red: "Verification failed",
  },
  system: {
    tabsLabel: "System sections",
    evidence: "Evidence pack",
  },
  exportSheet: {
    title: (name: string): string => `Evidence pack for ${name}`,
    cancel: "Cancel",
    submit: "Download .zip",
  },
  notFound: {
    title: "Page not found",
    heading: "Page not found",
    back: "Back to the ledger",
  },
  systemsPage: {
    title: "Systems",
    heading: "Systems",
    views: { attivi: "Active", archiviati: "Archived", tutti: "All" },
    noneInView: {
      attivi: "No active systems.",
      archiviati: "No archived systems.",
      tutti: "No systems yet.",
    },
    columns: { system: "System", state: "Status", receipts: "Receipts", last: "Last action", archived: "Archived" },
    archivedBadge: "Archived",
    connection: {
      sdk: "Python SDK",
      otlp: "OpenTelemetry",
      api: "HTTP API",
      none: "Not connected yet",
      // The SDK heartbeat's state (connection/watch.ts), when there is one.
      open: "Python SDK · connected",
      lost: (since: string): string => `Python SDK · disconnected since ${since}`,
      closed: (since: string): string => `Python SDK · closed on ${since}`,
    },
    newTitle: "New system",
    displayNameLabel: "Name",
    displayNamePlaceholder: "Sales assistant",
    nameLabel: "Identifier",
    namePlaceholder: "sales-assistant",
    submit: "Create system",
    nameRequired: "Enter a name or an identifier.",
    exists: "A system with this identifier already exists.",
    deleted: (systemId: string): string => `${systemId} has been deleted.`,
  },
  connect: {
    ready: (name: string): string => `${name} is ready`,
    newKey: (name: string): string => `New key for ${name}`,
    keyLabel: "System key",
    keyNote: "You can only see it now: copy it and keep it safe.",
    heading: "Connect your agent",
    title: (name: string): string => `Connect ${name}`,
    ways: { python: "Python SDK", model: "AI model" },
    modelStep1: "Save your OpenAI, Anthropic or Gemini key in Manage, under “AI model”.",
    modelStep2: "Point the agent's model at sigillo, with the system key:",
    keyPlaceholder: "<the-system-key>",
    waiting: "Waiting for the first receipt…",
    check: "Check",
    arrived: (when: string): string => `First receipt arrived: ${when}`,
    goToSystem: "Go to the system",
  },
  people: {
    title: "People",
    heading: "People",
    searchLabel: "Person identifier",
    searchPlaceholder: "customer-4821",
    searchSubmit: "Search",
    notFound: "No receipts for this person.",
    receipts: (count: number): string => `${count} ${count === 1 ? "receipt" : "receipts"}`,
    eraseTitle: "Erase the person",
    eraseHint: "The receipts stay valid, but they can no longer be linked to this person.",
    eraseConfirm: (token: string): string => `Type ${token} to confirm`,
    eraseSubmit: "Erase permanently",
    erased: (token: string): string => `Done: ${token} can no longer be linked to anyone.`,
    confirmMismatch: "The text you typed does not match the pseudonym: nothing was erased.",
    legacy: (count: number): string =>
      `${count} ${count === 1 ? "receipt" : "receipts"} written before October 2026 ${count === 1 ? "contains" : "contain"} this identifier in clear text, and no erasure reaches ${count === 1 ? "it" : "them"}.`,
  },
  manage: {
    nameTitle: "Name",
    nameLabel: "Display name",
    nameSubmit: "Save",
    renamed: "Name saved.",
    idTitle: "Identifier",
    keyTitle: "Key",
    keyLabel: "Current key",
    noKey: "No active key",
    newKey: "New key",
    newKeyConfirm: "The current key stops working immediately.",
    newKeySubmit: "Create new key",
    connect: "How to connect the agent",
    modelTitle: "AI model",
    modelProvider: "Provider",
    modelKeyLabel: "Provider API key",
    modelKeyInvalid: "This does not look like an API key: nothing was saved.",
    modelSave: "Save",
    modelRemove: "Remove",
    modelSaved: "Model key saved.",
    modelRemoved: "Model key removed.",
    archiveTitle: "Archive",
    archiveSubmit: "Archive system",
    archived: "System archived.",
    archivedOn: (when: string): string => `Archived on ${when}.`,
    unarchiveSubmit: "Reactivate",
    unarchived: "System reactivated.",
    deleteTitle: "Delete",
    deleteConfirmLabel: (systemId: string): string => `Type ${systemId} to confirm`,
    deleteSubmit: "Delete permanently",
    deleteRefused: (receipts: number): string =>
      `It holds ${receipts - 1} recorded ${receipts - 1 === 1 ? "action" : "actions"}: it can only be archived.`,
    confirmMismatch: "The text you typed does not match the system identifier: nothing was deleted.",
  },
  settings: {
    title: "Settings",
    heading: "Settings",
    account: "Account",
    operator: "Administrator",
    operatorDetail: "Signed in with the installation password",
    organization: "Organization",
    systems: (count: number): string => `${count} ${count === 1 ? "system" : "systems"}`,
    quota: (used: string, limit: string): string => `${used} of ${limit} receipts this month`,
    noLimit: (used: string): string => `${used} receipts this month`,
    appearance: "Appearance",
    themes: { light: "Light", dark: "Dark", system: "Automatic" },
    themeLabel: "Theme",
    adminLog: "Administrative log",
    adminLogAll: "See all",
    adminLogEmpty: "No operations yet.",
    signingKey: "Signing key",
    dailyExport: {
      heading: "Daily export",
      on: "On",
      off: "Off",
      stateOn: "Every day at 23:59",
      stateOff: "Off.",
      empty: "No files yet.",
      download: "Download",
      size: (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`),
    },
  },
  history: {
    anchored: "Sealed",
    anchorPending: "Pending",
    noMatches: "No receipts.",
    searchButton: "Search",
    searchTitle: "Search",
    fromLabel: "From",
    toLabel: "To",
    nameLabel: "Action name",
    filterLabel: "Filter by kind",
    allKinds: "All",
    kinds: {
      tool_call: "Tools",
      llm_call: "Models",
      agent_step: "Steps",
      decision: "Decisions",
      genesis: "Opening",
    },
    listLabel: "Receipts",
    clearFilters: "Clear filters",
    capped: "The 200 most recent",
    back: "History",
  },
  inspector: {
    label: "Receipt details",
    receiptNo: (seq: number): string => `Receipt no. ${seq}`,
    genesisNote: "The first receipt: the chain starts here.",
    agent: "Agent",
    onBehalfOf: "On behalf of",
    model: "Model",
    when: "When",
    source: "Arrived from",
    sources: {
      sdk: "Python SDK",
      otlp: "OpenTelemetry",
      api: "HTTP API",
      genesis: "sigillo",
    },
    files: "Files",
    verifyFile: "Verify",
    seal: "Seal",
    sealedAt: (when: string): string => `Sealed ${when}`,
    sealWaiting: "Pending",
    technical: "Technical details",
    fingerprint: "Fingerprint",
    linkedTo: (seq: number): string => `Linked to receipt no. ${seq}`,
    first: "First receipt: none before it",
    signature: "Signature",
    key: "Key",
    timestamp: "Timestamp",
    inputHash: "Input fingerprint",
    outputHash: "Output fingerprint",
    promptHash: "Prompt fingerprint",
    replyHash: "Reply fingerprint",
    receivedIso: "Received (UTC)",
    eventIso: "Happened (UTC, as declared by the agent)",
    version: "Format version",
  },
  anchoring: {
    notCovered: "Not sealed yet",
    waiting: "Sealed, timestamp pending",
    unreadable: "Timestamped (time not readable from the token)",
    at: (when: string): string => `Timestamped ${when}`,
  },
  checkpoints: {
    title: "Seals",
    none: "No seals yet.",
    sealed: (count: number): string => `${count} ${count === 1 ? "receipt sealed" : "receipts sealed"}`,
    stamped: "Timestamp",
    waiting: "Pending",
    written: "Written",
    root: "Merkle root",
    attested: "Time attested by the authority",
    authority: "Authority",
    genTimeUnreadable: "not readable from the token",
  },
  verifyDocument: {
    title: "Verify document",
    heading: "Verify document",
    privacyNote: "The document never leaves your computer.",
    textLabel: "or paste the text",
    submit: "Verify",
    scriptInactive:
      "The browser did not compute the fingerprint, so Verify is disabled. Reload the page; if it stays like this, whoever runs sigillo needs to update it with deploy/update.sh.",
    computeFailed: "The chosen document could not be read. Choose it again and press Verify.",
    browserError: "Browser error",
    resultTitle: "Result",
    placeholder: "The result will appear here.",
    searchedFingerprint: "Exact fingerprint (SHA-256)",
    textFingerprint: "Text fingerprint (sigillo-text/1)",
    noTextFingerprint: "none: it is not UTF-8 text",
    fromFile: "Computed by the browser from the chosen file.",
    fromText: "Computed by the browser from the pasted text.",
    noMatch: "No recorded action used this document.",
    noMatchHint:
      "A text recorded before version 3 is found only if it matches byte for byte, apart from line endings. For a PDF or an image every byte counts. You can compare the exact fingerprint with the file's own: Get-FileHash on Windows, sha256sum on Linux, shasum -a 256 on Mac.",
    match: {
      bytes: "Identical",
      text: "Same text",
      lines: "Identical, apart from line endings",
      json: "Same content",
      "json-lines": "Same content, apart from line endings",
    },
    usedBy: (system: string, when: string, action: string): string => `Used by ${system} ${when}, in the action ${action}.`,
    seeReceipt: "See the receipt",
    found: "Found in the ledger",
    notFound: "Not found",
    technical: "Technical details",
    documentLabel: "Document to verify",
    dropTitle: "Drop a file here",
    dropHint: "or choose one",
    notModified: "It has not been modified",
  },
  languages: { en: "English", it: "Italiano" },
  languageLabel: "Language",
};

const ADMIN_ACTIONS: Record<string, string> = {
  "system.rename": "renamed",
  "system.archive": "archived",
  "system.unarchive": "reactivated",
  "system.delete": "deleted",
  "signer.init": "registered in the signer's state",
  "signer.recovered": "receipt recovered from the signer",
  "signer.divergence": "in disagreement with the signer",
  "subject.erase": "data subject erased",
  "openings.erase": "nonces erased",
  "organization.create": "organization created",
  "organization.approve": "organization approved",
  "user.register": "new sign-up",
  "system.assign": "assigned to an organization",
};

/** The server's own receipts for the SDK heartbeat (connection/watch.ts): a title and a sentence each. */
const CONNECTION_TEXTS: Record<string, { title: string; sentence: string }> = {
  "sigillo.connection.start": { title: "Agent connected", sentence: "The agent connected to sigillo and sends its heartbeat." },
  "sigillo.connection.stop": { title: "Agent closed normally", sentence: "The agent's program was closed normally." },
  "sigillo.connection.lost": {
    title: "Connection lost",
    sentence:
      "The agent stopped sending its heartbeat without closing: sigillo's code removed, the program stopped, " +
      "the computer switched off or the network down. The event time is that of the last heartbeat received.",
  },
  "sigillo.connection.restored": { title: "Connection restored", sentence: "The agent sends its heartbeat again after an interruption." },
};

const KIND_LABELS: Record<Receipt["action"]["kind"], string> = {
  tool_call: "tool",
  llm_call: "model",
  agent_step: "step",
  decision: "decision",
  genesis: "ledger opening",
};

const OUTCOME_WORDS: Record<Receipt["outcome"], string> = {
  ok: "completed",
  error: "failed",
  blocked: "blocked",
  unknown: "outcome unknown",
};

function modelLocale(provider: string | null): string {
  if (provider === null) return "";
  return isLocalProvider(provider) ? " (local)" : ` (${provider})`;
}

function onBehalfOfClause(onBehalfOf: string | undefined): string {
  return onBehalfOf === undefined ? "" : ` on behalf of «${onBehalfOf}»`;
}

function modelWhere(provider: string | null): string | null {
  if (provider === null) return null;
  return isLocalProvider(provider) ? `locally, with ${provider}` : provider;
}

/** A whole number of minutes as a person says it: "90 minutes", "1 hour", "24 hours", "2 days". */
function durationWords(minutes: number): string {
  if (minutes >= 2880 && minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? "1 hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const actions = (total: number): string => `${total} ${total === 1 ? "action" : "actions"}`;

export const EN: Texts = {
  ui,
  numberLocale: "en-GB",
  months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  monthNames: [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ],
  weekdays: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  today: "Today",
  yesterday: "Yesterday",
  inlineWhen: (relative: string | null, date: string, time: string): string =>
    relative !== null ? `${relative.toLowerCase()} at ${time}` : `on ${date} at ${time}`,
  kindLabels: KIND_LABELS,
  outcomeWords: OUTCOME_WORDS,
  modelWhere,
  durationWords,

  describeReceipt(receipt: Receipt): string {
    const { action, actor, outcome } = receipt;
    const ok = outcome === "ok";
    const onBehalfOf = onBehalfOfClause(actor.on_behalf_of);
    const model = receipt.v !== 1 ? receipt.model : undefined;
    const connection = CONNECTION_TEXTS[action.name];
    if (connection !== undefined) return connection.sentence;

    if (action.kind === "genesis") {
      return `The system «${action.name}» opened its ledger.`;
    }

    let sentence: string;
    switch (action.kind) {
      case "tool_call": {
        const verb = ok ? "used the tool" : "tried the tool";
        sentence = `The agent «${actor.agent}» ${verb} «${action.name}»${onBehalfOf}`;
        break;
      }
      case "llm_call": {
        if (model !== undefined) {
          const verb = ok ? "generated a reply" : "did not complete the request";
          sentence = `The model «${model.name}»${modelLocale(model.provider)} ${verb}`;
        } else {
          const verb = ok ? "called the model" : "tried to call the model";
          sentence = `The agent «${actor.agent}» ${verb} «${action.name}»${onBehalfOf}`;
        }
        break;
      }
      case "decision": {
        const verb = ok ? "was taken" : "was attempted";
        sentence = `The decision «${action.name}»${onBehalfOf} ${verb}`;
        break;
      }
      default: {
        // agent_step
        const verb = ok ? "ran the step" : "tried the step";
        sentence = `The agent «${actor.agent}» ${verb} «${action.name}»${onBehalfOf}`;
      }
    }

    return `${sentence} — ${OUTCOME_WORDS[outcome]}.`;
  },

  artifactRoleWords: (role: "input" | "output"): string => (role === "input" ? "used as input" : "produced as output"),

  receiptTitle(receipt: Receipt): string {
    const { action } = receipt;
    const connection = CONNECTION_TEXTS[action.name];
    if (connection !== undefined) return connection.title;
    const model = receipt.v !== 1 ? receipt.model : undefined;
    switch (action.kind) {
      case "genesis":
        return "Ledger opened";
      case "tool_call":
        return `${receipt.outcome === "ok" ? "Used" : "Tried"} «${action.name}»`;
      case "llm_call":
        return model !== undefined ? `Reply from «${model.name}»` : `Call to «${action.name}»`;
      case "decision":
        return `Decision «${action.name}»`;
      default:
        return `Step «${action.name}»`;
    }
  },

  receiptSubtitle(receipt: Receipt): string {
    if (receipt.action.kind === "genesis") return `Opening of the ledger of ${receipt.action.name}`;
    const parts = [receipt.actor.agent];
    const model = receipt.v !== 1 ? receipt.model : undefined;
    const where = model === undefined ? null : modelWhere(model.provider);
    if (where !== null) parts.push(`model ${where}`);
    if (receipt.actor.on_behalf_of !== undefined) parts.push(`on behalf of ${receipt.actor.on_behalf_of}`);
    if (receipt.v !== 1) for (const artifact of receipt.artifacts ?? []) parts.push(artifact.label);
    return parts.join(" · ");
  },

  describeDocumentMatch(match: DocumentMatch): string {
    const who =
      match.display_name === undefined || match.display_name === null
        ? match.system_id
        : `«${match.display_name}» (system ${match.system_id})`;
    const when = match.when;
    const used = `by ${who} on ${when}, as «${match.label ?? ""}», in the action ${match.action_name} (${match.role})`;
    const lineEndings = "apart from line endings (Windows, or Mac and Linux), the final line break or a leading BOM";
    switch (match.kind) {
      case "bytes":
        return `✓ This document is exactly the one used ${used}. ${ui.verifyDocument.notModified}.`;
      case "text":
        return (
          `✓ This document has the same text as the one used ${used}: the two differ at most in spaces, ` +
          `line breaks and invisible formatting characters (rule ${match.text_canon ?? "sigillo-text/1"}). The bytes are not identical.`
        );
      case "lines":
        return `✓ This document is the one used ${used}, ${lineEndings}. Everything else is identical.`;
      case "json":
        return `✓ The text of this document is exactly the whole ${match.role} of the action ${match.action_name}, recorded by ${who} on ${when}.`;
      case "json-lines":
        return `✓ The text of this document is the whole ${match.role} of the action ${match.action_name}, recorded by ${who} on ${when}, ${lineEndings}.`;
    }
  },

  describeAdminAction(entry: AdminAction): string {
    const what = ADMIN_ACTIONS[entry.action] ?? entry.action;
    if (entry.action === "subject.erase") return `${what}: pseudonym ${String(entry.detail["token"])}`;
    if (entry.action === "organization.create" || entry.action === "organization.approve" || entry.action === "user.register") {
      return `${what}: ${String(entry.detail["organization_id"])}`;
    }
    let extra = "";
    if (entry.action === "system.rename") {
      const name = (value: unknown): string => (typeof value === "string" ? `«${value}»` : "no name");
      extra = `: from ${name(entry.detail["from"])} to ${name(entry.detail["to"])}`;
    }
    if (entry.action === "system.assign") {
      const whose = (value: unknown): string => (typeof value === "string" ? value : "the operator only");
      extra = `: from ${whose(entry.detail["from"])} to ${whose(entry.detail["to"])}`;
    }
    if (entry.action === "openings.erase") {
      const seqs = Array.isArray(entry.detail["seqs"]) ? entry.detail["seqs"].join(", ") : "";
      extra = ` for receipts ${seqs} (${String(entry.detail["erased"])})`;
    }
    return `${entry.system_id} ${what}${extra}`;
  },

  health: {
    linkBroken: (seq: number): string => `receipt seq ${seq} does not link to the one before it`,
    signatureInvalid: (seq: number): string => `the signature of receipt seq ${seq} is not valid`,
    failed: (detail: string | null): string => `Verification failed: ${detail ?? "the chain does not add up"}.`,
    signerDown:
      "The signer is not responding: no new action can be recorded until it is back. " +
      "Receipts already written do not change.",
    divergence:
      "The signer and the database disagree about this ledger: no automatic correction, " +
      "the details are in the administrative log.",
    noActions: "No actions recorded yet.",
    firstComing: (total: number, within: string): string =>
      `Ledger intact. ${actions(total)} recorded, first seal due within ${within}.`,
    sealed: (total: number, when: string, stampComing: boolean): string =>
      `Ledger intact. ${actions(total)} recorded, last seal on ${when}${stampComing ? ", timestamp on its way" : ""}.`,
    notSealed: (over: string): string => `it has not been sealed yet, for over ${over}`,
    stampMissing: (over: string): string => `the timestamp has been missing for over ${over}`,
    stampLate: (late: string, limit: string): string =>
      `the last timestamp arrived ${late} after the seal, beyond the limit of ${limit}`,
    idle: (over: string): string => `no new actions for over ${over}`,
    disconnected: (since: string): string => `the agent has been disconnected since ${since}`,
    attention: (total: number, reasons: string[]): string => `Ledger intact (${actions(total)}), but ${reasons.join(" and ")}.`,
  },
};
