"""Unit tests for sigillo.init, against a throwaway HTTP server.

No pytest: the standard library's unittest is enough, and it keeps the package's
dependency list to what the specification allows.

    python -m unittest discover -s sdk-python/tests -t sdk-python
"""

from __future__ import annotations

import hashlib
import http.server
import importlib.util
import json
import logging
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

from opentelemetry import trace
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

import sigillo

try:
    # Only used, conditionally, by a test function defined inside a test
    # method below. Because this file has `from __future__ import
    # annotations`, that function's annotations are strings resolved
    # against this module's globals — so the name has to live here, at
    # module level, even though every use of it is otherwise local to one
    # test. When langchain_core is absent that test skips before the
    # annotation is ever evaluated, so the placeholder is never touched.
    from langchain_core.callbacks.manager import CallbackManager
except ImportError:
    CallbackManager = None

# For cross-checking sigillo's content digest against the real server-side
# implementation (fase 9, decision D6): built, not reimplemented here.
_CORE_INDEX = Path(__file__).resolve().parent.parent.parent / "packages" / "core" / "dist" / "index.js"


def _core_requirements_met() -> str | None:
    if shutil.which("node") is None:
        return "node is not on PATH"
    if not _CORE_INDEX.exists():
        return f"{_CORE_INDEX} is missing: run pnpm build first"
    return None


def _hash_canonical_json_in_node(value: str) -> str:
    """The real `hashCanonicalJson` from `packages/core`, run for real in Node.

    Not a reimplementation to compare against: the same built module the
    server itself imports, so a digest that matches this is a digest the
    server would compute too. `value` travels over stdin, not argv: argv
    strings are NUL-terminated at the OS level, and JSON allows a NUL byte
    inside a string.
    """
    script = (
        f"import {{ hashCanonicalJson }} from {json.dumps(str(_CORE_INDEX))};\n"
        "const chunks = [];\n"
        "process.stdin.on('data', (chunk) => chunks.push(chunk));\n"
        "process.stdin.on('end', () => {\n"
        "  process.stdout.write(hashCanonicalJson(Buffer.concat(chunks).toString('utf8')));\n"
        "});\n"
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=value.encode("utf-8"),
        capture_output=True,
        check=True,
    )
    return result.stdout.decode("utf-8")


class _Capture(http.server.BaseHTTPRequestHandler):
    bodies: list[bytes] = []
    headers_seen: list[dict[str, str]] = []
    paths: list[str] = []

    def do_POST(self):  # noqa: N802 - the name is fixed by the base class
        length = int(self.headers.get("Content-Length", "0"))
        type(self).bodies.append(self.rfile.read(length))
        type(self).headers_seen.append({key.lower(): value for key, value in self.headers.items()})
        type(self).paths.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.end_headers()
        self.wfile.write(b"")

    def log_message(self, *_args):
        pass


