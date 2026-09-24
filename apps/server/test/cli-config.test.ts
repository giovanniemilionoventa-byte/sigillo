import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyFile, startSignerDaemon, type SignerDaemon } from "../../signer/src/index.js";
import { positiveInteger, readSecret, trustProxy } from "../src/config.js";

/**
 * How `sigillo-server serve` reads its configuration, run as the real CLI in
 * a process of its own, as an operator (or a container) would start it.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX = join(REPOSITORY_ROOT, "node_modules", ".bin", "tsx");
const SERVER_CLI = join(REPOSITORY_ROOT, "apps", "server", "src", "cli.ts");
const PASSWORD = "a password read from a file";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "sigillo-cli-config-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  output: string;
}

/** Runs `serve` until it exits, or until `until` shows up in its output (then stops it). */
function serve(env: Record<string, string>, until?: RegExp, whileRunning?: () => Promise<void>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [SERVER_CLI, "serve"], {
      cwd: REPOSITORY_ROOT,
      env: {
        PATH: process.env["PATH"] ?? "",
        SIGILLO_DB: join(directory, "sigillo.db"),
        SIGILLO_SIGNER_SOCKET: join(directory, "absent.sock"),
        ...env,
      },
      detached: true,
    });
    let output = "";
    let acting = false;
    const timer = setTimeout(() => {
      process.kill(-(child.pid ?? 0), "SIGKILL");
      reject(new Error(`serve did not finish: ${output}`));
    }, 45_000);
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (until !== undefined && !acting && until.test(output)) {
        acting = true;
        void (whileRunning ?? (async () => undefined))().then(
          () => process.kill(-(child.pid ?? 0), "SIGTERM"),
          (error: unknown) => {
            process.kill(-(child.pid ?? 0), "SIGKILL");
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

describe("numeric settings", () => {
  // Review point 16: SIGILLO_CHECKPOINT_MINUTES=abc became NaN, and Node runs
  // setInterval(NaN) every millisecond.
  const cases: [string, string][] = [
    ["SIGILLO_CHECKPOINT_MINUTES", "abc"],
    ["SIGILLO_CHECKPOINT_MINUTES", "0"],
    ["SIGILLO_STALE_AFTER_MINUTES", "-5"],
    ["SIGILLO_PORT", "99999"],
    ["SIGILLO_PORT", "80a"],
    ["SIGILLO_LOGIN_MAX_FAILURES", "0"],
    ["SIGILLO_INGEST_MAX_FAILURES", "lots"],
  ];

  it.each(cases)("refuses %s=%s before doing anything, and names the variable", async (name, value) => {
    const run = await serve({ [name]: value });
    expect(run.code).toBe(1);
    expect(run.output).toContain(name);
    expect(run.output).not.toContain("cannot reach the signer");
  }, 60_000);

  it("accepts plain whole numbers and refuses anything else", () => {
    expect(positiveInteger("X", "15", 1)).toBe(15);
    expect(positiveInteger("X", undefined, 7)).toBe(7);
    for (const bad of ["", "1.5", "1e2", "0x10", " 1", "Infinity", "NaN", "9007199254740993"]) {
      expect(() => positiveInteger("X", bad, 1), bad).toThrow(/X/);
    }
  });
});

describe("the proxy to trust", () => {
  it("takes addresses, and refuses what would trust every client", () => {
    expect(trustProxy(undefined)).toBe(false);
    expect(trustProxy("uniquelocal")).toBe("uniquelocal");
    expect(trustProxy("10.0.0.0/8, 127.0.0.1")).toBe("10.0.0.0/8, 127.0.0.1");
    for (const bad of ["true", "1", "2"]) expect(() => trustProxy(bad)).toThrow(/SIGILLO_TRUST_PROXY/);
  });

  it("stops serve with a bad value", async () => {
    const run = await serve({ SIGILLO_TRUST_PROXY: "true" });
    expect(run.code).toBe(1);
    expect(run.output).toContain("SIGILLO_TRUST_PROXY");
  }, 60_000);
});

describe("secrets read from a file", () => {
  it("reads the value, without the trailing newline an editor leaves", () => {
    const file = join(directory, "secret");
    writeFileSync(file, `${PASSWORD}\n`);
    expect(readSecret({ SIGILLO_ADMIN_PASSWORD_FILE: file }, "SIGILLO_ADMIN_PASSWORD")).toBe(PASSWORD);
    writeFileSync(file, `${PASSWORD}\r\n`);
    expect(readSecret({ SIGILLO_ADMIN_PASSWORD_FILE: file }, "SIGILLO_ADMIN_PASSWORD")).toBe(PASSWORD);
    expect(readSecret({ SIGILLO_ADMIN_PASSWORD: "direct" }, "SIGILLO_ADMIN_PASSWORD")).toBe("direct");
    expect(readSecret({}, "SIGILLO_ADMIN_PASSWORD")).toBeUndefined();
  });

  it("refuses both forms at once, and a file it cannot read, without quoting either", () => {
    const file = join(directory, "secret");
    writeFileSync(file, PASSWORD);
    expect(() =>
      readSecret({ SIGILLO_ADMIN_PASSWORD_FILE: file, SIGILLO_ADMIN_PASSWORD: "other" }, "SIGILLO_ADMIN_PASSWORD"),
    ).toThrow(/SIGILLO_ADMIN_PASSWORD_FILE/);
    try {
      readSecret({ SIGILLO_ADMIN_PASSWORD_FILE: join(directory, "missing") }, "SIGILLO_ADMIN_PASSWORD");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("SIGILLO_ADMIN_PASSWORD_FILE");
      expect(String(error)).not.toContain(PASSWORD);
    }
  });

  it("opens the web view with the password from the file, and never prints it", async () => {
    const socketPath = join(directory, "signer.sock");
    const daemon: SignerDaemon = await startSignerDaemon({
      socketPath,
      key: generateKeyFile(join(directory, "signer.key")),
    });
    try {
      const passwordFile = join(directory, "admin_password");
      writeFileSync(passwordFile, `${PASSWORD}\n`, { mode: 0o600 });
      const port = await freePort();
      let status = 0;

      const run = await serve(
        {
          SIGILLO_SIGNER_SOCKET: socketPath,
          SIGILLO_PORT: String(port),
          SIGILLO_ADMIN_PASSWORD_FILE: passwordFile,
          SIGILLO_CHECKPOINT_MINUTES: "60",
        },
        /signing with key/,
        async () => {
          const response = await fetch(`http://127.0.0.1:${port}/ui/login`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: `password=${encodeURIComponent(PASSWORD)}`,
            redirect: "manual",
          });
          status = response.status;
        },
      );

      expect(status).toBe(302);
      expect(run.output).toContain("signing with key");
      expect(run.output).not.toContain(PASSWORD);
    } finally {
      await daemon.close();
    }
  }, 60_000);
});
