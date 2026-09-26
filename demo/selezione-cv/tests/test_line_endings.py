"""The curricula have the same bytes on every operating system.

The agent records the SHA-256 of each curriculum's bytes, and "verifica un
documento" answers only for a file with exactly those bytes. Line endings are
part of the bytes: with no rule in the repository, a Windows checkout
(core.autocrlf=true, Git for Windows' default) wrote candidato-07.txt with
CRLF, 406 bytes, ecfe08f1…, and every other checkout with LF, 392 bytes,
d819ede8… — two different documents for sigillo. PROGRESS.md, sessions 5, 6
and 7.

demo/selezione-cv/curricula/.gitattributes now fixes them to LF. These tests
fail if a curriculum is added outside that rule (a PDF, say), if one reaches
the repository or the disk with a CR in it, or if the rule stops holding for
a checkout configured the way Git for Windows configures one.

Skipped outside a git checkout, e.g. a copy of the demo downloaded as a zip.

    python -m unittest discover -s demo/selezione-cv/tests -t demo/selezione-cv
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
CURRICULA = ROOT / "demo" / "selezione-cv" / "curricula"
CURRICULA_FROM_ROOT = "demo/selezione-cv/curricula"


def git(*arguments: str) -> bytes:
    return subprocess.run(["git", *arguments], cwd=ROOT, check=True, capture_output=True).stdout


def in_a_git_checkout() -> bool:
    if shutil.which("git") is None:
        return False
    try:
        return git("rev-parse", "--is-inside-work-tree").strip() == b"true"
    except subprocess.CalledProcessError:
        return False


def line_endings(content: bytes) -> tuple[int, int, int]:
    """(CRLF, lone LF, lone CR), counted on the raw bytes."""
    crlf = content.count(b"\r\n")
    return crlf, content.count(b"\n") - crlf, content.count(b"\r") - crlf


@unittest.skipUnless(in_a_git_checkout(), "not a git checkout: nothing decides the line endings")
class CurriculaLineEndingsTest(unittest.TestCase):
    def setUp(self) -> None:
        # Tracked files as git lists them, plus whatever the agent would read
        # from disk (agent.py globs candidato-*.txt), so a new curriculum not
        # yet committed is held to the same rule.
        tracked = git("ls-files", "-z", "--", CURRICULA_FROM_ROOT).decode("utf-8").split("\0")
        on_disk = [f"{CURRICULA_FROM_ROOT}/{p.name}" for p in CURRICULA.glob("candidato-*.txt")]
        self.curricula = sorted(
            {p for p in tracked + on_disk if p and not p.endswith("/.gitattributes")}
        )
        self.tracked = sorted(p for p in tracked if p and not p.endswith("/.gitattributes"))
        self.assertGreaterEqual(len(self.curricula), 20)

    def test_every_curriculum_is_declared_text_with_lf_line_endings(self) -> None:
        output = git("check-attr", "-z", "text", "eol", "--", *self.curricula).decode("utf-8")
        fields = output.split("\0")[:-1]
        declared: dict[str, dict[str, str]] = {}
        for path, attribute, value in zip(fields[0::3], fields[1::3], fields[2::3]):
            declared.setdefault(path, {})[attribute] = value
        for path in self.curricula:
            with self.subTest(path=path):
                self.assertEqual(declared[path], {"text": "set", "eol": "lf"})

    def test_the_files_on_disk_have_lf_line_endings_only(self) -> None:
        for path in self.curricula:
            with self.subTest(path=path):
                crlf, lf, cr = line_endings((ROOT / path).read_bytes())
                self.assertEqual((crlf, cr), (0, 0))
                self.assertGreater(lf, 0)

    def test_the_repository_holds_lf_line_endings_only(self) -> None:
        for path in self.tracked:
            with self.subTest(path=path):
                # cat-file prints the blob as stored: no filter, no conversion.
                crlf, lf, cr = line_endings(git("cat-file", "blob", f":{path}"))
                self.assertEqual((crlf, cr), (0, 0))
                self.assertGreater(lf, 0)

    def test_a_checkout_configured_like_git_for_windows_writes_the_same_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(
                ["git", "-c", "core.autocrlf=true", "-c", "core.eol=crlf",
                 "checkout-index", f"--prefix={directory}/", "--", *self.tracked],
                cwd=ROOT, check=True, capture_output=True,
            )
            for path in self.tracked:
                with self.subTest(path=path):
                    written = (pathlib.Path(directory) / path).read_bytes()
                    self.assertEqual(line_endings(written)[0::2], (0, 0))
                    self.assertEqual(written, git("cat-file", "blob", f":{path}"))


if __name__ == "__main__":
    unittest.main()
