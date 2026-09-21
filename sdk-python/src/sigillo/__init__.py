"""Send an AI agent's actions to a sigillo server.

There is one function to call:

    import sigillo
    sigillo.init(
        endpoint="https://sigillo.example/",
        api_key="sigillo_...",
        system_id="acme-support-bot",
    )

After that, any OpenInference instrumentation this package turned on emits
spans, and the sigillo server turns them into signed receipts. Nothing else in
your code changes.

What this package does not do: it does not sign anything, and it does not decide
where a receipt lands. The API key does: a key belongs to exactly one system,
and the server writes to that system's chain whatever `system_id` says here.
`system_id` becomes the OpenTelemetry `service.name`, which the server falls
back to when a span does not name its agent.
"""

from __future__ import annotations

# Imported under private names: this package's surface is one function, and a
# stray `sigillo.TracerProvider` would be part of it otherwise.
import logging as _logging
from typing import Sequence as _Sequence

from opentelemetry import trace as _trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter as _OTLPSpanExporter,
)
from opentelemetry.sdk.resources import Resource as _Resource
from opentelemetry.sdk.trace import TracerProvider as _TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor as _BatchSpanProcessor

__all__ = ["init", "Tracing"]
__version__ = "0.1.0"

_LOG = _logging.getLogger("sigillo")
_TRACES_PATH = "/v1/traces"
_SUPPORTED = ("langchain", "crewai")


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
        else:
            from openinference.instrumentation.crewai import CrewAIInstrumentor

            CrewAIInstrumentor().instrument(tracer_provider=provider)
    except ImportError:
        _LOG.warning(
            "sigillo: %s instrumentation was requested but is not installed; "
            "install it with: pip install 'sigillo[%s]'",
            name,
            name,
        )
        return False
    return True


def init(
    endpoint: str,
    api_key: str,
    system_id: str,
    instrument: _Sequence[str] = _SUPPORTED,
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
