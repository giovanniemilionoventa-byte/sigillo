"""LangGraph demo agent, English edition: screens CVs for a junior backend developer role.

The same agent as demo/selezione-cv/agent.py, in English throughout: the
three recorded tools are read_cv, evaluate_candidate and send_email, wired as
a fixed three-step LangGraph (read, evaluate, send), so nothing about which
tool runs is left to a model to decide. The rubric is the same, read from
English CVs: technical skills and years of development experience only,
never a candidate's name, age, gender, background or photo (see the Italian
demo's README.md, "Neutral scoring"). The 20 CVs in curricula/ are the
Italian demo's, translated, and score exactly as they do there
(tests/test_parity.py).

Run it against a running sigillo server:

    export SIGILLO_ENDPOINT=http://127.0.0.1:8080
    export SIGILLO_API_KEY=sigillo_...
    python demo/cv-screening/agent.py
"""

from __future__ import annotations

import json
import os
import pathlib
import re
import sys
import urllib.request
from dataclasses import dataclass
from typing import TypedDict

from langchain_core.callbacks.manager import CallbackManager, CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import SimpleChatModel
from langchain_core.messages import BaseMessage, HumanMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor

import sigillo

HERE = pathlib.Path(__file__).resolve().parent
CURRICULA_DIR = HERE / "curricula"
OUTBOX_DIR = pathlib.Path(os.environ.get("SIGILLO_DEMO_OUTBOX", str(HERE / "outbox")))

SYSTEM_ID = os.environ.get("SIGILLO_SYSTEM_ID", "cv-screening")
# A plain name, as an agent naturally sends it: since receipt version 4 the
# server never writes it into a receipt, only a pseudonym token (psn_...).
RECRUITER_ID = os.environ.get("SIGILLO_RECRUITER_ID", "elena.rizzo")
POSITION = "Junior Backend Developer"

# --- Neutral, declared scoring rubric ---------------------------------------
#
# Only technical skills and years of experience explicitly described as
# development experience are read from the CV text.

BACKEND_SKILLS = (
    "python", "java", "javascript", "typescript", "node.js", "sql", "postgresql",
    "mysql", "mongodb", "git", "docker", "kubernetes", "rest", "linux", "php",
    "spring", "django", "flask", "pytest", "junit", "ci/cd", "microservices",
    "agile", "scrum", "kafka", "redis",
)
EDUCATION_HINTS = ("computer science", "computer engineering", "software engineering", "in computing")
EXPERIENCE_PATTERN = re.compile(r"(\d+)\s+years?\s+of\s+experience\s+as\s+an?\s+(?:\w+\s+)?developer")
INTERVIEW_THRESHOLD = 8
MAX_SKILL_POINTS = 10
MAX_EXPERIENCE_POINTS = 5
EDUCATION_POINTS = 2

_SKILL_PATTERNS = {skill: re.compile(rf"\b{re.escape(skill)}\b") for skill in BACKEND_SKILLS}


@dataclass(frozen=True)
class Evaluation:
    score: int
    outcome: str  # "interview" or "not_suitable"
    skills_found: tuple[str, ...]
    years: int


def evaluate_cv_text(text: str) -> Evaluation:
    """The declared rubric, in full: relevant skills and years of relevant
    experience, nothing else. This function is the rubric."""
    lower = text.lower()
    skills_found = tuple(skill for skill in BACKEND_SKILLS if _SKILL_PATTERNS[skill].search(lower))
    match = EXPERIENCE_PATTERN.search(lower)
    years = int(match.group(1)) if match else 0
    has_cs_education = any(hint in lower for hint in EDUCATION_HINTS)

    score = (
        min(2 * len(skills_found), MAX_SKILL_POINTS)
        + min(years, MAX_EXPERIENCE_POINTS)
        + (EDUCATION_POINTS if has_cs_education else 0)
    )
    outcome = "interview" if score >= INTERVIEW_THRESHOLD else "not_suitable"
    return Evaluation(score=score, outcome=outcome, skills_found=skills_found, years=years)


# --- The model: a small local Ollama model if reachable, else a deterministic
# fake with the same interface, so the demo runs anywhere. -------------------


