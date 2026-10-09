"""The guard process that strict mode starts beside the agent.

It runs in its own interpreter, so code inside the agent cannot stop it by
stopping a thread; it can only kill the process, and then the agent's beats
end and the server writes `lost`. Every few seconds it takes the hashes of the
agent's main script and of this package again. If either differs from what the
agent started with, it tells the server at once (a beat carrying the new
hashes, which the server writes as `script_changed`) and ends the agent.

It ends by itself when the agent's end of its standard input closes, which is
how it learns the agent is gone, on every operating system. Standard library
only: it must not import the package it watches.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import signal
import sys
import threading
import time
import urllib.request


def file_hash(path: str) -> str | None:
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


def _tell_server(config: dict, script_hash: str | None, sdk_hash: str | None) -> None:
    payload: dict[str, object] = {"session": config["session"], "event": "beat", "sdk_hash": sdk_hash}
    if config["script"] is not None:
        payload["script_hash"] = script_hash
    request = urllib.request.Request(
        config["url"],
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=10).read()
    except Exception:  # noqa: BLE001 - the agent is ended whether or not the server heard
        pass


def _end(pid: int) -> None:
    try:
        os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
    except OSError:
        pass


def main() -> None:
    config = json.loads(sys.stdin.readline())
    directory = os.path.dirname(os.path.abspath(__file__))

    def parent_gone() -> None:
        sys.stdin.read()
        os._exit(0)

    threading.Thread(target=parent_gone, daemon=True).start()
    while True:
        time.sleep(config["period"])
        script = file_hash(config["script"]) if config["script"] is not None else None
        sdk = package_hash(directory)
        if script != config["script_hash"] or sdk != config["sdk_hash"]:
            _tell_server(config, script, sdk)
            sys.stderr.write("sigillo: the agent's script or the sigillo package changed: ending the agent\n")
            _end(config["parent"])
            os._exit(0)


if __name__ == "__main__":
    main()
