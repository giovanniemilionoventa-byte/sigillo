import type { CheckpointEntry, Manifest } from "@sigillo/core";

/**
 * VERIFY.md, written into every archive.
 *
 * It is addressed to someone who has the file and no reason to trust whoever
 * gave it to them, and it is deliberately self-contained: the second half shows
 * how to check a receipt and a timestamp with nothing but a shell.
 */
export function verifyInstructions(
  manifest: Manifest,
  checkpoints: readonly CheckpointEntry[],
): string {
  const key = manifest.keys[0];
  const anchored = checkpoints.filter((entry) => entry.timestamps.length > 0);
  const firstToken = anchored[0]?.timestamps[0];
  const firstRoot = anchored[0]?.checkpoint.root_hash;

  return `# How to verify this file

This archive is a record of the actions of the AI system \`${manifest.system_id}\`,
covering positions ${manifest.range.from_seq} to ${manifest.range.to_seq} of its chain
(${manifest.counts.receipts} receipts), exported on ${manifest.exported_at}.

Nothing here asks you to trust the system that produced it. Every claim in
\`report.pdf\` can be rechecked from the files beside it.

## What is in the archive

| file | what it is |
|---|---|
| \`receipts.jsonl\` | one receipt per line, in RFC 8785 canonical form, ordered by position |
| \`checkpoints.jsonl\` | each signed checkpoint, its inclusion proofs, and the timestamp tokens anchoring it |
| \`timestamps/\` | the RFC 3161 tokens, byte for byte as the authority returned them |
| \`manifest.json\` | the public keys, the range and the counts this archive claims |
| \`report.pdf\` | the same facts written for a reader |
| \`VERIFY.md\` | this file |

A receipt holds no prompt, no tool argument and no model output. Where content
existed, the receipt carries its SHA-256 digest and nothing else.

## The quick way

\`\`\`sh
sigillo-verify <this archive>
\`\`\`

\`sigillo-verify\` is open source and reads only the format described in
\`docs/FORMAT.md\`. It exits non-zero and names the first thing that fails.

It checks, in order: the manifest is well formed and each published key really
has the identifier it is published under; every line is a valid receipt;
positions run without gap, repeat or reordering; every \`prev_hash\` is the
recomputed hash of the receipt before it; every signature verifies under a
published key; every checkpoint is signed; every Merkle root is rebuilt from
these receipts; every inclusion proof rebuilds its checkpoint's root.

To check the timestamp tokens' signatures as well, give it the authority's
certificate:

\`\`\`sh
sigillo-verify <this archive> --tsa-ca <authority-ca>.pem
\`\`\`

Without it, the tokens are checked only for the digest they carry, and the tool
says so rather than reporting a pass.

## Checking a receipt by hand

The hash of a receipt is the SHA-256 of its RFC 8785 canonical JSON **with the
\`sig\` member removed**. The signature is Ed25519 over those 32 raw bytes.

Take the first line of \`receipts.jsonl\`, drop \`"sig":"..."\`, and:

\`\`\`sh
printf '%s' '<the receipt without its sig member>' | openssl dgst -sha256
\`\`\`

That digest must appear as \`prev_hash\` in the next line. Repeating this down
the file is the whole chain argument: changing any receipt changes its hash, and
the next receipt no longer points at it.

The signing key${manifest.keys.length === 1 ? " is" : "s are"}:

\`\`\`
${manifest.keys.map((entry) => `${entry.key_id}  ${entry.public_key_base64}`).join("\n")}
\`\`\`

Each is the raw 32 bytes of an Ed25519 public key, base64. The identifier is the
first 16 hex characters of the SHA-256 of those bytes${
    key === undefined
      ? ""
      : `, which you can confirm:

\`\`\`sh
printf '%s' '${key.public_key_base64}' | base64 -d | openssl dgst -sha256
\`\`\`

The first 16 characters of that digest must be \`${key.key_id}\`.`
  }

## Checking a timestamp by hand

${
  firstToken === undefined || firstRoot === undefined
    ? "This archive carries no timestamp tokens, so nothing anchors it to an external clock. " +
      "The chain and the signatures still hold, but the times in it are only the server's own."
    : `Each token in \`timestamps/\` was issued over the Merkle root of one checkpoint.
For \`${firstToken.file}\`, that root is:

\`\`\`
${firstRoot}
\`\`\`

To read what the authority attested:

\`\`\`sh
openssl ts -reply -in ${firstToken.file} -text
\`\`\`

The \`Message data\` in the output must be those 32 bytes, and the status must be
\`Granted\`. To check the authority's signature too, fetch its certificate and:

\`\`\`sh
openssl ts -verify -digest ${firstRoot} \\
  -in ${firstToken.file} -CAfile <authority-ca>.pem
\`\`\`

The token was issued by \`${firstToken.tsa_url}\`, at ${firstToken.obtained_at}.
Obtain that authority's certificate from the authority itself, not from this
archive.`
}

## What this proves, and what it does not

It proves that these receipts existed in this order at the times attested, and
that none of them has been altered since. Any change to any of them, any
removal, any reordering, breaks a hash or a signature and the verifier says
where.

It does not prove that everything the system did was recorded. That depends on
the instrumentation of the system itself, which is outside what any log format
can attest. If a record is missing, this file cannot tell you.
`;
}
