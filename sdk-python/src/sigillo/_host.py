"""Facts about the agent's own computer that the heartbeat carries.

The hashes of the agent's main script, of this package and of the recording
libraries it loaded (OpenTelemetry, OpenInference), so that the server can
write on the chain that one of them changed while the agent ran; and when the
computer was switched on, so that the server can tell a computer switched off
from an agent that went silent. Standard library only.
"""

from __future__ import annotations

import datetime
import hashlib
import pathlib
import sys
import time


def file_hash(path: str) -> str | None:
    """SHA-256 of a file's bytes, or None when it can no longer be read."""
    try:
        return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def package_hash(directory: str) -> str | None:
    """SHA-256 over the names and bytes of the package's .py files, in name order."""
    digest = hashlib.sha256()
    try:
        for path in sorted(pathlib.Path(directory).glob("*.py")):
            digest.update(path.name.encode("utf-8") + b"\0" + path.read_bytes() + b"\0")
    except OSError:
        return None
    return digest.hexdigest()


def libraries_hash(directories: list[str]) -> str | None:
    """SHA-256 over the .py files under each directory, recursively, in path order:
    the recording libraries the agent loaded. A change to one of them could drop
    actions from the record without touching the agent's script or this package."""
    digest = hashlib.sha256()
    try:
        for directory in sorted(set(directories)):
            root = pathlib.Path(directory)
            for path in sorted(root.rglob("*.py")):
                digest.update(str(path.relative_to(root)).encode("utf-8") + b"\0" + path.read_bytes() + b"\0")
    except OSError:
        return None
    return digest.hexdigest()


def watched_hash(directory: str, libraries: list[str] | None) -> str | None:
    """What the heartbeat sends as `sdk_hash`: this package, and with
    `libraries` the recording libraries too, in one digest."""
    own = package_hash(directory)
    if not libraries or own is None:
        return own
    libs = libraries_hash(libraries)
    if libs is None:
        return None
    return hashlib.sha256(f"{own}:{libs}".encode("ascii")).hexdigest()


def boot_time() -> float | None:
    """When this computer was switched on, as seconds since the epoch, or None if unknown."""
    try:
        if sys.platform.startswith("linux"):
            for line in pathlib.Path("/proc/stat").read_text().splitlines():
                if line.startswith("btime "):
                    return float(line.split()[1])
        elif sys.platform == "darwin":
            import re
            import subprocess

            out = subprocess.run(["sysctl", "-n", "kern.boottime"], capture_output=True, text=True, timeout=5).stdout
            match = re.search(r"sec = (\d+)", out)
            return float(match.group(1)) if match else None
        elif sys.platform == "win32":
            import ctypes

            kernel = ctypes.windll.kernel32  # type: ignore[attr-defined]
            kernel.GetTickCount64.restype = ctypes.c_ulonglong
            return time.time() - kernel.GetTickCount64() / 1000
    except Exception:  # noqa: BLE001 - no boot time is no evidence either way
        return None
    return None


def iso(seconds: float) -> str:
    return datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
