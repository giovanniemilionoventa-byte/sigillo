import { StorageError, type AdminLogEntry, type AdminRequest, type ReceiptStore, type SystemRecord } from "../storage/store.js";

/**
 * Who is looking at the web view.
 *
 * The operator signs in with the installation's one password and sees the
 * operator's own systems (those whose organization_id is NULL), plus the
 * list of customers it approves. A member of an organization sees that
 * organization's systems. Neither ever sees the other's systems, receipts,
 * people or log, and one organization never sees another's: not even
 * whether they exist.
 */
export type Viewer =
  | { kind: "operator" }
  /** userId: the member's Firebase uid; absent only in tests that stand for no one in particular. */
  | { kind: "organization"; organizationId: string; userId?: string };

export const OPERATOR: Viewer = { kind: "operator" };

/** Raised when a viewer reaches for something it may not see or do. */
export class NotVisibleError extends StorageError {
  constructor(what: string) {
    super(`not visible to this viewer: ${what}`);
    this.name = "NotVisibleError";
  }
}

/**
 * The store as `viewer` may see it: for an organization, its own systems;
 * for the operator, the operator's own systems, never a customer's. It is a
 * stand-in that is closed by default: a method listed below answers within
 * the viewer's systems, and any other method — one that exists today and is
 * not listed, or one added to the store later — throws when it is reached,
 * rather than answering across organizations. That is the point of building
 * it this way: forgetting a method here fails a page, it never leaks one.
 *
 * What a viewer cannot see answers as if it did not exist (a system record is
 * null, hasSystem is false), so that a guessed identifier tells the guesser
 * nothing about whether someone else has it.
 *
 * What only the operator does across customers (listing and approving
 * organizations, counting a quota) is not here: ui.ts reads those from the
 * whole store, and shows names and counts, never a system or a receipt.
 */
