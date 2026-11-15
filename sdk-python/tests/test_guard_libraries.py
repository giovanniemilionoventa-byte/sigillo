"""The heartbeat watches the recording libraries too (security audit, 2026-11-07)."""

from __future__ import annotations

import os
import pathlib
import tempfile
import unittest


class GuardLibrariesTest(unittest.TestCase):
    def test_a_change_to_a_recording_library_changes_the_watched_hash(self) -> None:
        from sigillo import _host

        own = os.path.dirname(_host.__file__)
        with tempfile.TemporaryDirectory() as lib:
            exporter = pathlib.Path(lib, "sdk", "trace", "export.py")
            exporter.parent.mkdir(parents=True)
            exporter.write_text("def export(spans):\n    send(spans)\n")
            before = _host.watched_hash(own, [lib])
            self.assertEqual(before, _host.watched_hash(own, [lib]))
            self.assertNotEqual(before, _host.package_hash(own))
            exporter.write_text("def export(spans):\n    pass  # nothing is sent any more\n")
            self.assertNotEqual(before, _host.watched_hash(own, [lib]))
        # Without libraries, the hash is the package's alone, as before.
        self.assertEqual(_host.watched_hash(own, []), _host.package_hash(own))

    def test_the_heartbeat_names_the_loaded_opentelemetry(self) -> None:
        import sigillo

        libraries = sigillo._recording_libraries()
        self.assertTrue(any(pathlib.Path(path).name == "opentelemetry" for path in libraries), libraries)

