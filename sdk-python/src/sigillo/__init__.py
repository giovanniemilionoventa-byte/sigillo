"""Send an AI agent's actions to a sigillo server.

There is one function to call to start:

    import sigillo
    sigillo.init(
        endpoint="https://sigillo.example/",
        api_key="sigillo_...",
        system_id="acme-support-bot",
    )

After that, any OpenInference instrumentation this package turned on emits
spans, and the sigillo server turns them into signed receipts. Nothing else in
your code changes.

A second function, `sigillo.artifact(...)`, attaches a document's fingerprint
(never its content) to the action being recorded, and `ollama_url` on `init`
lets a locally-run model's digest ride along on its own receipt. Both are
optional: code that calls neither behaves exactly as before. A third,
`sigillo.current_span_from_callbacks(...)`, is the one piece most LangChain
tools need alongside `artifact`: see its docstring.

What this package does not do: it does not sign anything, and it does not decide
where a receipt lands. The API key does: a key belongs to exactly one system,
and the server writes to that system's chain whatever `system_id` says here.
`system_id` becomes the OpenTelemetry `service.name`, which the server falls
back to when a span does not name its agent.
"""

from __future__ import annotations

# Imported under private names: this package's public surface is init and
# artifact, and a stray `sigillo.TracerProvider` would be part of it otherwise.
import hashlib as _hashlib
import json as _json
import logging as _logging
import mimetypes as _mimetypes
import os as _os
import pathlib as _pathlib
import urllib.request as _urllib_request
from typing import Sequence as _Sequence

from opentelemetry import trace as _trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter as _OTLPSpanExporter,
)
from opentelemetry.sdk.resources import Resource as _Resource
from opentelemetry.sdk.trace import ReadableSpan as _ReadableSpan
from opentelemetry.sdk.trace import Span as _Span
from opentelemetry.sdk.trace import SpanProcessor as _SpanProcessor
from opentelemetry.sdk.trace import TracerProvider as _TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor as _BatchSpanProcessor

__all__ = ["init", "artifact", "current_span_from_callbacks", "Tracing"]
__version__ = "0.1.0"

_LOG = _logging.getLogger("sigillo")
_TRACES_PATH = "/v1/traces"
_SUPPORTED = ("langchain", "crewai", "openai")
_ARTIFACT_ROLES = ("input", "output")
# Both dialects an LLM span's model name arrives under, tried in order.
_MODEL_NAME_ATTRIBUTES = ("gen_ai.request.model", "gen_ai.response.model", "llm.model_name")


class Tracing:
    """What `init` hands back. Holding on to it is optional."""

    def __init__(
        self,
        provider: _TracerProvider,
        system_id: str,
        endpoint: str,
        instrumented: tuple[str, ...],
    ) -> None:
        self.provider = provider
        self.system_id = system_id
        self.endpoint = endpoint
        self.instrumented = instrumented

    def flush(self, timeout_millis: int = 30_000) -> bool:
        """Sends whatever is still buffered. Call this before a short process exits."""
        return self.provider.force_flush(timeout_millis)

    def shutdown(self) -> None:
        self.provider.shutdown()

    def __repr__(self) -> str:
        return (
            f"Tracing(system_id={self.system_id!r}, endpoint={self.endpoint!r}, "
            f"instrumented={self.instrumented!r})"
        )


def _traces_endpoint(endpoint: str) -> str:
    """Accepts the server's base URL or the full traces URL, and returns the latter."""
    cleaned = endpoint.strip().rstrip("/")
    if not cleaned:
        raise ValueError("endpoint must not be empty")
    if cleaned.endswith(_TRACES_PATH):
        return cleaned
    return cleaned + _TRACES_PATH


def _instrument(name: str, provider: _TracerProvider) -> bool:
    try:
        if name == "langchain":
            from openinference.instrumentation.langchain import LangChainInstrumentor

            LangChainInstrumentor().instrument(tracer_provider=provider)
        elif name == "crewai":
            from openinference.instrumentation.crewai import CrewAIInstrumentor

            CrewAIInstrumentor().instrument(tracer_provider=provider)
        else:
            from openinference.instrumentation.openai import OpenAIInstrumentor

            OpenAIInstrumentor().instrument(tracer_provider=provider)
    except ImportError:
        _LOG.warning(
            "sigillo: %s instrumentation was requested but is not installed; "
            "install it with: pip install 'sigillo[%s]'",
            name,
            name,
        )
        return False
    return True


