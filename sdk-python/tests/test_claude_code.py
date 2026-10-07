"""Tests for sigillo.claude_code, the Claude Code connector, against a throwaway HTTP server.

    python -m unittest discover -s sdk-python/tests -t sdk-python
"""

from __future__ import annotations

import http.server
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import unittest.mock

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.proto.trace.v1.trace_pb2 import Status

from sigillo import claude_code


class _Server(http.server.BaseHTTPRequestHandler):
    bodies: list[bytes] = []
    status: int = 200
    answer: bytes = b"{}"

    def do_POST(self):  # noqa: N802 - the name is fixed by the base class
        length = int(self.headers.get("Content-Length", "0"))
        type(self).bodies.append(self.rfile.read(length))
        self.send_response(type(self).status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(type(self).answer)

    def log_message(self, *_args):
        pass


def _spans(body: bytes) -> list[tuple[dict, object]]:
    """Each span in an export, with its resource's attributes."""
    request = ExportTraceServiceRequest()
    request.ParseFromString(body)
    found = []
    for resource in request.resource_spans:
        attributes = {item.key: item.value.string_value for item in resource.resource.attributes}
        for scope in resource.scope_spans:
            for span in scope.spans:
                found.append((attributes, span))
    return found


def _attributes(span: object) -> dict[str, str]:
    return {item.key: item.value.string_value for item in span.attributes}  # type: ignore[attr-defined]


class ClaudeCodeTest(unittest.TestCase):
    def setUp(self) -> None:
        _Server.bodies = []
        _Server.status = 200
        _Server.answer = b"{}"
        self.server = http.server.HTTPServer(("127.0.0.1", 0), _Server)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

        self.home = pathlib.Path(tempfile.mkdtemp(prefix="sigillo-claude-code-"))
        self.environment = {
            "SIGILLO_CLAUDE_CODE_CONFIG": str(self.home / "sigillo" / "claude-code.json"),
            "CLAUDE_CONFIG_DIR": str(self.home / "claude"),
        }
        patcher = unittest.mock.patch.dict(os.environ, self.environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.settings_file = self.home / "claude" / "settings.json"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=5)
        self.server.server_close()

    def _only_span(self) -> tuple[dict, object]:
        self.assertEqual(len(_Server.bodies), 1)
        spans = _spans(_Server.bodies[0])
        self.assertEqual(len(spans), 1)
        return spans[0]

    # -- what one hook event becomes ------------------------------------------

    def test_a_tool_call_leaves_as_digests_only(self) -> None:
        claude_code.record(
            {
                "hook_event_name": "PostToolUse",
                "session_id": "session-1",
                "tool_name": "Bash",
                "tool_input": {"command": "cat the-secret-contract.txt"},
                "tool_response": {"stdout": "the confidential clause"},
            },
            self.base,
            "sigillo_key",
        )
        resource, span = self._only_span()
        self.assertEqual(resource["service.name"], "claude-code")
        self.assertEqual(resource["sigillo.client"], "claude-code")
        attributes = _attributes(span)
        self.assertEqual(attributes["openinference.span.kind"], "TOOL")
        self.assertEqual(attributes["tool.name"], "Bash")
        for name in ("sigillo.input.sha256", "sigillo.input.nonce", "sigillo.output.sha256", "sigillo.output.nonce"):
            self.assertRegex(attributes[name], r"^[0-9a-f]{64}$")
        self.assertNotIn("input.value", attributes)
        self.assertNotIn(b"secret", _Server.bodies[0])
        self.assertNotIn(b"confidential", _Server.bodies[0])
        self.assertEqual(span.status.code, Status.STATUS_CODE_OK)  # type: ignore[attr-defined]

    def test_a_failed_tool_call_is_an_error(self) -> None:
        claude_code.record(
            {"hook_event_name": "PostToolUseFailure", "session_id": "s", "tool_name": "Edit",
             "tool_input": {"file_path": "a.txt"}, "tool_error": "no such file"},
            self.base,
            "k",
        )
        _, span = self._only_span()
        self.assertEqual(span.status.code, Status.STATUS_CODE_ERROR)  # type: ignore[attr-defined]
        self.assertEqual(_attributes(span)["error.type"], "tool_error")
        self.assertNotIn(b"no such file", _Server.bodies[0])

    def test_a_prompt_and_the_session_edges_are_agent_steps(self) -> None:
        for event in (
            {"hook_event_name": "SessionStart", "session_id": "s", "source": "startup"},
            {"hook_event_name": "UserPromptSubmit", "session_id": "s", "prompt": "write the private memo"},
            {"hook_event_name": "SessionEnd", "session_id": "s", "reason": "other"},
        ):
            claude_code.record(event, self.base, "k")
        spans = [span for body in _Server.bodies for _, span in _spans(body)]
        self.assertEqual(
            [span.name for span in spans],  # type: ignore[attr-defined]
            ["claude_code.session_start", "claude_code.prompt", "claude_code.session_end"],
        )
        self.assertTrue(all(_attributes(span)["openinference.span.kind"] == "AGENT" for span in spans))
        self.assertIn("sigillo.input.sha256", _attributes(spans[1]))
        self.assertNotIn(b"private memo", b"".join(_Server.bodies))

    def test_events_it_does_not_know_send_nothing(self) -> None:
        claude_code.record({"hook_event_name": "Notification", "session_id": "s"}, self.base, "k")
        self.assertEqual(_Server.bodies, [])

    def test_one_session_is_one_trace(self) -> None:
        for session in ("alpha", "alpha", "beta"):
            claude_code.record({"hook_event_name": "SessionStart", "session_id": session}, self.base, "k")
        traces = [span.trace_id for body in _Server.bodies for _, span in _spans(body)]  # type: ignore[attr-defined]
        self.assertEqual(traces[0], traces[1])
        self.assertNotEqual(traces[0], traces[2])

    def test_a_refusal_carries_the_servers_reason(self) -> None:
        _Server.status = 403
        _Server.answer = b'{"error": "Claude Code is not enabled for this account yet"}'
        with self.assertRaisesRegex(Exception, "not enabled for this account"):
            claude_code.record({"hook_event_name": "SessionStart", "session_id": "s"}, self.base, "k")

    # -- connect and disconnect ------------------------------------------------

    def test_connect_saves_the_key_privately_and_adds_the_hooks_beside_the_existing_ones(self) -> None:
        self.settings_file.parent.mkdir(parents=True)
        theirs = {"type": "command", "command": "echo formatted"}
        self.settings_file.write_text(json.dumps({"model": "opus", "hooks": {"PostToolUse": [{"matcher": "Edit", "hooks": [theirs]}]}}))

        claude_code.connect(self.base + "/", "sigillo_key", python="/opt/python/bin/python3")
        claude_code.connect(self.base, "sigillo_key", python="/opt/python/bin/python3")  # twice: still one of ours

        config = pathlib.Path(self.environment["SIGILLO_CLAUDE_CODE_CONFIG"])
        self.assertEqual(json.loads(config.read_text()), {"endpoint": self.base, "api_key": "sigillo_key"})
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)

        settings = json.loads(self.settings_file.read_text())
        self.assertEqual(settings["model"], "opus")
        self.assertEqual(set(settings["hooks"]), {"SessionStart", "UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "SessionEnd"})
        command = '"/opt/python/bin/python3" -m sigillo.claude_code hook'
        self.assertEqual(settings["hooks"]["PostToolUse"][0], {"matcher": "Edit", "hooks": [theirs]})
        self.assertEqual(settings["hooks"]["PostToolUse"][1], {"hooks": [{"type": "command", "command": command, "timeout": 15, "async": True}]})
        self.assertEqual(settings["hooks"]["SessionEnd"], [{"hooks": [{"type": "command", "command": command, "timeout": 15}]}])

        # Each connect wrote a first receipt, which is how the key was checked.
        names = [span.name for body in _Server.bodies for _, span in _spans(body)]  # type: ignore[attr-defined]
        self.assertEqual(names, ["claude_code.connected", "claude_code.connected"])

    def test_connect_with_a_refused_key_changes_nothing(self) -> None:
        _Server.status = 401
        _Server.answer = b'{"error": "a valid Bearer API key is required"}'
        with self.assertRaisesRegex(Exception, "valid Bearer API key"):
            claude_code.connect(self.base, "sigillo_wrong")
        self.assertFalse(self.settings_file.exists())
        self.assertFalse(pathlib.Path(self.environment["SIGILLO_CLAUDE_CODE_CONFIG"]).exists())

    def test_connect_leaves_settings_it_cannot_read_alone(self) -> None:
        self.settings_file.parent.mkdir(parents=True)
        self.settings_file.write_text("{ not json")
        with self.assertRaises(json.JSONDecodeError):
            claude_code.connect(self.base, "k")
        self.assertEqual(self.settings_file.read_text(), "{ not json")
        self.assertEqual(_Server.bodies, [])

    def test_disconnect_says_so_on_the_chain_then_removes_only_its_own(self) -> None:
        self.settings_file.parent.mkdir(parents=True)
        theirs = {"matcher": "Edit", "hooks": [{"type": "command", "command": "echo formatted"}]}
        self.settings_file.write_text(json.dumps({"hooks": {"PostToolUse": [theirs]}}))
        claude_code.connect(self.base, "k")
        _Server.bodies = []

        self.assertTrue(claude_code.disconnect())

        self.assertEqual(json.loads(self.settings_file.read_text()), {"hooks": {"PostToolUse": [theirs]}})
        self.assertFalse(pathlib.Path(self.environment["SIGILLO_CLAUDE_CODE_CONFIG"]).exists())
        names = [span.name for body in _Server.bodies for _, span in _spans(body)]  # type: ignore[attr-defined]
        self.assertEqual(names, ["claude_code.disconnected"])
        self.assertFalse(claude_code.disconnect())

    # -- the hook, as Claude Code runs it ---------------------------------------

    def _run_hook(self, event: dict) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-m", "sigillo.claude_code", "hook"],
            input=json.dumps(event),
            capture_output=True,
            text=True,
            env={**os.environ, **self.environment},
            timeout=60,
        )

    def test_connect_runs_as_python_dash_m_where_the_script_is_not_on_the_path(self) -> None:
        result = subprocess.run(
            [sys.executable, "-m", "sigillo.claude_code", "connect", "--endpoint", self.base, "--key", "k"],
            capture_output=True,
            text=True,
            env={**os.environ, **self.environment},
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Connected", result.stdout)
        self.assertTrue(self.settings_file.exists())

    def test_the_hook_records_an_event_from_standard_input(self) -> None:
        claude_code.connect(self.base, "k")
        _Server.bodies = []
        result = self._run_hook({"hook_event_name": "PostToolUse", "session_id": "s", "tool_name": "Write",
                                 "tool_input": {"file_path": "x"}, "tool_response": "ok"})
        self.assertEqual(result.returncode, 0, result.stderr)
        _, span = self._only_span()
        self.assertEqual(_attributes(span)["tool.name"], "Write")

    def test_the_hook_does_nothing_when_not_connected(self) -> None:
        result = self._run_hook({"hook_event_name": "SessionStart", "session_id": "s"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(_Server.bodies, [])

    def test_the_hook_reports_a_refusal_without_blocking_claude_code(self) -> None:
        claude_code.connect(self.base, "k")
        _Server.status = 403
        _Server.answer = b'{"error": "Claude Code is not enabled for this account yet"}'
        result = self._run_hook({"hook_event_name": "SessionStart", "session_id": "s"})
        # 1, not 2: Claude Code shows the message and goes on; 2 would block the action.
        self.assertEqual(result.returncode, 1)
        self.assertIn("not enabled for this account yet", result.stderr)


if __name__ == "__main__":
    unittest.main()