def _ollama_reachable(url: str, model: str) -> bool:
    try:
        with urllib.request.urlopen(url.rstrip("/") + "/api/tags", timeout=3) as response:  # noqa: S310
            payload = json.loads(response.read())
    except Exception:
        return False
    names = {entry.get("name") for entry in payload.get("models", []) if isinstance(entry, dict)}
    return model in names


class FakeRationaleModel(SimpleChatModel):
    """Deterministic stand-in for a real model: same interface, no network,
    same output for the same facts. It reads back exactly the facts it was
    given — nothing is invented."""

    @property
    def _llm_type(self) -> str:
        return "sigillo-demo-fake-model"

    def _call(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: object,
    ) -> str:
        prompt = str(messages[-1].content) if messages else ""
        return _rationale_from_facts(prompt)


def build_model() -> tuple[object, str | None]:
    """An Ollama chat model when `OLLAMA_URL` is set and the model is pulled
    there, otherwise the deterministic fake."""
    ollama_url = os.environ.get("OLLAMA_URL")
    model_name = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b")
    if ollama_url and _ollama_reachable(ollama_url, model_name):
        from langchain_ollama import ChatOllama  # optional, see the Italian demo's requirements.txt

        return ChatOllama(base_url=ollama_url, model=model_name), ollama_url
    return FakeRationaleModel(), None


_FACT_LINE = re.compile(r"^(Outcome|Score|Years of relevant experience|Technical skills found): (.*)$", re.MULTILINE)


def _facts_prompt(evaluation: Evaluation) -> str:
    skills = ", ".join(evaluation.skills_found) if evaluation.skills_found else "none"
    return (
        "Write a short rationale (1-2 sentences), in English, for the outcome of a "
        "job application screening. Use only the facts below, invent nothing else, "
        "and do not mention the candidate's age, gender, background or appearance.\n"
        f"Outcome: {evaluation.outcome}\n"
        f"Score: {evaluation.score}/17\n"
        f"Years of relevant experience: {evaluation.years}\n"
        f"Technical skills found: {skills}\n"
    )


def _rationale_from_facts(prompt: str) -> str:
    facts = dict(_FACT_LINE.findall(prompt))
    outcome = facts.get("Outcome", "not_suitable")
    score = facts.get("Score", "0/17")
    years = facts.get("Years of relevant experience", "0")
    skills = facts.get("Technical skills found", "none")
    base = f"Score {score} under the declared rules: {years} years of relevant experience, technical skills found: {skills}."
    if outcome == "interview":
        return base + " The profile clears the threshold for an interview."
    return base + " The profile does not reach the minimum threshold for this position."


def rationale_for(evaluation: Evaluation, model: object) -> str:
    response = model.invoke([HumanMessage(content=_facts_prompt(evaluation))])  # type: ignore[attr-defined]
    return str(response.content).strip()


# --- The three tools sigillo records, one receipt each -----------------------

_MODEL: object = None


@tool
def read_cv(file_path: str, callbacks: CallbackManager | None = None) -> str:
    """Reads a candidate's CV from disk and records it as the input document for this action.

    `callbacks` is injected by LangChain because of its name: it is how this
    tool reaches its own span (see sigillo.artifact's docstring).
    """
    path = pathlib.Path(file_path)
    span = sigillo.current_span_from_callbacks(callbacks)
    sigillo.artifact(path, role="input", label="CV", span=span)
    return path.read_text(encoding="utf-8")


@tool
def evaluate_candidate(cv_text: str) -> dict[str, object]:
    """Scores a CV against the declared, skills-only rubric and drafts a short rationale."""
    evaluation = evaluate_cv_text(cv_text)
    rationale = rationale_for(evaluation, _MODEL)
    return {"score": evaluation.score, "outcome": evaluation.outcome, "rationale": rationale}


@tool
def send_email(output_path: str, body: str, callbacks: CallbackManager | None = None) -> str:
    """Writes the reply email under outbox/ (no real send) and records it as the output document."""
    target = pathlib.Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8")
    span = sigillo.current_span_from_callbacks(callbacks)
    sigillo.artifact(target, role="output", label="reply email", span=span)
    return f"email written to {target}"


