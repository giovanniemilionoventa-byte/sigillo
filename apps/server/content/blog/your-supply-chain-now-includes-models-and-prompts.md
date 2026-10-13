---
title: Your software supply chain now includes models, prompts and tools
description: Pinning dependencies is a solved habit. Models, prompt files and agent tools are dependencies too, and they fail in some new ways.
date: 2026-10-13
related: prompt-injection-is-a-confused-deputy-problem, an-ai-governance-checklist-for-engineering-teams
---
Most teams have learned to pin package versions, run a vulnerability scan and look twice at a new dependency. Then they add an AI feature and download a model from a hub, copy a prompt from a blog, and connect an agent to a tool server someone published last week. None of that went through the process they use for a library.

Here is where the old habits still apply, and where they need a small extension.

## Model files can run code

Some model formats are not just data. Python's `pickle`, which many model files have used, can run arbitrary code while it is being loaded. Loading an untrusted checkpoint can be the same as running an untrusted program. This is not a theoretical risk, malicious models have been found on public hubs.

What helps:

- Prefer formats that only hold tensors, such as **safetensors**, over pickle-based ones.
- If you must load a pickle-based file, do it in a sandbox, not on your build server with its credentials.
- Pin by **hash**, not only by name and tag. A repository name can point at different files tomorrow.
- Download from the publisher you meant to, and check that the name is exactly right. Typos and look-alike names are the oldest trick there is.

## Packages that models invent

Code assistants sometimes suggest an import for a package that does not exist. Attackers can register that name and wait. The practice has been called *slopsquatting*. The defence is dull: check that a package exists, has history and has the maintainer you expect, before you install it, and keep a lockfile so that the install is the same tomorrow as today.

## Prompts and configuration are code

A system prompt decides what your product does. Treat it that way:

- Keep prompts in the repository, reviewed like code, with the evaluation set that checks them (see [testing LLM features without fooling yourself](/blog/testing-llm-features-without-fooling-yourself)).
- Do not pull instructions at runtime from a place that people outside your team can edit.
- If a retrieval index is built from documents, then whoever can write those documents can write instructions to your model. Decide who that is.

## Tools and servers your agent connects to

An agent that calls tools extends your trust to whoever runs them. A tool server can return text, and that text goes into the model's context, so a compromised or careless tool is a way to inject instructions (we describe the wider problem in [prompt injection is a confused deputy problem](/blog/prompt-injection-is-a-confused-deputy-problem)). It can also be updated under you, changing what a named tool does.

Practical rules: use tools from sources you can name, pin their versions, give each one the least access it needs, and read what a tool declares about itself before you let a model read it too, since descriptions are text the model will obey.

## A bill of materials that includes the AI parts

You may already produce an SBOM, a list of software components. Standards are catching up with AI: CycloneDX, for example, can describe machine-learning models and datasets in its bill of materials. Even a plain spreadsheet is a start: for each AI feature, which model (name, version, hash), which prompt version, which tools, which data sources, who owns it. When a vulnerability or a licence problem is announced, this is the list that tells you whether it concerns you.

Licences matter here too. Model licences vary a great deal: some forbid certain uses, some require attribution, some limit commercial use above a size. Reading it once, at the start, is cheaper than discovering it at a customer's due diligence.

## What to do on Monday

Pick one AI feature. Write down every external thing it depends on: model, prompt, index, tools, packages. Pin each by version or hash. Remove any you cannot explain. That is the same exercise you would do for a web service, just with more kinds of dependency in the list.
