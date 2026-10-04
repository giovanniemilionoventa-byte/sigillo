import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOffsiteStatus, STATUS_FILE, writeOffsiteSettings, type OffsiteSettings, type OffsiteStatus } from "../src/backup/offsite.js";

/**
 * The production deployment files, checked as Docker Compose itself reads
 * them. This needs only the `docker compose` command, not a running Docker
 * daemon: `config` resolves the file without starting anything. Where the
 * command is missing the tests are skipped, and say so.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEPLOY = join(REPOSITORY_ROOT, "deploy");
const PASSWORD = "Segreto-Di-Prova-1234-non-deve-comparire";

const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
const haveCompose = compose.status === 0;

interface Service {
  read_only?: boolean;
  security_opt?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  logging?: { driver?: string; options?: Record<string, string> };
  deploy?: { resources?: { limits?: { memory?: unknown; pids?: unknown; cpus?: unknown } } };
  environment?: Record<string, string>;
  volumes?: { target: string }[];
  ports?: unknown[];
  network_mode?: string;
}

let directory: string;
let rendered = "";
let services: Record<string, Service> = {};

beforeAll(() => {
  if (!haveCompose) return;
  // A copy, so that the secret file this test writes never sits in the tree.
  directory = mkdtempSync(join(tmpdir(), "sigillo-deploy-"));
  cpSync(DEPLOY, join(directory, "deploy"), { recursive: true });
  const deploy = join(directory, "deploy");
  mkdirSync(join(deploy, "secrets"), { mode: 0o700 });
  writeFileSync(join(deploy, "secrets", "admin_password"), PASSWORD, { mode: 0o444 });
  writeFileSync(
    join(deploy, ".env"),
    `SIGILLO_DOMAIN=sigillo.example.com\nSIGILLO_TLS_EMAIL=ops@example.com\n` +
      // What an operator used to set: it must not leak even if left in .env.
      `SIGILLO_ADMIN_PASSWORD=${PASSWORD}\nTSA_PASSWORD=${PASSWORD}\n`,
  );
  rendered = execFileSync("docker", ["compose", "config"], { cwd: deploy, encoding: "utf8" });
  services = (
    JSON.parse(
      execFileSync("docker", ["compose", "config", "--format", "json"], { cwd: deploy, encoding: "utf8" }),
    ) as { services: Record<string, Service> }
  ).services;
});

afterAll(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(!haveCompose)("deploy/docker-compose.yml, as Compose resolves it", () => {
  it("never prints the administrator password", () => {
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain(PASSWORD);
    expect(services["server"]?.environment?.["SIGILLO_ADMIN_PASSWORD_FILE"]).toBe("/run/secrets/admin_password");
    expect(services["server"]?.environment?.["SIGILLO_ADMIN_PASSWORD"]).toBeUndefined();
  });

  it("hardens every service", () => {
    expect(Object.keys(services).sort()).toEqual(["caddy", "server", "signer"]);
    for (const [name, service] of Object.entries(services)) {
      expect(service.read_only, name).toBe(true);
      expect(service.security_opt, name).toContain("no-new-privileges:true");
      expect(service.cap_drop, name).toEqual(["ALL"]);
      expect(service.logging?.driver, name).toBe("json-file");
      expect(service.logging?.options?.["max-size"], name).toBeDefined();
      expect(service.logging?.options?.["max-file"], name).toBeDefined();
      const limits = service.deploy?.resources?.limits;
      expect(limits?.memory, name).toBeDefined();
      expect(limits?.pids, name).toBeDefined();
      expect(limits?.cpus, name).toBeDefined();
    }
    expect(services["caddy"]?.cap_add).toEqual(["NET_BIND_SERVICE"]);
    expect(services["server"]?.cap_add).toBeUndefined();
    expect(services["signer"]?.cap_add).toBeUndefined();
  });

  it("publishes only Caddy, and keeps the signer off every network", () => {
    expect(services["server"]?.ports).toBeUndefined();
    expect(services["signer"]?.ports).toBeUndefined();
    expect(services["signer"]?.network_mode).toBe("none");
    expect(services["caddy"]?.ports?.length).toBe(2);
  });

  it("trusts X-Forwarded-For only from the compose network, and marks the cookie Secure", () => {
    expect(services["server"]?.environment?.["SIGILLO_TRUST_PROXY"]).toBe("uniquelocal");
    expect(services["server"]?.environment?.["SIGILLO_COOKIE_SECURE"]).toBe("true");
  });
});

describe.skipIf(!haveCompose)("deploy/docker-compose.yml, misconfigured", () => {
  // Found by running Caddy on the Caddyfile: with SIGILLO_TLS_EMAIL empty,
  // which the file used to allow, the global `email` line has no argument and
  // Caddy refuses its whole configuration. Compose now stops first, and says
  // which variable is missing.
  it("refuses to start without a certificate contact address", () => {
    const deploy = join(directory, "deploy");
    const env = join(directory, "no-email.env");
    writeFileSync(env, "SIGILLO_DOMAIN=sigillo.example.com\n");
    const run = spawnSync("docker", ["compose", "--env-file", env, "config"], { cwd: deploy, encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("SIGILLO_TLS_EMAIL");
  });
});

const caddy = spawnSync("caddy", ["version"], { encoding: "utf8" });

describe.skipIf(caddy.status !== 0)("deploy/Caddyfile, as Caddy reads it", () => {
  it("is a valid configuration once the domain and the address are set", () => {
    const run = spawnSync("caddy", ["validate", "--config", join(DEPLOY, "Caddyfile"), "--adapter", "caddyfile"], {
      encoding: "utf8",
      env: { ...process.env, SIGILLO_DOMAIN: "sigillo.example.com", SIGILLO_TLS_EMAIL: "ops@example.com" },
    });
    expect(run.stderr + run.stdout).toContain("Valid configuration");
  });
});

describe("deploy/Dockerfile", () => {
  // Found reading the files (Docker is not available where this was written):
  // the backups volume was mounted on a directory the image did not have, so
  // Docker would have created it owned by root, and backup.sh, running as
  // node, could not have written a single backup.
  it("creates, owned by node, every directory the server and the signer mount a volume on", () => {
    const dockerfile = readFileSync(join(DEPLOY, "Dockerfile"), "utf8");
    const composeFile = readFileSync(join(DEPLOY, "docker-compose.yml"), "utf8");
    const created = [...dockerfile.matchAll(/install -d -o node -g node ([^\n]+)/g)].flatMap((match) =>
      (match[1] ?? "").trim().split(/\s+/),
    );
    const mounted = [...composeFile.matchAll(/^\s+- (?:signer-key|signer-socket|sigillo-data|backups):(\S+)$/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(mounted.length).toBeGreaterThanOrEqual(5);
    for (const target of mounted) expect(created, target).toContain(target);
  });

  it("builds from a base image pinned by digest", () => {
    const froms = [...readFileSync(join(DEPLOY, "Dockerfile"), "utf8").matchAll(/^FROM (\S+)/gm)].map((m) => m[1] ?? "");
    expect(froms).toHaveLength(3);
    for (const from of froms) expect(from).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(new Set(froms).size).toBe(1);
  });
});

/**
 * deploy/update.sh, run for real by /bin/sh, with `git` and `docker` replaced
 * by stand-ins that record what they were asked and answer as Caddy's admin
 * endpoint would. What is checked is the script's own logic: the order of
 * the steps, that Caddy is always restarted, and that a Caddy serving another
 * script hash than the Caddyfile's fails the update.
 */
