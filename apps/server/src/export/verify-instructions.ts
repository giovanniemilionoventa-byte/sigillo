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
  /** The time each token attests (genTime), by the token's file name, where it could be read. */
  genTimes: ReadonlyMap<string, string> = new Map(),
  /** The system's label in the web view at export time, if it had one: see ArchiveInput. */
  displayName?: string,
): string {
  const key = manifest.keys[0];
  const anchored = checkpoints.filter((entry) => entry.timestamps.length > 0);
  const firstToken = anchored[0]?.timestamps[0];
  const firstRoot = anchored[0]?.checkpoint.root_hash;
  const firstGenTime = firstToken === undefined ? undefined : genTimes.get(firstToken.file);

  return `# How to verify this file

This archive is a record of the actions of the AI system \`${manifest.system_id}\`,
covering positions ${manifest.range.from_seq} to ${manifest.range.to_seq} of its chain
(${manifest.counts.receipts} receipts), exported on ${manifest.exported_at}.
${
  displayName === undefined
    ? ""
    : `
When this file was exported, the operator's web view showed this system as
"${displayName}". That name is a label, not part of the signed record, and it
may have changed since: the system is identified by \`${manifest.system_id}\`.
`
}
Every claim in \`report.pdf\` can be rechecked from the files beside it. Two
things cannot come from the archive itself, because whoever made the archive
also made everything in it, and you need them from elsewhere (see "What this
proves, and what it does not" below): **the identifier of the operator's signing
key**, and, if you have one, **an export of the same chain you received earlier**.

## What is in the archive

| file | what it is |
|---|---|
| \`receipts.jsonl\` | one receipt per line, in RFC 8785 canonical form, ordered by position |
| \`checkpoints.jsonl\` | each signed checkpoint, its inclusion proofs, and the timestamp tokens anchoring it |
| \`artifacts-index.jsonl\` | one line per document fingerprint a receipt names, pointing back at it |
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

The keys are published in \`manifest.json\`, inside the archive. An archive
fabricated from scratch would carry the forger's key there, and verify. Ask the
operator for the identifier of their signing key through a channel that does
not pass through this archive (a contract, a signed letter, their website), and
give it to the verifier, which then refuses any signature by another key:

\`\`\`sh
sigillo-verify <this archive> --key-id ${key?.key_id ?? "<the operator's key_id>"}
\`\`\`

If you received an export of this chain before, give that too. The verifier
then requires this one to contain it unchanged and to reach at least as far:
receipts cut from the end, or history rewritten since, are caught this way and
in no other.

\`\`\`sh
sigillo-verify <this archive> --previous <the earlier archive>
\`\`\`

## Checking whether a specific document was used

If a receipt names a document — a curriculum, a reply — the archive can tell
you whether a file you have is the exact one, without a server:

\`\`\`sh
sigillo-verify doc <this archive> <the file>
\`\`\`

It verifies the whole archive first, then hashes the file with SHA-256 and
looks for that digest in \`artifacts-index.jsonl\`. Changing even one character
of the file changes its digest, so no near match is possible: it is either
exactly the file that was used, or the tool reports no match at all.

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

The token was issued by \`${firstToken.tsa_url}\`. ${
        firstGenTime === undefined
          ? "Its attested time is"
          : `The authority dates it ${firstGenTime}: that is`
      } the \`Time stamp\` line of the output above, and it is the evidence of when this
checkpoint existed. (The server received the token at ${firstToken.obtained_at}, by
its own clock.) Obtain the authority's certificate from the authority itself,
not from this archive.`
}

## What this proves, and what it does not

It proves that the receipts covered by a timestamped checkpoint existed, in
this order, no later than the time the authority attests, signed by the key in
the manifest. A change to any receipt, a receipt removed from the middle, two
receipts swapped or one repeated, breaks a hash, a signature or the sequence,
and the verifier says where.

It does not prove, on its own:

- **that the key is the operator's.** A wholly fabricated archive, signed with
  a new key and published in its own manifest, verifies. Check the key's
  identifier with \`--key-id\`, as above.
- **that nothing was cut from the end.** Removing the last receipts (and the
  checkpoints over them) and adjusting the manifest leaves a shorter chain that
  is still valid. Compare with an earlier export with \`--previous\`, or check
  that the last checkpoint's attested time is recent enough.
- **that receipts after the last timestamp are untouched.** Until a checkpoint
  over them is timestamped, whoever controls the server can rewrite them, and
  have them signed.
- **that everything the system did was recorded.** That depends on the
  instrumentation of the system itself, which is outside what any log format
  can attest. If a record is missing, this file cannot tell you.
`;
}
