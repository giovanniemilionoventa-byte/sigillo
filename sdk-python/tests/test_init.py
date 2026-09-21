"""Unit tests for sigillo.init, against a throwaway HTTP server.

No pytest: the standard library's unittest is enough, and it keeps the package's
dependency list to what the specification allows.

    python -m unittest discover -s sdk-python/tests -t sdk-python
"""

from __future__ import annotations

import http.server
import importlib.util
import logging
import threading
import unittest

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

import sigillo


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

    def test_the_public_surface_is_one_function(self) -> None:
        self.assertEqual(sigillo.__all__, ["init", "Tracing"])
        public = [name for name in dir(sigillo) if not name.startswith("_")]
        self.assertEqual(
            sorted(name for name in public if callable(getattr(sigillo, name))),
            ["Tracing", "init"],
        )


if __name__ == "__main__":
    unittest.main()