def _fetch_ollama_digests(ollama_url: str) -> dict[str, str]:
    """`{model name: digest}`, read once from Ollama's own model list.

    Any failure here — Ollama not running, an unexpected response, a network
    hiccup — is not this SDK's problem to raise: the digest is an enrichment,
    never a requirement to record an action, so a broad catch is deliberate.
    """
    url = ollama_url.rstrip("/") + "/api/tags"
    try:
        with _urllib_request.urlopen(url, timeout=5) as response:  # noqa: S310
            payload = _json.loads(response.read())
        entries = payload.get("models", []) if isinstance(payload, dict) else []
    except Exception as error:  # noqa: BLE001 - see docstring
        _LOG.warning("sigillo: could not read model digests from Ollama at %s: %s", url, error)
        return {}

    digests: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        digest = entry.get("digest")
        if not isinstance(digest, str) or not digest:
            continue
        # Ollama has published the same model under both keys across versions.
        for key in ("name", "model"):
            name = entry.get(key)
            if isinstance(name, str) and name:
                digests[name] = digest
    return digests


class _ModelDigestProcessor(_SpanProcessor):
    """Stamps `sigillo.model.digest` on an LLM span, from a digest map read once at `init`.

    Runs at `on_start`, not `on_end`: a span refuses attributes once it has
    ended, and a well-behaved instrumentation sets the model name as part of
    the span's initial attributes, precisely so that early hooks like this one
    can see it.
    """

    def __init__(self, digests: dict[str, str]) -> None:
        self._digests = digests

    def on_start(self, span: _Span, parent_context: object = None) -> None:
        if not self._digests:
            return
        attributes = span.attributes or {}
        for key in _MODEL_NAME_ATTRIBUTES:
            name = attributes.get(key)
            if isinstance(name, str) and name in self._digests:
                span.set_attribute("sigillo.model.digest", self._digests[name])
                return

    def on_end(self, span: _ReadableSpan) -> None:
        return None

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        return True


def init(
    endpoint: str,
    api_key: str,
    system_id: str,
    instrument: _Sequence[str] = _SUPPORTED,
    ollama_url: str | None = None,
) -> Tracing:
    """Point OpenTelemetry at a sigillo server and turn on the instrumentations.

    Args:
        endpoint: the server's base URL, or its full `/v1/traces` URL.
        api_key: the key issued with `sigillo-server key create`. It decides
            which system's chain the receipts join.
        system_id: reported as `service.name`.
        instrument: which OpenInference instrumentations to enable. One that is
            not installed is skipped with a warning, not an error, so that a
            deployment with only LangChain does not have to install CrewAI.
        ollama_url: when given, `GET {ollama_url}/api/tags` is read once, here,
            and the digest of the model actually used is added to each LLM
            span as `sigillo.model.digest`. If Ollama does not answer, `init`
            still succeeds: the digest is simply absent, and this is logged
            rather than raised.

    Returns:
        A handle with `flush()` and `shutdown()`, and the list of the
        instrumentations that were actually turned on.
    """
    if not api_key:
        raise ValueError("api_key must not be empty")
    if not system_id:
        raise ValueError("system_id must not be empty")

    unknown = [name for name in instrument if name not in _SUPPORTED]
    if unknown:
        raise ValueError(
            f"unknown instrumentation {unknown}, this version knows {list(_SUPPORTED)}"
        )

    traces_endpoint = _traces_endpoint(endpoint)
    provider = _TracerProvider(resource=_Resource.create({"service.name": system_id}))

    if ollama_url:
        provider.add_span_processor(_ModelDigestProcessor(_fetch_ollama_digests(ollama_url)))

    provider.add_span_processor(
        _BatchSpanProcessor(
            _OTLPSpanExporter(
                endpoint=traces_endpoint,
                headers={"Authorization": f"Bearer {api_key}"},
            )
        )
    )

    # Instrumentations are attached to this provider explicitly, so they keep
    # working even where the global provider was already set by something else.
    _trace.set_tracer_provider(provider)
    instrumented = tuple(name for name in instrument if _instrument(name, provider))

    return Tracing(
        provider=provider,
        system_id=system_id,
        endpoint=traces_endpoint,
        instrumented=instrumented,
    )


