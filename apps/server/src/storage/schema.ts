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

CREATE TRIGGER IF NOT EXISTS receipts_no_update BEFORE UPDATE ON receipts
BEGIN SELECT RAISE(ABORT, 'append-only: a receipt cannot be modified'); END;

CREATE TRIGGER IF NOT EXISTS receipts_no_delete BEFORE DELETE ON receipts
BEGIN SELECT RAISE(ABORT, 'append-only: a receipt cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS checkpoints_no_update BEFORE UPDATE ON checkpoints
BEGIN SELECT RAISE(ABORT, 'append-only: a checkpoint cannot be modified'); END;

CREATE TRIGGER IF NOT EXISTS checkpoints_no_delete BEFORE DELETE ON checkpoints
BEGIN SELECT RAISE(ABORT, 'append-only: a checkpoint cannot be deleted'); END;

CREATE TRIGGER IF NOT EXISTS timestamps_no_update BEFORE UPDATE ON timestamps
BEGIN SELECT RAISE(ABORT, 'append-only: a timestamp token cannot be modified'); END;

CREATE TRIGGER IF NOT EXISTS timestamps_no_delete BEFORE DELETE ON timestamps
BEGIN SELECT RAISE(ABORT, 'append-only: a timestamp token cannot be deleted'); END;
`;
