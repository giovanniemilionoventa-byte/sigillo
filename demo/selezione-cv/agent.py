"""LangGraph demo agent: screens CVs for a junior backend developer role.

Three recorded tools per candidate — leggi_curriculum, valuta_candidato,
invia_email — wired as a fixed three-step LangGraph, not an LLM-driven tool
loop: the control flow is always read, score, reply, so nothing about which
tool runs is left to a model to decide. See README.md for the full picture,
including why the scoring rubric never looks at a candidate's name, age,
gender, background or photo.

Run it against a running sigillo server:

    export SIGILLO_ENDPOINT=http://127.0.0.1:8080
    export SIGILLO_API_KEY=sigillo_...
    python demo/selezione-cv/agent.py

run_demo.sh (or run_demo.ps1 on Windows) also starts a local signer and
server first, so this script only needs to be run directly when one is
already up.
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

SYSTEM_ID = os.environ.get("SIGILLO_SYSTEM_ID", "selezione-cv")
RECRUITER_ID = os.environ.get("SIGILLO_RECRUITER_ID", "elena.rizzo")
POSITION = "Sviluppatore Backend Junior"

# --- Neutral, declared scoring rubric ---------------------------------------
#
# Only technical skills and years of experience explicitly described as
# development experience are read from the CV text. Nothing here extracts or
# scores a candidate's name, age, gender, background or photo — see
# README.md, "Neutral scoring", for why that is the point of this demo.

BACKEND_SKILLS = (
    "python", "java", "javascript", "typescript", "node.js", "sql", "postgresql",
    "mysql", "mongodb", "git", "docker", "kubernetes", "rest", "linux", "php",
    "spring", "django", "flask", "pytest", "junit", "ci/cd", "microservizi",
    "agile", "scrum", "kafka", "redis",
)
EDUCATION_HINTS = ("informatic", "ingegneria del software")
EXPERIENCE_PATTERN = re.compile(r"(\d+)\s+ann[oi]\s+di\s+esperienza\s+come\s+sviluppat\w+")
INTERVIEW_THRESHOLD = 8
MAX_SKILL_POINTS = 10
MAX_EXPERIENCE_POINTS = 5
EDUCATION_POINTS = 2

_SKILL_PATTERNS = {skill: re.compile(rf"\b{re.escape(skill)}\b") for skill in BACKEND_SKILLS}


@dataclass(frozen=True)
class Evaluation:
    score: int
    outcome: str  # "colloquio" or "non_idoneo"
    skills_found: tuple[str, ...]
    years: int


def evaluate_cv_text(text: str) -> Evaluation:
    """The declared rubric, in full: relevant skills and years of relevant
    experience, nothing else. A reader does not have to trust this summary —
    this function is the rubric."""
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
    outcome = "colloquio" if score >= INTERVIEW_THRESHOLD else "non_idoneo"
    return Evaluation(score=score, outcome=outcome, skills_found=skills_found, years=years)


# --- The model: a small local Ollama model if reachable, else a deterministic
# fake with the same interface, so the demo runs anywhere, including CI. -----


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
    same output for the same facts, so the demo runs the same way every time,
    including in CI. It reads back exactly the facts it was given — nothing
    is invented."""

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
    there, otherwise the deterministic fake. Returns the model and, when
    real, the URL it talks to (for the startup banner)."""
    ollama_url = os.environ.get("OLLAMA_URL")
    model_name = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b")
    if ollama_url and _ollama_reachable(ollama_url, model_name):
        from langchain_ollama import ChatOllama  # optional, see requirements.txt

        return ChatOllama(base_url=ollama_url, model=model_name), ollama_url
    return FakeRationaleModel(), None


_FACT_LINE = re.compile(
    r"^(Esito|Punteggio|Anni di esperienza pertinente|Competenze tecniche rilevate): (.*)$",
    re.MULTILINE,
)


def _facts_prompt(evaluation: Evaluation) -> str:
    skills = ", ".join(evaluation.skills_found) if evaluation.skills_found else "nessuna"
    return (
        "Scrivi una motivazione breve (1-2 frasi), in italiano, per l'esito di una "
        "selezione del personale. Usa solo i fatti indicati sotto, non inventarne altri "
        "e non menzionare età, genere, provenienza o aspetto fisico del candidato.\n"
        f"Esito: {evaluation.outcome}\n"
        f"Punteggio: {evaluation.score}/17\n"
        f"Anni di esperienza pertinente: {evaluation.years}\n"
        f"Competenze tecniche rilevate: {skills}\n"
    )


def _rationale_from_facts(prompt: str) -> str:
    facts = dict(_FACT_LINE.findall(prompt))
    outcome = facts.get("Esito", "non_idoneo")
    score = facts.get("Punteggio", "0/17")
    years = facts.get("Anni di esperienza pertinente", "0")
    skills = facts.get("Competenze tecniche rilevate", "nessuna")
    base = (
        f"Punteggio {score} sulla base delle regole dichiarate: {years} anni di esperienza "
        f"pertinente, competenze tecniche rilevate: {skills}."
    )
    if outcome == "colloquio":
        return base + " Il profilo supera la soglia prevista per il colloquio."
    return base + " Il profilo non raggiunge la soglia minima prevista per questa posizione."


def rationale_for(evaluation: Evaluation, model: object) -> str:
    response = model.invoke([HumanMessage(content=_facts_prompt(evaluation))])  # type: ignore[attr-defined]
    return str(response.content).strip()


# --- The three tools sigillo records, one receipt each -----------------------

_MODEL: object = None


@tool
def leggi_curriculum(percorso_file: str, callbacks: CallbackManager | None = None) -> str:
    """Reads a candidate's CV from disk and records it as the input document for this action.

    `callbacks` is not something a caller passes: LangChain injects it because
    the parameter has this exact name. It is how this tool reaches the span
    OpenInference opened for its own call — see sigillo.artifact's docstring
    for why that span cannot be found any other way here.
    """
    percorso = pathlib.Path(percorso_file)
    span = sigillo.current_span_from_callbacks(callbacks)
    sigillo.artifact(percorso, role="input", label="curriculum", span=span)
    return percorso.read_text(encoding="utf-8")


@tool
def valuta_candidato(testo_curriculum: str) -> dict[str, object]:
    """Scores a CV against the declared, skills-only rubric and drafts a short rationale."""
    evaluation = evaluate_cv_text(testo_curriculum)
    rationale = rationale_for(evaluation, _MODEL)
    return {"score": evaluation.score, "outcome": evaluation.outcome, "rationale": rationale}


@tool
def invia_email(percorso_output: str, corpo: str, callbacks: CallbackManager | None = None) -> str:
    """Writes the reply email under outbox/ (no real send) and records it as the output document."""
    destinazione = pathlib.Path(percorso_output)
    destinazione.parent.mkdir(parents=True, exist_ok=True)
    destinazione.write_text(corpo, encoding="utf-8")
    span = sigillo.current_span_from_callbacks(callbacks)
    sigillo.artifact(destinazione, role="output", label="email di risposta", span=span)
    return f"email scritta in {destinazione}"


def compose_email(candidate_name: str, outcome: str) -> str:
    intro = (
        f"Gentile {candidate_name},\n\n"
        f"la ringraziamo per la candidatura alla posizione di {POSITION}. "
    )
    if outcome == "colloquio":
        body = (
            "Il suo profilo è in linea con i requisiti tecnici richiesti: la contatteremo "
            "a breve per fissare un colloquio."
        )
    else:
        body = (
            "Dopo una valutazione delle competenze tecniche e dell'esperienza richieste per "
            "il ruolo, non proseguiremo con il suo profilo in questa selezione. Le auguriamo "
            "il meglio per la ricerca."
        )
    return intro + body + "\n\nCordiali saluti,\nSelezione del personale\n"


# --- LangGraph wiring: read, score, reply — always in that order -------------


class CandidateState(TypedDict):
    file_path: str
    candidate_name: str
    cv_text: str
    score: int
    outcome: str
    rationale: str
    email_result: str


NAME_PATTERN = re.compile(r"^Nome:\s*(.+)$", re.MULTILINE)


def _read_node(state: CandidateState) -> dict[str, object]:
    text = leggi_curriculum.invoke({"percorso_file": state["file_path"]})
    match = NAME_PATTERN.search(text)
    name = match.group(1).strip() if match else "candidato"
    return {"cv_text": text, "candidate_name": name}


def _evaluate_node(state: CandidateState) -> dict[str, object]:
    result = valuta_candidato.invoke({"testo_curriculum": state["cv_text"]})
    return {"score": result["score"], "outcome": result["outcome"], "rationale": result["rationale"]}


def _email_node(state: CandidateState) -> dict[str, object]:
    body = compose_email(state["candidate_name"], state["outcome"])
    output_path = str(OUTBOX_DIR / f"{pathlib.Path(state['file_path']).stem}-risposta.txt")
    result = invia_email.invoke({"percorso_output": output_path, "corpo": body})
    return {"email_result": result}


def build_graph():
    graph = StateGraph(CandidateState)
    graph.add_node("leggi", _read_node)
    graph.add_node("valuta", _evaluate_node)
    graph.add_node("invia", _email_node)
    graph.add_edge(START, "leggi")
    graph.add_edge("leggi", "valuta")
    graph.add_edge("valuta", "invia")
    graph.add_edge("invia", END)
    return graph.compile()


# --- "On behalf of": every action in this run acts for the same recruiter ---


class OnBehalfOfProcessor(SpanProcessor):
    """Stamps every span with the recruiter this run acts for.

    Must run at `on_start`: a span refuses attribute changes once it has
    ended, and the exporter only ever sees a span at `on_end`.
    """

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

    tracing = sigillo.init(
        endpoint=endpoint, api_key=api_key, system_id=SYSTEM_ID, instrument=["langchain"]
    )
    tracing.provider.add_span_processor(OnBehalfOfProcessor(RECRUITER_ID))

    _MODEL, ollama_url = build_model()
    print(f"model: {'Ollama at ' + ollama_url if ollama_url else 'deterministic fake (no OLLAMA_URL reachable)'}")

    OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
    agent = build_graph()

    files = sorted(CURRICULA_DIR.glob("candidato-*.txt"))
    if not files:
        print(f"no CVs found in {CURRICULA_DIR}", file=sys.stderr)
        return 2

    counts = {"colloquio": 0, "non_idoneo": 0}
    for path in files:
        result = agent.invoke({"file_path": str(path)})
        counts[result["outcome"]] += 1
        print(f"{path.stem}: {result['candidate_name']:<20} punteggio={result['score']:>2} esito={result['outcome']}")

    tracing.flush()
    tracing.shutdown()

    print(f"\n{len(files)} candidature valutate: {counts['colloquio']} colloquio, {counts['non_idoneo']} non idoneo.")
    print("receipts sent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
