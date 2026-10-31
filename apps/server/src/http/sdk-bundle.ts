import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * The TypeScript SDK as an npm package, built from this installation at the
 * moment it is asked for, so what the console tells an agent to install is
 * the very code this server was built with. `npm install <this address>`
 * installs it: a tarball address is something npm takes as it is, which a
 * subdirectory of a repository is not. No registry, no account.
 */

export const SDK_TGZ_NAME = "sigillo-sdk.tgz";

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100, "ascii"); // mode
  header.write("0000000\0", 108, "ascii"); // uid
  header.write("0000000\0", 116, "ascii"); // gid
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii"); // mtime: fixed, so the same code is the same bytes
  header.write("        ", 148, "ascii"); // checksum, counted as spaces
  header.write("0", 156, "ascii"); // a regular file
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/** A gzip-compressed tar of `files` (name to bytes), in name order. */
export function tarGz(files: Map<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const name of [...files.keys()].sort()) {
    const data = files.get(name) as Buffer;
    parts.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

let cached: { tgz: Buffer } | undefined;

/** The directory of the installed `@sigillo/sdk`, found from this file. */
function sdkDirectory(): string {
  return dirname(createRequire(import.meta.url).resolve("@sigillo/sdk/package.json"));
}

export function sdkTarball(): { tgz: Buffer } {
  if (cached !== undefined) return cached;
  const directory = sdkDirectory();
  const source = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as Record<string, unknown>;
  // What npm needs to install it: no scripts, no workspace-only fields.
  const manifest = {
    name: source["name"],
    version: source["version"],
    type: "module",
    description: source["description"],
    exports: source["exports"],
    engines: { node: ">=22" },
  };
  const files = new Map<string, Buffer>([["package/package.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)]]);
  for (const name of readdirSync(join(directory, "dist"))) {
    if (name.endsWith(".map")) continue;
    files.set(`package/dist/${name}`, readFileSync(join(directory, "dist", name)));
  }
  const readme = join(directory, "README.md");
  files.set("package/README.md", readFileSync(readme));
  cached = { tgz: tarGz(files) };
  return cached;
}
