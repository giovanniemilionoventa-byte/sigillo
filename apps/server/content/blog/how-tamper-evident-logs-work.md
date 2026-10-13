---
title: How tamper-evident logs work: hash chains, signatures and trusted time
description: A plain-language tour of the building blocks behind logs that show when they have been changed, and an honest list of what they still cannot tell you.
date: 2026-10-13
related: why-ordinary-logs-are-not-evidence, when-your-logging-goes-silent, keeping-sensitive-content-out-of-logs
---
Ordinary logs can be edited without a trace. Tamper-evident logs cannot: if someone changes them, the change shows. The ideas behind this are a few decades old, they are used in places as different as certificate transparency, version control and blockchains, and a developer can understand all of them in one sitting. Here they are, one at a time.

## 1. A hash fingerprints a record

A cryptographic hash function such as SHA-256 turns any input into a short fixed-size string. The same input always gives the same string. Change one character and the output is completely different. You cannot work backwards from the string to the input.

So a hash is a fingerprint. If you remember the fingerprint of a record, you can tell later whether the record is still the same.

One practical detail: the bytes you hash must be exactly the same every time. JSON can say the same thing in many byte sequences (key order, spacing, number formats). A **canonical form**, such as the one in RFC 8785 for JSON, fixes that, so that two programs hashing the same record agree.

## 2. A chain makes each record vouch for the one before

Put the hash of the previous record inside the next one, and hash the result. Now every record depends on all earlier ones. This is the structure Git uses for commits.

Change record 5 and its hash changes, so record 6 (which contains the old hash) no longer matches, and so on to the end. To hide an edit, the attacker must recompute everything after it. Delete a record and the numbering and the links break in the same way.

A chain alone has a weakness. Whoever controls the whole file can simply recompute all the hashes after their edit. A chain shows damage only to someone who already knows the last hash.

## 3. A signature says who wrote it

If each record's hash is signed with a private key (Ed25519 is a common, fast choice), then recomputing the chain is not enough: the attacker would also need the key. Anyone with the public key can check the signatures.

Where the key lives is the important question. If the same process that writes the logs holds the key, whoever takes over that process can sign whatever they like going forward. A common design keeps the key in a separate small process that signs only the next record of a chain, and remembers where each chain ends. Then even a compromised application cannot get a second signature at a position that has already been signed. It can still add new false entries at the end, because the signer cannot tell a true event from a made-up one. It cannot rewrite history.

## 4. A Merkle tree summarises many records in one hash

Checking a million records one by one is slow. A Merkle tree (the structure in RFC 6962, used by certificate transparency) hashes records in pairs, then hashes the pairs, until one **root** hash remains. The root commits to every record. And to prove that a particular record is in the tree you need only about log2(n) hashes, not all of them.

## 5. A trusted timestamp fixes it in time

Signatures show *who* and *what*, but a clock you control proves nothing about *when*. A timestamp authority following RFC 3161 takes a hash you send, adds the time, and signs it. You publish only the hash, so nothing confidential leaves your systems. The result is a token anyone can check offline, saying: this hash existed no later than this time.

Do it for the Merkle root at regular intervals, and every record under it has a time that someone other than you vouches for. If you need a legal weight, check whether the authority is *qualified* under the EU's eIDAS regulation, since many free ones are not.

## 6. Anyone can check it, with software they can read

The point of all this is that a third party can verify without trusting you. For that the checker should be small, open and independent of the system that wrote the log. An auditor who has to run your code to verify your log has not gained much.

## What these logs still cannot tell you

This part matters as much as the rest.

- **They show what was recorded, not that it was true.** If the writer lies, the lie is signed.
- **They show nothing about what was never recorded.** An event that did not reach the log leaves no gap you can see, unless you design for it. We look at that in [when your logging goes silent](/blog/when-your-logging-goes-silent).
- **A single export can be cut short.** Remove the last records and their seals, and what remains is a valid, shorter log. Comparing against an earlier copy catches it.
- **The time between two timestamps is the writer's clock.** Only the timestamps themselves are vouched for.
- **Confidential content needs separate care.** If the records contain secrets, hashing the log does not protect them. See [keeping sensitive content out of logs](/blog/keeping-sensitive-content-out-of-logs).

Used for exactly what it does, a tamper-evident log is a strong, narrow claim: these records, in this order, unchanged, no later than this time. For the case for needing one at all, see [why ordinary logs are not evidence](/blog/why-ordinary-logs-are-not-evidence).
