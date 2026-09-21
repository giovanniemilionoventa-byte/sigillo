"""The whole path, with every process that runs in production.

A real signer holding a real key, a real server, the example agent driven by the
SDK, and the open-source verifier checking the export afterwards. Nothing is
stubbed except the language model, which is a fake by design: the point is the
record, not the answer.

Skipped when the Node packages have not been built or LangGraph is not
installed, so that `python -m unittest` still works on its own.
"""

from __future__ import annotations

import http.client
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
SIGNER_CLI = ROOT / "apps" / "signer" / "dist" / "cli.js"
SERVER_CLI = ROOT / "apps" / "server" / "dist" / "cli.js"
VERIFY_CLI = ROOT / "packages" / "verifier" / "dist" / "cli.js"
EXAMPLE = ROOT / "sdk-python" / "examples" / "langgraph_agent.py"
SYSTEM = "acme-support-bot"


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _requirements_met() -> str | None:
    if shutil.which("node") is None:
        return "node is not on PATH"
    for built in (SIGNER_CLI, SERVER_CLI, VERIFY_CLI):
        if not built.exists():
            return f"{built.relative_to(ROOT)} is missing: run pnpm build first"
    for module in ("langgraph", "langchain_core", "openinference.instrumentation.langchain"):
        if importlib.util.find_spec(module) is None:
            return f"{module} is not installed"
    return None