describe.skipIf(process.platform === "win32")("deploy/update.sh", () => {
  const caddyfileHash = /'sha256-[A-Za-z0-9+/]+=*'/.exec(readFileSync(join(DEPLOY, "Caddyfile"), "utf8"))?.[0] ?? "";

  function runUpdate(
    loadedHash: string,
    gitFails = false,
    signerDiffers = false,
  ): { status: number | null; calls: string[]; stdout: string; stderr: string } {
    const root = mkdtempSync(join(tmpdir(), "sigillo-update-"));
    try {
      mkdirSync(join(root, "deploy"));
      cpSync(join(DEPLOY, "update.sh"), join(root, "deploy", "update.sh"));
      cpSync(join(DEPLOY, "Caddyfile"), join(root, "deploy", "Caddyfile"));
      const bin = join(root, "bin");
      mkdirSync(bin);
      const log = join(root, "calls.log");
      writeFileSync(join(bin, "git"), `#!/bin/sh\necho "git $*" >> "${log}"\n${gitFails ? "exit 1\n" : ""}`, { mode: 0o755 });
      writeFileSync(
        join(bin, "docker"),
        `#!/bin/sh\necho "docker $*" >> "${log}"\n` +
          `case "$*" in *"exec -T caddy wget"*) printf '%s' '{"apps":{"http":{"servers":{"srv0":{"routes":[{"handle":[{"headers":{"set":{"Content-Security-Policy":["script-src ${loadedHash.replace(/'/g, "'\\''")}"]}}}]}]}}}}}' ;; esac\n` +
          `case "$*" in *"signer check"*) ${
            signerDiffers ? `printf 'bot\\tdatabase seq 4\\tsigner seq 5\\tDIFFERENT\\n'; exit 1` : `printf 'bot\\tdatabase seq 4\\tsigner seq 4\\tsame\\n'`
          } ;; esac\n`,
        { mode: 0o755 },
      );
      // The retries wait for nothing here.
      writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const result = spawnSync("/bin/sh", [join(root, "deploy", "update.sh")], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      let calls: string[] = [];
      try {
        calls = readFileSync(log, "utf8").trim().split("\n");
      } catch {
        // nothing was called
      }
      return { status: result.status, calls, stdout: result.stdout, stderr: result.stderr };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("pulls, rebuilds, restarts Caddy every time, and checks the hash Caddy loaded", () => {
    expect(caddyfileHash).not.toBe("");
    const { status, calls } = runUpdate(caddyfileHash);
    expect(status).toBe(0);
    expect(calls.slice(0, 5)).toEqual([
      "git -C .. pull --ff-only",
      "docker compose build",
      "docker compose up -d",
      "docker compose restart caddy",
      "docker compose exec -T caddy wget -qO- http://localhost:2019/config/",
    ]);
  });

  it("asks the server whether the signer agrees with the database, after Caddy", () => {
    const { status, calls, stdout } = runUpdate(caddyfileHash);
    expect(status).toBe(0);
    expect(calls.indexOf("docker compose exec -T server node dist/cli.js signer check")).toBeGreaterThan(
      calls.indexOf("docker compose exec -T caddy wget -qO- http://localhost:2019/config/"),
    );
    expect(stdout).toContain("bot\tdatabase seq 4\tsigner seq 4\tsame");
  });

  it("fails, showing which chain, when the signer and the database disagree", () => {
    const { status, calls, stderr } = runUpdate(caddyfileHash, false, true);
    expect(status).toBe(1);
    expect(calls.filter((call) => call.includes("signer check"))).toHaveLength(10);
    expect(stderr).toContain("DIFFERENT");
    expect(stderr).toContain("the signer and the database disagree");
  });

  it("fails when Caddy serves another script hash than the Caddyfile's", () => {
    const { status, stderr } = runUpdate(`'sha256-${"A".repeat(43)}='`);
    expect(status).toBe(1);
    expect(stderr).toContain("deploy/Caddyfile says");
  });

  it("stops before touching any container when the pull fails", () => {
    const { status, calls } = runUpdate(caddyfileHash, true);
    expect(status).not.toBe(0);
    expect(calls).toEqual(["git -C .. pull --ff-only"]);
  });
});

/**
 * deploy/backup-offsite.sh, run for real by bash, with `docker` standing in
 * for the server container (a directory in place of the backups volume) and
 * `rclone` for the remote (another directory). What is checked is the
 * script's own logic: that the local backup runs whether or not a remote is
 * configured, that it follows what Impostazioni chose, that the newest copy
 * is what is uploaded, that the remote keeps one copy per day for the days
 * asked, that an upload cut short leaves nothing behind, and that what it
 * reports is what backup/offsite.ts reads. The encryption itself is
 * rclone's, and 6.1 has the script check it on the server with `--check`.
 */
describe.skipIf(process.platform === "win32")("deploy/backup-offsite.sh", () => {
  const NOW = Math.floor(Date.now() / 1000);

  function runOffsite(options: {
    configured: boolean;
    onRemote?: string[];
    keepDays?: number;
    streamFails?: boolean;
    settings?: OffsiteSettings;
    lastSuccess?: number;
  }): {
    status: number | null;
    stdout: string;
    stderr: string;
    remote: string[];
    uploaded: Buffer | undefined;
    newest: Buffer;
    reported: OffsiteStatus | null;
  } {
    const root = mkdtempSync(join(tmpdir(), "sigillo-offsite-"));
    try {
      mkdirSync(join(root, "deploy"));
      cpSync(join(DEPLOY, "backup-offsite.sh"), join(root, "deploy", "backup-offsite.sh"));
      const container = join(root, "container");
      const remote = join(root, "remote");
      mkdirSync(container);
      mkdirSync(remote);
      for (const name of options.onRemote ?? []) writeFileSync(join(remote, name), "old");
      writeFileSync(join(container, "sigillo-20261001T100000Z.db"), "older copy");
      if (options.settings !== undefined) writeOffsiteSettings(container, options.settings);
      if (options.lastSuccess !== undefined) {
        writeFileSync(
          join(container, STATUS_FILE),
          `{"checked":${options.lastSuccess},"drive":true,"last_success":${options.lastSuccess},"last_failure":null}\n`,
        );
      }
      const bin = join(root, "bin");
      mkdirSync(bin);
      // `docker compose exec -T server <command>` runs <command> here, with
      // the volume's path pointing at the stand-in directory.
      writeFileSync(
        join(bin, "docker"),
        `#!/bin/bash\n` +
          `shift 4\n` +
          `args=(); for a in "$@"; do args+=("\${a//\\/var\\/lib\\/sigillo-backups/${container}}"); done\n` +
          `case "\${args[0]}" in\n` +
          `/app/backup.sh) printf 'newest copy' > "${container}/sigillo-20261003T120000Z.db"; touch -d '+1 minute' "${container}/sigillo-20261003T120000Z.db" ;;\n` +
          `cat) ${options.streamFails ? `[ "\${args[1]##*.}" = db ] && { head -c 4 "\${args[1]}"; exit 1; }; ` : ""}exec "\${args[@]}" ;;\n` +
          `*) exec "\${args[@]}" ;;\n` +
          `esac\n`,
        { mode: 0o755 },
      );
      writeFileSync(
        join(bin, "rclone"),
        `#!/bin/bash\n` +
          `path() { echo "${remote}/\${1#*:}"; }\n` +
          `case "$1" in\n` +
          `listremotes) ${options.configured ? "echo sigillo-backup:" : "true"} ;;\n` +
          `lsf) ls -1 "${remote}" | grep '^sigillo-.*\\.db\\.gz$' ;;\n` +
          `rcat) cat > "$(path "$2")" ;;\n` +
          `deletefile) rm "$(path "$2")" ;;\n` +
          `*) exit 2 ;;\n` +
          `esac\n`,
        { mode: 0o755 },
      );
      const result = spawnSync("/bin/bash", [join(root, "deploy", "backup-offsite.sh")], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          ...(options.keepDays === undefined ? {} : { SIGILLO_OFFSITE_KEEP_DAYS: String(options.keepDays) }),
        },
      });
      const remoteFiles = readdirSync(remote).sort();
      const newestName = "sigillo-20261003T120000Z.db.gz";
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        remote: remoteFiles,
        uploaded: remoteFiles.includes(newestName) ? readFileSync(join(remote, newestName)) : undefined,
        newest: readFileSync(join(container, "sigillo-20261003T120000Z.db")),
        reported: readOffsiteStatus(container),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("still makes the local backup, and says so, when no remote is configured", () => {
    const { status, stdout, newest, remote, reported } = runOffsite({ configured: false });
    expect(status).toBe(0);
    expect(newest.toString()).toBe("newest copy");
    expect(stdout).toContain("off-site copy: not configured");
    expect(remote).toEqual([]);
    expect(reported).toMatchObject({ drive: false, lastSuccess: null, lastFailure: null });
    expect(Math.abs((reported?.checked ?? 0) - NOW)).toBeLessThan(60);
  });

  it("uploads the newest copy, compressed, and reports it as Impostazioni reads it", () => {
    const { status, remote, uploaded, stdout, reported } = runOffsite({ configured: true });
    expect(status).toBe(0);
    expect(remote).toEqual(["sigillo-20261003T120000Z.db.gz"]);
    expect(execFileSync("gzip", ["-dc"], { input: uploaded ?? Buffer.alloc(0) }).toString()).toBe("newest copy");
    expect(stdout).toContain("off-site copies in sigillo-backup:: 1");
    expect(reported?.drive).toBe(true);
    expect(reported?.lastSuccess).toBe(reported?.checked);
    expect(reported?.lastFailure).toBeNull();
  });

  it("makes no copy when Impostazioni turned it off, and still reports that it ran", () => {
    const { status, remote, stdout, reported, newest } = runOffsite({
      configured: true,
      settings: { enabled: false, everyHours: 1 },
    });
    expect(status).toBe(0);
    expect(newest.toString()).toBe("newest copy");
    expect(remote).toEqual([]);
    expect(stdout).toContain("turned off in Impostazioni");
    expect(reported).toMatchObject({ drive: true, lastSuccess: null });
  });

  it("waits for the frequency chosen, counting from the last copy that succeeded", () => {
    const early = runOffsite({ configured: true, settings: { enabled: true, everyHours: 6 }, lastSuccess: NOW - 5 * 3600 });
    expect(early.status).toBe(0);
    expect(early.remote).toEqual([]);
    expect(early.reported?.lastSuccess).toBe(NOW - 5 * 3600);
    const due = runOffsite({ configured: true, settings: { enabled: true, everyHours: 6 }, lastSuccess: NOW - 6 * 3600 + 300 });
    expect(due.status).toBe(0);
    expect(due.remote).toEqual(["sigillo-20261003T120000Z.db.gz"]);
  });

  it("keeps the newest copy of each day, for the newest days asked", () => {
    const { status, remote } = runOffsite({
      configured: true,
      keepDays: 3,
      onRemote: [
        "sigillo-20261003T080000Z.db.gz",
        "sigillo-20261002T230000Z.db.gz",
        "sigillo-20261002T220000Z.db.gz",
        "sigillo-20260920T100000Z.db.gz",
        "sigillo-20260901T100000Z.db.gz",
      ],
    });
    expect(status).toBe(0);
    expect(remote).toEqual([
      "sigillo-20260920T100000Z.db.gz",
      "sigillo-20261002T230000Z.db.gz",
      "sigillo-20261003T120000Z.db.gz",
    ]);
  });

  it("fails, removes what it uploaded and reports the failure, when the copy cannot be read whole", () => {
    const failed = runOffsite({ configured: true, streamFails: true, onRemote: ["sigillo-20261002T230000Z.db.gz"] });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("off-site copy: upload of sigillo-20261003T120000Z.db.gz");
    expect(failed.remote).toEqual(["sigillo-20261002T230000Z.db.gz"]);
    expect(failed.reported?.lastFailure).toBe(failed.reported?.checked);
    expect(failed.reported?.lastSuccess).toBeNull();
  });
});
