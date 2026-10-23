import type { Receipt } from "@sigillo/core";
import { isLocalProvider, type AdminAction, type DocumentMatch, type Strings, type Texts } from "./strings-it.js";

/**
 * Every piece of English text the web view shows: the same keys and the same
 * sentence templates as strings-it.ts, which the compiler holds this file to.
 * English is the default language (locale.ts).
 */

const ui: Strings = {
  v2more: {
    runs: {
      header: (time: string, agent: string, count: number): string => `Run at ${time} · ${agent === "" ? "agent" : agent} · ${count === 1 ? "1 action" : `${count} actions`}`,
      band: (time: string, agent: string, count: number): string => `Run of ${time} · ${agent === "" ? "agent" : agent} · ${count === 1 ? "1 action" : `${count} actions`}`,
      remove: "Remove",
      sealed: (when: string): string => `sealed at ${when}, timestamped`,
      sealedLater: "not sealed yet",
      prepare: "Prepare the evidence pack for this run",
      checkDocument: "Check a document from this run",
      unknown: "No actions in this run.",
      back: "Back to actions",
      onlyThese: (period: string, count: number): string => `${period}: ${count === 1 ? "the action" : `the ${count} actions`} of this run, nothing else in between.`,
      withOthers: (period: string, count: number, others: number): string =>
        `${period}: ${count === 1 ? "the action" : `the ${count} actions`} of this run, and ${others === 1 ? "1 action" : `${others} actions`} of other runs in between: they prove nothing is missing, and hold no names or contents.`,
      revealNothing: "Nothing",
      revealInputs: (count: number): string => `Inputs and outputs of ${count === 1 ? "this action" : `these ${count} actions`}, for whoever holds them`,
      disclose: "What to disclose",
    },
    keys: {
      title: "Keys",
      current: (date: string): string => `Key of ${date}`,
      used: (when: string): string => `used ${when}`,
      neverUsed: "never used",
      add: "Add a key",
      retire: "Retire",
      newKey: "New key",
      prepare: "Prepare the connection",
      visibleOnce: "Key shown only now",
      added: "Key added. The others keep working.",
      retired: "Key retired.",
      lastOne: "It is the only active key: add another before retiring it.",
      none: "No active key",
    },
    register: {
      title: "Handed over",
      empty: "No evidence pack handed over.",
      columns: { when: "When", what: "What", reveals: "Discloses", by: "Who", fingerprint: "Zip fingerprint" },
      period: (from: string, to: string): string => `${from} – ${to}`,
      wholeRecord: "the whole record",
      run: "run",
      nothing: "nothing",
      some: "inputs and outputs",
    },
    service: {
      title: "Service",
      signer: "Signer",
      responds: "Responding",
      stamp: "Timestamp",
      stampLine: (url: string): string => `${url} (not eIDAS qualified)`,
      stampNone: "No authority configured",
      seals: "Seals",
      sealsLine: (minutes: number, chains: number): string => `every ${minutes} minutes · ${chains === 1 ? "1 chain" : `${chains} chains`}`,
      sealNow: "Seal now",
      switches: "Switches",
      switchOff: "off",
      switchOperator: "only you",
      switchAll: "everyone",
      version: "Version",
    },
    account: {
      title: "Account",
      you: "You",
      signedWith: "Signed in with",
      organization: "Organization",
      appearance: "Appearance",
      language: "Language",
      quota: (used: string, limit: string): string => `${used} receipts of ${limit} this month`,
      signOut: "Sign out",
    },
    seals: {
      title: "Seals",
      empty: "The first seal arrives within an hour of the first action.",
      day: (day: string, count: number): string => `${day} — ${count === 1 ? "1 seal" : `${count} seals`}`,
      stamped: "timestamped",
      noStamp: "no timestamp",
      actions: (n: number): string => (n === 1 ? "1 action" : `${n} actions`),
      system: "System",
    },
    changes: { title: "Changes", empty: "No changes." },
    packReader: {
      titles: { tool_ok: "Used «{name}»", tool_fail: "Tried «{name}»", llm: "Reply from «{name}»", decision: "Decision «{name}»", step: "Step «{name}»", genesis: "Record opened" },
      outcomes: { ok: "", error: "Failed", blocked: "Blocked", unknown: "Unknown outcome" },
      intact: "Intact",
      intactLine: "{receipts} receipts of {system}, signed and in order. None was changed, removed or added in between.",
      failed: "Check failed",
      failedLine: "The pack does not pass verification.",
      notPack: "This file is not a sigillo evidence pack.",
      checks: "The checks",
      signatures: "Signatures",
      signaturesValue: "{n} of {n} valid",
      chain: "Chain",
      chainValue: "in order, from no. {first} to no. {last}",
      seals: "Seals",
      sealsValue: "{n} with a timestamp",
      noSeals: "none",
      showing: "Showing the first {n} actions of {total}.",
      docChoose: "Choose the document",
      docDrop: "Drop the document here · it stays in your browser",
    },
    pack: {
      title: "Verify an evidence pack",
      question: "Verify an evidence pack",
      choose: "Choose the pack (.zip)",
      stays: "Drop the pack (.zip) here · it stays in your browser",
      keyCode: "Code received separately from whoever sent you the pack",
      keyMatches: (code: string): string => `Matches: every signature is from ${code}.`,
      keyDiffers: "Does not match: this pack is signed by another key.",
      when: "When",
      existedBy: (when: string, authority: string): string => `They existed by ${when} · ${authority}`,
      whenLimit: "The authority's signature is checked by the full verification.",
      contents: "What it holds, in words",
      checkDocument: "Check a document in this pack",
      docFound: (when: string, label: string, action: string): string => `This document is exactly the one used on ${when}, as «${label}», in the action ${action}.`,
      docNotFound: "No action in this pack used this document.",
      notProven: "What this pack does not prove",
      notProvenLines: (): string[] => [
        "That the agent recorded everything",
        "The reasons for the decisions",
        "What was written",
        "Actions after the last one in the pack",
      ],
      full: "Full verification",
      fullHint: "For those who would not even trust this page",
      openSource: "The verifier's code (open source)",
    },
  },
  v2: {
    nav: { label: "Places", stato: "Status", azioni: "Actions", prove: "Evidence", systems: "Systems", archived: "Archived", admin: "Administration", documents: "Check a document" },
    stato: {
      title: "Status",
      question: "Is everything all right?",
      allRecording: (count: number): string => (count === 1 ? "No alteration. The system is recording." : `No alteration. All ${count} systems are recording.`),
      noAlteration: "No alteration.",
      disconnected: (name: string, since: string): string => `No alteration. «${name}» has been disconnected since ${since}.`,
      toCheck: (name: string, why: string): string => `Needs a look: «${name}». ${why}`,
      failed: (name: string): string => `The record of «${name}» fails verification.`,
      open: "Open",
      figures: { today: "actions today", blocked: (n: number): string => (n === 1 ? "blocked" : "blocked"), failed: (n: number): string => (n === 1 ? "failed" : "failed"), lastSeal: "last seal" },
      systems: "Systems",
      columns: { system: "System", record: "Record", agent: "Agent", last: "Last action" },
      connect: "Connect",
      newSystem: "New system",
      watch: "Worth a look",
      watchWindow: "Last 7 days",
      all: "All",
    },
    signals: {
      newRecord: "New",
      recording: "Recording",
      disconnected: (since: string): string => `Disconnected since ${since}`,
      stopped: (since: string): string => `Stopped since ${since}`,
      never: "Never connected",
      lastAction: (when: string): string => `Last action ${when}`,
    },
    outcomes: { error: "Failed", blocked: "Blocked", unknown: "Unknown outcome" },
    actions: {
      title: "Actions",
      question: "What did the AI do?",
      prepare: "Prepare the evidence pack",
      system: "System",
      allSystems: "All",
      period: "Period",
      periods: { today: "Today", yesterday: "Yesterday", "7d": "7 days", "30d": "30 days", all: "All" },
      kind: "Kind",
      allKinds: "All",
      outcome: "Outcome",
      allOutcomes: "All",
      problems: "Problems",
      none: "No actions in this period.",
      noSystems: "No systems yet.",
      createFirst: "Create the first system",
      shown: (count: number): string => (count === 1 ? "1 action" : `${count} actions`),
      older: "Older",
      newest: "Most recent",
    },
    evidence: {
      title: "Evidence",
      question: "Can you prepare the evidence?",
      system: "System",
      from: "From",
      to: "To",
      wholeRecord: "With no dates, the evidence pack covers the whole record.",
      download: "Download the evidence pack (.zip)",
      contents: "Inside: the signed receipts, the seals with their timestamps, report.pdf and the instructions for whoever checks it.",
      notProven: "Not proven",
      notProvenLines: (): string[] => ["That the agent recorded everything", "That the decisions were right", "What was written: sigillo keeps fingerprints only"],
      receiver: "Whoever receives it",
      receiverSteps: {
        file: "Send them the file.",
        code: "Separately, by phone or in another message, the key code:",
        verify: (address: string): string => `They check it at ${address}, with no account.`,
      },
      daily: "Daily evidence packs",
      dailyLink: "Daily evidence pack settings",
      packTab: "Evidence pack",
      seals: "Seals",
      changes: "Changes",
      noSystems: "No record to prepare evidence from.",
    },
    system: { tabs: { actions: "Actions", connect: "Connect", manage: "Manage" }, prepare: "Prepare the evidence pack", connectAgent: "Connect the agent" },
  },
  nav: {
    registro: "Ledger",
    sistemi: "Systems",
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
    reject: "Reject",
    delete: "Delete",
    confirmPlaceholder: "type delete",
    isConfirm: (word: string): boolean => word === "delete",
    confirmNeeded: "Type the word delete next to the button to confirm.",
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
    tooMany: (limit: number): string => `This account can have up to ${limit} systems. Archived ones count; contact us to raise the limit.`,
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
    heading: "Connect your agent",
    title: (name: string): string => `Connect ${name}`,
    ways: { python: "Python SDK" },
    pasteAtTop: "Paste this at the top of your agent's Python file:",
    keyPlaceholder: "<the-system-key>",
    customerKeyComment: "your own key: sigillo never receives it. Keep a copy.",
    customerKeyPlaceholder: "<your-own-key>",
    waiting: "Waiting for the first receipt…",
    check: "Check",
    arrived: (when: string): string => `First receipt arrived: ${when}`,
    goToSystem: "Go to the system",
    upload: {
      drop: "Upload your agent's .py file",
      done: "{file} downloaded, with sigillo already in it. Run your agent as usual: the first time, it installs what it needs by itself. The file also holds your own key (customer_key), made in this browser: sigillo never receives it, so it cannot read or guess your content. Keep a copy of the file.",
      doneNoFramework:
        "{file} downloaded, with sigillo already in it, which installs itself the first time. It uses neither LangChain, CrewAI nor OpenAI: sigillo records when it is connected and the actions you record yourself. The file also holds your own key (customer_key), made in this browser: sigillo never receives it. Keep a copy of the file.",
      already: "{file} already uses sigillo: there is nothing to add.",
      notPython: "Choose the agent's Python file (.py, up to 1 MB).",
      choose: "Click here to choose the file.",
      another: "Loaded. Click here to choose another file.",
      or: "or",
      analysisCloud: "This agent calls a cloud model ({providers}).",
      analysisOther: "No cloud model key was found: the agent seems to run on your computer, so there is nothing more to secure here.",
      analysisLocal: "This agent calls a model on your computer ({server}): it has no model key, so there is nothing more to secure here.",
      analysisLocalGuarded: "This agent calls a model on your computer ({server}). It has no model key, and sigillo guards it already: the model answers only to your agent, through a door that records every call, and a receipt says so if it is ever left open.",
      download: "Download the file",
      secure: "More security? If you tick this, the model key in your file is taken out and kept by sigillo, and the agent can reach the model only through sigillo. If you leave it unticked, your file keeps its own key.",
      modelFound: "Your file now calls the model through sigillo. Save the model key here so sigillo can use it on your behalf.",
      modelProvider: "Provider",
      modelKey: "Model key",
      modelRevoke: "Then delete the old key at the provider, or an agent that wanted to could still use it without sigillo.",
      modelSave: "Save the key",
    },
  },
  transfer: {
    linkTitle: (name: string): string => `Transfer link for ${name}`,
    linkIntro: "Send it to whoever should receive the system. You see it only now: it cannot be shown again, but you can create another.",
    linkLabel: "Transfer link",
    linkExpires: (when: string): string => `Works until ${when}, once. After the transfer you lose access to the system.`,
    back: "Back to settings",
    acceptTitle: "Add to your account",
    acceptIntro: (name: string, account: string): string => `The system “${name}” will move to the account ${account}, with all its history.`,
    acceptSubmit: "Add to my account",
    done: (name: string): string => `“${name}” is now in your account.`,
    invalidTitle: "Link not valid",
    invalid: "This link is no longer valid: it has expired, been used, or been cancelled. Ask whoever sent it for a new one.",
    operator: "This link must be opened with a customer's account, not the administrator's.",
    alreadyYours: "This system is already in your account.",
  },
  manage: {
    nameTitle: "Name",
    nameLabel: "Display name",
    nameSubmit: "Save",
    renamed: "Name saved.",
    modelSaved: "Model key saved. Delete the old key at the provider, so only sigillo can use it.",
    modelKeyInvalid: "This does not look like a model key.",
    modelKeyRefused: "The provider refused this key, so it was not saved. Copy it again from the provider's site.",
    idTitle: "Identifier",
    vaultTitle: "Model keys vault",
    vaultState: {
      none: "Not created yet: model keys can be stored only once you make it.",
      open: "Open: agents can use your model keys.",
      locked: "Locked: agents cannot use your model keys until you unlock it.",
      sealed: "Sealed by your hours: it cannot be opened until they end.",
    },
    vaultLink: "Open or lock it, and set the sealed hours",
    keyTitle: "Key",
    keyLabel: "Current key",
    noKey: "No active key",
    newKey: "New key",
    newKeyConfirm: "The current key stops working immediately.",
    newKeySubmit: "Create new key",
    connect: "How to connect the agent",
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
    deleteErases: (actions: number): string =>
      `This also deletes its ${actions} recorded ${actions === 1 ? "action" : "actions"}, for good. Only your own systems can be deleted like this.`,
    transferTitle: "Hand over to another account",
    transferIntro: "Create a link: whoever opens it signs in to their own account and the system moves to it. The link works once and for seven days.",
    transferSubmit: "Create transfer link",
    transferOpen: "A link is already open. Creating a new one cancels the old one.",
    transferRevoke: "Cancel the link",
    transferRevoked: "Link cancelled.",
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
    agentLabel: "Agent or session",
    allAgents: "All",
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
  // The key vault (gateway/provider-keys.ts, vault-page.ts).
  vault: {
    title: "Key vault",
    intro:
      "The model keys you give us are encrypted with a passphrase only you know. Nothing on the server opens them: not us, and not anyone with access to the disk or a backup.",
    createTitle: "Create the vault",
    passphrase: "Passphrase (at least 12 characters)",
    passphraseAgain: "Repeat the passphrase",
    create: "Create the vault",
    mismatch: "The two passphrases do not match.",
    tooShort: "The passphrase needs at least 12 characters.",
    already: "The vault already exists.",
    recoveryTitle: "Recovery key",
    recoveryText:
      "Save it now somewhere safe (a password manager will do). We will not show it again and cannot make it again: if you lose both the passphrase and this key, the model keys cannot be recovered and have to be entered again.",
    recoveryDone: "I have saved it",
    lockedTitle: "The vault is locked",
    lockedText:
      "While it is locked, agents cannot use your model keys. Enter the passphrase (or the recovery key) to open it: it stays open for 12 hours, or until you lock it. If the server restarts, it has to be opened again.",
    unlock: "Unlock",
    unlockField: "Passphrase or recovery key",
    wrong: "Wrong passphrase or recovery key.",
    tooMany: "Too many wrong attempts: try again in a few minutes.",
    openTitle: "The vault is open",
    openText: "Agents can use your model keys. It locks itself after 12 hours, or when your sealed hours begin.",
    lock: "Lock now",
    changeTitle: "Change passphrase",
    change: "Change passphrase",
    changed: "Passphrase changed. The recovery key stays the same.",
    needFirst: "First unlock or create the vault, then enter the model key again.",
    link: "Keys are encrypted with your passphrase: manage the vault",
    day: (d: number): string => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d] ?? "",
    scheduleTitle: "Sealed hours (optional)",
    scheduleText:
      "An extra option, not needed to protect the keys (the vault already does that). In the hours you choose, the server cannot use your keys: your agents' calls to the models are refused. For example every night, or at weekends. When the hours end the vault stays locked until you open it.",
    scheduleNone: "No hours set: the vault closes only when you close it or after 12 hours.",
    scheduleDays: "Days on which it starts",
    scheduleFrom: "Sealed from",
    scheduleTo: "to",
    scheduleZone: "Time zone (for example Europe/Rome)",
    scheduleAdd: "Add hours",
    scheduleRemove: "Remove",
    scheduleInvalid: "Not valid: pick at least one day, two different times and a time zone that exists.",
    scheduleLimit:
      "Hours that end before they start (22:00–06:00) run on into the next morning. Times are in the time zone given here.",
    sealedTitle: "The vault is sealed by your hours",
    sealedText: "It cannot be opened until the sealed hours below end. Agents that call a model are refused (423).",
    limits:
      "The limit: while the vault is open, and while you type the passphrase, the server has what it needs to use the keys, because model calls pass through it. Prompts and answers are not stored.",
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
  "organization.delete": "organization deleted",
  "organization.reject": "sign-up rejected",
  "user.register": "new sign-up",
  "system.assign": "assigned to an organization",
  "system.transfer.create": "transfer link created",
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
  "sigillo.connection.script_changed": {
    title: "Agent script changed",
    sentence:
      "The agent's main script is not the one it started with (or it can no longer be read), or it started with a " +
      "different script than the last time. An agent in strict mode stops on the first case.",
  },
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
    if (entry.action === "organization.create" || entry.action === "organization.approve" || entry.action === "organization.reject" || entry.action === "organization.delete" || entry.action === "user.register") {
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
