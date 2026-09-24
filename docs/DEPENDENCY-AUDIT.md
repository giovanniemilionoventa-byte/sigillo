# Dependency audit

sigillo checks its dependencies for **known** vulnerabilities: ones already
published in a public advisory database. It cannot find a vulnerability nobody
has reported yet, and it says nothing about sigillo's own code.

## How to run it

From the repository root:

| command | what it checks | needs |
|---|---|---|
| `pnpm audit:node` | the pnpm workspace, from `pnpm-lock.yaml` | network access to the npm registry |
| `pnpm audit:python` | the Python SDK and its extras (`sdk-python/pyproject.toml`), the example's and the demo's `requirements.txt` | Python 3.11+, `pip install pip-audit`, network access to PyPI |
| `pnpm audit:deps` | both | both |

## What fails, and why

| scope | fails on | reason |
|---|---|---|
| Node **production** dependencies (`pnpm audit --prod`) | any advisory, of any severity | these ship in the Docker images and run with the evidence |
| Node **development** dependencies (`pnpm audit --dev --audit-level high`) | `high` or `critical` | they never reach a deployment, but they run on developers' machines and in CI |
| Python (`pip-audit`) | any advisory | the SDK runs inside the customer's agent process |

Moderate and low advisories in development dependencies do not fail the check,
but CI lists every advisory in a step that is allowed to fail, so they stay
visible.

## What a failure means

The exit code is not zero, and the output names the package, the installed
version, the advisory (`GHSA-…`, `CVE-…` or `PYSEC-…`) and the first version
that fixes it. It means that a version the project resolves is affected by a
published advisory. It does **not** mean that sigillo is exploitable through it:
that depends on whether the vulnerable code is reachable. That question is for
a person to answer, not the tool.

What to do:

1. Read the advisory and check whether the affected code path is used.
2. If a fixed version exists, upgrade: for Node, change `package.json` and run
   `pnpm install`, never edit `pnpm-lock.yaml` by hand. If the package is only
   transitive, re-resolve the package that pulls it in. Then run `pnpm check`,
   `node scripts/smoke-dist.mjs` and `python3 scripts/crosscheck_vectors.py`.
   `canonicalize`, `zod` and anything else on the receipt path must never be
   upgraded without those passing.
3. If no fix exists, or the fix cannot be taken yet, record the decision and
   its reason in `PROGRESS.md`. Only then consider an explicit exception
   (`pnpm audit --ignore <CVE>`, `pip-audit --ignore-vuln <ID>`), and never a
   silent one.

A failure can also come from the network: if the npm registry or PyPI cannot
be reached, the check fails rather than passing unchecked. Run it again.

## When it runs

- **Automatically in CI** (`.github/workflows/dependency-audit.yml`), on every
  push and pull request.
- **Every Monday at 05:00 UTC**, and on demand from the Actions tab. An advisory
  can be published against a version already in use without any commit here,
  and the Python requirements are not pinned, so what they resolve to changes
  on its own. GitHub runs scheduled workflows on the default branch only.
- **By hand**, before building an image for a deployment and before tagging a
  release.

The Docker base images (`node:22-bookworm-slim`, `caddy:2-alpine`) and their
operating-system packages are **not** covered by this check.