@unittest.skipIf(_requirements_met() is not None, _requirements_met() or "")
class EndToEndTest(unittest.TestCase):
    def setUp(self) -> None:
        self.work = pathlib.Path(tempfile.mkdtemp(prefix="sigillo-e2e-"))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)

        self.key_path = self.work / "signer.key"
        self.socket_path = self.work / "signer.sock"
        self.db_path = self.work / "sigillo.db"
        self.processes: list[subprocess.Popen[bytes]] = []
        self.addCleanup(self._stop_processes)

        self._run(["node", str(SIGNER_CLI), "keygen", "--key", str(self.key_path)])
        self.assertEqual(oct(self.key_path.stat().st_mode & 0o777), "0o600")

        self._spawn(["node", str(SIGNER_CLI), "serve", "--key", str(self.key_path),
                     "--socket", str(self.socket_path)])
        self._wait_for(lambda: self.socket_path.exists(), "the signer's socket")

        self._run(["node", str(SERVER_CLI), "system", "create", SYSTEM,
                   "--db", str(self.db_path), "--signer-socket", str(self.socket_path)])

        issued = self._run(["node", str(SERVER_CLI), "key", "create", SYSTEM,
                            "--db", str(self.db_path)])
        self.token = issued.strip().splitlines()[-1]
        self.assertRegex(self.token, r"^sigillo_[0-9a-f]{16}_[0-9a-f]{64}$")

        self.port = _free_port()
        self._spawn(["node", str(SERVER_CLI), "serve", "--db", str(self.db_path),
                     "--signer-socket", str(self.socket_path), "--port", str(self.port)])
        self._wait_for(self._server_is_up, "the server")

    def _run(self, command: list[str]) -> str:
        result = subprocess.run(command, capture_output=True, text=True, cwd=ROOT, timeout=120)
        self.assertEqual(result.returncode, 0, f"{command}\n{result.stdout}\n{result.stderr}")
        return result.stdout

    def _spawn(self, command: list[str]) -> None:
        # A new process group, because the wrappers start children of their own.
        self.processes.append(
            subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             start_new_session=True)
        )

    def _stop_processes(self) -> None:
        for process in self.processes:
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                process.kill()
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
            process.wait(timeout=10)
        self.processes.clear()

    def _server_is_up(self) -> bool:
        try:
            connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
            connection.request("GET", "/healthz")
            return connection.getresponse().status == 200
        except OSError:
            return False

    def _wait_for(self, ready, what: str, seconds: float = 30.0) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if ready():
                return
            time.sleep(0.2)
        self.fail(f"{what} did not come up within {seconds:.0f}s")

    def test_the_example_produces_a_verifiable_chain(self) -> None:
        environment = {
            **os.environ,
            "SIGILLO_ENDPOINT": f"http://127.0.0.1:{self.port}",
            "SIGILLO_API_KEY": self.token,
            "SIGILLO_SYSTEM_ID": SYSTEM,
        }
        example = subprocess.run(
            ["python", str(EXAMPLE)], capture_output=True, text=True, env=environment,
            cwd=ROOT, timeout=180,
        )
        self.assertEqual(example.returncode, 0, f"{example.stdout}\n{example.stderr}")
        self.assertIn("A-1099", example.stdout)

        export = self.work / "fascicolo"
        self._run(["node", str(SERVER_CLI), "export", SYSTEM, "--db", str(self.db_path),
                   "--signer-socket", str(self.socket_path), "--out", str(export)])

        receipts = [
            json.loads(line)
            for line in (export / "receipts.jsonl").read_text().splitlines()
            if line
        ]

        # The genesis receipt, plus one for every span the agent produced.
        self.assertGreater(len(receipts), 1)
        self.assertEqual(receipts[0]["action"]["kind"], "genesis")
        kinds = [receipt["action"]["kind"] for receipt in receipts[1:]]
        self.assertIn("llm_call", kinds)
        self.assertIn("tool_call", kinds)
        self.assertIn("agent_step", kinds)

        for index, receipt in enumerate(receipts):
            self.assertEqual(receipt["seq"], index)
            self.assertEqual(receipt["system_id"], SYSTEM)
            self.assertRegex(receipt["sig"], r"^[A-Za-z0-9+/]{86}==$")
            self.assertRegex(receipt["key_id"], r"^[0-9a-f]{16}$")

        tool_call = next(r for r in receipts if r["action"]["name"] == "search_orders")
        self.assertRegex(tool_call["input_hash"], r"^[0-9a-f]{64}$")

        # Whatever the agent actually said must not be in the record.
        whole_export = (export / "receipts.jsonl").read_text()
        self.assertNotIn("A-1099", whole_export)
        self.assertNotIn("where is my order", whole_export)
        self.assertNotIn("DHL", whole_export)

        verdict = self._run(["node", str(VERIFY_CLI), str(export), "--quiet"])
        self.assertIn("OK", verdict)
        self.assertIn(SYSTEM, verdict)
        self.assertIn(f"{len(receipts)} receipts", verdict)

    def test_a_tampered_export_is_rejected(self) -> None:
        environment = {
            **os.environ,
            "SIGILLO_ENDPOINT": f"http://127.0.0.1:{self.port}",
            "SIGILLO_API_KEY": self.token,
            "SIGILLO_SYSTEM_ID": SYSTEM,
        }
        subprocess.run(["python", str(EXAMPLE)], capture_output=True, env=environment,
                       cwd=ROOT, timeout=180, check=True)

        export = self.work / "fascicolo"
        self._run(["node", str(SERVER_CLI), "export", SYSTEM, "--db", str(self.db_path),
                   "--signer-socket", str(self.socket_path), "--out", str(export)])

        receipts_file = export / "receipts.jsonl"
        lines = [line for line in receipts_file.read_text().splitlines() if line]
        altered = json.loads(lines[1])
        altered["outcome"] = "ok" if altered["outcome"] != "ok" else "error"
        lines[1] = json.dumps(altered, separators=(",", ":"), sort_keys=True)
        receipts_file.write_text("\n".join(lines) + "\n")

        result = subprocess.run(["node", str(VERIFY_CLI), str(export)],
                                capture_output=True, text=True, cwd=ROOT, timeout=120)
        self.assertEqual(result.returncode, 1)
        self.assertIn("FAILED", result.stderr)

    def test_the_server_refuses_a_key_it_did_not_issue(self) -> None:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        connection.request(
            "POST",
            "/api/v1/receipts",
            body=json.dumps({"actor": {"agent": "a"},
                             "action": {"kind": "tool_call", "name": "n"},
                             "outcome": "ok"}),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer sigillo_{'0' * 16}_{'0' * 64}"},
        )
        self.assertEqual(connection.getresponse().status, 401)


if __name__ == "__main__":
    unittest.main()
