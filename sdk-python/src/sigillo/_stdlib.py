"""Record what a plain Python agent does, with no framework to instrument.

An agent that calls its model with `urllib`, `requests` or `httpx` and writes
its results with `pathlib` has no framework for an OpenInference
instrumentation to hook into. `install` hooks those libraries themselves, at
the places such an agent does its work, and turns each call into a span:

* `urllib.request.urlopen`: a call to a model server (Ollama, OpenAI-style,
  Anthropic, Gemini) is an LLM call named after the model; any other address is
  a tool call named after the host. The address and the request body travel
  only as digests (`input.value` goes through the SDK's content filter), never
  the address itself, which can carry the search a user typed.
* `requests` (`Session.send`) and `httpx` (`Client.send`, `AsyncClient.send`),
  where installed: the same two kinds of call, by the same rule.
* `pathlib.Path.write_text` and `write_bytes`, and `open()` in a writing mode:
  a tool call `write_file`, with the path as its input and, for `write_text`,
  the text as its output. Both only as digests.

What a call did not do is not recorded: the model's answer is read by the agent
after `urlopen` returns, so an LLM call has its request but no output.

Calls made by the standard library itself, by installed packages and by this
package (its own heartbeat, a log file being opened) are not recorded: only the
agent's own code is.
"""

from __future__ import annotations

import builtins as _builtins
import contextlib as _contextlib
import json as _json
import os as _os
import pathlib as _pathlib
import sys as _sys
import sysconfig as _sysconfig
import urllib.parse as _parse
import urllib.request as _request
from typing import Callable as _Callable
from typing import Iterator as _Iterator

from opentelemetry import trace as _trace
from opentelemetry.trace import StatusCode as _StatusCode

# The paths a model server answers on, per the servers an agent is likely to
# call. A request to any of them is an LLM call; its model is read from the
# request body (or from the path, for Gemini).
_MODEL_PATHS = (
    "/api/chat",
    "/api/generate",
    "/api/embeddings",
    "/api/embed",
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/responses",
    "/v1/messages",
)

_originals: dict[str, object] = {}
_patched: list[tuple[object, str, object]] = []
_tracer: _trace.Tracer | None = None


def _patch(label: str, owner: object, name: str, wrapper: object) -> None:
    _originals[label] = getattr(owner, name)
    _patched.append((owner, name, _originals[label]))
    setattr(owner, name, wrapper)


def install(provider: object) -> None:
    """Hooks the HTTP libraries and file writing so that their calls become
    spans of `provider`. Safe to call twice: the second call only replaces the
    provider. `requests` and `httpx` are hooked only if they are installed."""
    global _tracer
    _tracer = provider.get_tracer("sigillo.stdlib")  # type: ignore[attr-defined]
    if _originals:
        return
    _patch("urlopen", _request, "urlopen", _urlopen)
    _patch("write_text", _pathlib.Path, "write_text", _write_text)
    _patch("write_bytes", _pathlib.Path, "write_bytes", _write_bytes)
    _patch("open", _builtins, "open", _open)
    try:
        import requests
    except ImportError:
        pass
    else:
        _patch("requests", requests.Session, "send", _requests_send)
        _HTTP_PACKAGES.append(_os.path.dirname(requests.__file__))
    try:
        import httpx
    except ImportError:
        pass
    else:
        _patch("httpx", httpx.Client, "send", _httpx_send)
        _patch("httpx async", httpx.AsyncClient, "send", _httpx_async_send)
        _HTTP_PACKAGES.append(_os.path.dirname(httpx.__file__))


def uninstall() -> None:
    """Puts everything back as it was. For tests."""
    global _tracer
    for owner, name, original in _patched:
        setattr(owner, name, original)
    _patched.clear()
    _originals.clear()
    _HTTP_PACKAGES.clear()
    _tracer = None


# Where requests and httpx live: their own frames are skipped when asking who
# called them, since `requests.get` reaches `Session.send` through them.
_HTTP_PACKAGES: list[str] = []


_LIBRARY_ROOTS = tuple(
    {path for name in ("stdlib", "platstdlib", "purelib", "platlib") if (path := _sysconfig.get_paths().get(name))}
    | {_os.path.dirname(_os.path.abspath(__file__))}
)


def _from_the_agent(depth: int) -> bool:
    """Whether the code that called, `depth` frames up, is the agent's own, not
    the standard library's, an installed package's or this package's. Frames of
    requests and httpx themselves are passed over to find who called them."""
    try:
        frame = _sys._getframe(depth + 1)
    except ValueError:
        return False
    skip = tuple(_HTTP_PACKAGES)
    while skip and frame.f_back is not None and frame.f_code.co_filename.startswith(skip):
        frame = frame.f_back
    filename = frame.f_code.co_filename
    return not filename.startswith(_LIBRARY_ROOTS) and not filename.startswith("<frozen")


@_contextlib.contextmanager
def _span(name: str, attributes: dict[str, str]) -> _Iterator[None]:
    """One span, with its outcome set as `Tracing.tool` does: the exception's
    class and nothing of its message."""
    assert _tracer is not None
    with _tracer.start_as_current_span(
        name, attributes=attributes, record_exception=False, set_status_on_exception=False
    ) as span:
        try:
            yield
        except BaseException as error:
            span.set_attribute("error.type", type(error).__qualname__)
            span.set_status(_StatusCode.ERROR)
            raise
        span.set_status(_StatusCode.OK)