def artifact(
    data: bytes | str | _os.PathLike,
    role: str,
    label: str,
    media_type: str | None = None,
    span: _Span | None = None,
) -> None:
    """Attaches a document's fingerprint to the action being recorded right now.

    `data` is the document itself — raw `bytes`, a `str` of exact text content
    (hashed as its UTF-8 bytes), or a path to read it from — never a filename
    to describe it with: `label` is that, a category such as `"curriculum"`,
    chosen so it cannot carry a person's name. Hashing happens here, in this
    process; only the digest is attached to the span, as an event named
    `sigillo.artifact`. The document's content is never sent anywhere.

    By default this attaches to the current span (whatever the instrumentation
    already opened for this action); if there is none, it logs a warning and
    does nothing, since there would be no action for the fingerprint to attach
    to. Pass `span` explicitly to attach to a specific one instead — needed
    for OpenInference's LangChain integration, which opens a span without ever
    making it "current" in OpenTelemetry's sense (deliberately: it must not
    risk leaving a context attached if a callback fails partway through).
    `current_span_from_callbacks` finds that span from inside a `@tool`.
    """
    if role not in _ARTIFACT_ROLES:
        raise ValueError(f"role must be one of {_ARTIFACT_ROLES}, got {role!r}")

    target = span if span is not None else _trace.get_current_span()
    if not target.is_recording():
        _LOG.warning("sigillo.artifact() called with no action being recorded; nothing was attached")
        return

    raw, default_media_type = _artifact_bytes(data)
    target.add_event(
        "sigillo.artifact",
        attributes={
            "sigillo.artifact.role": role,
            "sigillo.artifact.label": label,
            "sigillo.artifact.media_type": media_type or default_media_type,
            "sigillo.artifact.sha256": _hashlib.sha256(raw).hexdigest(),
        },
    )


def current_span_from_callbacks(callbacks: object) -> _Span | None:
    """The span a callback-based instrumentation opened for the run behind `callbacks`.

    LangChain injects a `CallbackManager` into a `@tool` function that declares
    a `callbacks` parameter; its handlers include OpenInference's LangChain
    tracer, which — unlike most instrumentations — keeps its spans out of
    OpenTelemetry's context (see `artifact`'s docstring for why) and only
    exposes them through its own `get_span(run_id)`. This walks `callbacks` to
    find that span, for passing to `artifact(..., span=...)`. LangChain itself
    is never imported here: everything is read with `getattr`, against
    whatever object was passed in.

        def leggi_curriculum(percorso_file: str, callbacks: CallbackManager | None = None) -> str:
            span = sigillo.current_span_from_callbacks(callbacks)
            sigillo.artifact(percorso_file, role="input", label="curriculum", span=span)
            ...

    Returns `None` when `callbacks` is `None`, carries no run, or none of its
    handlers expose a span this way — `artifact` then falls back to its usual
    warning rather than raising.
    """
    if callbacks is None:
        return None
    parent_run_id = getattr(callbacks, "parent_run_id", None)
    if parent_run_id is None:
        return None
    for handler in getattr(callbacks, "handlers", []):
        get_span = getattr(handler, "get_span", None)
        if callable(get_span):
            found = get_span(parent_run_id)
            if found is not None:
                return found
    return None


def _artifact_bytes(data: bytes | str | _os.PathLike) -> tuple[bytes, str]:
    """The exact bytes to fingerprint, and a media type to fall back to."""
    if isinstance(data, str):
        return data.encode("utf-8"), "text/plain"
    if isinstance(data, (bytes, bytearray)):
        return bytes(data), "application/octet-stream"
    path = _pathlib.Path(_os.fspath(data))
    guessed, _encoding = _mimetypes.guess_type(path.name)
    return path.read_bytes(), guessed or "application/octet-stream"
