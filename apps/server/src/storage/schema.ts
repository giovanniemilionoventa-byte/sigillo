import type Database from "better-sqlite3";

/**
 * The whole database schema, applied on open.
 *
 * The triggers make the three evidence tables append-only for anything that
 * speaks SQL to this file. They are not a defence against an attacker who can
 * replace the file or drop the tables: that is what the signatures, the chain
 * and the timestamped checkpoints are for. What they do stop is the ordinary
 * case — a script, a support query, or a bug quietly rewriting history.
 */
export const SCHEMA_SQL = `
-- One row per chain. system_id is the chain's identity, written into every
-- receipt, checkpoint and export, and never changes (a trigger below refuses
-- it). display_name and archived_at are labels for the web view: not
-- evidence, never signed, free to change (added after the first release, by
-- ensureColumn in applySchema).
CREATE TABLE IF NOT EXISTS systems (
  system_id  TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;

-- The customers of a hosted installation. Not evidence, and not part of any
-- chain: which organization a system belongs to decides who may see it in the
-- web view, never what its receipts say. A system's organization_id (added by
-- ensureColumn in applySchema) is NULL for a system no organization was given,
-- and such a system is seen by the operator alone. approved_at is NULL until
-- the operator lets the organization in.
CREATE TABLE IF NOT EXISTS organizations (
  organization_id TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  approved_at     TEXT
) STRICT;

-- The people who sign in for an organization (auth/firebase.ts). uid is
-- Firebase's identifier for the account; the password, if there is one, is
-- Firebase's and never reaches this file. One organization per person.
CREATE TABLE IF NOT EXISTS users (
  uid             TEXT PRIMARY KEY,
  email           TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES organizations (organization_id),
  created_at      TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS users_by_organization ON users (organization_id);

-- Not evidence, and deliberately not append-only: a key must be revocable.
-- Only the scrypt hash of the secret is stored, so a copy of this database
-- does not let anyone speak for a system.
CREATE TABLE IF NOT EXISTS api_keys (
  key_id      TEXT PRIMARY KEY,
  system_id   TEXT NOT NULL REFERENCES systems (system_id),
  salt        TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  revoked_at  TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS api_keys_by_system ON api_keys (system_id);

CREATE TABLE IF NOT EXISTS receipts (
  id          INTEGER PRIMARY KEY,
  system_id   TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  hash        TEXT    NOT NULL,
  prev_hash   TEXT    NOT NULL,
  canonical   TEXT    NOT NULL,
  sig         TEXT    NOT NULL,
  key_id      TEXT    NOT NULL,
  ts_event    TEXT    NOT NULL,
  ts_received TEXT    NOT NULL,
  action_kind TEXT    NOT NULL,
  action_name TEXT    NOT NULL,
  outcome     TEXT    NOT NULL,
  -- Present only for a receipt built from an OTLP span. What lets a resent
  -- batch be recognised as the one already written (fase 9 / review point 6):
  -- an exporter whose response was lost retries the whole batch, unchanged.
  source_trace_id TEXT,
  source_span_id  TEXT,
  UNIQUE (system_id, seq),
  UNIQUE (hash)
) STRICT;

CREATE INDEX IF NOT EXISTS receipts_by_time
  ON receipts (system_id, ts_received);
CREATE INDEX IF NOT EXISTS receipts_by_action
  ON receipts (system_id, action_kind, action_name);

CREATE TABLE IF NOT EXISTS checkpoints (
  id        INTEGER PRIMARY KEY,
  system_id TEXT    NOT NULL,
  tree_size INTEGER NOT NULL,
  root_hash TEXT    NOT NULL,
  ts        TEXT    NOT NULL,
  key_id    TEXT    NOT NULL,
  sig       TEXT    NOT NULL,
  UNIQUE (system_id, tree_size)
) STRICT;

CREATE TABLE IF NOT EXISTS timestamps (
  id            INTEGER PRIMARY KEY,
  checkpoint_id INTEGER NOT NULL REFERENCES checkpoints (id),
  tsa_url       TEXT    NOT NULL,
  token_base64  TEXT    NOT NULL,
  obtained_at   TEXT    NOT NULL,
  UNIQUE (checkpoint_id, tsa_url)
) STRICT;

-- One row per artifact occurrence: a receipt with two artifacts is two rows.
-- This is what makes "has anyone ever used this document" an index lookup
-- instead of a scan of every receipt's canonical JSON. text_canon and
-- text_sha256 (a version 3 artifact's text fingerprint, null otherwise) were
-- added later, by ensureColumn in applySchema.
CREATE TABLE IF NOT EXISTS artifacts (
  id         INTEGER PRIMARY KEY,
  system_id  TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT    NOT NULL,
  label      TEXT    NOT NULL,
  media_type TEXT    NOT NULL,
  sha256     TEXT    NOT NULL,
  FOREIGN KEY (system_id, seq) REFERENCES receipts (system_id, seq)
) STRICT;

CREATE INDEX IF NOT EXISTS artifacts_by_sha256 ON artifacts (sha256);

-- Every public key the server has signed with, kept for as long as the
-- receipts it signed: an export publishes all of them, and the web view's
-- monitor checks each receipt under its own key. Without this, a key that
-- changed (lost and regenerated, or replaced) would leave every earlier
-- receipt unverifiable from the server's own exports.
CREATE TABLE IF NOT EXISTS signing_keys (
  key_id            TEXT PRIMARY KEY,
  public_key_base64 TEXT NOT NULL,
  first_seen        TEXT NOT NULL
) STRICT;

-- The Python SDK's heartbeat (connection/watch.ts), one row per running
-- copy of an agent: its session, whether it is beating, and when it last did.
-- Not evidence: state only, so the server can notice silence. What is evidence
-- is the receipt written on each change of state (sigillo.connection.*).
CREATE TABLE IF NOT EXISTS connections (
  system_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('open', 'lost', 'closed')),
  started_at   TEXT NOT NULL,
  last_beat_at TEXT NOT NULL,
  PRIMARY KEY (system_id, session_id)
) STRICT;

-- What an administrator did to a system outside its chain: renaming,
-- archiving, and deleting an empty one. Append-only like the evidence, and
-- deliberately outside any chain: a deleted system's chain no longer exists
-- to record its own deletion. genesis_hash is set only for a deletion, and
-- names the genesis receipt it removes (see deletable_chains).
CREATE TABLE IF NOT EXISTS admin_log (
  id           INTEGER PRIMARY KEY,
  ts           TEXT NOT NULL,
  action       TEXT NOT NULL,
  system_id    TEXT NOT NULL,
  actor        TEXT NOT NULL,
  detail       TEXT NOT NULL,
  genesis_hash TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS admin_log_by_system ON admin_log (system_id);

-- Who a pseudonym token stands for (receipt version 4). Not evidence, and
-- deliberately not append-only: deleting a row is how a person is erased, after
-- which nothing links the token in their receipts to them. identifier is
-- normalised (normaliseSubjectIdentifier), so one person has one token. The
-- store turns secure_delete on, so a deleted row is overwritten, not just
-- unlinked, in this file.
CREATE TABLE IF NOT EXISTS subjects (
  token      TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

-- The nonce under which a version 4 receipt's salted input or output digest
-- was computed. Without it the digest cannot be opened, nor its content found
-- by guessing; deleting the row is how a receipt is cut off from its content.
-- Not append-only, for that reason.
CREATE TABLE IF NOT EXISTS openings (
  system_id TEXT    NOT NULL,
  seq       INTEGER NOT NULL,
  role      TEXT    NOT NULL CHECK (role IN ('input', 'output')),
  nonce     TEXT    NOT NULL,
  PRIMARY KEY (system_id, seq, role),
  FOREIGN KEY (system_id, seq) REFERENCES receipts (system_id, seq)
) STRICT;

-- The chains whose receipts, checkpoints and tokens may be deleted: those
-- that hold only their genesis, and whose deletion, naming that genesis by
-- its hash, is already logged. Every delete guard below asks this view.
CREATE VIEW IF NOT EXISTS deletable_chains AS
SELECT genesis.system_id
FROM receipts genesis
JOIN admin_log entry
  ON entry.action = 'system.delete'
 AND entry.system_id = genesis.system_id
 AND entry.genesis_hash = genesis.hash
WHERE genesis.seq = 0
  AND NOT EXISTS (
    SELECT 1 FROM receipts later WHERE later.system_id = genesis.system_id AND later.seq > 0
  );

CREATE TRIGGER IF NOT EXISTS receipts_no_update BEFORE UPDATE ON receipts
BEGIN SELECT RAISE(ABORT, 'append-only: a receipt cannot be modified'); END;

-- A receipt can be deleted in exactly one case: it is the genesis of a chain
-- that holds nothing else, and the deletion of that very genesis (by its
-- hash) is already in the administrative log. That is how an empty system
-- created by mistake is removed (ReceiptStore.deleteEmptySystem); a chain
-- with even one real action can never lose a receipt, whoever asks and
-- through whichever connection (docs/SECURITY.md, "Deleting a system").
CREATE TRIGGER IF NOT EXISTS receipts_delete_guard BEFORE DELETE ON receipts
WHEN NOT (OLD.seq = 0 AND OLD.system_id IN (SELECT system_id FROM deletable_chains))
BEGIN SELECT RAISE(ABORT, 'append-only: a receipt cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS checkpoints_no_update BEFORE UPDATE ON checkpoints
BEGIN SELECT RAISE(ABORT, 'append-only: a checkpoint cannot be modified'); END;

-- Same rule: only the one-receipt checkpoint of a logged, genesis-only chain.
CREATE TRIGGER IF NOT EXISTS checkpoints_delete_guard BEFORE DELETE ON checkpoints
WHEN NOT (OLD.tree_size = 1 AND OLD.system_id IN (SELECT system_id FROM deletable_chains))
BEGIN SELECT RAISE(ABORT, 'append-only: a checkpoint cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS timestamps_no_update BEFORE UPDATE ON timestamps
BEGIN SELECT RAISE(ABORT, 'append-only: a timestamp token cannot be modified'); END;

-- Same rule: only a token over such a checkpoint.
CREATE TRIGGER IF NOT EXISTS timestamps_delete_guard BEFORE DELETE ON timestamps
WHEN NOT EXISTS (
  SELECT 1 FROM checkpoints c
  WHERE c.id = OLD.checkpoint_id AND c.tree_size = 1
    AND c.system_id IN (SELECT system_id FROM deletable_chains)
)
BEGIN SELECT RAISE(ABORT, 'append-only: a timestamp token cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS artifacts_no_update BEFORE UPDATE ON artifacts
BEGIN SELECT RAISE(ABORT, 'append-only: an artifact entry cannot be modified'); END;

CREATE TRIGGER IF NOT EXISTS artifacts_no_delete BEFORE DELETE ON artifacts
BEGIN SELECT RAISE(ABORT, 'append-only: an artifact entry cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS admin_log_no_update BEFORE UPDATE ON admin_log
BEGIN SELECT RAISE(ABORT, 'append-only: an administrative log entry cannot be modified'); END;

CREATE TRIGGER IF NOT EXISTS admin_log_no_delete BEFORE DELETE ON admin_log
BEGIN SELECT RAISE(ABORT, 'append-only: an administrative log entry cannot be deleted'); END;

-- The identity of a chain never changes.
CREATE TRIGGER IF NOT EXISTS systems_id_immutable BEFORE UPDATE OF system_id, created_at ON systems
BEGIN SELECT RAISE(ABORT, 'a system_id and its creation time cannot be changed'); END;

-- A system can be removed only once its chain is gone, which the guards above
-- allow only for a logged, genesis-only chain: without this, deleting the row
-- alone would hide a whole chain from every listing.
CREATE TRIGGER IF NOT EXISTS systems_delete_guard BEFORE DELETE ON systems
WHEN EXISTS (SELECT 1 FROM receipts WHERE system_id = OLD.system_id)
BEGIN SELECT RAISE(ABORT, 'append-only: a system with receipts cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS signing_keys_no_update BEFORE UPDATE ON signing_keys
BEGIN SELECT RAISE(ABORT, 'append-only: a signing key cannot be modified'); END;

CREATE TRIGGER IF NOT EXISTS signing_keys_no_delete BEFORE DELETE ON signing_keys
BEGIN SELECT RAISE(ABORT, 'append-only: a signing key cannot be deleted'); END;
`;

