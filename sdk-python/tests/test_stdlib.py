"""The "stdlib" instrumentation: an agent with no framework, only urllib and pathlib.

Real urllib and real files, against a throwaway HTTP server that plays both the
model server and sigillo. Run as the other tests are:

    python -m unittest discover -s sdk-python/tests -t sdk-python
"""

from __future__ import annotations

import http.server
import json
import pathlib
import tempfile
import threading
import unittest
import urllib.request

import sigillo
from sigillo import _stdlib

from .test_init import _all_spans, _Capture, _string_attributes


class _Model(_Capture):
    """sigillo's capture, plus an Ollama-style /api/chat and a search page."""

    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"results")

    def do_POST(self):  # noqa: N802
        if self.path == "/api/chat":
            length = int(self.headers.get("Content-Length", "0"))
            self.rfile.read(length)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"message": {"content": "ciao"}}')
            return
        super().do_POST()


class StdlibInstrumentationTest(unittest.TestCase):
    def setUp(self) -> None:
        _Capture.bodies = []
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Model)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.out = pathlib.Path(tempfile.mkdtemp(prefix="sigillo-stdlib-"))
        self.tracing = sigillo.init(
            endpoint=self.base, api_key="k", system_id="plain-agent", instrument=["stdlib"], heartbeat_seconds=3600
        )
        self.addCleanup(self._stop)

    def _stop(self) -> None:
        _stdlib.uninstall()
        self.tracing.shutdown()
        self.server.shutdown()
        self.server.server_close()

    def _spans(self) -> list[dict[str, str]]:
        self.tracing.flush()
        return [
            {"name": span.name, **_string_attributes(span.attributes)}
            for body in _Capture.bodies
            for span in _all_spans(body)
        ]

    def test_a_model_call_a_web_call_and_the_three_ways_of_writing(self) -> None:
        body = json.dumps({"model": "qwen2.5:1.5b", "messages": [{"role": "user", "content": "SEGRETO"}]}).encode()
        request = urllib.request.Request(self.base + "/api/chat", body, {"Content-Type": "application/json"})
        with urllib.request.urlopen(request) as response:
            self.assertIn(b"ciao", response.read())
        urllib.request.urlopen(self.base + "/lite/?q=SEGRETO-QUERY").read()
        (self.out / "a.txt").write_text("SEGRETO-TESTO")
        (self.out / "b.bin").write_bytes(b"x")
        with open(self.out / "c.txt", "w") as handle:
            handle.write("y")

        spans = self._spans()
        self.assertEqual(
            [(s["name"], s["openinference.span.kind"]) for s in spans],
            [("llm qwen2.5:1.5b", "LLM"), ("http 127.0.0.1", "TOOL")] + [("write_file", "TOOL")] * 3,
        )
        self.assertEqual(spans[0]["llm.model_name"], "qwen2.5:1.5b")
        self.assertEqual(spans[1]["tool.name"], "http 127.0.0.1")
        self.assertEqual({s["tool.name"] for s in spans[2:]}, {"write_file"})
        # Content leaves only as digests: no raw text, no address, no query.
        sent = b"".join(_Capture.bodies)
        for secret in (b"SEGRETO", b"a.txt", b"/lite"):
            self.assertNotIn(secret, sent)
        for span in spans:
            self.assertRegex(span["sigillo.input.sha256"], "^[0-9a-f]{64}$")
        self.assertIn("sigillo.output.sha256", spans[2])

    def test_requests_and_httpx_are_recorded_by_the_same_rule(self) -> None:
        import asyncio

        import httpx
        import requests

        body = {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "SEGRETO"}]}
        # An OpenAI-style path on the local server: any server answering POST works.
        requests.post(self.base + "/api/chat", json=body)
        requests.get(self.base + "/search?q=SEGRETO-QUERY")
        httpx.post(self.base + "/api/chat", json=body)
        with httpx.Client() as client:
            client.get(self.base + "/search?q=SEGRETO-QUERY")

        async def call() -> None:
            async with httpx.AsyncClient() as client:
                await client.post(self.base + "/api/chat", json=body)

        asyncio.run(call())

        spans = self._spans()
        self.assertEqual(
            [s["name"] for s in spans],
            ["llm gpt-4o-mini", "http 127.0.0.1", "llm gpt-4o-mini", "http 127.0.0.1", "llm gpt-4o-mini"],
        )
        sent = b"".join(_Capture.bodies)
        for secret in (b"SEGRETO", b"/search"):
            self.assertNotIn(secret, sent)
        for span in spans:
            self.assertRegex(span["sigillo.input.sha256"], "^[0-9a-f]{64}$")

    def test_a_failure_is_recorded_by_class_only(self) -> None:
        with self.assertRaises(OSError):
            pathlib.Path(self.out / "missing" / "a.txt").write_text("x")
        [span] = self._spans()
        self.assertEqual(span["error.type"], "FileNotFoundError")

    def test_the_resource_names_the_client_and_default_init_does_not_hook_anything(self) -> None:
        self.tracing.flush()
        self.assertEqual(self.tracing.instrumented, ("stdlib",))
        self.assertEqual(self.tracing.provider.resource.attributes["sigillo.client"], "stdlib")
        _stdlib.uninstall()
        plain = sigillo.init(endpoint=self.base, api_key="k", system_id="x", instrument=[], heartbeat_seconds=3600)
        self.addCleanup(plain.shutdown)
        self.assertNotIn("sigillo.client", plain.provider.resource.attributes)
        pathlib.Path(self.out / "z.txt").write_text("z")
        self.assertEqual(self._spans(), [])

    def test_sigillos_own_requests_and_the_standard_librarys_are_not_recorded(self) -> None:
        # The heartbeat and the exporter go through urllib/requests inside this package.
        self.tracing._heartbeat._send("beat")  # type: ignore[union-attr]
        self.assertEqual(self._spans(), [])


if __name__ == "__main__":
    unittest.main()