def _provider_of(host: str, port: int | None) -> str:
    host = host.lower()
    if port == 11434 or "ollama" in host:
        return "ollama"
    for fragment, name in (("openai", "openai"), ("anthropic", "anthropic"), ("googleapis", "google")):
        if fragment in host:
            return name
    return host


def _model_of(body: object, path: str) -> str:
    if isinstance(body, (bytes, str)):
        try:
            model = _json.loads(body).get("model")
        except (ValueError, AttributeError):
            model = None
        if isinstance(model, str) and model:
            return model
    if "/models/" in path:  # Gemini: /v1beta/models/<model>:generateContent
        return path.split("/models/", 1)[1].split(":", 1)[0]
    return "unknown"


def _url_attributes(url: object, body: object) -> tuple[str, dict[str, str]]:
    """The span's name and attributes for a call to `url`, sending `body`."""
    if not isinstance(url, str):
        return "http", {"openinference.span.kind": "TOOL", "tool.name": "http"}
    parsed = _parse.urlsplit(url)
    host = parsed.hostname or "unknown"
    if parsed.path.rstrip("/").endswith(_MODEL_PATHS) or ":generateContent" in parsed.path or ":streamGenerateContent" in parsed.path:
        model = _model_of(body, parsed.path)
        attributes = {
            "openinference.span.kind": "LLM",
            "llm.model_name": model,
            "llm.system": _provider_of(host, parsed.port),
        }
        if isinstance(body, bytes):
            attributes["input.value"] = body.decode("utf-8", "replace")
        elif isinstance(body, str):
            attributes["input.value"] = body
        return f"llm {model}", attributes
    return f"http {host}", {"openinference.span.kind": "TOOL", "tool.name": f"http {host}", "input.value": url}


def _urlopen(url, *args, **kwargs):  # type: ignore[no-untyped-def]
    original: _Callable = _originals["urlopen"]  # type: ignore[assignment]
    if _tracer is None or not _from_the_agent(1):
        return original(url, *args, **kwargs)
    name, attributes = _url_attributes(getattr(url, "full_url", url), getattr(url, "data", None))
    with _span(name, attributes):
        return original(url, *args, **kwargs)


def _requests_send(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
    original: _Callable = _originals["requests"]  # type: ignore[assignment]
    if _tracer is None or not _from_the_agent(1):
        return original(self, request, *args, **kwargs)
    name, attributes = _url_attributes(request.url, request.body)
    with _span(name, attributes):
        return original(self, request, *args, **kwargs)


def _httpx_body(request) -> bytes | None:  # type: ignore[no-untyped-def]
    try:
        return request.content
    except Exception:  # a streamed body that was not read: nothing to hash
        return None


def _httpx_send(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
    original: _Callable = _originals["httpx"]  # type: ignore[assignment]
    if _tracer is None or not _from_the_agent(1):
        return original(self, request, *args, **kwargs)
    name, attributes = _url_attributes(str(request.url), _httpx_body(request))
    with _span(name, attributes):
        return original(self, request, *args, **kwargs)


async def _httpx_async_send(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
    original: _Callable = _originals["httpx async"]  # type: ignore[assignment]
    if _tracer is None or not _from_the_agent(1):
        return await original(self, request, *args, **kwargs)
    name, attributes = _url_attributes(str(request.url), _httpx_body(request))
    with _span(name, attributes):
        return await original(self, request, *args, **kwargs)


def _write_attributes(path: object, text: str | None = None) -> dict[str, str]:
    attributes = {"openinference.span.kind": "TOOL", "tool.name": "write_file", "input.value": str(path)}
    if text is not None:
        attributes["output.value"] = text
    return attributes


def _write_text(self, data, *args, **kwargs):  # type: ignore[no-untyped-def]
    original: _Callable = _originals["write_text"]  # type: ignore[assignment]
    if _tracer is None or not _from_the_agent(1):
        return original(self, data, *args, **kwargs)
    with _span("write_file", _write_attributes(self, data if isinstance(data, str) else None)):
        return original(self, data, *args, **kwargs)


def _write_bytes(self, data, *args, **kwargs):  # type: ignore[no-untyped-def]
    original: _Callable = _originals["write_bytes"]  # type: ignore[assignment]
    if _tracer is None or not _from_the_agent(1):
        return original(self, data, *args, **kwargs)
    with _span("write_file", _write_attributes(self)):
        return original(self, data, *args, **kwargs)


def _open(file, mode="r", *args, **kwargs):  # type: ignore[no-untyped-def]
    original: _Callable = _originals["open"]  # type: ignore[assignment]
    writing = isinstance(mode, str) and any(letter in mode for letter in "wax+")
    if _tracer is None or not writing or isinstance(file, int) or not _from_the_agent(1):
        return original(file, mode, *args, **kwargs)
    with _span("write_file", _write_attributes(file)):
        return original(file, mode, *args, **kwargs)
