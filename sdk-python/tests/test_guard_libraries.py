"""The guard watches the recording libraries too (security audit, 2026-11-07)."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest


class GuardLibrariesTest(unittest.TestCase):
    def test_a_change_to_a_recording_library_changes_the_watched_hash(self) -> None:
        from sigillo import _watchdog

        own = os.path.dirname(_watchdog.__file__)
        with tempfile.TemporaryDirectory() as lib:
            exporter = pathlib.Path(lib, "sdk", "trace", "export.py")
            exporter.parent.mkdir(parents=True)
            exporter.write_text("def export(spans):\n    send(spans)\n")
            before = _watchdog.watched_hash(own, [lib])
            self.assertEqual(before, _watchdog.watched_hash(own, [lib]))
            self.assertNotEqual(before, _watchdog.package_hash(own))
            exporter.write_text("def export(spans):\n    pass  # nothing is sent any more\n")
            self.assertNotEqual(before, _watchdog.watched_hash(own, [lib]))
        # Without libraries, the hash is the package's alone, as before.
        self.assertEqual(_watchdog.watched_hash(own, []), _watchdog.package_hash(own))

    def test_the_heartbeat_names_the_loaded_opentelemetry(self) -> None:
        import sigillo

        libraries = sigillo._recording_libraries()
        self.assertTrue(any(pathlib.Path(path).name == "opentelemetry" for path in libraries), libraries)

    def test_the_guard_ends_the_agent_when_a_library_is_edited(self) -> None:
        from sigillo import _watchdog

        own = os.path.dirname(_watchdog.__file__)
        with tempfile.TemporaryDirectory() as lib:
            exporter = pathlib.Path(lib, "export.py")
            exporter.write_text("x = 1\n")
            agent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            self.addCleanup(agent.kill)
            config = {
                "period": 0.1, "probe": None, "script": None, "script_hash": None,
                "sdk_hash": _watchdog.watched_hash(own, [lib]), "libraries": [lib],
                "parent": agent.pid, "url": "http://127.0.0.1:9/api/v1/heartbeat", "session": "b" * 32,
                "api_key": "k", "strict": True,
            }
            guard = subprocess.Popen([sys.executable, "-I", _watchdog.__file__], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.addCleanup(guard.kill)
            guard.stdin.write((json.dumps(config) + "\n").encode())
            guard.stdin.flush()
            time.sleep(0.5)
            self.assertIsNone(agent.poll())  # nothing changed yet
            exporter.write_text("x = 2\n")
            agent.wait(timeout=30)


if __name__ == "__main__":
    unittest.main()
