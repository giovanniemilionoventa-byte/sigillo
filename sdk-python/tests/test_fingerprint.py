"""`python -m sigillo fingerprint`: the same digest the heartbeat sends, and nothing else.

    python -m unittest discover -s sdk-python/tests -t sdk-python
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from sigillo import _host

SRC = str(Path(__file__).resolve().parents[1] / "src")


def run(*args: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PYTHONPATH": SRC}
    return subprocess.run([sys.executable, "-m", "sigillo", *args], capture_output=True, text=True, env=env, timeout=60)


class FingerprintTest(unittest.TestCase):
    def test_prints_the_digest_the_heartbeat_sends(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "agente.py"
            path.write_bytes(b"import sigillo\nAPI_KEY = 'segreto'\n")
            for command in ("fingerprint", "impronta"):
                result = run(command, str(path))
                self.assertEqual(result.returncode, 0, result.stderr)
                expected = hashlib.sha256(path.read_bytes()).hexdigest()
                self.assertEqual(expected, _host.file_hash(str(path)))
                self.assertIn(f"agent program fingerprint: {expected}", result.stdout)
                # Nothing of the file itself is printed.
                self.assertNotIn("segreto", result.stdout + result.stderr)

    def test_unreadable_file_or_wrong_use_exits_2(self) -> None:
        self.assertEqual(run("fingerprint", "/does/not/exist.py").returncode, 2)
        self.assertEqual(run("fingerprint").returncode, 2)
        self.assertEqual(run("something", "x").returncode, 2)


if __name__ == "__main__":
    unittest.main()
