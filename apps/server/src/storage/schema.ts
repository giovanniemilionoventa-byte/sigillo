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
-- instead of a scan of every receipt's canonical JSON.
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
 * Applies the schema and every migration, in the order a database needs them:
 * the tables first (a no-op on one that already has them), then any column a
 * later version added, then the indexes that depend on those columns. Every
 * caller that opens a database file — the receipt store, the API key store —
 * goes through here, so it does not matter which one opens the file first.
 */
export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  ensureColumn(db, "receipts", "source_trace_id", "TEXT");
  ensureColumn(db, "receipts", "source_span_id", "TEXT");
  ensureColumn(db, "systems", "display_name", "TEXT");
  ensureColumn(db, "systems", "archived_at", "TEXT");
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
  `);
}
