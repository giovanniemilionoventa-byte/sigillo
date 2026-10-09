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
goes into `on_behalf_of` — see its docstring. The handle `init` returns has
`tool(...)`, for a tool call written by hand: it records the call with its
outcome, and without the exception's text when it fails.

By default, `init` also hashes a span's input and output right here, before
anything is sent, instead of letting the raw text travel to the server: see
`redact_content` below.

`init` also starts a heartbeat: every minute, busy or idle, the agent tells
the server it is still connected, so that an agent whose sigillo code was
removed, or whose process or computer stopped, shows on the chain as
disconnected from its last beat on. See `heartbeat_seconds` below. Each beat
also carries the SHA-256 of the agent's main script, so that a script edited
while the agent runs (or before it restarts) is written on the chain too, and
`strict=True` makes the agent stop when that happens or when it cannot record.

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
import atexit as _atexit
import contextlib as _contextlib
import hashlib as _hashlib
import hmac as _hmac
import json as _json
import logging as _logging
import mimetypes as _mimetypes
import os as _os
import pathlib as _pathlib
import secrets as _secrets
import subprocess as _subprocess
import sys as _sys
import threading as _threading
import urllib.request as _urllib_request
from typing import Callable as _Callable
from typing import Iterator as _Iterator
from typing import Sequence as _Sequence

from opentelemetry import trace as _trace
from opentelemetry.trace import Status as _Status
from opentelemetry.trace import StatusCode as _StatusCode
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter as _OTLPSpanExporter,
)
from opentelemetry.sdk.resources import Resource as _Resource
from opentelemetry.sdk.trace import ReadableSpan as _ReadableSpan
from opentelemetry.sdk.trace import Event as _Event
from opentelemetry.sdk.trace import Span as _Span
from opentelemetry.sdk.trace import SpanProcessor as _SpanProcessor
from opentelemetry.sdk.trace import TracerProvider as _TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor as _BatchSpanProcessor
from opentelemetry.sdk.trace.export import SpanExportResult as _SpanExportResult
from . import _text, _watchdog

__all__ = ["init", "artifact", "current_span_from_callbacks", "pseudonym", "Tracing"]
__version__ = "0.4.0"

_LOG = _logging.getLogger("sigillo")
_TRACES_PATH = "/v1/traces"
_HEARTBEAT_PATH = "/api/v1/heartbeat"
# What `init` tries when `instrument=` is not given. "stdlib" (see _stdlib.py)
# is not among them: it hooks urllib and file writing in the whole process, so
# it is turned on only by naming it.
_DEFAULT_INSTRUMENT = ("langchain", "crewai", "openai")
_SUPPORTED = _DEFAULT_INSTRUMENT + ("stdlib",)
_ARTIFACT_ROLES = ("input", "output")
# Both dialects an LLM span's model name arrives under, tried in order.
_MODEL_NAME_ATTRIBUTES = ("gen_ai.request.model", "gen_ai.response.model", "llm.model_name")


_STRICT_MISSED_BEATS = 3


def _main_script() -> str | None:
    """The path of the program's main script, or None where there is none (a
    notebook, an interactive session)."""
    path = getattr(_sys.modules.get("__main__"), "__file__", None)
    return str(path) if path else None


def _hash_of_file(path: str) -> str | None:
    """SHA-256 of a file's bytes, or None when it can no longer be read."""
    try:
        with open(path, "rb") as handle:
            return _hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return None


def _halt_process(reason: str) -> None:
    """What strict mode does by default: say why on standard error and end the process."""
    _sys.stderr.write(f"sigillo: stopping this agent: {reason}\n")
    _sys.stderr.flush()
    _os._exit(70)


