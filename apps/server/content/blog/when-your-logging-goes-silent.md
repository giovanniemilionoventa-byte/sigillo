---
title: When your logging goes silent, how would you know?
description: A log that stops looks the same as a system with nothing to do. Dead man's switches, heartbeats and other ways to make silence visible.
date: 2026-10-13
related: how-tamper-evident-logs-work, why-ordinary-logs-are-not-evidence
---
The most awkward hole in any log is not a changed line. It is a missing stretch of time.

The record shows nothing on Wednesday afternoon. Did nothing happen? Did the service crash? Did a deploy remove the logging code? From the log alone you cannot tell, because silence is just the absence of lines. Monitoring people know this as the "no data" problem, and it has a classic answer.

## Why it fails quietly

A recorder that lives inside the thing it records has a conflict of interest. If the application's own code sends the logs, then removing that code, crashing the process, filling the disk or losing the network all produce the same result: nothing arrives, and nothing says so.

The usual failure is boring, not malicious. A config change drops a log level. An exporter's queue overflows. A library upgrade renames a field and the pipeline discards what it cannot parse. Weeks later someone wants the data and it is not there.

## The dead man's switch

Train drivers once had a pedal that had to be held down. If the driver stopped holding it, the train braked. The same idea applies here: do not wait for an event that says "something is wrong", expect a signal that says "everything is fine" and treat its absence as the alarm.

In practice: the monitored component sends a small heartbeat at a fixed interval, and a separate watcher raises an alert if none arrives within a window (two or three intervals, so that a single lost packet does not wake anyone). The watcher must live outside the thing it watches, or it fails together with it. Tools like Prometheus (the `absent()` function, or alerting on `up == 0`), Healthchecks-style ping URLs and cloud monitors all implement this.

## Make the gap itself a record

Alerting tells you now. For audits you also want the gap to be on the record afterwards. If the watcher writes an entry of its own ("no heartbeat since 14:07"), dated at the last signal it heard, then the missing stretch has a start time written down by someone other than the component that went quiet. If that log is tamper-evident (see [how tamper-evident logs work](/blog/how-tamper-evident-logs-work)), nobody can quietly delete the entry later either.

## What a heartbeat does not tell you

Be careful about what you conclude from a good heartbeat.

- **It says the sender is alive, not that it is recording.** A process can keep sending heartbeats while its logging is broken. Where it matters, send a heartbeat from the same code path as the real events, and have the watcher check that counts of events look plausible.
- **It says that a gap exists and since when, not why.** A crash, a deployment and a network cut look alike.
- **It says nothing about what happened in the gap.** The service may have been busy the whole time.
- **A hostile component can fake it.** If someone who controls the sender wants to hide a gap, a hand-sent heartbeat defeats a heartbeat. Heartbeats defend against accidents and honest mistakes much better than against someone with the same access as the sender.

## Other cheap checks that help

- **Expected volume.** Alert when events per hour fall far below the usual for that hour and day.
- **Sequence numbers.** Number the records per source. A gap in the numbers is a loss you can see, even when the source is still running.
- **Synthetic events.** Generate a known test event every few minutes and check it arrives end to end.
- **Reconcile with a second source.** Compare your logs with the payment provider's, the load balancer's or the customer's own record. Where two sources disagree, you have found something.

## The honest framing

If someone says their logs are complete, ask how they know. A log can show that what it holds is unchanged. Whether it holds everything depends on the pipeline that feeds it, which is a separate property and needs its own checks. The cheapest improvement is the one above: make silence loud, and put the alarm outside the thing that might fail. The wider case for evidence you do not have to take on trust is in [why ordinary logs are not evidence](/blog/why-ordinary-logs-are-not-evidence).
