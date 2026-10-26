"""The door in front of a local model, with real HTTP servers on both sides.

    python -m unittest discover -s sdk-python/tests -t sdk-python
"""

from __future__ import annotations

import base64
import http.server
import json
import threading
import time
import unittest
import urllib.error
import urllib.request

import sigillo
from sigillo import door

from .test_init import _all_spans, _Capture, _string_attributes

KEY = "sgl_the-systems-key"


class _Model(http.server.BaseHTTPRequestHandler):
    """An Ollama-like model: streams two lines, and remembers what reached it."""

    seen: list[dict[str, str]] = []

    def log_message(self, *args: object) -> None:
        pass

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        type(self).seen.append({k.lower(): v for k, v in self.headers.items()})
        if self.path == "/boom":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"no")
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"c":"ci"}\n')
        self.wfile.flush()
        self.wfile.write(b'{"c":"ao"}\n')


class DoorTest(unittest.TestCase):
    def setUp(self) -> None:
        _Capture.bodies = []
        _Model.seen = []
        self.sigillo = http.server.HTTPServer(("127.0.0.1", 0), _Capture)
        self.model = http.server.HTTPServer(("127.0.0.1", 0), _Model)
        for server in (self.sigillo, self.model):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.tracing = sigillo.init(
            endpoint=f"http://127.0.0.1:{self.sigillo.server_address[1]}",
            api_key=KEY,
            system_id="local-agent",
            instrument=[],
            heartbeat_seconds=3600,
        )
        upstream = f"http://127.0.0.1:{self.model.server_address[1]}"
        tracer = self.tracing.provider.get_tracer("sigillo.door")
        self.door = http.server.ThreadingHTTPServer(("127.0.0.1", 0), door._handler(upstream, KEY, tracer))
        threading.Thread(target=self.door.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.door.server_address[1]}"
        self.addCleanup(self._stop)

    def _stop(self) -> None:
        from sigillo import _stdlib

        _stdlib._tracer = None
        self.tracing.shutdown()
        for server in (self.door, self.model, self.sigillo):
            server.shutdown()
            server.server_close()

    def _post(self, path: str, token: str | None) -> urllib.request.addinfourl:
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        body = json.dumps({"model": "qwen2.5:1.5b", "messages": [{"role": "user", "content": "SEGRETO"}]}).encode()
        return urllib.request.urlopen(urllib.request.Request(self.base + path, body, headers))

    def _spans(self, expected: int = 0) -> list[dict[str, str]]:
        # The door ends its span just after the caller has its answer: wait for it.
        for _ in range(50):
            self.tracing.flush()
            if len(_Capture.bodies) >= expected:
                break
            time.sleep(0.05)
        return [
            {"name": span.name, "status": str(span.status.code), **_string_attributes(span.attributes)}
            for body in _Capture.bodies
            for span in _all_spans(body)
        ]

    def test_with_the_key_the_call_goes_through_and_leaves_a_receipt(self) -> None:
        with self._post("/api/chat", KEY) as answer:
            self.assertEqual(answer.read(), b'{"c":"ci"}\n{"c":"ao"}\n')
        self.assertNotIn("authorization", _Model.seen[0])  # the model never sees the key
        spans = self._spans(1)
        self.assertEqual([s["name"] for s in spans], ["llm qwen2.5:1.5b"])
        self.assertEqual(spans[0]["llm.system"], "ollama")
        self.assertNotIn(b"SEGRETO", b"".join(_Capture.bodies))

    def test_the_key_in_the_address_is_taken_as_basic_authentication(self) -> None:
        # What a Rust client such as ollama-rs sends for http://sigillo:<key>@127.0.0.1:11434.
        body = json.dumps({"model": "qwen2.5:1.5b", "messages": []}).encode()
        for password, allowed in ((KEY, True), ("not-the-key", False)):
            basic = base64.b64encode(f"sigillo:{password}".encode()).decode()
            headers = {"Content-Type": "application/json", "Authorization": f"Basic {basic}"}
            request = urllib.request.Request(self.base + "/api/chat", body, headers)
            if allowed:
                with urllib.request.urlopen(request) as answer:
                    self.assertEqual(answer.status, 200)
            else:
                with self.assertRaises(urllib.error.HTTPError) as refused:
                    urllib.request.urlopen(request)
                self.assertEqual(refused.exception.code, 401)

    def test_another_local_server_is_named_in_its_receipts_and_is_not_started_by_the_door(self) -> None:
        from sigillo import _stdlib

        upstream = f"http://127.0.0.1:{self.model.server_address[1]}"
        tracer = self.tracing.provider.get_tracer("sigillo.door")
        lm_studio = http.server.ThreadingHTTPServer(("127.0.0.1", 0), door._handler(upstream, KEY, tracer, "lm-studio"))
        threading.Thread(target=lm_studio.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (lm_studio.shutdown(), lm_studio.server_close()))
        base = f"http://127.0.0.1:{lm_studio.server_address[1]}"
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"}
        body = json.dumps({"model": "qwen", "messages": [{"role": "user", "content": "SEGRETO"}]}).encode()
        urllib.request.urlopen(urllib.request.Request(base + "/v1/chat/completions", body, headers)).read()
        spans = self._spans(1)
        self.assertEqual(spans[0]["llm.system"], "lm-studio")
        self.assertEqual(door._server_name(1234), "lm-studio")
        self.assertEqual(door._server_name(8080), "llama.cpp")
        self.assertEqual(door._server_name(8000), "vllm")
        self.assertEqual(_stdlib._provider_of("localhost", 1234), "lm-studio")
        with self.assertRaises(SystemExit):
            door.main(["--endpoint", "http://127.0.0.1:9", "--system-id", "x", "--api-key", KEY,
                       "--upstream", "http://127.0.0.1:1235", "--port", "1234", "--serve"])

    def test_without_the_key_or_with_another_nothing_reaches_the_model(self) -> None:
        for token in (None, "not-the-key", ""):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self._post("/api/chat", token)
            self.assertEqual(caught.exception.code, 401)
        self.assertEqual(_Model.seen, [])
        self.assertEqual(self._spans(), [])

    def test_a_failing_model_is_passed_on_and_recorded_as_an_error(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self._post("/boom", KEY)
        self.assertEqual(caught.exception.code, 500)
        spans = self._spans(1)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["status"], "2")  # STATUS_CODE_ERROR

    def test_an_agent_with_no_framework_sends_the_key_itself_and_is_recorded_once(self) -> None:
        from sigillo import _stdlib

        tracing = sigillo.init(
            endpoint=f"http://127.0.0.1:{self.sigillo.server_address[1]}",
            api_key=KEY,
            system_id="local-agent",
            instrument=["stdlib"],
            heartbeat_seconds=3600,
            local_model=True,
        )
        port = self.door.server_address[1]
        _stdlib._LOCAL_PORT = port
        self.addCleanup(lambda: (setattr(_stdlib, "_LOCAL_PORT", 11434), _stdlib.uninstall(), tracing.shutdown()))
        body = json.dumps({"model": "qwen2.5:1.5b", "messages": []}).encode()
        # No Authorization header in the agent's own code: sigillo adds it.
        with urllib.request.urlopen(urllib.request.Request(self.base + "/api/chat", body)) as answer:
            self.assertIn(b"ci", answer.read())
        with urllib.request.urlopen(self.base + "/api/generate", body) as answer:  # a plain address, no Request object
            answer.read()
        tracing.flush()  # in one process here, the door's tracer is the agent's: two providers, one capture
        self.assertEqual(len(self._spans(2)), 2)  # the door's, one per call: not the agent's as well

    def _fake_ollama(self) -> None:
        import os
        import pathlib
        import stat
        import tempfile

        folder = pathlib.Path(tempfile.mkdtemp(prefix="sigillo-fake-ollama-"))
        fake = folder / "ollama"
        fake.write_text(
            "#!/bin/sh\nexec python3 -c \"import http.server as h,os;"
            "H=type('H',(h.BaseHTTPRequestHandler,),{'do_GET':lambda s:(s.send_response(200),s.end_headers(),s.wfile.write(b'{}'))});"
            "a=os.environ['OLLAMA_HOST'].split(':');h.HTTPServer((a[0],int(a[1])),H).serve_forever()\"\n"
        )
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        previous = os.environ["PATH"]
        os.environ["PATH"] = f"{folder}{os.pathsep}{previous}"
        self.addCleanup(lambda: os.environ.__setitem__("PATH", previous))

    @staticmethod
    def _free_port() -> int:
        import socket

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            return probe.getsockname()[1]

    def test_the_agents_file_starts_the_door_and_ollama_which_end_with_it(self) -> None:
        from sigillo import _watchdog

        self._fake_ollama()
        local = f"http://127.0.0.1:{self._free_port()}"
        upstream = f"http://127.0.0.1:{self._free_port()}"
        endpoint = f"http://127.0.0.1:{self.sigillo.server_address[1]}"
        self.assertEqual(door.ensure(endpoint, KEY, "local-agent", local, upstream), "door")
        self.assertEqual(_watchdog.model_state(local), "closed")  # the door, asking for the key
        self.assertEqual(_watchdog.model_state(upstream), "open")  # Ollama, moved behind it
        self.assertEqual(door.ensure(endpoint, KEY, "local-agent", local, upstream), "door")  # not a second one
        process = door._started.pop()
        process.stdin.close()  # the agent ends
        process.wait(timeout=10)
        for _ in range(40):
            if _watchdog.model_state(upstream) == "none":
                break
            time.sleep(0.25)
        self.assertEqual(_watchdog.model_state(local), "none")
        self.assertEqual(_watchdog.model_state(upstream), "none")

    def test_an_ollama_already_open_is_left_alone(self) -> None:
        model = f"http://127.0.0.1:{self.model.server_address[1]}"
        self.assertEqual(door.ensure("http://127.0.0.1:9", KEY, "local-agent", model, "http://127.0.0.1:9"), "ollama open")
        self.assertEqual(door._started, [])

    def test_serve_starts_ollama_at_the_moved_address_and_leaves_a_running_one_alone(self) -> None:
        import os
        import pathlib
        import socket
        import stat
        import tempfile

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        folder = pathlib.Path(tempfile.mkdtemp(prefix="sigillo-fake-ollama-"))
        fake = folder / "ollama"
        fake.write_text(
            "#!/bin/sh\nexec python3 -c \"import http.server as h,os;"
            "H=type('H',(h.BaseHTTPRequestHandler,),{'do_GET':lambda s:(s.send_response(200),s.end_headers(),s.wfile.write(b'{}'))});"
            "a=os.environ['OLLAMA_HOST'].split(':');h.HTTPServer((a[0],int(a[1])),H).serve_forever()\"\n"
        )
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        previous = os.environ["PATH"]
        os.environ["PATH"] = f"{folder}{os.pathsep}{previous}"
        self.addCleanup(lambda: os.environ.__setitem__("PATH", previous))
        upstream = f"http://127.0.0.1:{port}"
        process = door.serve_model(upstream)
        self.assertIsNotNone(process)
        self.addCleanup(process.terminate)
        self.assertIsNone(door.serve_model(upstream))  # it answers now: nothing more is started

    def test_the_guard_tells_an_open_model_from_a_closed_one(self) -> None:
        from sigillo import _watchdog

        self.assertEqual(_watchdog.model_state(self.base), "closed")  # the door wants the key
        self.assertEqual(_watchdog.model_state(f"http://127.0.0.1:{self.model.server_address[1]}"), "open")
        free = http.server.HTTPServer(("127.0.0.1", 0), _Model)
        port = free.server_address[1]
        free.server_close()
        self.assertEqual(_watchdog.model_state(f"http://127.0.0.1:{port}"), "none")

    def test_an_open_model_is_said_in_a_receipt_the_server_accepts_in_shape(self) -> None:
        from sigillo import _watchdog

        _Capture.bodies = []
        _watchdog._say_open({"receipts": f"http://127.0.0.1:{self.sigillo.server_address[1]}/api/v1/receipts", "api_key": KEY})
        sent = json.loads(_Capture.bodies[0])
        self.assertEqual(sent["action"], {"kind": "decision", "name": "sigillo.local_model.open"})
        self.assertEqual(sent["outcome"], "error")

    def test_the_guard_ends_the_agent_when_the_local_model_answers_without_the_key(self) -> None:
        import subprocess
        import sys

        from sigillo import _watchdog

        _Capture.bodies = []
        agent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(agent.kill)
        config = {
            "period": 0.1, "probe": f"http://127.0.0.1:{self.model.server_address[1]}",  # open: no key asked
            "script": None, "script_hash": None, "sdk_hash": _watchdog.package_hash(
                __import__("os").path.dirname(_watchdog.__file__)),
            "parent": agent.pid, "receipts": f"http://127.0.0.1:{self.sigillo.server_address[1]}/api/v1/receipts",
            "api_key": KEY,
        }
        guard = subprocess.Popen([sys.executable, "-I", _watchdog.__file__], stdin=subprocess.PIPE)
        self.addCleanup(guard.kill)
        guard.stdin.write((json.dumps(config) + "\n").encode())
        guard.stdin.flush()
        agent.wait(timeout=15)  # ended by the guard
        self.assertEqual(json.loads(_Capture.bodies[0])["action"]["name"], "sigillo.local_model.open")

    def test_the_guard_says_an_open_model_once_and_leaves_the_agent_when_the_door_is_beside_it(self) -> None:
        import subprocess
        import sys

        from sigillo import _watchdog

        _Capture.bodies = []
        agent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        self.addCleanup(agent.kill)
        config = {
            "period": 0.1, "probe": f"http://127.0.0.1:{self.model.server_address[1]}", "keep": True,
            "script": None, "script_hash": None, "sdk_hash": _watchdog.package_hash(
                __import__("os").path.dirname(_watchdog.__file__)),
            "parent": agent.pid, "receipts": f"http://127.0.0.1:{self.sigillo.server_address[1]}/api/v1/receipts",
            "api_key": KEY,
        }
        guard = subprocess.Popen([sys.executable, "-I", _watchdog.__file__], stdin=subprocess.PIPE)
        self.addCleanup(guard.kill)
        guard.stdin.write((json.dumps(config) + "\n").encode())
        guard.stdin.flush()
        for _ in range(50):
            if _Capture.bodies:
                break
            time.sleep(0.1)
        time.sleep(0.5)
        self.assertEqual(len(_Capture.bodies), 1)  # said once
        self.assertIsNone(agent.poll())  # and the agent goes on

    def test_calls_to_a_model_that_was_open_are_sent_to_the_door_beside_it_with_the_key(self) -> None:
        from sigillo import _stdlib

        reached = []
        self.addCleanup(_stdlib.uninstall)
        _stdlib._originals["urlopen"] = lambda request, *a, **k: reached.append(request)
        _stdlib.use_door(KEY, 11434, 5555)
        _stdlib._urlopen("http://127.0.0.1:11434/api/chat", b"{}")
        self.assertEqual(reached[0].full_url, "http://127.0.0.1:5555/api/chat")
        self.assertEqual(reached[0].get_header("Authorization"), f"Bearer {KEY}")
        reached.clear()
        _stdlib._urlopen("http://127.0.0.1:9999/other")  # not the model: left where it is
        self.assertEqual(reached[0], "http://127.0.0.1:9999/other")


if __name__ == "__main__":
    unittest.main()