class _FakeOllama(http.server.BaseHTTPRequestHandler):
    """Plays the one endpoint sigillo reads: GET /api/tags."""

    models: list[dict] = []

    def do_GET(self):  # noqa: N802 - the name is fixed by the base class
        if self.path != "/api/tags":
            self.send_response(404)
            self.end_headers()
            return
        body = json.dumps({"models": type(self).models}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def _all_spans(body: bytes):
    request = ExportTraceServiceRequest()
    request.ParseFromString(body)
    return [
        span
        for resource in request.resource_spans
        for scope in resource.scope_spans
        for span in scope.spans
    ]


def _first_span(body: bytes):
    return next(iter(_all_spans(body)))


def _string_attributes(pairs) -> dict[str, str]:
    return {pair.key: pair.value.string_value for pair in pairs}


class SigilloInitTest(unittest.TestCase):
    def setUp(self) -> None:
        _Capture.bodies = []
        _Capture.headers_seen = []
        _Capture.paths = []
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Capture)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()

    def _emit_span(self, tracing: sigillo.Tracing, name: str = "example") -> None:
        tracer = tracing.provider.get_tracer("sigillo.tests")
        with tracer.start_as_current_span(name) as span:
            span.set_attribute("gen_ai.operation.name", "execute_tool")
            span.set_attribute("gen_ai.tool.name", "search_orders")
        tracing.flush()

    def test_sends_spans_to_the_server(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="sigillo_key", system_id="acme-support-bot", instrument=[]
        )
        self.addCleanup(tracing.shutdown)
        self._emit_span(tracing)

        self.assertEqual(len(_Capture.bodies), 1)
        request = ExportTraceServiceRequest()
        request.ParseFromString(_Capture.bodies[0])
        spans = [
            span
            for resource in request.resource_spans
            for scope in resource.scope_spans
            for span in scope.spans
        ]
        self.assertEqual([span.name for span in spans], ["example"])

    def test_sends_the_api_key_as_a_bearer_token(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="sigillo_secret", system_id="s", instrument=[]
        )
        self.addCleanup(tracing.shutdown)
        self._emit_span(tracing)

        self.assertEqual(
            _Capture.headers_seen[0]["authorization"], "Bearer sigillo_secret"
        )
        self.assertEqual(
            _Capture.headers_seen[0]["content-type"], "application/x-protobuf"
        )

    def test_reports_the_system_id_as_the_service_name(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="acme-support-bot", instrument=[]
        )
        self.addCleanup(tracing.shutdown)
        self._emit_span(tracing)

        request = ExportTraceServiceRequest()
        request.ParseFromString(_Capture.bodies[0])
        attributes = {
            attribute.key: attribute.value.string_value
            for attribute in request.resource_spans[0].resource.attributes
        }
        self.assertEqual(attributes["service.name"], "acme-support-bot")

    def test_accepts_the_base_url_or_the_full_traces_url(self) -> None:
        for endpoint in (self.base, f"{self.base}/", f"{self.base}/v1/traces"):
            with self.subTest(endpoint=endpoint):
                tracing = sigillo.init(
                    endpoint=endpoint, api_key="k", system_id="s", instrument=[]
                )
                self.addCleanup(tracing.shutdown)
                self.assertEqual(tracing.endpoint, f"{self.base}/v1/traces")

        self._emit_span(
            sigillo.init(endpoint=self.base, api_key="k", system_id="s", instrument=[])
        )
        self.assertEqual(_Capture.paths[0], "/v1/traces")

    def test_refuses_an_empty_key_system_or_endpoint(self) -> None:
        for kwargs in (
            {"endpoint": self.base, "api_key": "", "system_id": "s"},
            {"endpoint": self.base, "api_key": "k", "system_id": ""},
            {"endpoint": "", "api_key": "k", "system_id": "s"},
            {"endpoint": "   ", "api_key": "k", "system_id": "s"},
        ):
            with self.subTest(**kwargs), self.assertRaises(ValueError):
                sigillo.init(instrument=[], **kwargs)

    def test_refuses_an_instrumentation_it_does_not_know(self) -> None:
        with self.assertRaises(ValueError) as caught:
            sigillo.init(
                endpoint=self.base, api_key="k", system_id="s", instrument=["autogen"]
            )
        self.assertIn("autogen", str(caught.exception))

    def test_turns_on_the_instrumentations_that_are_installed(self) -> None:
        installed = importlib.util.find_spec("openinference.instrumentation.langchain") is not None
        if not installed:
            self.skipTest("openinference-instrumentation-langchain is not installed")

        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=["langchain"]
        )
        self.addCleanup(tracing.shutdown)
        self.assertEqual(tracing.instrumented, ("langchain",))

    def test_skips_an_instrumentation_that_is_not_installed(self) -> None:
        if importlib.util.find_spec("openinference.instrumentation.crewai") is not None:
            self.skipTest("openinference-instrumentation-crewai is installed here")

        with self.assertLogs("sigillo", level=logging.WARNING) as logs:
            tracing = sigillo.init(
                endpoint=self.base, api_key="k", system_id="s", instrument=["crewai"]
            )
        self.addCleanup(tracing.shutdown)

        self.assertEqual(tracing.instrumented, ())
        self.assertIn("crewai", "".join(logs.output))
        # A missing optional instrumentation is a warning, not a failure: the
        # rest of the recording still works.
        self._emit_span(tracing)
        self.assertEqual(len(_Capture.bodies), 1)

    def test_artifact_attaches_a_matching_fingerprint_and_never_the_content(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=[]
        )
        self.addCleanup(tracing.shutdown)
        content = "il contenuto esatto del curriculum, per un test che non deve mai vederlo altrove"
        expected_digest = hashlib.sha256(content.encode("utf-8")).hexdigest()

        tracer = tracing.provider.get_tracer("sigillo.tests")
        with tracer.start_as_current_span("leggi_curriculum") as span:
            span.set_attribute("gen_ai.operation.name", "execute_tool")
            sigillo.artifact(content, role="input", label="curriculum")
        tracing.flush()

        body = _Capture.bodies[0]
        span = _first_span(body)
        self.assertEqual(len(span.events), 1)
        self.assertEqual(span.events[0].name, "sigillo.artifact")
        attributes = _string_attributes(span.events[0].attributes)
        self.assertEqual(attributes["sigillo.artifact.role"], "input")
        self.assertEqual(attributes["sigillo.artifact.label"], "curriculum")
        self.assertEqual(attributes["sigillo.artifact.media_type"], "text/plain")
        self.assertEqual(attributes["sigillo.artifact.sha256"], expected_digest)

        # What left this process must not contain the document itself.
        self.assertNotIn(content.encode("utf-8"), body)

    def test_artifact_reads_a_file_and_guesses_its_media_type(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=[]
        )
        self.addCleanup(tracing.shutdown)

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "email.txt"
            path.write_text("gentile candidato, la ringraziamo per l'interesse")
            expected_digest = hashlib.sha256(path.read_bytes()).hexdigest()

            tracer = tracing.provider.get_tracer("sigillo.tests")
            with tracer.start_as_current_span("invia_email") as span:
                span.set_attribute("gen_ai.operation.name", "execute_tool")
                sigillo.artifact(path, role="output", label="email di risposta")
            tracing.flush()

        attributes = _string_attributes(_first_span(_Capture.bodies[0]).events[0].attributes)
        self.assertEqual(attributes["sigillo.artifact.sha256"], expected_digest)
        self.assertEqual(attributes["sigillo.artifact.media_type"], "text/plain")

    def test_artifact_accepts_raw_bytes_with_a_generic_default_media_type(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=[]
        )
        self.addCleanup(tracing.shutdown)
        content = bytes(range(256))

        tracer = tracing.provider.get_tracer("sigillo.tests")
        with tracer.start_as_current_span("leggi_curriculum") as span:
            span.set_attribute("gen_ai.operation.name", "execute_tool")
            sigillo.artifact(content, role="input", label="allegato")
        tracing.flush()

        attributes = _string_attributes(_first_span(_Capture.bodies[0]).events[0].attributes)
        self.assertEqual(attributes["sigillo.artifact.sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(attributes["sigillo.artifact.media_type"], "application/octet-stream")

    def test_artifact_rejects_a_role_that_is_not_input_or_output(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=[]
        )
        self.addCleanup(tracing.shutdown)
        tracer = tracing.provider.get_tracer("sigillo.tests")
        with tracer.start_as_current_span("x"):
            with self.assertRaises(ValueError) as caught:
                sigillo.artifact(b"x", role="both", label="l")
            self.assertIn("both", str(caught.exception))

    def test_artifact_warns_and_does_nothing_without_an_active_span(self) -> None:
        with self.assertLogs("sigillo", level=logging.WARNING) as logs:
            sigillo.artifact(b"orphaned", role="input", label="l")
        self.assertIn("no action being recorded", "".join(logs.output))

    def test_artifact_attaches_to_an_explicit_span_that_is_not_the_current_one(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=[]
        )
        self.addCleanup(tracing.shutdown)
        tracer = tracing.provider.get_tracer("sigillo.tests")

        # Started and left open, deliberately never entered as the current
        # span: the explicit `span=` argument must not depend on context.
        target = tracer.start_span("valuta_candidato")
        self.assertFalse(trace.get_current_span().is_recording())

        sigillo.artifact(b"contenuto", role="input", label="curriculum", span=target)
        target.end()
        tracing.flush()

        attributes = _string_attributes(_first_span(_Capture.bodies[0]).events[0].attributes)
        self.assertEqual(attributes["sigillo.artifact.sha256"], hashlib.sha256(b"contenuto").hexdigest())

    def test_current_span_from_callbacks_finds_nothing_without_a_run(self) -> None:
        self.assertIsNone(sigillo.current_span_from_callbacks(None))

        class _NoRunId:
            parent_run_id = None
            handlers: list[object] = []

        self.assertIsNone(sigillo.current_span_from_callbacks(_NoRunId()))

    def test_current_span_from_callbacks_reads_get_span_from_any_handler(self) -> None:
        sentinel = object()

        class _Handler:
            def get_span(self, run_id: object) -> object:
                return sentinel if run_id == "run-1" else None

        class _Callbacks:
            parent_run_id = "run-1"
            handlers = [object(), _Handler()]  # a handler without get_span comes first

        self.assertIs(sigillo.current_span_from_callbacks(_Callbacks()), sentinel)

    def test_artifact_works_inside_a_real_langchain_tool_call(self) -> None:
        """The scenario `artifact`'s `span` parameter exists for: a `@tool`
        instrumented by OpenInference's LangChain integration, which is known
        not to set its spans as OpenTelemetry-current (see `artifact`'s
        docstring). Without `span=current_span_from_callbacks(callbacks)` this
        silently attaches nothing — this test is what would have caught it.
        """
        if importlib.util.find_spec("langchain_core") is None:
            self.skipTest("langchain_core is not installed")
        if importlib.util.find_spec("openinference.instrumentation.langchain") is None:
            self.skipTest("openinference-instrumentation-langchain is not installed")

        from langchain_core.tools import tool

        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=["langchain"]
        )
        self.addCleanup(tracing.shutdown)
        content = "il contenuto esatto del curriculum, letto da un vero strumento LangChain"
        expected_digest = hashlib.sha256(content.encode("utf-8")).hexdigest()

        @tool
        def leggi_curriculum(testo: str, callbacks: CallbackManager | None = None) -> str:
            """Reads a CV."""
            span = sigillo.current_span_from_callbacks(callbacks)
            sigillo.artifact(testo, role="input", label="curriculum", span=span)
            return testo

        # A plain call, exactly as LangGraph or an agent would make it: no
        # caller ever passes `callbacks` themselves, LangChain supplies it.
        result = leggi_curriculum.invoke({"testo": content})
        self.assertEqual(result, content)
        tracing.flush()

        tool_span = next(
            span for span in _all_spans(_Capture.bodies[0]) if span.name == "leggi_curriculum"
        )
        # Exactly one artifact event, regardless of whatever else LangChain's
        # own instrumentation put on this span (its input.value/output.value
        # capture is that instrumentation's concern, hashed away server-side —
        # not what this test is about).
        artifact_events = [event for event in tool_span.events if event.name == "sigillo.artifact"]
        self.assertEqual(len(artifact_events), 1)
        attributes = _string_attributes(artifact_events[0].attributes)
        self.assertEqual(attributes["sigillo.artifact.role"], "input")
        self.assertEqual(attributes["sigillo.artifact.label"], "curriculum")
        self.assertEqual(attributes["sigillo.artifact.sha256"], expected_digest)

    def test_ollama_digest_is_attached_to_an_llm_span_when_ollama_answers(self) -> None:
        _FakeOllama.models = [
            {"name": "qwen2.5:3b", "digest": "sha256:deadbeefcafe"},
            {"name": "llama3", "digest": "sha256:0000111122223333"},
        ]
        ollama = http.server.HTTPServer(("127.0.0.1", 0), _FakeOllama)
        thread = threading.Thread(target=ollama.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(ollama.shutdown)
        self.addCleanup(thread.join, 5)
        self.addCleanup(ollama.server_close)

        tracing = sigillo.init(
            endpoint=self.base,
            api_key="k",
            system_id="s",
            instrument=[],
            ollama_url=f"http://127.0.0.1:{ollama.server_address[1]}",
        )
        self.addCleanup(tracing.shutdown)

        tracer = tracing.provider.get_tracer("sigillo.tests")
        with tracer.start_as_current_span(
            "chat",
            attributes={"gen_ai.operation.name": "chat", "gen_ai.request.model": "qwen2.5:3b"},
        ):
            pass
        tracing.flush()

        attributes = _string_attributes(_first_span(_Capture.bodies[0]).attributes)
        self.assertEqual(attributes["sigillo.model.digest"], "sha256:deadbeefcafe")

    def test_ollama_digest_is_absent_without_error_when_ollama_does_not_answer(self) -> None:
        with self.assertLogs("sigillo", level=logging.WARNING) as logs:
            tracing = sigillo.init(
                endpoint=self.base,
                api_key="k",
                system_id="s",
                instrument=[],
                # Nothing listens here: a loopback connection refusal, fast and offline.
                ollama_url="http://127.0.0.1:1",
            )
        self.addCleanup(tracing.shutdown)
        self.assertIn("Ollama", "".join(logs.output))

        tracer = tracing.provider.get_tracer("sigillo.tests")
        with tracer.start_as_current_span(
            "chat",
            attributes={"gen_ai.operation.name": "chat", "gen_ai.request.model": "qwen2.5:3b"},
        ):
            pass
        tracing.flush()

        attributes = _string_attributes(_first_span(_Capture.bodies[0]).attributes)
        self.assertNotIn("sigillo.model.digest", attributes)

    def test_no_ollama_url_means_no_digest_and_no_extra_network_call(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=[]
        )
        self.addCleanup(tracing.shutdown)
        tracer = tracing.provider.get_tracer("sigillo.tests")
        with tracer.start_as_current_span(
            "chat",
            attributes={"gen_ai.operation.name": "chat", "gen_ai.request.model": "qwen2.5:3b"},
        ):
            pass
        tracing.flush()

        attributes = _string_attributes(_first_span(_Capture.bodies[0]).attributes)
        self.assertNotIn("sigillo.model.digest", attributes)

    def test_accepts_the_openai_instrumentation_name(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=["openai"]
        )
        self.addCleanup(tracing.shutdown)
        installed = importlib.util.find_spec("openinference.instrumentation.openai") is not None
        self.assertEqual(tracing.instrumented, ("openai",) if installed else ())

    def test_the_public_surface_is_three_functions_and_a_handle(self) -> None:
        self.assertEqual(
            sigillo.__all__,
            ["init", "artifact", "current_span_from_callbacks", "pseudonym", "Tracing"],
        )
        public = [name for name in dir(sigillo) if not name.startswith("_")]
        self.assertEqual(
            sorted(name for name in public if callable(getattr(sigillo, name))),
            ["Tracing", "artifact", "current_span_from_callbacks", "init", "pseudonym"],
        )


class ContentFilterTest(unittest.TestCase):
    """Fase 9, decision C (D6): input.value and output.value are hashed here,
    in this process, before anything is sent — never in the clear, and never
    computed by the server. On by default, since the whole point is that a
    caller who does nothing extra gets the private behaviour.
    """

    def setUp(self) -> None:
        _Capture.bodies = []
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Capture)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()

    def _emit(self, tracing: sigillo.Tracing, attributes: dict[str, str]) -> bytes:
        tracer = tracing.provider.get_tracer("sigillo.tests")
        with tracer.start_as_current_span("leggi_curriculum") as span:
            for key, value in attributes.items():
                span.set_attribute(key, value)
        tracing.flush()
        return _Capture.bodies[-1]

    def test_replaces_input_and_output_with_matching_digests(self) -> None:
        tracing = sigillo.init(endpoint=self.base, api_key="k", system_id="s", instrument=[])
        self.addCleanup(tracing.shutdown)
        input_value = '{"order_id": "A-1099", "candidate": "Maria Bianchi"}'
        output_value = "Il candidato è stato ammesso al colloquio del 12 marzo."

        body = self._emit(
            tracing,
            {
                "openinference.span.kind": "TOOL",
                "tool.name": "leggi_curriculum",
                "input.value": input_value,
                "output.value": output_value,
            },
        )

        attributes = _string_attributes(_first_span(body).attributes)
        self.assertNotIn("input.value", attributes)
        self.assertNotIn("output.value", attributes)
        self.assertEqual(
            attributes["sigillo.input.sha256"],
            hashlib.sha256(json.dumps(input_value, ensure_ascii=False).encode("utf-8")).hexdigest(),
        )
        self.assertEqual(
            attributes["sigillo.output.sha256"],
            hashlib.sha256(json.dumps(output_value, ensure_ascii=False).encode("utf-8")).hexdigest(),
        )
        self.assertNotIn(input_value.encode("utf-8"), body)
        self.assertNotIn(output_value.encode("utf-8"), body)
        self.assertNotIn(b"Maria Bianchi", body)

    @unittest.skipIf(_core_requirements_met() is not None, _core_requirements_met() or "")
    def test_the_digest_matches_what_the_server_itself_would_compute(self) -> None:
        tracing = sigillo.init(endpoint=self.base, api_key="k", system_id="s", instrument=[])
        self.addCleanup(tracing.shutdown)
        for value in [
            '{"messages": [{"role": "user", "content": "dov\'è il mio ordine?"}]}',
            "caffè ☕ 検索",
            "",
            "\x00\x1f control characters, a tab\t and a newline\n",
        ]:
            with self.subTest(value=value):
                body = self._emit(
                    tracing,
                    {"openinference.span.kind": "TOOL", "tool.name": "t", "input.value": value},
                )
                digest = _string_attributes(_first_span(body).attributes)["sigillo.input.sha256"]
                self.assertEqual(digest, _hash_canonical_json_in_node(value))

    def test_strips_attributes_the_server_does_not_read(self) -> None:
        tracing = sigillo.init(endpoint=self.base, api_key="k", system_id="s", instrument=[])
        self.addCleanup(tracing.shutdown)
        body = self._emit(
            tracing,
            {
                "openinference.span.kind": "TOOL",
                "tool.name": "leggi_curriculum",
                "metadata": '{"langgraph_step": 3, "thread_id": "abc"}',
                "tool.description": "Reads a candidate's CV from disk and returns its text.",
                "llm.invocation_parameters": '{"temperature": 0.2}',
                "input.mime_type": "text/plain",
            },
        )
        attributes = _string_attributes(_first_span(body).attributes)
        for stripped in ("metadata", "tool.description", "llm.invocation_parameters", "input.mime_type"):
            self.assertNotIn(stripped, attributes)
        for kept in ("openinference.span.kind", "tool.name"):
            self.assertIn(kept, attributes)

    def test_keeps_the_identifiers_the_server_actually_reads(self) -> None:
        tracing = sigillo.init(endpoint=self.base, api_key="k", system_id="s", instrument=[])
        self.addCleanup(tracing.shutdown)
        body = self._emit(
            tracing,
            {
                "openinference.span.kind": "LLM",
                "llm.model_name": "claude-sonnet-5",
                "llm.provider": "anthropic",
                "user.id": "u-123",
            },
        )
        attributes = _string_attributes(_first_span(body).attributes)
        self.assertEqual(attributes["llm.model_name"], "claude-sonnet-5")
        self.assertEqual(attributes["llm.provider"], "anthropic")
        self.assertEqual(attributes["user.id"], "u-123")

    def test_leaves_sigillo_artifact_events_untouched(self) -> None:
        tracing = sigillo.init(endpoint=self.base, api_key="k", system_id="s", instrument=[])
        self.addCleanup(tracing.shutdown)
        tracer = tracing.provider.get_tracer("sigillo.tests")
        with tracer.start_as_current_span("leggi_curriculum") as span:
            span.set_attribute("openinference.span.kind", "TOOL")
            sigillo.artifact("il testo del CV", role="input", label="curriculum")
        tracing.flush()
        body = _Capture.bodies[-1]
        span = _first_span(body)
        self.assertEqual(len(span.events), 1)
        self.assertEqual(span.events[0].name, "sigillo.artifact")

    def test_can_be_turned_off_explicitly(self) -> None:
        tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="s", instrument=[], redact_content=False
        )
        self.addCleanup(tracing.shutdown)
        body = self._emit(
            tracing,
            {"openinference.span.kind": "TOOL", "tool.name": "t", "input.value": "in chiaro di proposito"},
        )
        attributes = _string_attributes(_first_span(body).attributes)
        self.assertEqual(attributes["input.value"], "in chiaro di proposito")
        self.assertNotIn("sigillo.input.sha256", attributes)


