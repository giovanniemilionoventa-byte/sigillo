import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real RFC 3161 timestamp authority, on this machine, made with openssl: a
 * CA, a TSA certificate issued by it with the timeStamping purpose, and
 * `openssl ts -reply` to answer requests. Nothing is mocked: its tokens are
 * genuine RFC 3161 responses that `openssl ts -verify` checks against the CA,
 * exactly as it checks FreeTSA's. It only saves the tests the network.
 */

const CONFIG = `
[ req ]
distinguished_name = dn
prompt = no
[ dn ]
CN = sigillo test TSA
[ ca_ext ]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
[ tsa_ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,nonRepudiation
extendedKeyUsage = critical,timeStamping
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[ tsa ]
default_tsa = tsa_config
[ tsa_config ]
serial = SERIAL_FILE
crypto_device = builtin
signer_digest = sha256
default_policy = 1.2.3.4.1
digests = sha256
accuracy = secs:1
ordering = no
tsa_name = no
ess_cert_id_chain = no
ess_cert_id_alg = sha256
`;

export interface LocalTsa {
  /** The CA certificate, for `sigillo-verify --tsa-ca`. */
  caFile: string;
  /** A DER TimeStampResp over the 32-byte digest given in hex, as a TSA returns it. */
  stamp(digestHex: string): Buffer;
  /**
   * Serves RFC 3161 over HTTP on 127.0.0.1, as an authority does: a POST of a
   * TimeStampReq, answered with a TimeStampResp. Resolves to its URL.
   */
  listen(): Promise<string>;
  close(): void;
}

export function createLocalTsa(): LocalTsa {
  const directory = mkdtempSync(join(tmpdir(), "sigillo-tsa-"));
  const path = (name: string): string => join(directory, name);
  const quiet = { stdio: "pipe" as const };

  writeFileSync(path("tsa.cnf"), CONFIG.replace("SERIAL_FILE", path("serial")));
  writeFileSync(path("serial"), "01\n");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path("ca.key"), "-out", path("ca.crt"),
      "-days", "3650", "-subj", "/CN=sigillo test CA", "-config", path("tsa.cnf"), "-extensions", "ca_ext"],
    quiet,
  );
  execFileSync(
    "openssl",
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", path("tsa.key"), "-out", path("tsa.csr"),
      "-subj", "/CN=sigillo test TSA", "-config", path("tsa.cnf")],
    quiet,
  );
  execFileSync(
    "openssl",
    ["x509", "-req", "-in", path("tsa.csr"), "-CA", path("ca.crt"), "-CAkey", path("ca.key"),
      "-CAcreateserial", "-out", path("tsa.crt"), "-days", "3650",
      "-extfile", path("tsa.cnf"), "-extensions", "tsa_ext"],
    quiet,
  );

  let requests = 0;
  const reply = (query: Buffer): Buffer => {
    requests += 1;
    const queryFile = path(`http${requests}.tsq`);
    const replyFile = path(`http${requests}.tsr`);
    writeFileSync(queryFile, query);
    execFileSync(
      "openssl",
      ["ts", "-reply", "-config", path("tsa.cnf"), "-queryfile", queryFile, "-signer", path("tsa.crt"),
        "-inkey", path("tsa.key"), "-out", replyFile],
      quiet,
    );
    return readFileSync(replyFile);
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method !== "POST" || request.headers["content-type"] !== "application/timestamp-query") {
        response.writeHead(400).end();
        return;
      }
      try {
        const body = reply(Buffer.concat(chunks));
        response.writeHead(200, { "content-type": "application/timestamp-reply" }).end(body);
      } catch {
        response.writeHead(500).end();
      }
    });
  });
  return {
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(`http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/tsr`);
        });
      }),
    caFile: path("ca.crt"),
    stamp(digestHex: string): Buffer {
      requests += 1;
      const query = path(`q${requests}.tsq`);
      const reply = path(`r${requests}.tsr`);
      execFileSync("openssl", ["ts", "-query", "-sha256", "-digest", digestHex, "-cert", "-no_nonce", "-out", query], quiet);
      execFileSync(
        "openssl",
        ["ts", "-reply", "-config", path("tsa.cnf"), "-queryfile", query, "-signer", path("tsa.crt"),
          "-inkey", path("tsa.key"), "-out", reply],
        quiet,
      );
      return readFileSync(reply);
    },
    close(): void {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
