---
title: What the AI Act actually asks of your AI agent's logs
description: Article 12 gets quoted a lot and read rarely. Here is what it says, who it applies to, and what it leaves open.
date: 2026-10-13
related: why-ordinary-logs-are-not-evidence, how-tamper-evident-logs-work, keeping-sensitive-content-out-of-logs
---
If you build or run AI agents in Europe, someone has probably told you that the AI Act "requires logs". That is half true, and the half that is missing matters. Before you spend money on anything, it is worth knowing which half applies to you.

This is a plain reading of the text, not legal advice. If a lot depends on it, ask a lawyer who works with the regulation (Regulation (EU) 2024/1689).

## It applies to high-risk systems, not to every agent

The record-keeping rules sit in the chapter about **high-risk AI systems**. A system is high-risk if it falls under one of the lists in the Act: certain safety components of regulated products, and the uses named in Annex III. Those include things like recruitment and worker management, deciding who gets a loan or an insurance price, access to education, and some uses in law enforcement, migration and the administration of justice.

A support chatbot that answers questions about opening hours is, in general, not on that list. An agent that screens CVs or helps decide on credit very likely is. Most of the work is in that first question, and no logging tool can answer it for you.

If your agent is not high-risk, the Act does not oblige you to keep these logs. You may still want them for your own reasons: a customer dispute, an incident review, an auditor who asks. But it is a different conversation.

## What Article 12 says

Article 12 is short. A high-risk system must **technically allow for the automatic recording of events (logs) over its lifetime**. The logs have to make it possible to spot situations that could present a risk or lead to a substantial modification, to support monitoring after the system is on the market, and to let the people running it keep an eye on how it behaves.

Notice what is there and what is not. It says *automatic*, so a person writing notes afterwards does not count. It says *over the lifetime*, so a log that starts in the second month is a problem. It does not say which fields to record, which format to use, or that the logs must be signed. The Act sets the goal and leaves the engineering to you.

## Who keeps them, and for how long

Two other articles do the practical work:

- **Providers** (the ones who build the system) keep the logs that the system generates automatically, to the extent those logs are under their control. The minimum is six months, unless other law says otherwise.
- **Deployers** (the companies that use the system) keep the logs too, again to the extent they control them, for a period that fits the purpose of the system, and at least six months. Data protection law can push that period in either direction.

"At least six months" is the number everyone remembers. The more useful sentence is "to the extent under their control". If your agent runs through a vendor's platform and you cannot get at the logs, the question of who should have kept them is a contract question you want settled before something goes wrong.

## Human oversight is the other half

Article 14 asks that a high-risk system be designed so that people can oversee it effectively while it is in use. Logs are not the same as oversight, but you cannot oversee what you cannot see afterwards. In practice a person reviewing a decision wants to know what the agent did, in what order, using which tools. That is a log read by a human, which is a different design target from a log read by a machine.

## And the dates?

The date from which the high-risk rules apply has moved. The AI Omnibus, Regulation (EU) 2026/1744, entered into force on 27 July 2026. It pushes the obligations for stand-alone Annex III systems (recruitment, credit and similar uses) from 2 August 2026 to **2 December 2027**, and for AI built into regulated products to **2 August 2028**. Other parts of the Act, such as the transparency duties of Article 50, were not delayed in the same way. Dates are the kind of detail that changes, so check the Official Journal before you plan around one.

## Where signed records fit in

The Act does not say "sign your logs". It says record events automatically and keep the records. So why bother with signatures?

Because a log you cannot trust is a weak answer to the question the regulation is really asking: can someone check afterwards what this system did? A log that anyone with database access can edit quietly is hard to defend. We wrote about that in [why ordinary logs are not evidence](/blog/why-ordinary-logs-are-not-evidence), and about how a log that shows tampering is built in [how tamper-evident logs work](/blog/how-tamper-evident-logs-work).

One more caution. Tamper-evident records do not make a system compliant. Compliance depends on what your AI does and how you use it. What a good record gives you is a solid piece of the evidence, and a way to show it has not been touched since.