/**
 * Columns added to `receipts` after databases already held rows: SQLite's
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
 * exists, so a database created before this migration was written needs its
 * columns added here instead. Safe to run on every open: a no-op once the
 * column is there.
 */
function ensureColumn(db: Database.Database, table: string, column: string, type: string): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * The schema this build writes, kept in SQLite's `user_version`. It goes up
 * whenever a release changes the schema or starts writing something an
 * earlier release cannot read (receipt version 4 was the first: the release
 * before it restarts in a loop on such a database, with nothing but a parse
 * error to say why). A database stamped with a higher number was written by a
 * newer release, and this one refuses it with a sentence instead.
 * Databases written before the stamp existed read 0.
 */
// 2: organizations, and the organization a system belongs to. A release at 1
// would show every system to whoever holds its password.
// 3: the people who sign in for an organization.
// 4: the SDK heartbeat's sessions (connections).
export const SCHEMA_VERSION = 4;

export class NewerSchemaError extends Error {
  constructor(readonly found: number) {
    super(
      `this database was written by a newer release of sigillo (schema ${found}; this release knows up to ` +
        `${SCHEMA_VERSION}). Run that release, or restore a backup taken before it was installed ` +
        "(DEPLOY.md, \"Piano di ritorno\")",
    );
    this.name = "NewerSchemaError";
  }
}

