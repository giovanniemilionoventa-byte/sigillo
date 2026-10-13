---
title: Keeping sensitive content out of your logs: hashes, pseudonyms and their limits
description: You want a record of what happened. You do not want a second copy of every customer message. How to log the event without logging the content, and where that approach breaks.
date: 2026-10-13
related: how-tamper-evident-logs-work, personal-data-in-prompts-a-developers-guide, what-the-ai-act-asks-about-agent-logs
---
Logs have a way of becoming the least protected copy of your most sensitive data. A debugging line that prints the whole request, added in a hurry, ends up in a log aggregator that thirty people can search and that keeps everything for a year. Systems that handle conversations, such as chatbots and AI assistants, make it worse, because the content is the whole point.

The tension is real: the more complete the record, the more it contains. Here are the main techniques for logging *that* something happened without logging *what* was said, and the ways each one fails.

## Log the event, not the payload

Start with the simplest rule. For each action record the kind, the time, who or what did it, which resource, the outcome and an identifier you can use to look it up elsewhere. Leave the body out. In most incident reviews you need to know that a request happened and how it ended, and you can fetch the content from the system of record if you are allowed to.

## Fingerprints instead of content

When you do need to be able to say "this exact text went through here", store a hash of it. SHA-256 gives the same output for the same input and an unrelated output for any change, and it cannot be reversed.

That allows a useful check. If a customer disputes an email, you hash the email you hold and look for the hash in the log. A match shows that exact text passed through at that time. A single changed comma will not match. The log never contained the email.

## Where hashes fall short

- **Small input spaces can be guessed.** If a field can only be "yes" or "no", or a number from one to a hundred, an attacker can hash every possibility and look for a match. Hashing hides only values that cannot be enumerated. Use a keyed hash (HMAC) with a secret kept apart from the logs when the input space is small.
- **Short texts, names and ids are the same problem.** A hashed email address can be tested against a list of known addresses.
- **Metadata still talks.** Without any content, a log shows who did what, when and how often. For some uses that is already sensitive.
- **Legal status.** Whether hashes of personal data count as personal data depends on whether anyone can link them back to a person. Do not assume that hashing removes you from data protection law. Ask your DPO.

## Pseudonyms for people

Instead of the person's name or email, log a pseudonym: a random identifier, with the table that maps it to the real person stored elsewhere under tighter access. That separates the log, which many people read, from the identity, which few do.

It also helps with erasure. If someone asks to be forgotten, delete the mapping. The log entries remain, so the sequence of events is intact, but they no longer lead to the individual. This only works if the real identity never got into the log in the first place, which is why the rule about leaving content out comes first.

## Scrubbing is not a plan

Many teams rely on regexes that remove emails and card numbers before a line is written. It catches a lot, and it is worth having as a last layer. It will miss things (names, free-form addresses, a number someone typed into the wrong field). Do not make it the only protection.

## Control who can read

Logs deserve access control as much as the database does: limited access, an audit of who looked, and retention periods that are written down and enforced. A short retention for raw detail and a longer one for the events-only version is a common compromise.

## A working rule

Record what you need to be able to prove or investigate and nothing else. For most systems that is: what kind of action, by whom (as a pseudonym), when, the outcome, and a fingerprint of inputs and outputs where you will need to match them later. For how to make that record hard to alter, see [how tamper-evident logs work](/blog/how-tamper-evident-logs-work). For the legal side of sending personal data to a model, [personal data in prompts](/blog/personal-data-in-prompts-a-developers-guide).
