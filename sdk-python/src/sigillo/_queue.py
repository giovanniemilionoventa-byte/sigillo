"""The recorder's queue on disk: write first, send after.

Every batch of actions is written to a file in the queue directory before it
is sent, and its file is deleted only once the server has accepted it. A
network cut, a server that is down or busy, or an agent that stops before
the batch went out loses nothing: the files stay, and they are sent, in the
order they were written, as soon as the server answers again, by this
process or by the next one that starts with the same queue directory. The
server writes each action once, however many times it arrives (it knows a
resent span by its trace and span id).

The agent never waits for the network and is never stopped: nothing here
raises into the agent's code. Where the queue directory cannot be written
(a read-only container, say) the queue is kept in memory instead, with a
warning: it then survives a network cut but not a restart.

Standard library only.
"""

from __future__ import annotations

import logging
import os
import pathlib
import threading
import time
import urllib.error
import urllib.request

_LOG = logging.getLogger("sigillo")

# Past this many bytes waiting, new batches are refused with an error in the
# log rather than filling the agent's disk: what is already queued is kept,
# in order, and goes out first once the server answers.
DEFAULT_MAX_BYTES = 200 * 1024 * 1024

# Answers that will not change on a retry: the batch is set aside in
# `rejected/`, so that it does not hold up the ones behind it.
_PERMANENT = frozenset({400, 404, 413, 415, 422})


class DiskQueue:
    def __init__(
        self,
        directory: str | os.PathLike | None,
        url: str,
        headers: dict[str, str],
        retry_seconds: float = 30.0,
        max_bytes: int = DEFAULT_MAX_BYTES,
    ) -> None:
        self._url = url
        self._headers = dict(headers)
        self._retry = retry_seconds
        self._max_bytes = max_bytes
        # Writing and sending each have their own lock: a slow server never
        # holds up the writing of the next batch.
        self._write_lock = threading.Lock()
        self._send_lock = threading.Lock()
        self._wake = threading.Event()
        self._stopped = threading.Event()
        self._counter = 0
        self._memory: list[bytes] | None = None
        self._directory: pathlib.Path | None = None
        if directory is not None:
            try:
                path = pathlib.Path(directory)
                path.mkdir(parents=True, exist_ok=True, mode=0o700)
                probe = path / ".write-test"
                probe.write_bytes(b"")
                probe.unlink()
                self._directory = path
            except OSError as error:
                _LOG.warning(
                    "sigillo: the queue directory %s cannot be written (%s): actions waiting to be sent are "
                    "kept in memory, and lost if the agent restarts before the server answers",
                    directory,
                    type(error).__name__,
                )
        if self._directory is None:
            self._memory = []
        self._thread = threading.Thread(target=self._run, name="sigillo-queue", daemon=True)

    @property
    def on_disk(self) -> bool:
        return self._directory is not None

    def start(self) -> None:
        """Starts the thread that sends what is waiting: at once (what an earlier
        run left behind), then whenever something is added, and every
        `retry_seconds` while anything is still waiting."""
        self._thread.start()

    def put(self, body: bytes) -> bool:
        """Keeps one batch, already encoded, until the server has it. False only
        when the queue is full and the batch could not be kept."""
        with self._write_lock:
            if self.pending_bytes() + len(body) > self._max_bytes:
                _LOG.error(
                    "sigillo: %d bytes are already waiting to be sent: this batch of actions is not kept. "
                    "Check that the server can be reached.",
                    self.pending_bytes(),
                )
                return False
            if self._memory is not None:
                self._memory.append(body)
            else:
                assert self._directory is not None
                self._counter += 1
                name = f"{time.time_ns():020d}-{os.getpid()}-{self._counter:06d}.pb"
                partial = self._directory / (name + ".part")
                try:
                    with open(partial, "wb") as handle:
                        handle.write(body)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(partial, self._directory / name)
                except OSError as error:
                    _LOG.warning("sigillo: could not write to the queue (%s): kept in memory", type(error).__name__)
                    self._memory = [body]
                    self._directory = None
        self._wake.set()
        return True

    def pending(self) -> int:
        """How many batches are waiting."""
        if self._memory is not None:
            return len(self._memory)
        return len(self._files())

    def pending_bytes(self) -> int:
        if self._memory is not None:
            return sum(len(body) for body in self._memory)
        total = 0
        for path in self._files():
            try:
                total += path.stat().st_size
            except OSError:
                pass
        return total

    def _files(self) -> list[pathlib.Path]:
        assert self._directory is not None
        try:
            return sorted(path for path in self._directory.iterdir() if path.suffix == ".pb" and path.is_file())
        except OSError:
            return []

    def flush(self) -> bool:
        """Sends what is waiting, oldest first, and stops at the first batch the
        server does not take now. True when nothing is left waiting."""
        with self._send_lock:
            if self._memory is not None:
                while self._memory:
                    outcome = self._send(self._memory[0])
                    if outcome == "retry":
                        return False
                    self._memory.pop(0)
                return True
            for path in self._files():
                try:
                    body = path.read_bytes()
                except OSError:
                    continue
                outcome = self._send(body)
                if outcome == "retry":
                    return False
                if outcome == "rejected":
                    self._set_aside(path)
                    continue
                try:
                    path.unlink()
                except OSError:
                    pass
            return True

    def _set_aside(self, path: pathlib.Path) -> None:
        assert self._directory is not None
        rejected = self._directory / "rejected"
        try:
            rejected.mkdir(exist_ok=True, mode=0o700)
            os.replace(path, rejected / path.name)
        except OSError:
            pass

    def _send(self, body: bytes) -> str:
        """"sent", "rejected" (the server will never take it) or "retry"."""
        request = urllib.request.Request(self._url, data=body, headers=self._headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310 - the caller's own server
                response.read()
            return "sent"
        except urllib.error.HTTPError as error:
            if error.code in _PERMANENT:
                _LOG.error("sigillo: the server refused a batch of actions (HTTP %d): set aside in rejected/", error.code)
                return "rejected"
            _LOG.warning("sigillo: the server did not take a batch now (HTTP %d): kept, sent again later", error.code)
            return "retry"
        except Exception as error:  # noqa: BLE001 - a network failure must never reach the agent
            _LOG.warning("sigillo: the server cannot be reached (%s): actions kept, sent again later", type(error).__name__)
            return "retry"

    def _run(self) -> None:
        while not self._stopped.is_set():
            try:
                self.flush()
            except Exception as error:  # noqa: BLE001 - this thread must outlive any surprise
                _LOG.warning("sigillo: queue: %s", type(error).__name__)
            self._wake.wait(self._retry)
            self._wake.clear()

    def close(self) -> bool:
        """One last attempt to send, then the thread stops. What could not be
        sent stays on disk for the next run."""
        self._stopped.set()
        self._wake.set()
        try:
            return self.flush()
        except Exception:  # noqa: BLE001
            return False