class _Heartbeat:
    """Tells the server, every `interval` seconds, that this agent is still
    connected: `start` once, `beat` while the process runs (whether the agent
    is working or idle), `stop` when it closes normally. The server writes a
    receipt on the chain when the agent connects, closes, goes silent without
    closing (the code removed, the process killed, the computer switched off,
    the network cut) and comes back; an ordinary beat writes nothing.

    Runs on a daemon thread, so it never keeps a process alive. A beat that
    does not get through is logged and not retried: the next one says the
    same thing.
    """

    def __init__(
        self,
        url: str,
        api_key: str,
        interval: float,
        show: bool = False,
        strict: bool = False,
        on_halt: _Callable[[str], None] | None = None,
        guard_seconds: float = 5.0,
    ) -> None:
        self._url = url
        self._show = show
        self._strict = strict
        self._on_halt = on_halt or _halt_process
        self._halted = False
        self._missed = 0
        # The main script is found once, here; its bytes are read at every beat.
        self._script = _main_script()
        self._api_key = api_key
        self._guard: _subprocess.Popen | None = None
        self._guard_period = guard_seconds
        self._headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        self._interval = interval
        self.session = _secrets.token_hex(16)
        self._stopped = _threading.Event()
        self._closed = False
        self._lock = _threading.Lock()
        self._thread = _threading.Thread(target=self._run, name="sigillo-heartbeat", daemon=True)

    def start(self) -> None:
        # Strict mode that ends the process by itself also starts the guard
        # process (_watchdog.py); an `on_halt` of the caller's own replaces how
        # the agent is stopped, so there is nothing for a guard to kill.
        if self._strict and self._on_halt is _halt_process:
            self._start_guard()
        self._thread.start()
        # A process that ends without calling shutdown() still says it closed.
        _atexit.register(self.close)

    def _start_guard(self) -> None:
        directory = _os.path.dirname(_os.path.abspath(_watchdog.__file__))
        config = {
            "url": self._url,
            "api_key": self._api_key,
            "session": self.session,
            "script": self._script,
            "script_hash": _hash_of_file(self._script) if self._script is not None else None,
            "sdk_hash": _watchdog.package_hash(directory),
            "parent": _os.getpid(),
            "period": self._guard_period,
        }
        try:
            guard = _subprocess.Popen(
                [_sys.executable, "-I", _watchdog.__file__],
                stdin=_subprocess.PIPE,
                stdout=_subprocess.DEVNULL,
                text=True,
            )
            assert guard.stdin is not None
            guard.stdin.write(_json.dumps(config) + "\n")
            guard.stdin.flush()
        except (OSError, AssertionError) as error:
            _LOG.warning("sigillo guard process not started: %s", type(error).__name__)
            return
        self._guard = guard

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._stopped.set()
        self._thread.join(timeout=self._interval + 15)
        self._send("stop")
        if self._guard is not None and self._guard.stdin is not None:
            self._guard.stdin.close()
        _atexit.unregister(self.close)

    def _run(self) -> None:
        self._send("start")
        while not self._stopped.wait(self._interval):
            self._send("beat")

    def _send(self, event: str) -> None:
        payload: dict[str, object] = {"session": self.session, "event": event}
        if self._script is not None and event != "stop":
            payload["script_hash"] = _hash_of_file(self._script)
        if event != "stop":
            payload["sdk_hash"] = _watchdog.package_hash(_os.path.dirname(_os.path.abspath(_watchdog.__file__)))
            if self._guard is not None and self._guard.poll() is not None:
                self._halt("the sigillo guard process is no longer running")
        body = _json.dumps(payload).encode("utf-8")
        if self._show:
            _show_sent("heartbeat", body.decode("utf-8"))
        request = _urllib_request.Request(self._url, data=body, headers=self._headers, method="POST")
        try:
            with _urllib_request.urlopen(request, timeout=10) as response:
                answer = response.read()
        except Exception as error:  # noqa: BLE001 - a heartbeat must never take the agent down
            _LOG.warning("sigillo heartbeat %r not delivered: %s", event, type(error).__name__)
            if event != "stop":
                self._missed += 1
                if self._missed >= _STRICT_MISSED_BEATS:
                    self._halt(f"sigillo could not record for {self._missed} heartbeats in a row")
            return
        self._missed = 0
        try:
            changed = _json.loads(answer).get("script_changed") is True
        except (ValueError, AttributeError):
            changed = False
        if changed:
            self._halt("this agent's script is not the one it started with")

    def _halt(self, reason: str) -> None:
        """Strict mode only, and once: the agent is told to stop."""
        if not self._strict or self._halted:
            return
        self._halted = True
        _LOG.critical("sigillo strict mode: %s", reason)
        self._on_halt(reason)


