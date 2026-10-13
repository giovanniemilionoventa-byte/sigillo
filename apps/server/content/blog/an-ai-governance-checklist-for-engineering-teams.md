---
title: An AI governance checklist for engineering teams
description: Governance sounds like paperwork. For a team shipping LLM features it comes down to a handful of questions you can answer in a day.
date: 2026-10-13
related: prompt-injection-is-a-confused-deputy-problem, what-the-ai-act-asks-about-agent-logs, why-ordinary-logs-are-not-evidence
---
"AI governance" tends to land on engineers as a request from legal or a customer's security questionnaire. It arrives as forty questions about policies you have not written. Underneath it, though, the questions are mostly ones a good team already asks about any production system. Here is a version you can work through in an afternoon, in the order that tends to be useful.

None of this replaces legal advice. It is a way to find out what you already know, and what you do not.

## 1. Do you know what you are running?

Start with a list. Every place where a model makes or influences something: the chatbot on the website, the internal tool that drafts replies, the script someone built that summarises tickets, the vendor feature that got switched on by default. For each, write down:

- what it does and for whom,
- which model and version, and who hosts it,
- what data goes in and where it goes after,
- who owns it.

Most teams find at least one system nobody remembered. You cannot govern a system you have not listed.

## 2. How risky is each one, honestly?

Sort the list by what happens when it is wrong. A tool that suggests subject lines for newsletters and a tool that screens job applicants are not the same kind of thing, even if they use the same API.

Some frameworks help you do this without inventing your own scale:

- The **EU AI Act** sorts systems into prohibited, high-risk, limited-risk (mostly transparency duties) and minimal. Whether you are in the high-risk group depends on what the system is used for, not on which model it runs. We went through what that means for records in [what the AI Act actually asks of your agent's logs](/blog/what-the-ai-act-asks-about-agent-logs).
- The **NIST AI Risk Management Framework** gives four functions to organise the work: Govern, Map, Measure, Manage. It is voluntary and readable.
- **ISO/IEC 42001** is a certifiable management-system standard for AI, in the same family as ISO 27001. Useful if customers ask for a certificate.

You do not need all three. Pick one as a vocabulary and stick to it.

## 3. What can it do, and who can stop it?

For anything that acts (sends, writes, buys, deletes), list its permissions and ask whether a hostile input could trigger them. We cover this in [prompt injection is a confused deputy problem](/blog/prompt-injection-is-a-confused-deputy-problem). The short version is least privilege, a human in front of irreversible actions, and an off switch somebody knows how to use.

## 4. How do you know it still works?

Models change underneath you. A hosted model can be updated, a prompt can be edited by a well-meaning colleague, a retrieval index can drift. Ask:

- Is the model version pinned, and who decides when to move?
- Is there a test set of real cases, run before a change goes out?
- Do you notice when quality drops, or do customers tell you first?

A small evaluation suite that runs in CI is worth more than a long policy.

## 5. What do you keep, and for how long?

Prompts and answers often contain personal data. Decide what you store, who can read it, and when it goes away. The tension is real: you want enough to investigate an incident, and data protection law wants you to keep no more than you need. One way out is to keep fingerprints of content rather than the content itself, which we describe in [keeping prompts out of your audit trail](/blog/keeping-sensitive-content-out-of-logs).

## 6. Could you reconstruct what happened?

When something goes wrong, can you say what the system was asked, what it did, and in which order, a month later? And if someone doubts your answer, can you show it? A log that the team can edit is a weak basis for that conversation ([more on why](/blog/why-ordinary-logs-are-not-evidence)).

## 7. Who is responsible?

Name a person per system. Write down what they do when something goes wrong: who they call, what they switch off, who tells the customer. Run it once as a drill. The first time is always instructive.

## 8. What do you tell people?

Users should know when they are talking to a machine, and when a machine's output affects a decision about them. Under the AI Act some of this is a legal duty, depending on the system. In any case it is cheaper to say it clearly up front than to explain it later.

## How to use this

Do not try to finish it. Get through items 1 to 3 for your most exposed system this week. You will find gaps, and you will know which ones matter. The paperwork can follow the engineering.
