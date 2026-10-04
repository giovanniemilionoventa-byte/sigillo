# Demo: CV screening (English edition)

The English edition of `demo/selezione-cv`: the same LangGraph agent, the same
neutral, skills-only rubric, and the same 20 fictional candidates, with their
CVs translated. Everything the agent records and prints is in English: the
tools are `read_cv`, `evaluate_candidate` and `send_email`, the CVs are
`candidate-01.txt` … `candidate-20.txt`, and the outcomes are `interview` and
`not_suitable`.

`tests/test_parity.py` checks that every English CV scores exactly as its
Italian original, so the two editions always reach the same outcomes.

It exists for the English demo video (`video/`, `SIGILLO_VIDEO_LANG=en`),
and runs like the Italian one, against a running sigillo server:

```bash
pip install -e sdk-python -r demo/selezione-cv/requirements.txt
export SIGILLO_ENDPOINT=http://127.0.0.1:8080
export SIGILLO_API_KEY=sigillo_...
python demo/cv-screening/agent.py      # system id: cv-screening
```

See `demo/selezione-cv/README.md` for the rubric, the model (a deterministic
stand-in unless `OLLAMA_URL` is set) and the "on behalf of" pseudonyms; all
of it applies here unchanged.
