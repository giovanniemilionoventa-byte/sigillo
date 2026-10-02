import { StorageError, type ReceiptStore, type SystemRecord } from "../storage/store.js";

/**
 * Who is looking at the web view.
 *
 * The operator signs in with the installation's one password and sees every
 * system, as before organizations existed. A member of an organization sees
 * that organization's systems and nothing else: not another organization's,
 * and not the operator's own (a system whose organization_id is NULL).
 */
export type Viewer =
  | { kind: "operator" }
  /** userId: the member's Firebase uid; absent only in tests that stand for no one in particular. */
  | { kind: "organization"; organizationId: string; userId?: string };

export const OPERATOR: Viewer = { kind: "operator" };

/** Raised when an organization's view reaches for something it may not see or do. */
export class NotVisibleError extends StorageError {
  constructor(what: string) {
    super(`not visible to this organization: ${what}`);
    this.name = "NotVisibleError";
  }
}

/**
 * The store as `viewer` may see it. For the operator, the store itself. For
 * an organization, a stand-in that is closed by default: a method listed
 * below answers within the organization's systems, and any other method —
 * one that exists today and is not listed, or one added to the store later —
 * throws when it is reached, rather than answering across organizations.
 * That is the point of building it this way: forgetting a method here fails
 * a page, it never leaks one.
 *
 * What an organization cannot see answers as if it did not exist (a system
 * record is null, hasSystem is false), so that a guessed identifier tells
 * the guesser nothing about whether some other organization has it.
 */
export function storeFor(store: ReceiptStore, viewer: Viewer): ReceiptStore {
  if (viewer.kind === "operator") return store;
  const organizationId = viewer.organizationId;

  const owns = (record: SystemRecord | null): record is SystemRecord =>
    record !== null && record.organization_id === organizationId;
  const visible = (systemId: string): boolean => owns(store.systemRecord(systemId));
  const require = (systemId: string): void => {
    if (!visible(systemId)) throw new NotVisibleError(systemId);
  };
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
    // A deletion is only ever shown for a system this organization had; for
    // any other identifier, as if there had been none.
    deletionOf: (systemId: string) => {
      const entry = store
        .adminLog(10_000)
        .find((logged) => logged.action === "system.delete" && logged.system_id === systemId);
      return entry !== undefined && entry.detail["organization_id"] === organizationId ? entry.ts : null;
    },

    // Searches across systems, cut down to this organization's.
    findDocument: (fingerprints: Parameters<ReceiptStore["findDocument"]>[0]) =>
      store.findDocument(fingerprints).filter((match) => visible(match.system_id)),
    // The log of this organization's systems, its deletions included. Not
    // the moves between organizations, which name the other one, and not
    // what concerns no system (an erasure, another organization's creation).
    adminLog: (limit?: number) =>
      store
        .adminLog(10_000)
        .filter((entry) =>
          entry.action === "system.delete"
            ? entry.detail["organization_id"] === organizationId
            : entry.action !== "system.assign" && entry.system_id !== "" && visible(entry.system_id),
        )
        .slice(0, limit ?? 100),

    // A system created here is this organization's, from its genesis on.
    createSystem: (systemId: string, ts: string) => store.createSystem(systemId, ts, organizationId),

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
