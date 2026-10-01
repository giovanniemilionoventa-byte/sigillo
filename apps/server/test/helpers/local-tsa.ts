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
 *
 * `stampAt` issues a token dated whenever the test says, which an authority
 * never would: it is how the tests show a verifier what a late, early or
 * backdated anchor looks like. The token is still genuine RFC 3161, signed by
 * this authority's key and accepted by `openssl ts -verify`; only its TSTInfo
 * is written here instead of by `openssl ts -reply`, which always uses the
 * current time.
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
  /** The same, but dated `genTime` (whole seconds or milliseconds) rather than now. */
  stampAt(digestHex: string, genTime: Date | string): Buffer;
  /**
   * Serves RFC 3161 over HTTP on 127.0.0.1, as an authority does: a POST of a
   * TimeStampReq, answered with a TimeStampResp. Resolves to its URL. With a
   * clock, the tokens are dated by it (stampAt), so that a test whose server
   * runs on an injected clock gets an authority that agrees with it.
   */
  listen(clock?: () => Date): Promise<string>;
  close(): void;
}

/** DER, just enough of it to write a TSTInfo and wrap a TimeStampResp. */
function der(tag: number, ...body: Uint8Array[]): Buffer {
  const content = Buffer.concat(body);
  const n = content.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), content]);
}
function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const groups = [value & 0x7f];
    for (let left = value >> 7; left > 0; left >>= 7) groups.unshift((left & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
}
function generalizedTime(when: Date): Buffer {
  const iso = when.toISOString(); // 2026-03-29T15:00:05.250Z
  const whole = iso.slice(0, 19).replace(/[-T:]/g, "");
  const millis = iso.slice(20, 23).replace(/0+$/, "");
  return der(0x18, Buffer.from(`${whole}${millis === "" ? "" : `.${millis}`}Z`, "ascii"));
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
  let clock: (() => Date) | undefined;
  const reply = (query: Buffer): Buffer => {
    if (clock !== undefined) {
      const queryFile = path(`clocked${requests + 1}.tsq`);
      writeFileSync(queryFile, query);
      const text = execFileSync("openssl", ["ts", "-query", "-in", queryFile, "-text"], { encoding: "utf8" });
      const digest = [...text.matchAll(/^\s+[0-9a-f]{4} - ([0-9a-f -]+?)\s{2,}/gm)]
        .map((line) => (line[1] ?? "").replace(/[^0-9a-f]/g, ""))
        .join("");
      return stampAt(digest, clock());
    }
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
  function stampAt(digestHex: string, genTime: Date | string): Buffer {
    requests += 1;
    const tstInfo = der(
      0x30,
      der(0x02, Buffer.from([1])), // version
      oid("1.2.3.4.1"), // policy, as the configuration above
      der(0x30, der(0x30, oid("2.16.840.1.101.3.4.2.1"), Buffer.from([0x05, 0x00])), der(0x04, Buffer.from(digestHex, "hex"))),
      der(0x02, Buffer.from([0x40, requests & 0xff])), // serialNumber, positive and unique enough here
      generalizedTime(new Date(genTime)),
    );
    const infoFile = path(`at${requests}.der`);
    const tokenFile = path(`at${requests}.tok`);
    writeFileSync(infoFile, tstInfo);
    // id-smime-ct-TSTInfo as the content type; -cades adds the
    // signingCertificateV2 attribute that RFC 3161 (via RFC 5816) requires.
    execFileSync(
      "openssl",
      ["cms", "-sign", "-binary", "-nodetach", "-outform", "DER", "-in", infoFile,
        "-econtent_type", "1.2.840.113549.1.9.16.1.4", "-signer", path("tsa.crt"), "-inkey", path("tsa.key"),
        "-md", "sha256", "-cades", "-nosmimecap", "-out", tokenFile],
      quiet,
    );
    // TimeStampResp ::= SEQUENCE { status PKIStatusInfo (granted), timeStampToken }
    return der(0x30, der(0x30, der(0x02, Buffer.from([0]))), readFileSync(tokenFile));
  }

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
    listen: (withClock?: () => Date) =>
      new Promise((resolve) => {
        clock = withClock;
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
    stampAt,
    close(): void {
      server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
