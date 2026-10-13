---
title: Testing LLM features in production without fooling yourself
description: Demos always work. Here is how to build an evaluation setup that tells you the truth about a model feature, before and after you ship it.
date: 2026-10-13
related: an-ai-governance-checklist-for-engineering-teams, prompt-injection-is-a-confused-deputy-problem
---
The first version of any LLM feature looks great. You try ten examples, nine are good, the tenth is funny. You ship. Three weeks later someone notices that it quietly gets one kind of question wrong, and has done since the day you changed the prompt.

Nothing exotic happened. You tested by looking, and looking does not scale. A few habits fix most of it.

## Start with real cases, not invented ones

The best test set is made of things users actually asked, with the answer you would have wanted. Take a couple of hundred from real traffic (with the privacy rules your company needs: remove or replace personal data first), and add every bug report as it arrives. After a few months you have a set that reflects what really goes wrong, not what you imagined would.

Keep it in version control, next to the prompt. A prompt change and a test set change should be reviewable in the same pull request.

## Decide what "good" means before you run anything

"Is the answer good?" is too vague to test. Break it into checks you can state:

- Does the answer contain the required fact (an exact match you can check with code)?
- Does it avoid something it must never say?
- Is it in the right format, so that the next step in your code can parse it?
- Does it refuse when it should?

Anything you can check with plain code, check with plain code. It is fast, free and does not drift.

## Using a model to grade a model

Some qualities (tone, helpfulness, whether a summary is faithful) are hard to test without a reader. A second model can act as the grader. It works well enough to be useful and badly enough to be dangerous if you trust it blindly. Known problems:

- Graders tend to prefer longer answers and answers from their own model family.
- The score moves when you reword the grading prompt.
- Scores from different grader models are not comparable.

So calibrate. Have a person grade fifty examples, compare with the grader, and look at the disagreements. Keep a small set of cases a human reviews every time. And use the grader to catch big regressions, not to rank two versions that differ by half a point.

## Pin what you can, and watch what you cannot

Your results depend on the model version, the prompt, the retrieval index, the tool definitions and the sampling settings. Write them all down for every run. If your provider offers dated model versions, use one and move on purpose, running your set first. If they change the model behind a name, you will only find out by measuring, so run the set on a schedule, not only when you deploy.

## Measure the run, not just the answer

Outputs are one thing. Cost, latency, number of tool calls and how often the model needed a retry tell you about the rest. A new prompt that is slightly more accurate and uses three times the tokens is a decision, not a free win.

## Look at production, because the test set is always behind

Sample real conversations weekly and have a person read twenty of them. Watch for signals that need no grader: users rephrasing the same question, abandoning a flow, pressing the thumbs-down, asking for a human. Turn each failure into a test case. This is the loop that makes the set useful.

For agents that act, also keep a record of what they did, in order, which you can read afterwards. A faithful trace of tool calls is how you find out that the answer was fine and the action was not. We say more about that in [an AI governance checklist for engineering teams](/blog/an-ai-governance-checklist-for-engineering-teams).

## A reasonable minimum

If you do nothing else: a hundred real cases in the repository, checks you can run with one command, a run on every prompt change, and twenty conversations read by a person each week. That is a day of work, and it turns "it seemed fine" into something you can argue about with data.
