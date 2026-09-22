"""The whole demo, with every process that runs for real: a real signer
holding a real key, a real server, the demo agent over all 20 CVs, and the
open-source verifier checking the export afterwards. The only thing not real
is the language model — FakeRationaleModel, by design (see agent.py) — since
OLLAMA_URL is never set here.

Skipped when the Node packages have not been built or a dependency is
missing, so `python -m unittest` still works on its own.

    python -m unittest discover -s demo/selezione-cv/tests -t demo/selezione-cv
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
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
DEMO = ROOT / "demo" / "selezione-cv"
SIGNER_CLI = ROOT / "apps" / "signer" / "dist" / "cli.js"
SERVER_CLI = ROOT / "apps" / "server" / "dist" / "cli.js"
VERIFY_CLI = ROOT / "packages" / "verifier" / "dist" / "cli.js"
AGENT = DEMO / "agent.py"
SYSTEM = "selezione-cv"
CANDIDATE_COUNT = 20


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
class DemoEndToEndTest(unittest.TestCase):
    def setUp(self) -> None:
        self.work = pathlib.Path(tempfile.mkdtemp(prefix="sigillo-demo-e2e-"))
        self.addCleanup(shutil.rmtree, self.work, ignore_errors=True)

        self.key_path = self.work / "signer.key"
        self.socket_path = self.work / "signer.sock"
        self.db_path = self.work / "sigillo.db"
        self.outbox = self.work / "outbox"
        self.processes: list[subprocess.Popen[bytes]] = []
        self.addCleanup(self._stop_processes)

        self._run(["node", str(SIGNER_CLI), "keygen", "--key", str(self.key_path)])
        self._spawn(["node", str(SIGNER_CLI), "serve", "--key", str(self.key_path),
                     "--socket", str(self.socket_path)])
        self._wait_for(lambda: self.socket_path.exists(), "the signer's socket")

        self._run(["node", str(SERVER_CLI), "system", "create", SYSTEM,
                   "--db", str(self.db_path), "--signer-socket", str(self.socket_path)])
        issued = self._run(["node", str(SERVER_CLI), "key", "create", SYSTEM,
                            "--db", str(self.db_path)])
        self.token = issued.strip().splitlines()[-1]

        self.port = _free_port()
        self._spawn(["node", str(SERVER_CLI), "serve", "--db", str(self.db_path),
                     "--signer-socket", str(self.socket_path), "--port", str(self.port)])
        self._wait_for(self._server_is_up, "the server")

    def _run(self, command: list[str]) -> str:
        result = subprocess.run(command, capture_output=True, text=True, cwd=ROOT, timeout=120)
        self.assertEqual(result.returncode, 0, f"{command}\n{result.stdout}\n{result.stderr}")
        return result.stdout

    def _spawn(self, command: list[str]) -> None:
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

    def _run_agent(self) -> str:
        environment = {
            **os.environ,
            "SIGILLO_ENDPOINT": f"http://127.0.0.1:{self.port}",
            "SIGILLO_API_KEY": self.token,
            "SIGILLO_SYSTEM_ID": SYSTEM,
            "SIGILLO_DEMO_OUTBOX": str(self.outbox),
        }
        result = subprocess.run(
            ["python3", str(AGENT)], capture_output=True, text=True, env=environment,
            cwd=self.work, timeout=180,
        )
        self.assertEqual(result.returncode, 0, f"{result.stdout}\n{result.stderr}")
        return result.stdout

    def _export(self) -> pathlib.Path:
        export = self.work / "fascicolo.zip"
        self._run(["node", str(SERVER_CLI), "export", SYSTEM, "--db", str(self.db_path),
                   "--signer-socket", str(self.socket_path), "--out", str(export)])
        return export

    def test_the_agent_screens_all_twenty_cvs_and_produces_a_verifiable_chain(self) -> None:
        output = self._run_agent()
        self.assertIn(f"{CANDIDATE_COUNT} candidature valutate", output)
        self.assertIn("Andrea Bianchi", output)
        self.assertIn("deterministic fake", output)

        export = self._export()
        with zipfile.ZipFile(export) as archive:
            self.assertIsNone(archive.testzip(), "the archive fails its own CRC checks")
            names = set(archive.namelist())
            self.assertIn("artifacts-index.jsonl", names)
            receipts_text = archive.read("receipts.jsonl").decode()
            index_text = archive.read("artifacts-index.jsonl").decode()

        receipts = [json.loads(line) for line in receipts_text.splitlines() if line]
        self.assertEqual(receipts[0]["action"]["kind"], "genesis")

        tool_calls = [r for r in receipts if r["action"]["kind"] == "tool_call"]
        by_name: dict[str, int] = {}
        for receipt in tool_calls:
            by_name[receipt["action"]["name"]] = by_name.get(receipt["action"]["name"], 0) + 1
        self.assertEqual(by_name.get("leggi_curriculum"), CANDIDATE_COUNT)
        self.assertEqual(by_name.get("valuta_candidato"), CANDIDATE_COUNT)
        self.assertEqual(by_name.get("invia_email"), CANDIDATE_COUNT)

        llm_calls = [r for r in receipts if r["action"]["kind"] == "llm_call"]
        self.assertEqual(len(llm_calls), CANDIDATE_COUNT)

        # Every real action was recorded as acting for the same recruiter.
        for receipt in receipts[1:]:
            self.assertEqual(receipt["actor"].get("on_behalf_of"), "elena.rizzo")

        # One input artifact (the CV) and one output artifact (the reply) per
        # candidate, indexed on both sides — this is what N3's verifier check
        # and the "verifica un documento" page depend on.
        index_lines = [json.loads(line) for line in index_text.splitlines() if line]
        self.assertEqual(len(index_lines), 2 * CANDIDATE_COUNT)
        self.assertEqual(sum(1 for e in index_lines if e["role"] == "input"), CANDIDATE_COUNT)
        self.assertEqual(sum(1 for e in index_lines if e["role"] == "output"), CANDIDATE_COUNT)

        # The CVs' content must never appear in the export, only its hashes.
        candidate_seven = (DEMO / "curricula" / "candidato-07.txt").read_text(encoding="utf-8")
        self.assertNotIn(candidate_seven, receipts_text)
        self.assertNotIn("Andrea Bianchi", receipts_text)

        verdict = self._run(["node", str(VERIFY_CLI), str(export), "--quiet"])
        self.assertIn("OK", verdict)
        self.assertIn(f"{len(receipts)} receipts", verdict)

    def test_sigillo_verify_doc_finds_the_exact_cv_candidate_seven_submitted(self) -> None:
        self._run_agent()
        export = self._export()

        candidate_seven = DEMO / "curricula" / "candidato-07.txt"
        found = subprocess.run(
            ["node", str(VERIFY_CLI), "doc", str(export), str(candidate_seven)],
            capture_output=True, text=True, cwd=ROOT, timeout=60,
        )
        self.assertEqual(found.returncode, 0, found.stdout + found.stderr)
        self.assertIn("leggi_curriculum", found.stdout)

        tampered = self.work / "candidato-07-tampered.txt"
        tampered.write_text(candidate_seven.read_text(encoding="utf-8").replace("Andrea", "Andreaa"))
        not_found = subprocess.run(
            ["node", str(VERIFY_CLI), "doc", str(export), str(tampered)],
            capture_output=True, text=True, cwd=ROOT, timeout=60,
        )
        self.assertEqual(not_found.returncode, 1, not_found.stdout + not_found.stderr)

    def test_a_rejection_reaches_the_declared_threshold_score(self) -> None:
        # The score behind candidate 7's non_idoneo is right there in the
        # receipt chain, at the fixed threshold the rubric declares — nothing
        # about it depends on the candidate's name or this test's wording.
        self._run_agent()
        export = self._export()
        with zipfile.ZipFile(export) as archive:
            receipts = [json.loads(line) for line in archive.read("receipts.jsonl").decode().splitlines() if line]

        evaluations = [r for r in receipts if r["action"].get("name") == "valuta_candidato"]
        self.assertEqual(len(evaluations), CANDIDATE_COUNT)
        for receipt in evaluations:
            self.assertEqual(receipt["outcome"], "ok")


if __name__ == "__main__":
    unittest.main()