class PseudonymTest(unittest.TestCase):
    """Fase 9, decision F (D1 of docs/PROPOSTA-FASE-4.md): an opaque stand-in
    for `on_behalf_of`, so the one field the instrumentation puts in clear by
    convention need not carry a real identifier into a receipt. The key never
    leaves the caller's process; sigillo never sees it.
    """

    def test_is_deterministic_for_the_same_value_and_key(self) -> None:
        self.assertEqual(
            sigillo.pseudonym("elena.rizzo", key=b"a-key-only-the-client-holds"),
            sigillo.pseudonym("elena.rizzo", key=b"a-key-only-the-client-holds"),
        )

    def test_differs_for_a_different_value_or_a_different_key(self) -> None:
        base = sigillo.pseudonym("elena.rizzo", key=b"key-one")
        self.assertNotEqual(base, sigillo.pseudonym("m.rossi", key=b"key-one"))
        self.assertNotEqual(base, sigillo.pseudonym("elena.rizzo", key=b"key-two"))

    def test_never_contains_the_original_value(self) -> None:
        result = sigillo.pseudonym("elena.rizzo", key=b"a-key-only-the-client-holds")
        self.assertNotIn("elena.rizzo", result)

    def test_accepts_a_string_key_too(self) -> None:
        self.assertEqual(
            sigillo.pseudonym("elena.rizzo", key="a text key"),
            sigillo.pseudonym("elena.rizzo", key=b"a text key"),
        )

    def test_fits_the_on_behalf_of_length_limit(self) -> None:
        # docs/DATA-INVENTORY.md, D4: 64 characters for on_behalf_of.
        result = sigillo.pseudonym("a very very very long identifier indeed, much longer than usual", key=b"k")
        self.assertLessEqual(len(result), 64)

    def test_is_a_real_hmac_sha256_truncated_and_prefixed(self) -> None:
        import hmac

        expected = "p:" + hmac.new(b"k", "elena.rizzo".encode("utf-8"), hashlib.sha256).hexdigest()[:32]
        self.assertEqual(sigillo.pseudonym("elena.rizzo", key=b"k"), expected)

    def test_rejects_an_empty_key(self) -> None:
        with self.assertRaises(ValueError):
            sigillo.pseudonym("elena.rizzo", key=b"")


if __name__ == "__main__":
    unittest.main()
