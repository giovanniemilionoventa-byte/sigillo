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
tools need alongside `artifact`: see its docstring. A fourth,
`sigillo.pseudonym(...)`, turns an identifier into an opaque stand-in before it
goes into `on_behalf_of` — see its docstring.

By default, `init` also hashes a span's input and output right here, before
anything is sent, instead of letting the raw text travel to the server: see
`redact_content` below.

What this package does not do: it does not sign anything, and it does not decide
where a receipt lands. The API key does: a key belongs to exactly one system,
and the server writes to that system's chain whatever `system_id` says here.
`system_id` becomes the OpenTelemetry `service.name`, which the server falls
back to when a span does not name its agent.
"""

from __future__ import annotations

# Imported under private names: this package's public surface is init,
# artifact, current_span_from_callbacks and pseudonym, and a stray
# `sigillo.TracerProvider` would be part of it otherwise.
import hashlib as _hashlib
import hmac as _hmac
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
from opentelemetry.sdk.trace.export import SpanExportResult as _SpanExportResult

__all__ = ["init", "artifact", "current_span_from_callbacks", "pseudonym", "Tracing"]
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


# Fase 9, decision D6. Which attribute holds a span's input or output — and so
# gets replaced with a digest, never sent as it arrived — under either
# convention this package's instrumentations, or a future one, might use. The
# OpenInference names are what LangChain, CrewAI and the OpenAI instrumentation
# actually emit today; the GenAI names are not emitted by anything `init` turns
# on yet, listed anyway so that this stays in step with what
# apps/server/src/ingest/adapter.ts itself treats as content, dialect for
# dialect, if a GenAI-convention instrumentation is ever added to _SUPPORTED.
_CONTENT_ATTRIBUTES: dict[str, str] = {
    "input.value": "sigillo.input.sha256",
    "gen_ai.input.messages": "sigillo.input.sha256",
    "gen_ai.prompt": "sigillo.input.sha256",
    "output.value": "sigillo.output.sha256",
    "gen_ai.output.messages": "sigillo.output.sha256",
    "gen_ai.completion": "sigillo.output.sha256",
}

# Everything else the server adapter actually reads from a span's attributes —
# identifiers and categories, never a value an agent produced. An attribute
# not named here, and not one of _CONTENT_ATTRIBUTES' keys, does not leave
# this process once the filter is on: see `redact_content` on `init`.
_KEEP_ATTRIBUTES = frozenset(
    {
        "gen_ai.operation.name",
        "gen_ai.tool.name",
        "gen_ai.tool.type",
        "gen_ai.request.model",
        "gen_ai.response.model",
        "gen_ai.agent.name",
        "gen_ai.provider.name",
        "gen_ai.system",
        "openinference.span.kind",
        "tool.name",
        "llm.model_name",
        "llm.provider",
        "llm.system",
        "user.id",
        "enduser.id",
        "sigillo.model.digest",
    }
)


def _hash_content_value(value: str) -> str:
    """The digest `apps/server/src/ingest/adapter.ts` computes for a text
    attribute: SHA-256 of the RFC 8785 canonical JSON form of the string.

    For a plain string that form is exactly `json.dumps(value,
    ensure_ascii=False)` — verified against `packages/core`'s
    `hashCanonicalJson`, the same function the server itself calls, over more
    than 2000 arbitrary strings in fase 8, and cross-checked again for real in
    `sdk-python/tests/test_init.py`.
    """
    return _hashlib.sha256(_json.dumps(value, ensure_ascii=False).encode("utf-8")).hexdigest()


def _filtered_attributes(attributes: object) -> dict[str, object]:
    kept: dict[str, object] = {}
    if not attributes:
        return kept
    for key, value in attributes.items():  # type: ignore[union-attr]
        digest_name = _CONTENT_ATTRIBUTES.get(key)
        if digest_name is not None:
            if isinstance(value, str) and digest_name not in kept:
                kept[digest_name] = _hash_content_value(value)
            continue
        if key in _KEEP_ATTRIBUTES:
            kept[key] = value
    return kept


def _filtered_span(span: _ReadableSpan) -> _ReadableSpan:
    """A copy of `span`, its attributes replaced — nothing else about it
    changes: same name, same timing, same trace, same events (so
    `sigillo.artifact`, which never carried content in the first place, is
    untouched). `ReadableSpan.attributes` is read-only past `on_end` (OpenTelemetry
    marks a span's own attribute mapping immutable the moment it ends), so this
    builds a new `ReadableSpan` rather than editing the one that arrived.
    """
    return _ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=_filtered_attributes(span.attributes),
        events=span.events,
        links=span.links,
        kind=span.kind,
        status=span.status,
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
    )


class _ContentFilteringExporter(_OTLPSpanExporter):
    """The real OTLP exporter, wrapped: every span is rewritten by
    `_filtered_span` before it is handed to the exporter that serialises and
    sends it, so a value this build does not need to see never leaves this
    process (fase 9, decision D6).
    """

    def export(self, spans: _Sequence[_ReadableSpan]) -> _SpanExportResult:
        return super().export([_filtered_span(span) for span in spans])


def init(
    endpoint: str,
    api_key: str,
    system_id: str,
    instrument: _Sequence[str] = _SUPPORTED,
    ollama_url: str | None = None,
    redact_content: bool = True,
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
        redact_content: true by default. Hashes a span's input and output
            right here, with SHA-256, before anything is sent, and drops every
            other attribute the server does not read (a tool's docstring, a
            framework's own metadata, the full text of every message).
            Without it, the raw text an instrumentation attached travels to
            the server exactly as before this version — that was every
            version's behaviour before fase 9 of the pilot plan, kept for
            whoever explicitly asks for it. The server, either way, still
            stores only a digest: this setting decides what crosses the
            network and sits in the server's memory while a request is
            handled, not what a receipt ends up holding.

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

    exporter_class = _ContentFilteringExporter if redact_content else _OTLPSpanExporter
    provider.add_span_processor(
        _BatchSpanProcessor(
            exporter_class(
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


def pseudonym(value: str, key: bytes | str) -> str:
    """An opaque stand-in for `value`, to pass as `on_behalf_of` in place of it.

    `actor.on_behalf_of` is the one field an instrumentation is likely to fill
    with a real identifier (`user.id`, `enduser.id`) by convention, not by
    choice of the person integrating sigillo (see
    docs/DATA-INVENTORY.md and docs/PROPOSTA-FASE-4.md, decision D1). Once it
    is in a receipt it cannot be corrected or erased, so this turns the
    identifier into something opaque before it ever gets there:

        actor_id = sigillo.pseudonym(user_id, key=os.environ["SIGILLO_PSEUDONYM_KEY"])
        # set it as the user.id / enduser.id attribute the instrumentation
        # reads, or pass it through wherever your framework lets you name
        # who an action is for.

    `key` never leaves this process and is never sent to sigillo: it is HMAC-
    SHA256(`key`, `value`), truncated to 32 hex characters and prefixed `p:`,
    so the result fits `on_behalf_of`'s 64-character limit with room to
    spare. The same `value` and `key` always give the same pseudonym — useful
    for spotting the same actor across receipts — and a different `key`
    (which only the caller holds) gives an unrelated one: without it, the
    pseudonym does not lead back to `value`. It is still a personal
    identifier for whoever holds the key, not an anonymisation.

    Raises `ValueError` if `key` is empty: an empty key is not a secret.
    """
    key_bytes = key.encode("utf-8") if isinstance(key, str) else key
    if not key_bytes:
        raise ValueError("key must not be empty")
    digest = _hmac.new(key_bytes, value.encode("utf-8"), _hashlib.sha256).hexdigest()
    return f"p:{digest[:32]}"


def _artifact_bytes(data: bytes | str | _os.PathLike) -> tuple[bytes, str]:
    """The exact bytes to fingerprint, and a media type to fall back to."""
    if isinstance(data, str):
        return data.encode("utf-8"), "text/plain"
    if isinstance(data, (bytes, bytearray)):
        return bytes(data), "application/octet-stream"
    path = _pathlib.Path(_os.fspath(data))
    guessed, _encoding = _mimetypes.guess_type(path.name)
    return path.read_bytes(), guessed or "application/octet-stream"
