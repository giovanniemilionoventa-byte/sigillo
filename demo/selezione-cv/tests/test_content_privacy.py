"""Fase 9: what actually leaves this process while the demo runs.

The real agent, run as a subprocess exactly as `test_demo_e2e.py` runs it, but
pointed at a capture server standing in for sigillo instead of a real one — so
every OTLP payload can be inspected before any server ever touches it. This is
the measurement of docs/PROPOSTA-FASE-8.md §1, repeated as an automated test
with the fase 9 filter (decision D6) turned on, which is now the default.

    python -m unittest discover -s demo/selezione-cv/tests -t demo/selezione-cv
"""

from __future__ import annotations

import http.server
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading
import unittest

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
DEMO = ROOT / "demo" / "selezione-cv"
AGENT = DEMO / "agent.py"
CANDIDATE_NAMES = [
    line.removeprefix("Nome: ").strip()
    for path in sorted(DEMO.glob("curricula/candidato-*.txt"))
    for line in path.read_text(encoding="utf-8").splitlines()
    if line.startswith("Nome: ")
]


class _Capture(http.server.BaseHTTPRequestHandler):
    bodies: list[bytes] = []

    def do_POST(self) -> None:  # noqa: N802 - the name is fixed by the base class
        length = int(self.headers.get("Content-Length", "0"))
        type(self).bodies.append(self.rfile.read(length))
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.end_headers()
        self.wfile.write(b"")

    def log_message(self, *_args: object) -> None:
        return None


@unittest.skipIf(len(CANDIDATE_NAMES) != 20, "the demo's fixture CVs are missing or incomplete")
class DemoContentPrivacyTest(unittest.TestCase):
    def setUp(self) -> None:
        _Capture.bodies = []
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Capture)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)
        self.work = pathlib.Path(tempfile.mkdtemp(prefix="sigillo-demo-privacy-"))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)

    def _stop_server(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()

    def test_no_candidate_name_and_no_line_of_a_cv_crosses_the_wire(self) -> None:
        environment = {
            **os.environ,
            "SIGILLO_ENDPOINT": f"http://127.0.0.1:{self.server.server_address[1]}",
            "SIGILLO_API_KEY": "sigillo_0000000000000000_" + "0" * 64,
            "SIGILLO_SYSTEM_ID": "selezione-cv",
            "SIGILLO_DEMO_OUTBOX": str(self.work / "outbox"),
        }
        result = subprocess.run(
            ["python3", str(AGENT)],
            capture_output=True,
            text=True,
            env=environment,
            cwd=self.work,
            timeout=180,
        )
        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")
        self.assertGreater(len(_Capture.bodies), 0, "the agent sent nothing at all")

        traffic = b"".join(_Capture.bodies)
        for name in CANDIDATE_NAMES:
            self.assertNotIn(name.encode("utf-8"), traffic, f"{name!r} reached the wire")
        for path in sorted(DEMO.glob("curricula/candidato-*.txt")):
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if len(line) < 8:  # short, generic lines ("Esperienza:") are not identifying
                    continue
                self.assertNotIn(line.encode("utf-8"), traffic, f"a line of {path.name} reached the wire")

        # The server's own vocabulary for what a span was, and its digests,
        # are expected — this test is about content, not about the span
        # disappearing.
        spans = 0
        for body in _Capture.bodies:
            request = ExportTraceServiceRequest()
            request.ParseFromString(body)
            spans += sum(
                len(scope.spans) for resource in request.resource_spans for scope in resource.scope_spans
            )
        self.assertGreater(spans, 0)


if __name__ == "__main__":
    unittest.main()
