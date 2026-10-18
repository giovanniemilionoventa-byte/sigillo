import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * deploy/attiva-backup-fuori-sede.sh with the real `age`, the real SQLite and
 * the real offsite-backup.sh. Only the transport is replaced: a tiny `rclone`
 * that treats "box:" as a local folder, so no account is needed. Skipped where
 * `age` is not installed.
 */

const SCRIPT = fileURLToPath(new URL("../../../deploy/attiva-backup-fuori-sede.sh", import.meta.url));
const haveTools =
  spawnSync("age", ["--version"]).status === 0 && spawnSync("python3", ["--version"]).status === 0;

const FAKE_RCLONE = `#!/bin/sh
map() { echo "$FAKE_REMOTE_ROOT/\${1#*:}"; }
case "$1" in
  config) echo "$@" >> "$FAKE_REMOTE_ROOT/config.log" ;;
  copyto)
    case "$2" in
      box:*) cp "$(map "$2")" "$3" ;;
      *) mkdir -p "$(dirname "$(map "$3")")"; cp "$2" "$(map "$3")" ;;
    esac ;;
  lsf) ls -1 "$(map "$2")" 2>/dev/null || true ;;
  deletefile) rm -f "$(map "$2")" ;;
  *) echo "fake rclone: $1" >&2; exit 2 ;;
esac
`;

let work: string;
let env: NodeJS.ProcessEnv;
let identity: string;
let tail: string;

function makeDb(path: string, valid: boolean): void {
  const code = valid
    ? "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('create table t(x)');c.execute('insert into t values (1)');c.commit()"
    : "open(__import__('sys').argv[1],'w').write('this is not a database')";
  spawnSync("python3", ["-I", "-c", code, path], { encoding: "utf8" });
}

function run(extra: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", [SCRIPT], { env: { ...env, ...extra }, encoding: "utf8" });
}

beforeAll(() => {
  if (!haveTools) return;
  work = mkdtempSync(join(tmpdir(), "setup-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rclone"), FAKE_RCLONE);
  chmodSync(join(bin, "rclone"), 0o755);
  mkdirSync(join(work, "remote"));
  identity = join(work, "key.txt");
  spawnSync("age-keygen", ["-o", identity]);
  tail = /AGE-SECRET-KEY-\S+/.exec(readFileSync(identity, "utf8"))![0].slice(-6);
  env = {
    PATH: `${bin}:${process.env["PATH"]}`,
    HOME: work,
    FAKE_REMOTE_ROOT: join(work, "remote"),
    SIGILLO_OFFSITE_ENV: join(work, "offsite.env"),
    SIGILLO_SETUP_SKIP_INSTALL: "1",
    SIGILLO_SETUP_SKIP_CRON: "1",
    SIGILLO_SETUP_KIND: "sftp",
    SIGILLO_SETUP_HOST: "storage.example",
    SIGILLO_SETUP_USER: "u1",
    SIGILLO_SETUP_PASSWORD: "hunter2-not-a-real-password",
    SIGILLO_SETUP_PATH: "sigillo",
  };
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!haveTools)("deploy/attiva-backup-fuori-sede.sh", () => {
  it("proves a full restore and leaves no private key behind", () => {
    const db = join(work, "sigillo-20261016T180000Z.db");
    makeDb(db, true);
    const wrong = run({ SIGILLO_OFFSITE_SOURCE: db, SIGILLO_SETUP_IDENTITY: identity, SIGILLO_SETUP_CONFIRM_KEY: "wrong!" });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain("ultimi 6 caratteri");
    expect(existsSync(join(work, "offsite.env"))).toBe(false);

    const ok = run({ SIGILLO_OFFSITE_SOURCE: db, SIGILLO_SETUP_IDENTITY: identity, SIGILLO_SETUP_CONFIRM_KEY: tail });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain("backup fuori sede attivo e provato");
    expect(readdirSync(join(work, "remote", "sigillo"))).toEqual(["sigillo-20261016T180000Z.db.age"]);
    const settings = readFileSync(join(work, "offsite.env"), "utf8");
    expect(settings).toMatch(/SIGILLO_OFFSITE_RECIPIENT=age1/);
    expect(settings).not.toContain("AGE-SECRET-KEY");
    expect(settings).not.toContain("hunter2");
    const config = readFileSync(join(work, "remote", "config.log"), "utf8");
    expect(config).toContain("host storage.example");
  });

  it("connects Google Drive with the narrow scope and the pasted token", () => {
    const db = join(work, "sigillo-20261016T200000Z.db");
    makeDb(db, true);
    const r = run({
      SIGILLO_OFFSITE_SOURCE: db,
      SIGILLO_SETUP_IDENTITY: identity,
      SIGILLO_SETUP_CONFIRM_KEY: tail,
      SIGILLO_SETUP_KIND: "drive",
      SIGILLO_SETUP_PATH: "",
      SIGILLO_SETUP_PASSWORD: '{"access_token":"x"}',
    });
    expect(r.status, r.stderr).toBe(0);
    const config = readFileSync(join(work, "remote", "config.log"), "utf8");
    expect(config).toContain("drive scope drive.file");
    expect(readFileSync(join(work, "offsite.env"), "utf8")).toContain("SIGILLO_OFFSITE_REMOTE=box:sigillo-backup");
  });

  it("accepts the base64 blob that newer rclone prints, and passes the bare token on", () => {
    const db = join(work, "sigillo-20261016T210000Z.db");
    makeDb(db, true);
    const token = JSON.stringify({ access_token: "ya29.x", token_type: "Bearer", refresh_token: "1//r" });
    const blob = Buffer.from(JSON.stringify({ client_id: "", client_secret: "", token })).toString("base64url");
    const r = run({
      SIGILLO_OFFSITE_SOURCE: db,
      SIGILLO_SETUP_IDENTITY: identity,
      SIGILLO_SETUP_CONFIRM_KEY: tail,
      SIGILLO_SETUP_KIND: "drive",
      SIGILLO_SETUP_PATH: "",
      SIGILLO_SETUP_PASSWORD: blob,
    });
    expect(r.status, r.stderr).toBe(0);
    const config = readFileSync(join(work, "remote", "config.log"), "utf8");
    expect(config).toContain(`token ${token}`);
    expect(config).not.toContain(blob);
  });

  it("rejects pasted text that is not a Google authorisation", () => {
    const db = join(work, "sigillo-20261016T220000Z.db");
    makeDb(db, true);
    const r = run({
      SIGILLO_OFFSITE_SOURCE: db,
      SIGILLO_SETUP_IDENTITY: identity,
      SIGILLO_SETUP_CONFIRM_KEY: tail,
      SIGILLO_SETUP_KIND: "drive",
      SIGILLO_SETUP_PASSWORD: "not a token",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("autorizzazione");
  });

  it("does not call it proven when the restored database is damaged", () => {
    const db = join(work, "sigillo-20261016T190000Z.db");
    makeDb(db, false);
    const r = run({ SIGILLO_OFFSITE_SOURCE: db, SIGILLO_SETUP_IDENTITY: identity, SIGILLO_SETUP_CONFIRM_KEY: tail });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("backup fuori sede attivo e provato");
    expect(r.stderr).toContain("danneggiato");
  });
});
