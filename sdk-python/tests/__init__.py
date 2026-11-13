"""Tests for the sigillo Python SDK, run with the standard library's unittest.

Every `sigillo.init` in these tests gets a folder of its own for its queue and
customer key, unless the test names one: a batch one test could not send must
not be sent again, by the queue, to the next test's server. Agents the tests
start in a separate process get a folder of their own through
SIGILLO_STATE_DIR.
"""

from __future__ import annotations

import functools
import os
import shutil
import tempfile

import sigillo

_ROOT = tempfile.mkdtemp(prefix="sigillo-tests-")
os.environ["SIGILLO_STATE_DIR"] = _ROOT

if not hasattr(sigillo.init, "__wrapped__"):
    _original_init = sigillo.init

    @functools.wraps(_original_init)
    def _init_with_its_own_folder(*args, **kwargs):  # type: ignore[no-untyped-def]
        if kwargs.get("state_dir") is None:
            kwargs["state_dir"] = tempfile.mkdtemp(dir=_ROOT)
        return _original_init(*args, **kwargs)

    sigillo.init = _init_with_its_own_folder  # type: ignore[assignment]


def _cleanup() -> None:
    shutil.rmtree(_ROOT, ignore_errors=True)


import atexit  # noqa: E402

atexit.register(_cleanup)
