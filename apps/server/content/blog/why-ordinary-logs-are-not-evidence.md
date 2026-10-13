---
title: Why ordinary logs are not evidence
description: Your application logs are useful for debugging. Here is why they fall short the day someone has to rely on them.
date: 2026-10-13
related: how-tamper-evident-logs-work, when-your-logging-goes-silent, what-the-ai-act-asks-about-agent-logs
---
Every system has logs. Most teams trust them, and for debugging that is fine. The trouble starts when a log has to do a different job: settle an argument.

Imagine the argument. A customer says your agent approved a refund and then went back on it. Your agent says it never approved anything. Someone opens the log and finds no approval. Now the question is not "what happened?" It is "why should anyone believe this log?"

## A log is a file somebody can edit

An ordinary log is lines in a file or rows in a table. Whoever can write to it can also change it. That includes the engineer on call, the person with admin rights on the database, anyone who got hold of those credentials, and a script that "cleans up" old entries.

Most of the time nobody does anything wrong. That is not the point. The point is that from the outside, an untouched log and a carefully edited one look exactly the same. If the log is the only evidence, you are asking the other side to take your word for it.

## Three ways a log can fail you

**It can be changed.** A line can be rewritten, or deleted, and nothing remains to show it. Backups help only if someone compares them, and they have the same problem one level up.

**It can be incomplete without anyone noticing.** If the process that writes the log crashes, or the logging code is removed, the log does not say "I stopped". It just ends. A quiet log looks like a quiet system. We go into this one in [when an AI agent goes quiet](/blog/when-your-logging-goes-silent).

**The time can be wrong.** The timestamp in a log line comes from a clock that someone controls. If the whole question is "before or after the customer complained", a time you wrote yourself is a weak answer.

## What evidence needs that a log does not

A third party should be able to check the record without relying on the person who kept it. For that you need a few things together:

1. Each entry is **signed**, so that changing it breaks the signature.
2. Entries are **linked** to each other, so that removing or reordering one breaks everything after it.
3. Something outside your own systems vouches for **when**, such as a trusted timestamp.
4. The checking can be done by **someone else, with software they can read**.

None of this is new cryptography. Signatures, hash chains and trusted timestamps have been around for years. What is new is applying them to what AI agents do, where the volume is high and the actions can have real consequences.

## What this still does not give you

Be careful with the word "proof". A signed record shows that these entries were written in this order and have not been changed since. It does not show that the agent told the truth about what it did, and it does not show that every action was recorded. A signed log of a badly instrumented agent is still a log of a badly instrumented agent.

The building blocks and their limits are in [how tamper-evident logs work](/blog/how-tamper-evident-logs-work). A scheme that states what it cannot do is easier to trust than one that does not.

## When you need this

If nobody will ever argue with your logs, keep your logs. If an auditor, a customer, a regulator or a court might one day ask "can you show me?", it is worth deciding now, while it is cheap, how you will answer. The [AI Act's rules on records](/blog/what-the-ai-act-asks-about-agent-logs) are one reason to ask. A customer who disagrees with you is another.