export function storeFor(store: ReceiptStore, viewer: Viewer): ReceiptStore {
  const organizationId = viewer.kind === "operator" ? null : viewer.organizationId;
  const owner = { organizationId };

  const owns = (record: SystemRecord | null): record is SystemRecord =>
    record !== null && record.organization_id === organizationId;
  const visible = (systemId: string): boolean => owns(store.systemRecord(systemId));
  const require = (systemId: string): void => {
    if (!visible(systemId)) throw new NotVisibleError(systemId);
  };
  /** Whether a logged deletion was of one of this viewer's systems. */
  const hadIt = (entry: AdminLogEntry): boolean => (entry.detail["organization_id"] ?? null) === organizationId;
  /** A token, if some receipt of this viewer's systems was made on its behalf; else null. */
  const ownToken = (token: string | null): string | null =>
    token !== null && store.receiptsOnBehalfOf(token, 1, owner).length > 0 ? token : null;
  /** A method whose first argument names the system it reads or changes. */
  const bySystem =
    <A extends unknown[], R>(method: (systemId: string, ...rest: A) => R) =>
    (systemId: string, ...rest: A): R => {
      require(systemId);
      return method.call(store, systemId, ...rest);
    };

  const allowed: Partial<Record<keyof ReceiptStore, unknown>> = {
    // Listings: only this organization's systems.
    listSystemRecords: () => store.listSystemRecords().filter(owns),
    listSystems: () => store.listSystemRecords().filter(owns).map((record) => record.system_id),
    systemRecord: (systemId: string) => {
      const record = store.systemRecord(systemId);
      return owns(record) ? record : null;
    },
    hasSystem: visible,

    // One system's chain, checkpoints and labels.
    tip: bySystem(store.tip),
    readChain: bySystem(store.readChain),
    readChainFrom: bySystem(store.readChainFrom),
    readChainInRange: bySystem(store.readChainInRange),
    readReceiptHashes: bySystem(store.readReceiptHashes),
    readCheckpoints: bySystem(store.readCheckpoints),
    latestCheckpoint: bySystem(store.latestCheckpoint),
    receiptAt: bySystem(store.receiptAt),
    openingsOf: bySystem(store.openingsOf),
    subjectIdentifierIn: bySystem(store.subjectIdentifierIn),
    signerDivergence: bySystem(store.signerDivergence),
    connectionsOf: bySystem(store.connectionsOf),
    renameSystem: bySystem(store.renameSystem),
    archiveSystem: bySystem(store.archiveSystem),
    unarchiveSystem: bySystem(store.unarchiveSystem),
    deleteEmptySystem: bySystem(store.deleteEmptySystem),
    readTimestamps: (checkpointId: number) => {
      const systemId = store.checkpointSystemId(checkpointId);
      if (systemId === null || !visible(systemId)) throw new NotVisibleError(`checkpoint ${checkpointId}`);
      return store.readTimestamps(checkpointId);
    },
    searchReceipts: (query: Parameters<ReceiptStore["searchReceipts"]>[0]) => {
      require(query.systemId);
      return store.searchReceipts(query);
    },
    countReceiptsByKind: (query: Parameters<ReceiptStore["countReceiptsByKind"]>[0]) => {
      require(query.systemId);
      return store.countReceiptsByKind(query);
    },
    recentAgents: (systemId: string, window?: number) => {
      require(systemId);
      return store.recentAgents(systemId, window);
    },
    countReceiptsByOutcome: (query: Parameters<ReceiptStore["countReceiptsByOutcome"]>[0]) => {
      require(query.systemId);
      return store.countReceiptsByOutcome(query);
    },
    // A deletion is only ever shown for a system this viewer had; for any
    // other identifier, as if there had been none.
    deletionOf: (systemId: string) => {
      const entry = store
        .adminLog(10_000)
        .find((logged) => logged.action === "system.delete" && logged.system_id === systemId);
      return entry !== undefined && hadIt(entry) ? entry.ts : null;
    },

    // Searches across systems, cut down to this organization's.
    findDocument: (fingerprints: Parameters<ReceiptStore["findDocument"]>[0]) =>
      store.findDocument(fingerprints).filter((match) => visible(match.system_id)),
    // The log of this viewer's systems, its deletions included. Not the
    // moves between organizations, which name the other one. What concerns
    // no system (customers signing up and being approved, an erasure) is the
    // operator's, who did it or has to act on it; an organization sees none.
    adminLog: (limit?: number) =>
      store
        .adminLog(10_000)
        .filter((entry) =>
          entry.action === "system.delete"
            ? hadIt(entry)
            : entry.system_id === ""
              ? viewer.kind === "operator"
              : entry.action !== "system.assign" && visible(entry.system_id),
        )
        .slice(0, limit ?? 100),

    // A system created here is this viewer's, from its genesis on.
    createSystem: (systemId: string, ts: string) => store.createSystem(systemId, ts, organizationId),

    // The people pages, the operator's alone (ui.ts, requireOperator): who
    // a token stands for, and the receipts made for them, only as far as the
    // operator's own systems go. An identifier that only a customer's agent
    // ever acted for is not found here, and cannot be erased from here.
    ...(viewer.kind === "operator"
      ? {
          subjectToken: (identifier: string) => ownToken(store.subjectToken(identifier)),
          receiptsOnBehalfOf: (token: string, limit?: number) => store.receiptsOnBehalfOf(token, limit, owner),
          legacyReceiptsNaming: (identifier: string) => store.legacyReceiptsNaming(identifier, owner),
          eraseSubject: async (token: string, request: AdminRequest) => {
            if (ownToken(token) === null) return false;
            return store.eraseSubject(token, request);
          },
        }
      : {}),

    // Neither reads nor writes anything of anyone's.
    exclusive: store.exclusive.bind(store),
    signingKeys: store.signingKeys.bind(store),
    publicKeyFor: store.publicKeyFor.bind(store),
  };

  // Anything else: a method that throws when called, and no other property
  // at all (the store's database connections are properties too).
  return new Proxy(store, {
    get(target, property) {
      if (typeof property === "string" && Object.prototype.hasOwnProperty.call(allowed, property)) {
        return allowed[property as keyof ReceiptStore];
      }
      if (typeof Reflect.get(target, property) === "function") {
        return () => {
          throw new NotVisibleError(`the store's ${String(property)}`);
        };
      }
      return undefined;
    },
  });
}