export class OlderSchemaError extends Error {
  constructor(readonly found: number) {
    super(
      `this database is at schema ${found}, and this release reads schema ${SCHEMA_VERSION}. A command that only ` +
        "reads does not bring it up to date: run `sigillo-server migrate` on it (on a copy, if it is a backup), " +
        "or start the server on it once",
    );
    this.name = "OlderSchemaError";
  }
}

/**
 * For a connection that only reads: the schema must be exactly this
 * release's. Nothing is applied, so a backup that is being looked at is left
 * byte for byte as it was (verification report of 2026-10-01, point 8).
 */
export function requireCurrentSchema(db: Database.Database): void {
  const found = db.pragma("user_version", { simple: true }) as number;
  if (found > SCHEMA_VERSION) throw new NewerSchemaError(found);
  if (found < SCHEMA_VERSION) throw new OlderSchemaError(found);
}

/**
 * Applies the schema and every migration, in the order a database needs them:
 * the tables first (a no-op on one that already has them), then any column a
 * later version added, then the indexes that depend on those columns. Every
 * caller that opens a database file — the receipt store, the API key store —
 * goes through here, so it does not matter which one opens the file first.
 */
export function applySchema(db: Database.Database): void {
  const found = db.pragma("user_version", { simple: true }) as number;
  if (found > SCHEMA_VERSION) {
    throw new NewerSchemaError(found);
  }
  db.exec(SCHEMA_SQL);
  ensureColumn(db, "receipts", "source_trace_id", "TEXT");
  ensureColumn(db, "receipts", "source_span_id", "TEXT");
  ensureColumn(db, "systems", "display_name", "TEXT");
  ensureColumn(db, "systems", "archived_at", "TEXT");
  ensureColumn(db, "systems", "organization_id", "TEXT REFERENCES organizations (organization_id)");
  ensureColumn(db, "artifacts", "text_canon", "TEXT");
  ensureColumn(db, "artifacts", "text_sha256", "TEXT");
  // Databases written before empty systems could be deleted carry the
  // unconditional delete triggers. The guards that replace them were created
  // just above, by SCHEMA_SQL, so there is no moment with neither.
  db.exec(`
    DROP TRIGGER IF EXISTS receipts_no_delete;
    DROP TRIGGER IF EXISTS checkpoints_no_delete;
    DROP TRIGGER IF EXISTS timestamps_no_delete;
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS receipts_by_source
      ON receipts (system_id, source_trace_id, source_span_id)
      WHERE source_trace_id IS NOT NULL AND source_span_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS artifacts_by_text_sha256
      ON artifacts (text_sha256) WHERE text_sha256 IS NOT NULL;
    CREATE INDEX IF NOT EXISTS systems_by_organization
      ON systems (organization_id) WHERE organization_id IS NOT NULL;
  `);
  // "Is this text exactly an action's whole input or output" (the document
  // lookup): indexes on the digests as the receipt itself holds them, so no
  // column has to be added and no existing row rewritten — the receipts
  // table is append-only, and a trigger refuses any UPDATE.
  db.exec(`
    CREATE INDEX IF NOT EXISTS receipts_by_input_hash
      ON receipts (json_extract(canonical, '$.input_hash'));
    CREATE INDEX IF NOT EXISTS receipts_by_output_hash
      ON receipts (json_extract(canonical, '$.output_hash'));
  `);
  // "Every receipt on behalf of this person": the token, as the receipt holds
  // it, found from the identifier through the subjects table.
  db.exec(`
    CREATE INDEX IF NOT EXISTS receipts_by_on_behalf_of
      ON receipts (json_extract(canonical, '$.actor.on_behalf_of'));
  `);
  if (found < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