def compose_email(candidate_name: str, outcome: str) -> str:
    intro = f"Dear {candidate_name},\n\nthank you for applying for the position of {POSITION}. "
    if outcome == "interview":
        body = "Your profile matches the technical requirements: we will be in touch shortly to arrange an interview."
    else:
        body = (
            "After assessing the technical skills and experience the role requires, we will not be "
            "taking your application further in this selection. We wish you all the best in your search."
        )
    return intro + body + "\n\nKind regards,\nRecruitment\n"


# --- LangGraph wiring: read, evaluate, send — always in that order -----------


class CandidateState(TypedDict):
    file_path: str
    candidate_name: str
    cv_text: str
    score: int
    outcome: str
    rationale: str
    email_result: str


NAME_PATTERN = re.compile(r"^Name:\s*(.+)$", re.MULTILINE)


def _read_node(state: CandidateState) -> dict[str, object]:
    text = read_cv.invoke({"file_path": state["file_path"]})
    match = NAME_PATTERN.search(text)
    name = match.group(1).strip() if match else "candidate"
    return {"cv_text": text, "candidate_name": name}


def _evaluate_node(state: CandidateState) -> dict[str, object]:
    result = evaluate_candidate.invoke({"cv_text": state["cv_text"]})
    return {"score": result["score"], "outcome": result["outcome"], "rationale": result["rationale"]}


def _send_node(state: CandidateState) -> dict[str, object]:
    body = compose_email(state["candidate_name"], state["outcome"])
    output_path = str(OUTBOX_DIR / f"{pathlib.Path(state['file_path']).stem}-reply.txt")
    result = send_email.invoke({"output_path": output_path, "body": body})
    return {"email_result": result}


def build_graph():
    graph = StateGraph(CandidateState)
    graph.add_node("read", _read_node)
    graph.add_node("evaluate", _evaluate_node)
    graph.add_node("send", _send_node)
    graph.add_edge(START, "read")
    graph.add_edge("read", "evaluate")
    graph.add_edge("evaluate", "send")
    graph.add_edge("send", END)
    return graph.compile()


# --- "On behalf of": every action in this run acts for the same recruiter ---


class OnBehalfOfProcessor(SpanProcessor):
    """Stamps every span with the recruiter this run acts for, at `on_start`
    (a span refuses attribute changes once it has ended)."""

    def __init__(self, user_id: str) -> None:
        self._user_id = user_id

    def on_start(self, span: Span, parent_context: object = None) -> None:
        span.set_attribute("user.id", self._user_id)

    def on_end(self, span: ReadableSpan) -> None:
        return None

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True


def main() -> int:
    global _MODEL

    endpoint = os.environ.get("SIGILLO_ENDPOINT")
    api_key = os.environ.get("SIGILLO_API_KEY")
    if not endpoint or not api_key:
        print("set SIGILLO_ENDPOINT and SIGILLO_API_KEY first", file=sys.stderr)
        return 2

    tracing = sigillo.init(endpoint=endpoint, api_key=api_key, system_id=SYSTEM_ID, instrument=["langchain"])
    tracing.provider.add_span_processor(OnBehalfOfProcessor(RECRUITER_ID))

    _MODEL, ollama_url = build_model()
    print(f"model: {'Ollama at ' + ollama_url if ollama_url else 'deterministic fake (no OLLAMA_URL reachable)'}")

    OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
    agent = build_graph()

    files = sorted(CURRICULA_DIR.glob("candidate-*.txt"))
    if not files:
        print(f"no CVs found in {CURRICULA_DIR}", file=sys.stderr)
        return 2

    counts = {"interview": 0, "not_suitable": 0}
    for path in files:
        result = agent.invoke({"file_path": str(path)})
        counts[result["outcome"]] += 1
        print(f"{path.stem}: {result['candidate_name']:<20} score={result['score']:>2} outcome={result['outcome']}")

    tracing.flush()
    tracing.shutdown()

    screened = f"{len(files)} application{'' if len(files) == 1 else 's'} screened"
    print(f"\n{screened}: {counts['interview']} interview, {counts['not_suitable']} not suitable.")
    print("receipts sent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
