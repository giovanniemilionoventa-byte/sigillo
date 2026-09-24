# CLAUDE.md — working rules for sigillo

This file collects the permanent rules for anyone (human or AI) working on this repository, plus the build/test commands discovered as the project is scaffolded. See `SPEC.md` for the product specification and `PROGRESS.md` for milestone status.

## Permanent rules

1. **Crypto code: test-first, always.** Write the failing test before the implementation for any cryptographic function (hashing, canonicalization, signing, Merkle trees, timestamping). Never mock cryptographic primitives in tests — use the real `node:crypto` implementations end to end.
2. **Never persist plaintext** of agent prompts, tool arguments, or outputs. Only their SHA-256 hashes are ever stored or logged.
3. **Never change the receipt format** without incrementing the schema version `v`, and keep older versions verifiable.
4. **`packages/core` stays pure.** No network I/O, no filesystem I/O, no internal `Date.now()`, no reading of environment variables. Everything (time, randomness where relevant, keys) is passed in as a parameter by the caller.
5. **The verifier stays small and readable.** Prefer explicit code over abstraction. The SPEC's original target was fewer than 1000 lines across `packages/verifier` plus the parts of `core` it uses; the project owner accepted the actual size on 2026-09-21, when it stood at 1792 lines (1416 excluding blanks and comments). The operative rule is therefore: **readability first, and no growth without a reason a reader would accept**. A change that adds more than about 100 lines to that total is worth a note in `PROGRESS.md` saying what it bought.
6. **No dependencies outside the approved list** (see "Approved dependencies" below) without asking first.
7. Code, comments, commit messages, and technical documentation are written in **English**. Status updates to the project owner are written in **Italian**.
8. At the end of every milestone: tests green, `PROGRESS.md` updated, commit and push to the `sigillo` GitHub repository.
9. **Never stop with unsaved work.** Before any pause, question, or end of session: push to the `sigillo` repository and open or update a pull request against `main`.
10. **Never push directly to `main`.** All work happens on the session's feature branch.

## Approved dependencies

- **Node runtime**: `fastify`, `better-sqlite3`, `canonicalize` (RFC 8785), `zod`, `protobufjs`, `pdfkit`, `commander`. Cryptography uses only `node:crypto` (SHA-256, Ed25519, scrypt) — no external crypto libraries.
- **Node dev**: `typescript`, `tsx`, `vitest`, `fast-check`, `@types/*`.
- **CI-only tooling** (never a dependency of any package): `pip-audit`, pinned in
  `.github/workflows/dependency-audit.yml`. Added in pilot phase 3 for the
  dependency check; pending the project owner's confirmation.
- **Python**: `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http`; optional extras `openinference-instrumentation-langchain`, `openinference-instrumentation-crewai`, `openinference-instrumentation-openai` (added in phase 2, N2, for agents that call an OpenAI-compatible server directly).
- Anything else: ask the project owner before adding it.

## Repository layout

```
packages/core       pure library: schema, canonicalization, hashing, chain, signing, Merkle
                     NO network, disk, or clock access — everything passed in as a parameter
packages/verifier    open-source CLI, depends only on core (+ system openssl for RFC 3161)
apps/signer          separate process holding the private key
apps/server          ingest, storage, checkpoints, timestamps, export, minimal UI
sdk-python/          thin Python package (separate folder, not a pnpm workspace member)
deploy/              Dockerfile, docker-compose.yml, Caddyfile
docs/                FORMAT.md, SECURITY.md, API.md
```

## Build & test commands

Run from the repository root. Node 22 and pnpm 10 are required.

| command | what it does |
|---|---|
| `pnpm install` | install workspace dependencies |
| `pnpm lint` | `scripts/lint.mjs`: architectural invariants, not style (see below) |
| `pnpm typecheck` | `tsc` over every package, sources and tests, no emit |
| `pnpm build` | `tsc` per package into `dist/` |
| `pnpm test` | vitest, run once, across all packages |
| `pnpm test:watch` | vitest in watch mode |
| `pnpm check` | lint, typecheck, build and test in sequence |
| `node scripts/smoke-dist.mjs` | verify the built package under plain Node (run after `pnpm build`) |
| `python3 scripts/crosscheck_vectors.py` | re-derive the receipt test vectors with an independent Python implementation |
| `pnpm tsx scripts/gen-vectors.ts` | regenerate `packages/core/test/vectors.json` |
| `pnpm audit:deps` | known-vulnerability check of Node and Python dependencies (`audit:node`, `audit:python`); see `docs/DEPENDENCY-AUDIT.md` |

Tests import `@sigillo/core` and resolve to `packages/core/src` through a vitest
alias, so no build is needed to run them. `scripts/smoke-dist.mjs` is what covers
the built output.

There is no eslint or prettier: neither is on the approved dependency list.
`pnpm lint` instead enforces the rules that matter here — core's purity, the
dependency allowlist, no `.only()` left in tests, no explicit `any`, no key
material in the tree. Style is left to the author.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, build, test and the dist
smoke check on Node 22, plus the Python cross-check as a separate job. A second
workflow, `.github/workflows/dependency-audit.yml`, runs the dependency audit on
every push and pull request and every Monday on its own.

## Workflow reminders (session process)

- Work one milestone at a time, in order. A milestone is done only when all its acceptance criteria pass with automated tests.
- After finishing a milestone: update `PROGRESS.md`, commit, push — then move to the next milestone without asking.
- Stop and ask the project owner only when: an external credential/account is needed; a SPEC decision turns out to be technically wrong; or a dependency outside the approved list is needed.
- At the start of a new session: make sure the branch is up to date with `main`, read `PROGRESS.md`, and resume from the first milestone not marked `fatto`.
