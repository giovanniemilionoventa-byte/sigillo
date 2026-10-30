"""The guard process that `init` starts beside the agent.

It runs in its own interpreter, so code inside the agent cannot stop it by
stopping a thread; it can only kill the process, and then the agent's beats
end and the server writes `lost`.

Its first job, in every mode, is to tell apart why an agent went quiet, which
the agent cannot do for itself:

- The agent's process ended without closing (stopped, crashed, killed) while
  the computer stayed on: the guard tells the server (`ended`) and exits.
- The network was cut while the computer stayed on: the guard keeps running,
  so it knows the agent was alive and unobserved; when the network is back it
  reports `gap` kind `offline`, from the last time it reached the server.
- The computer slept: the guard sees the clock jump when it wakes and reports
  `gap` kind `sleep`. The agent could not act in that time.
- The computer was switched off: nobody says anything. The next session sends
  the time the computer was switched on (`boot_time`); the server compares it
  with the previous session's and writes `power_off`.

In strict mode only, it also does the rest. Every few seconds it takes the hashes of the
agent's main script and of this package again. If either differs from what the
agent started with, it tells the server at once (a beat carrying the new
hashes, which the server writes as `script_changed`) and ends the agent.

It ends by itself when the agent's end of its standard input closes, which is
how it learns the agent is gone, on every operating system. Standard library
only: it must not import the package it watches.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import pathlib
import signal
import sys
import threading
import time
import urllib.error
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


def model_state(base: str) -> str:
    """"open" if the local model answers a request that carries no key, "closed"
    if it asks for one, "none" if nothing answers there."""
    try:
        urllib.request.urlopen(base + "/api/tags", timeout=2).read()
        return "open"
    except urllib.error.HTTPError as error:
        return "closed" if error.code in (401, 403) else "open"
    except Exception:  # noqa: BLE001 - nothing listening, or not an HTTP model
        return "none"


def _say_open(config: dict) -> None:
    """The receipt that says the model can be reached without sigillo."""
    payload = {
        "actor": {"agent": "sigillo-guard"},
        "action": {"kind": "decision", "name": "sigillo.local_model.open"},
        "outcome": "error",
    }
    request = urllib.request.Request(
        config["receipts"],
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=10).read()
    except Exception:  # noqa: BLE001 - tried again at the next change
        pass


def _tell_ended(config: dict) -> None:
    """The agent's process is gone and this one is not: one last word to the server."""
    if "url" not in config:
        return
    request = urllib.request.Request(
        config["url"],
        data=json.dumps({"session": config["session"], "event": "ended"}).encode("utf-8"),
        headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=10).read()
    except Exception:  # noqa: BLE001 - the server's silence check says `lost` instead
        pass


def _end(pid: int) -> None:
    try:
        os.kill(pid, getattr(signal, "SIGKILL", signal.SIGTERM))
    except OSError:
        pass


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


# A network cut shorter than this is not worth a receipt.
OFFLINE_MIN_SECONDS = 120.0


class Gaps:
    """What the guard saw of the computer between two looks: a sleep (the clock
    jumped) or a network cut (the server could not be reached). Pure
    bookkeeping with the times passed in, so it can be tested without waiting.

    `tick(now)` is called every `period` seconds, `reached(now, ok)` after each
    attempt to reach the server. `pending` holds what is still to be told.
    """

    def __init__(self, now: float, period: float) -> None:
        self.period = period
        self.last_tick = now
        self.last_ok = now
        self.down_since: float | None = None
        self.pending: list[dict] = []

    def tick(self, now: float) -> None:
        # Asleep: this loop did not run for far longer than its period.
        if now - self.last_tick > 3 * self.period + 15:
            self.pending.append({"kind": "sleep", "from": iso(self.last_tick)})
            self.down_since = None  # an attempt that failed while asleep proves nothing
            self.last_ok = now
        self.last_tick = now

    def reached(self, now: float, ok: bool) -> None:
        if not ok:
            if self.down_since is None:
                self.down_since = self.last_ok
            return
        if self.down_since is not None and now - self.down_since >= OFFLINE_MIN_SECONDS:
            self.pending.append({"kind": "offline", "from": iso(self.down_since)})
        self.down_since = None
        self.last_ok = now


def _post(config: dict, payload: dict) -> bool:
    """Whether the server could be reached: any answer counts, even a refusal."""
    request = urllib.request.Request(
        config["url"],
        data=json.dumps({"session": config["session"], **payload}).encode("utf-8"),
        headers={"Authorization": f"Bearer {config['api_key']}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=10).read()
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:  # noqa: BLE001 - no network, no DNS, a timeout
        return False


def main() -> None:
    config = json.loads(sys.stdin.readline())
    directory = os.path.dirname(os.path.abspath(__file__))

    def parent_gone() -> None:
        # A normal close says "closed" before it hangs up; a hang-up without it
        # means the process was ended from outside.
        if sys.stdin.read().strip() != "closed":
            _tell_ended(config)
        os._exit(0)

    threading.Thread(target=parent_gone, daemon=True).start()
    strict = bool(config.get("strict"))
    period = config["period"]
    beat_every = config.get("beat_every", 60.0)
    gaps = Gaps(time.time(), period)
    next_ping = time.monotonic() + beat_every
    was = "none"
    while True:
        time.sleep(period)
        gaps.tick(time.time())
        if time.monotonic() >= next_ping:
            next_ping = time.monotonic() + beat_every
            gaps.reached(time.time(), _post(config, {"event": "ping"}))
        # What could not be told yet is told again at the next look.
        gaps.pending = [gap for gap in gaps.pending if not _post(config, {"event": "gap", "gap": gap})][-50:]
        if not strict:
            continue
        if config.get("probe"):
            now = model_state(config["probe"])
            if now == "open" and was != "open":
                _say_open(config)
                if config.get("keep"):  # the agent goes through a door beside it: said once, not ended
                    was = now
                    continue
                sys.stderr.write("sigillo: the local model answers without the sigillo key: ending the agent\n")
                _end(config["parent"])
                os._exit(0)
            was = now
        script = file_hash(config["script"]) if config["script"] is not None else None
        sdk = package_hash(directory)
        if script != config["script_hash"] or sdk != config["sdk_hash"]:
            _tell_server(config, script, sdk)
            sys.stderr.write("sigillo: the agent's script or the sigillo package changed: ending the agent\n")
            _end(config["parent"])
            os._exit(0)


if __name__ == "__main__":
    main()