class Tracing:
    """What `init` hands back. Holding on to it is optional."""

    def __init__(
        self,
        provider: _TracerProvider,
        system_id: str,
        endpoint: str,
        instrumented: tuple[str, ...],
        heartbeat: _Heartbeat | None = None,
    ) -> None:
        self.provider = provider
        self.system_id = system_id
        self.endpoint = endpoint
        self.instrumented = instrumented
        self._heartbeat = heartbeat

    def flush(self, timeout_millis: int = 30_000) -> bool:
        """Sends whatever is still buffered. Call this before a short process exits."""
        return self.provider.force_flush(timeout_millis)

    def shutdown(self) -> None:
        """Sends what is buffered, then tells the server this agent closed normally."""
        self.provider.shutdown()
        if self._heartbeat is not None:
            self._heartbeat.close()

    @_contextlib.contextmanager
    def tool(self, name: str, agent: str | None = None) -> _Iterator[_Span]:
        """Records one tool call written by hand, with its outcome.

            with tracing.tool("scrivi_file", agent="agente-codice"):
                scrivi_file(percorso, testo)

        Sets the outcome explicitly. A block that returns is `ok`; one that
        raises is `error`, with the exception's class name as `error.type`,
        and the exception goes on unchanged. Its message and traceback are not
        attached: they can quote the very content this package keeps from
        leaving the process, and OpenTelemetry's own handling would send both.

        Tools run by LangChain, CrewAI or the OpenAI instrumentation do not
        need this: their instrumentation already reports the outcome.
        """
        if not name:
            raise ValueError("name must not be empty")
        attributes = {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name}
        if agent:
            attributes["gen_ai.agent.name"] = agent
        tracer = self.provider.get_tracer("sigillo")
        with tracer.start_as_current_span(
            f"execute_tool {name}",
            attributes=attributes,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                yield span
            except BaseException as error:
                span.set_attribute("error.type", type(error).__qualname__)
                span.set_status(_StatusCode.ERROR)
                raise
            span.set_status(_StatusCode.OK)

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


def _heartbeat_endpoint(traces_endpoint: str) -> str:
    """The heartbeat's URL, beside the traces URL on the same server."""
    return traces_endpoint[: -len(_TRACES_PATH)] + _HEARTBEAT_PATH


def _instrument(name: str, provider: _TracerProvider, requested: bool) -> bool:
    try:
        if name == "stdlib":
            from . import _stdlib

            _stdlib.install(provider)
        elif name == "langchain":
            from openinference.instrumentation.langchain import LangChainInstrumentor

            LangChainInstrumentor().instrument(tracer_provider=provider)
        elif name == "crewai":
            from openinference.instrumentation.crewai import CrewAIInstrumentor

            CrewAIInstrumentor().instrument(tracer_provider=provider)
        else:
            from openinference.instrumentation.openai import OpenAIInstrumentor

            OpenAIInstrumentor().instrument(tracer_provider=provider)
    except ImportError as error:
        # Only a missing instrumentation package is "not installed". An import
        # that fails inside it, or inside the framework it wraps (a DLL that
        # will not load, a dependency of the wrong version), is a different
        # problem, and saying "install it" would send the reader the wrong way.
        #
        # When `instrument=` was not given, every instrumentation is only tried:
        # one that is absent or will not start is not something the caller asked
        # for, so it is noted at debug level and nothing is printed.
        missing = isinstance(error, ModuleNotFoundError) and (error.name or "").startswith("openinference")
        if not requested:
            _LOG.debug("sigillo: %s instrumentation not turned on (%s: %s)", name, type(error).__name__, error)
        elif missing:
            _LOG.warning(
                "sigillo: %s instrumentation was requested but is not installed; "
                "install it with: pip install openinference-instrumentation-%s",
                name,
                name,
            )
        else:
            _LOG.warning(
                "sigillo: %s instrumentation is installed but could not start (%s: %s); "
                "the agent runs, but its %s calls are not recorded",
                name,
                type(error).__name__,
                error,
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
        "error.type",
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


# The nonce that goes with each digest when content is salted here.
_NONCE_ATTRIBUTES: dict[str, str] = {
    "sigillo.input.sha256": "sigillo.input.nonce",
    "sigillo.output.sha256": "sigillo.output.nonce",
}


def _salted_hash_content_value(value: str, nonce: bytes) -> str:
    """The salted digest `packages/core` defines (`saltedDigest`, FORMAT.md
    2.7): SHA-256 of the 32-byte nonce followed by the RFC 8785 canonical JSON
    form of the string. A short value ("score: 7") cannot be found from it
    without the nonce, which the server keeps apart and can erase.
    """
    return _hashlib.sha256(nonce + _json.dumps(value, ensure_ascii=False).encode("utf-8")).hexdigest()


def _filtered_attributes(attributes: object, salt: bool = True) -> dict[str, object]:
    kept: dict[str, object] = {}
    if not attributes:
        return kept
    for key, value in attributes.items():  # type: ignore[union-attr]
        digest_name = _CONTENT_ATTRIBUTES.get(key)
        if digest_name is not None:
            if isinstance(value, str) and digest_name not in kept:
                if salt:
                    nonce = _secrets.token_bytes(32)
                    kept[digest_name] = _salted_hash_content_value(value, nonce)
                    kept[_NONCE_ATTRIBUTES[digest_name]] = nonce.hex()
                else:
                    kept[digest_name] = _hash_content_value(value)
            continue
        if key in _KEEP_ATTRIBUTES:
            kept[key] = value
    return kept


def _filtered_event(event: _Event) -> _Event:
    """An `exception` event keeps its name and the exception's class, which is
    all the server reads (an exception with no status is *esito
    sconosciuto*); its message and traceback stay here, since they can quote
    the very content the attributes are filtered for. Every other event, such
    as `sigillo.artifact`'s, never carried content and goes as it is.
    """
    if event.name != "exception":
        return event
    kept = {key: value for key, value in (event.attributes or {}).items() if key == "exception.type"}
    return _Event(event.name, kept, event.timestamp)


def _filtered_span(span: _ReadableSpan, salt: bool = True) -> _ReadableSpan:
    """A copy of `span`, its attributes replaced, its exception events cut
    down to the exception's class (`_filtered_event`) and its status to its
    code: OpenTelemetry writes "ValueError: <the message>" as the description
    of a span an exception ended. Nothing else about it changes: same name,
    same timing, same trace, same other events (so `sigillo.artifact`, which
    never carried content in the first place, is untouched). `ReadableSpan.attributes` is read-only past `on_end` (OpenTelemetry
    marks a span's own attribute mapping immutable the moment it ends), so this
    builds a new `ReadableSpan` rather than editing the one that arrived.
    """
    return _ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=_filtered_attributes(span.attributes, salt),
        events=[_filtered_event(event) for event in span.events],
        links=span.links,
        kind=span.kind,
        status=_Status(span.status.status_code),
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

    def __init__(self, *args: object, salt: bool = True, show: bool = False, **kwargs: object) -> None:
        super().__init__(*args, **kwargs)  # type: ignore[arg-type]
        self._salt = salt
        self._show = show

    def export(self, spans: _Sequence[_ReadableSpan]) -> _SpanExportResult:
        filtered = [_filtered_span(span, self._salt) for span in spans]
        if self._show:
            for span in filtered:
                _show_span(span)
        return super().export(filtered)


class _ShowingExporter(_OTLPSpanExporter):
    """The plain OTLP exporter, for `redact_content=False`, showing each span
    before it goes when `show_sent` asks for it."""

    def export(self, spans: _Sequence[_ReadableSpan]) -> _SpanExportResult:
        for span in spans:
            _show_span(span)
        return super().export(spans)


def _show_sent(kind: str, what: str) -> None:
    """One line on standard error per thing sent, for `show_sent`: printed,
    not logged, so it appears whether or not the program configured logging."""
    print(f"[sigillo sends] {kind} {what}", file=_sys.stderr, flush=True)


def _show_span(span: _ReadableSpan) -> None:
    """Everything of a span the exporter is about to serialise that could
    carry a value: its name, attributes, status and events. Timing and trace
    identifiers are left out, being only numbers."""
    shown: dict[str, object] = {"name": span.name, "attributes": dict(span.attributes or {})}
    if span.status.status_code is not _StatusCode.UNSET:
        shown["status"] = span.status.status_code.name
        if span.status.description:
            shown["status_description"] = span.status.description
    if span.events:
        shown["events"] = [{"name": event.name, "attributes": dict(event.attributes or {})} for event in span.events]
    _show_sent("action", _json.dumps(shown, ensure_ascii=False, default=str))


def init(
    endpoint: str,
    api_key: str,
    system_id: str,
    instrument: _Sequence[str] | None = None,
    ollama_url: str | None = None,
    redact_content: bool = True,
    salt_content: bool = True,
    heartbeat_seconds: float = 60.0,
    show_sent: bool = False,
    strict: bool = False,
    on_halt: _Callable[[str], None] | None = None,
) -> Tracing:
    """Point OpenTelemetry at a sigillo server and turn on the instrumentations.

    Args:
        endpoint: the server's base URL, or its full `/v1/traces` URL.
        api_key: the key issued with `sigillo-server key create`. It decides
            which system's chain the receipts join.
        system_id: reported as `service.name`.
        instrument: which instrumentations to enable: "langchain", "crewai",
            "openai", and "stdlib" for an agent with no framework, which
            records its `urllib` calls (a model server, a web search) and its
            file writes, as digests. Left out, every OpenInference one that is
            installed is turned on and the others are passed over in silence;
            "stdlib" is only on when named. Named explicitly, one that is not installed is
            skipped with a warning, not an error, so that a deployment with
            only LangChain does not have to install CrewAI.
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
        salt_content: true by default, and only with `redact_content`. Each
            digest is salted with a fresh 32-byte nonce (FORMAT.md 2.7), sent
            alongside it as `sigillo.input.nonce` / `sigillo.output.nonce`:
            the receipt then holds a digest nobody can guess a short value
            from ("score: 7"), and the server keeps the nonce apart, where
            erasing it cuts the receipt off from its content. Needs a server
            that reads the nonce (October 2026 or later); an older one would
            record the salted digest as a plain one, so set this to false only
            for such a server.
        heartbeat_seconds: how often the agent tells the server it is still
            connected, 60 by default. The server calls an agent disconnected
            after three minutes without a beat, and writes that on the chain,
            so keep it well under that. The beat runs on its own thread from
            here on, whether the agent is busy or idle, and `shutdown()` (or
            the end of the process) sends a last one saying it closed.
        show_sent: false by default. When true, everything this package sends
            to the server is also printed on standard error, one line per
            action and per heartbeat, exactly as it leaves the process: what
            the agent said and received appears only as a digest. It is how a
            customer checks, on their own computer and without trusting
            sigillo, that no content leaves it.

        strict: false by default. When true, the agent stops itself, with a
            message on standard error and exit status 70, if the server says
            its main script is not the one it started with, or if three
            heartbeats in a row do not get through: it does not go on without
            the record. Each beat carries the SHA-256 of the main script
            file (the file `python` was started with, read again every beat,
            never its content); the server compares it with the one the
            session started with. Only a sigillo account with the script
            guard switched on is told anything, so for any other this does
            nothing about scripts, though the missed-beats rule still applies.
        on_halt: replaces how strict mode stops the agent: called once, from
            the heartbeat's thread, with the reason as a sentence. For a
            program that wants to shut down cleanly in its own way.

    Returns:
        A handle with `flush()` and `shutdown()`, and the list of the
        instrumentations that were actually turned on.
    """
    if not api_key:
        raise ValueError("api_key must not be empty")
    if not system_id:
        raise ValueError("system_id must not be empty")
    if not heartbeat_seconds > 0:
        raise ValueError("heartbeat_seconds must be a positive number of seconds")

    requested = instrument is not None
    if instrument is None:
        instrument = _DEFAULT_INSTRUMENT
    unknown = [name for name in instrument if name not in _SUPPORTED]
    if unknown:
        raise ValueError(
            f"unknown instrumentation {unknown}, this version knows {list(_SUPPORTED)}"
        )

    traces_endpoint = _traces_endpoint(endpoint)
    resource = {"service.name": system_id}
    if "stdlib" in instrument:
        # Says who is sending, so that the server can keep this to the accounts it is opened to.
        resource["sigillo.client"] = "stdlib"
    provider = _TracerProvider(resource=_Resource.create(resource))

    if ollama_url:
        provider.add_span_processor(_ModelDigestProcessor(_fetch_ollama_digests(ollama_url)))

    headers = {"Authorization": f"Bearer {api_key}"}
    exporter = (
        _ContentFilteringExporter(endpoint=traces_endpoint, headers=headers, salt=salt_content, show=show_sent)
        if redact_content
        else (_ShowingExporter if show_sent else _OTLPSpanExporter)(endpoint=traces_endpoint, headers=headers)
    )
    provider.add_span_processor(_BatchSpanProcessor(exporter))

    # Instrumentations are attached to this provider explicitly, so they keep
    # working even where the global provider was already set by something else.
    _trace.set_tracer_provider(provider)
    instrumented = tuple(name for name in instrument if _instrument(name, provider, requested))

    heartbeat = _Heartbeat(
        _heartbeat_endpoint(traces_endpoint), api_key, heartbeat_seconds, show=show_sent, strict=strict, on_halt=on_halt
    )
    heartbeat.start()

    return Tracing(
        provider=provider,
        system_id=system_id,
        endpoint=traces_endpoint,
        instrumented=instrumented,
        heartbeat=heartbeat,
    )


def artifact(
    data: bytes | str | _os.PathLike,
    role: str,
    label: str | None = None,
    media_type: str | None = None,
    span: _Span | None = None,
) -> None:
    """Attaches a document's fingerprint to the action being recorded right now.

    `data` is the document itself — raw `bytes`, a `str` of exact text content
    (hashed as its UTF-8 bytes), or a path to read it from — never a filename
    to describe it with: `label` is that, a category such as `"curriculum"`,
    chosen so it cannot carry a person's name. Without one, the label is the
    role and the media type (`"input application/pdf"`): never the file's
    name, which so often is a person's. Hashing happens here, in this
    process; only the digests are attached to the span, as an event named
    `sigillo.artifact`. The document's content is never sent anywhere.

    Two digests, for a text. `sha256` is always over the exact bytes. When
    the media type is `text/plain` (the default for a `str`, and for a
    `.txt` path) and the bytes are UTF-8, the event also carries the
    sigillo-text/1 fingerprint (docs/FORMAT.md, section 2.5.1), which a copy
    of the same text with other spacing, line breaks or invisible formatting
    characters shares, and one with any other difference does not. A PDF, an
    image, a CSV or any other type gets the exact digest only.

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
    effective_media_type = media_type or default_media_type
    attributes = {
        "sigillo.artifact.role": role,
        "sigillo.artifact.label": label or f"{role} {effective_media_type}",
        "sigillo.artifact.media_type": effective_media_type,
        "sigillo.artifact.sha256": _hashlib.sha256(raw).hexdigest(),
    }
    # A plain text also gets its sigillo-text/1 fingerprint, which a copy of
    # it with other spacing or line breaks shares; the exact one above keeps
    # its meaning. None for bytes that are not UTF-8 or hold only whitespace.
    text_digest = _text.text_sha256(raw) if _text.is_plain_text(effective_media_type) else None
    if text_digest is not None:
        attributes["sigillo.artifact.text_canon"] = _text.TEXT_CANON_1
        attributes["sigillo.artifact.text_sha256"] = text_digest
    target.add_event("sigillo.artifact", attributes=attributes)


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
