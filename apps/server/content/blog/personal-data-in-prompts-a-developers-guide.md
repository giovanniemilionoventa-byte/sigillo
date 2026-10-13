---
title: Personal data in prompts: a developer's guide
description: Every prompt is a data transfer. A practical walk through what to check before customer data reaches a model, written for people who ship code.
date: 2026-10-13
related: an-ai-governance-checklist-for-engineering-teams, keeping-sensitive-content-out-of-logs
---
When you send a customer's message to a language model, you are sending personal data to a processor, probably in another company's data centre. That sentence is dull and it has consequences. This is a developer-oriented walk through the questions that matter, based on the GDPR. It is not legal advice, and your data protection officer or lawyer has the last word.

## First, do you need to send it?

Data minimisation is a principle of the GDPR (Article 5) and it is also good engineering. Ask for each field in a prompt: would the answer change without it? Often a name, an address or an account number does not help the model at all.

A common pattern is to replace identifiers with placeholders before the call, keep the mapping on your side, and put the real values back in the answer. It takes an afternoon to build for the cases you know, and it reduces what any later problem can expose. It will not catch everything, free text is messy, so treat it as a reduction, not a guarantee.

## Who is the model provider to you?

If you send personal data to a provider that processes it on your behalf, you normally need a **data processing agreement** with them (Article 28). Read the parts that matter to you:

- Do they use your prompts to train their models? Many business offerings say no by default, consumer products often say yes.
- How long do they keep inputs and outputs, and can you shorten it?
- Where is the data processed? Transfers outside the EU need a legal mechanism.
- Which sub-processors are involved?

Do this once per provider, and write down the answer where the next engineer can find it.

## Where else does the text end up?

The model call is only one place. Prompts and answers also tend to land in:

- your application logs and error trackers,
- an observability or tracing tool,
- a vector database, as embeddings (these can be partially reversed, so treat them as personal data),
- analytics, chat transcripts shown to support staff, and backups.

Each copy has a retention period, an access list and a deletion path, or it should. The usual surprise is that deleting a user's account does not delete the tracing tool's copy of their messages.

## Decisions about people

If an AI feature makes or heavily shapes a decision with legal or similarly significant effect on a person (a credit refusal, a job screening), Article 22 of the GDPR and, depending on the system, the AI Act apply. That means a human who can actually review the outcome, an explanation you can give, and a way to contest it. Plan these before launch.

## Assessing the risk

For processing likely to result in a high risk to people, the GDPR asks for a **data protection impact assessment** (Article 35). New technology plus sensitive data plus scale is the typical trigger. Doing the assessment early, while the design is still cheap to change, is much better than doing it as a gate on the last day.

## Keeping a trail without keeping the content

You need to be able to show afterwards what a system did, and you also want to hold as little personal data as possible. The two pull apart. One approach is to record metadata and cryptographic fingerprints of the content rather than the content, so that you can match a document you hold against the record without the record containing it. [We describe how that works, and where it falls short](/blog/keeping-sensitive-content-out-of-logs).

## People's rights

People can ask what you hold, ask for corrections and ask for deletion. Design for it: know where an identifier appears, make it possible to find and remove it, and decide up front what you do with records you are required to keep.

## A starting checklist

1. List the personal data each AI feature sends.
2. Remove or replace what the model does not need.
3. Have an agreement with each provider, and know its training and retention terms.
4. Find every other place the text is copied, and set a retention period for each.
5. Decide who reviews decisions about people, and how a person contests one.
6. Do the impact assessment if the processing is high risk.

More on turning this into a routine for the whole team in [an AI governance checklist for engineering teams](/blog/an-ai-governance-checklist-for-engineering-teams).
