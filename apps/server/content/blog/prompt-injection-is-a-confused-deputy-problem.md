---
title: Prompt injection is a confused deputy problem, and the fix is old
description: You cannot reliably stop a model from obeying hostile text. You can limit what it is allowed to do when it does. Notes on least privilege for AI agents.
date: 2026-10-13
related: why-ordinary-logs-are-not-evidence, an-ai-governance-checklist-for-engineering-teams
---
Most advice about prompt injection sounds like advice about spam filters: detect the bad input, block it, keep the list updated. That is worth doing, and it will never be enough. A language model reads instructions and data through the same channel, as text. There is no reliable way to tell it "this part is only data". So treat the model as something that will, sometimes, follow instructions from anyone who gets text in front of it.

Once you accept that, the problem changes shape. It stops being "how do I stop the model being fooled?" and becomes "what can a fooled model do?". Security people have a name for this situation, and it is much older than LLMs.

## The confused deputy

In 1988 Norm Hardy described the **confused deputy**: a program that has authority of its own, and is tricked by someone with less authority into using it on their behalf. The compiler in his story could write to a billing file. A user asked it to write debugging output to that same file, and it did, because the compiler's permission to do so was ambient, not tied to who was asking.

An AI agent is a confused deputy by construction. It holds credentials (an email account, a database connection, a payments API) and it reads content from people who do not hold those credentials: a customer's message, a web page, a PDF, a ticket. When the content says "forward the last ten invoices to this address", the agent has the authority to do exactly that.

## The three things that make it dangerous

A useful rule of thumb, which Simon Willison has called the "lethal trifecta": the risk becomes serious when one agent has all three of these at once.

1. Access to **private data**.
2. Exposure to **untrusted content**.
3. A way to **send data out**: an email, an HTTP request, a rendered image URL, a comment on a public page.

Remove any one and the worst case shrinks a lot. An agent that reads untrusted web pages but cannot reach your data can still be told to lie, but it cannot leak your customer list. An agent with your data and no outbound channel cannot exfiltrate it directly.

The practical exercise is simple. For each agent you run, write down which of the three it has. If the answer is "all of them", you have found the place to spend your time.

## What actually helps

None of this is exotic. It is least privilege applied to a new kind of caller.

**Give each task its own narrow credentials.** A support agent that answers questions needs read access to one customer's tickets, not to the whole table. Short-lived tokens issued per session, scoped to the user the agent is acting for, mean a hijacked session can only reach what that user could.

**Separate reading from acting.** One component reads untrusted content and produces a summary or a structured result. A different one, which never sees the raw text, decides what to do. The boundary is a typed object, not a paragraph. This does not make injection impossible, but it makes it a lot harder for a sentence in a web page to become a function call.

**Put a human in front of what cannot be undone.** Sending money, deleting data, emailing someone outside the company. Show the person the actual action (recipient, amount, the exact text), not the model's description of it. Approval prompts that say "The agent wants to continue" teach people to click yes.

**Close the outbound channels you did not mean to open.** Allow-list the domains an agent can call. Be careful with anything that makes the *client* fetch a URL, because a model can encode data into the address of an image or a link.

**Treat tool output as untrusted too.** A tool that returns text from the outside world has the same problem as the user's message.

## Logging is part of the control, not a nice extra

You will get this wrong somewhere, so you want to know afterwards what the agent was asked, what it called, with what, and in what order. That record is only useful if it survives an attacker who can also reach the system, which is a reason to write it somewhere the agent cannot edit. We wrote about what makes a record worth trusting in [why ordinary logs are not evidence](/blog/why-ordinary-logs-are-not-evidence).

## A short test

Pick one agent in production and answer, in writing: what is the worst thing it could do if every piece of text it reads were hostile? If the answer makes you uncomfortable, the fix is rarely a better prompt. It is a smaller set of permissions.

For a broader checklist that includes this kind of review, see [an AI governance checklist for engineering teams](/blog/an-ai-governance-checklist-for-engineering-teams).
