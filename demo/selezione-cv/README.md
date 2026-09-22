# Demo: CV screening

A LangGraph agent that screens 20 fictional CVs for a junior backend developer
role, records every step through sigillo, and produces a fascicolo an
inspector can verify offline. It exists to make Phase 2's non-technical UI and
document verification tangible against a realistic, if small, workload —
not to be a real hiring tool.

## Neutral scoring

**The scoring rule only ever reads technical skills and years of development
experience from the CV text.** It never extracts or scores a candidate's
name, age, gender, background or photo — there is no code path that could,
since `evaluate_cv_text` in `agent.py` is the entire rubric, in the open,
and it takes nothing else as input. A screening demo that discriminated would
be the exact opposite of what sigillo is for: proving what an AI system did,
on terms a non-technical reviewer can check for themselves. See
`evaluate_cv_text` for the rubric in full, and `curricula/candidato-07.txt`
plus `ISPEZIONE.md` for a worked example of using the record to show a
rejection was reached on legitimate grounds.

## Layout

- `curricula/candidato-01.txt` … `candidato-20.txt` — the 20 fictional CVs,
  in Italian, with invented names.
- `agent.py` — the LangGraph agent: three tools (`leggi_curriculum`,
  `valuta_candidato`, `invia_email`), one sequential graph per candidate, and
  the scoring rubric.
- `outbox/` — created at runtime: the reply email `invia_email` writes for
  each candidate (never sent anywhere). Not committed.
- `run_demo.sh` / `run_demo.ps1` — start a throwaway signer and server, run
  the agent over all 20 CVs, force a checkpoint, print a summary.
- `ISPEZIONE.md` — a walkthrough, in Italian, of using the record to answer a
  candidate's complaint. Written for someone who has never seen sigillo.
- `VIDEO.md` — a script, in Italian, for a short demo video aimed at DPOs and
  compliance officers.
- `tests/` — `test_scoring.py` (the rubric, in isolation) and
  `test_demo_e2e.py` (the real signer, server and verifier, end to end).

## Running it

Build sigillo first (from the repository root): `pnpm install && pnpm build`.

```bash
pip install -e sdk-python -r demo/selezione-cv/requirements.txt
./demo/selezione-cv/run_demo.sh
```

On Windows, with Docker Desktop installed: `demo\selezione-cv\run_demo.ps1`.

Either script prints the web interface's address and admin password when it
finishes, and leaves the server running so you can follow `ISPEZIONE.md`
against it.

## The model

`valuta_candidato` computes the score itself — deterministically, from the
rubric above — and then asks a chat model for a one- or two-sentence
rationale phrased from exactly those computed facts (never anything else,
and never the candidate's name).

- If `OLLAMA_URL` is set and answers, with the model named by `OLLAMA_MODEL`
  (default `qwen2.5:3b`) already pulled, the demo uses that model, and its
  digest rides along on the `llm_call` receipt.
- Otherwise it uses `FakeRationaleModel`, a deterministic stand-in with the
  same interface: same facts in, same sentence out, no network. This is what
  actually runs in this session's sandbox and in CI — the sandbox could not
  install Ollama (see `PROGRESS.md`, milestone N5, for exactly what was
  tried and why) or reach a model registry to pull one, so the real-model
  path is written and unit-tested but not exercised end to end here. To try
  it yourself:

  ```bash
  curl -fsSL https://ollama.com/install.sh | sh
  ollama pull qwen2.5:3b
  export OLLAMA_URL=http://127.0.0.1:11434
  ./demo/selezione-cv/run_demo.sh
  ```

## "On behalf of"

Every action in a run acts for the same fictional recruiter
(`elena.rizzo` by default, `SIGILLO_RECRUITER_ID` to change it), attached to
every span by a small `SpanProcessor` in `agent.py`. This is what the web
interface's "per conto di «elena.rizzo»" comes from.

## A note on `sigillo.artifact()` and LangChain

`leggi_curriculum` and `invia_email` attach the CV and the reply email as
documents with `sigillo.artifact(...)`. Building this demo surfaced a real
gap in that function as it shipped in milestone N2: it looks for "the
current span" through OpenTelemetry's context, but OpenInference's LangChain
integration deliberately never puts its spans there (it cannot risk leaving
a context attached if a callback fails partway through — see its source).
Called from inside a real `@tool`, `sigillo.artifact()` silently attached
nothing.

The fix, in `sdk-python/src/sigillo/__init__.py`: `artifact()` now takes an
optional `span` argument, and a new `current_span_from_callbacks()` helper
finds that span from the `callbacks` argument LangChain injects into a tool
function that declares one — this demo's two tools show the pattern. See
`PROGRESS.md`, milestone N5, for the full account, and
`sdk-python/tests/test_init.py`'s
`test_artifact_works_inside_a_real_langchain_tool_call` for the regression
test.
