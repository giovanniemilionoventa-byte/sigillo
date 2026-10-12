import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * deploy/offsite-backup.sh with the real `age`. Only the transport is
 * replaced: a tiny `rclone` that treats "remote:" as a local folder, so no
 * account is needed. Nothing about the encryption is faked. Skipped where
 * `age` is not installed.
 */

const SCRIPT = fileURLToPath(new URL("../../../deploy/offsite-backup.sh", import.meta.url));
const haveAge = spawnSync("age", ["--version"]).status === 0;

const FAKE_RCLONE = `#!/bin/sh
# remote paths "x:dir/file" map to $FAKE_REMOTE_ROOT/dir/file
map() { echo "$FAKE_REMOTE_ROOT/\${1#*:}"; }
case "$1" in
  copyto) mkdir -p "$(dirname "$(map "$3")")"; cp "$2" "$(map "$3")" ;;
  lsf) ls -1 "$(map "$2")" 2>/dev/null || true ;;
  deletefile) rm -f "$(map "$2")" ;;
  *) echo "fake rclone: $1" >&2; exit 2 ;;
esac
`;

let work: string;
let publicKey: string;
let identity: string;
let env: NodeJS.ProcessEnv;
let remoteDir: string;

function run(extra: NodeJS.ProcessEnv = {}) {
  return spawnSync("sh", [SCRIPT], { env: { ...env, ...extra }, encoding: "utf8" });
}

function backupFile(name: string, content: string, ageMinutes = 1): string {
  const path = join(work, name);
  writeFileSync(path, content);
  const t = new Date(Date.now() - ageMinutes * 60_000);
  utimesSync(path, t, t);
  return path;
}

beforeAll(() => {
  if (!haveAge) return;
  work = mkdtempSync(join(tmpdir(), "offsite-"));
  const bin = join(work, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "rclone"), FAKE_RCLONE);
  chmodSync(join(bin, "rclone"), 0o755);
  identity = join(work, "key.txt");
  const generated = spawnSync("age-keygen", ["-o", identity], { encoding: "utf8" });
  publicKey = /age1[a-z0-9]+/.exec(generated.stderr + generated.stdout)![0];
  remoteDir = join(work, "remote");
  env = {
    PATH: `${bin}:${process.env["PATH"]}`,
    HOME: work,
    FAKE_REMOTE_ROOT: remoteDir,
    SIGILLO_OFFSITE_ENV: join(work, "none.env"),
    SIGILLO_OFFSITE_RECIPIENT: publicKey,
    SIGILLO_OFFSITE_REMOTE: "box:sigillo",
  };
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!haveAge)("deploy/offsite-backup.sh", () => {
  it("uploads a copy that is not plaintext and that only the private key opens", () => {
    const secret = "TOP-SECRET-DATABASE-CONTENT ".repeat(50);
    const src = backupFile("sigillo-20261012T030000Z.db", secret);
    const result = run({ SIGILLO_OFFSITE_SOURCE: src });
    expect(result.status, result.stderr).toBe(0);
    const stored = join(remoteDir, "sigillo", "sigillo-20261012T030000Z.db.age");
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).includes("TOP-SECRET")).toBe(false);
    const opened = execFileSync("age", ["-d", "-i", identity, stored], { encoding: "utf8" });
    expect(opened).toBe(secret);
  });

  it("keeps only the newest SIGILLO_OFFSITE_KEEP copies (by name, not by age)", () => {
    for (const day of ["01", "02", "03", "04"]) {
      const src = backupFile(`sigillo-202610${day}T030000Z.db`, `db ${day}`);
      const r = run({ SIGILLO_OFFSITE_SOURCE: src, SIGILLO_OFFSITE_KEEP: "2" });
      expect(r.status, r.stderr).toBe(0);
    }
    expect(readdirSync(join(remoteDir, "sigillo")).sort()).toEqual([
      "sigillo-20261004T030000Z.db.age",
      "sigillo-20261012T030000Z.db.age",
    ]);
  });

  it("refuses a private key given as the recipient", () => {
    const src = backupFile("sigillo-20261012T040000Z.db", "x");
    const secretKey = /AGE-SECRET-KEY-\S+/.exec(readFileSync(identity, "utf8"))![0];
    const r = run({ SIGILLO_OFFSITE_SOURCE: src, SIGILLO_OFFSITE_RECIPIENT: secretKey });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("PUBLIC key");
  });

  it("fails loudly when the newest backup is stale", () => {
    const src = backupFile("sigillo-20261012T050000Z.db", "x", 60 * 24);
    const r = run({ SIGILLO_OFFSITE_SOURCE: src });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("hourly backup.sh has stopped");
  });

  it("says what is missing when it is not configured", () => {
    const r = run({ SIGILLO_OFFSITE_REMOTE: "" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("SIGILLO_OFFSITE_REMOTE");
  });
});
