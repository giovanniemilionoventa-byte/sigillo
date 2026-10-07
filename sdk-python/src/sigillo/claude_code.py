"""Record a Claude Code session on a sigillo server, through Claude Code's hooks.

One command connects it, once per computer:

    sigillo-claude-code connect --endpoint https://sigillo.example --key sigillo_...

That writes the endpoint and key to `~/.sigillo/claude-code.json` (readable by
its owner only) and adds hooks to Claude Code's user settings
(`~/.claude/settings.json`, every project), each running this module with the
same Python that ran `connect`. From then on Claude Code itself starts this
module at each of these moments, and each becomes a receipt:

    SessionStart         claude_code.session_start   agent_step
    UserPromptSubmit     claude_code.prompt          agent_step, the prompt's digest
    PostToolUse          the tool's name             tool_call, input and output digests
    PostToolUseFailure   the tool's name             tool_call, outcome error, input digest
    SessionEnd           claude_code.session_end     agent_step

Recording does not depend on the model choosing to: Claude Code runs a hook
whatever the model does. Like the rest of this package, only digests leave the
computer: a prompt, a command or a file's text is hashed here, salted, before
anything is sent (`_filtered_span`). Every receipt of one session
shares one trace id, derived from Claude Code's session id, and one agent name,
"Claude Code · <project folder> · <session>", so the console lists each session
apart. The folder name (not its path) is the one thing sent beyond digests.

What it does not do: it cannot stop someone, or Claude itself with the user's
permission, from removing the hooks or running `disconnect`. `disconnect`
writes a receipt saying so before it removes them, and the console shows when a
system stopped receiving actions; the guarantee is that what Claude Code did
while connected is on the chain, not that it stays connected.

Spans carry the resource attribute `sigillo.client=claude-code`, so the server
can tell this connector apart and open it to accounts one step at a time
(SIGILLO_CLAUDE_CODE).
"""

from __future__ import annotations

import argparse as _argparse
import hashlib as _hashlib
import json as _json
import os as _os
import pathlib as _pathlib
import re as _re
import sys as _sys
import urllib.error as _urllib_error
import urllib.request as _urllib_request
from typing import Sequence as _Sequence

from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans as _encode_spans
from opentelemetry.sdk.resources import Resource as _Resource
from opentelemetry.sdk.trace import ReadableSpan as _ReadableSpan
from opentelemetry.sdk.trace import SpanProcessor as _SpanProcessor
from opentelemetry.sdk.trace import TracerProvider as _TracerProvider
from opentelemetry.sdk.trace.id_generator import RandomIdGenerator as _RandomIdGenerator
from opentelemetry.trace import StatusCode as _StatusCode

from . import _filtered_span, _show_span, _traces_endpoint

__all__ = ["connect", "disconnect", "record", "main"]

CLIENT = "claude-code"
# The agent on every receipt (service.name) starts with this; `_agent_name`
# adds the project folder and the session, so sessions read apart in the console.
AGENT = "Claude Code"
# What marks a hook as this module's, so that `connect` replaces it and
# `disconnect` removes it without touching anyone else's.
_MARK = "sigillo.claude_code"
# Async: Claude Code does not wait for these, so recording adds no delay to
# the session. SessionStart and SessionEnd are waited for, so the first and
# the last receipt are not lost to a process that is closing.
_EVENTS: dict[str, bool] = {
    "SessionStart": False,
    "UserPromptSubmit": True,
    "PostToolUse": True,
    "PostToolUseFailure": True,
    "SessionEnd": False,
}
_TIMEOUT_SECONDS = 15
_CONNECTED = "sigillo:connected"
_DISCONNECTED = "sigillo:disconnected"


def config_path() -> _pathlib.Path:
    override = _os.environ.get("SIGILLO_CLAUDE_CODE_CONFIG")
    return _pathlib.Path(override) if override else _pathlib.Path.home() / ".sigillo" / "claude-code.json"


def settings_path() -> _pathlib.Path:
    """Claude Code's user settings, where it reads them itself: CLAUDE_CONFIG_DIR if set."""
    base = _os.environ.get("CLAUDE_CONFIG_DIR")
    return (_pathlib.Path(base) if base else _pathlib.Path.home() / ".claude") / "settings.json"


class _SessionTraceIds(_RandomIdGenerator):
    """One trace per Claude Code session: the trace id is the first 16 bytes
    of the SHA-256 of the session id, so separate hook processes agree on it."""

    def __init__(self, session_id: str) -> None:
        self._trace_id = int.from_bytes(_hashlib.sha256(session_id.encode("utf-8")).digest()[:16], "big") or 1

    def generate_trace_id(self) -> int:
        return self._trace_id


def _agent_name(event: dict) -> str:
    """"Claude Code · <project folder> · <first 8 of the session id>".

    The folder is only the last name of Claude Code's working directory, never
    the path; it tells two projects apart. `connect` and `disconnect` belong
    to no session and are just "Claude Code".
    """
    session = str(event.get("session_id") or "")
    if session in ("", "connect", "disconnect", "unknown"):
        return AGENT
    parts = [AGENT]
    folder = [part for part in _re.split(r"[\\/]", str(event.get("cwd") or "")) if part]
    if folder:
        parts.append(folder[-1][:60])
    parts.append(session[:8])
    return " · ".join(parts)


def _text(value: object) -> str:
    """A tool's input or output as one string to hash: a string as it is, anything else as JSON."""
    if isinstance(value, str):
        return value
    return _json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _first(event: dict, *names: str) -> object:
    """The first of several names Claude Code has used for the same field."""
    for name in names:
        if name in event:
            return event[name]
    return None


def _span_for(event: dict) -> tuple[str, dict[str, object], bool] | None:
    """The span one hook event becomes: its name, attributes, and whether it failed."""
    kind = event.get("hook_event_name")
    if kind in ("PostToolUse", "PostToolUseFailure"):
        tool = str(event.get("tool_name") or "unknown")
        attributes: dict[str, object] = {
            "openinference.span.kind": "TOOL",
            "tool.name": tool,
            "input.value": _text(event.get("tool_input")),
        }
        if kind == "PostToolUse":
            output = _first(event, "tool_response", "tool_output")
            if output is not None:
                attributes["output.value"] = _text(output)
            return tool, attributes, False
        attributes["error.type"] = "tool_error"
        return tool, attributes, True
    if kind == "UserPromptSubmit":
        prompt = _first(event, "prompt", "user_input")
        attributes = {"openinference.span.kind": "AGENT"}
        if prompt is not None:
            attributes["input.value"] = _text(prompt)
        return "claude_code.prompt", attributes, False
    if kind == "SessionStart":
        return "claude_code.session_start", {"openinference.span.kind": "AGENT"}, False
    if kind == "SessionEnd":
        return "claude_code.session_end", {"openinference.span.kind": "AGENT"}, False
    # Not Claude Code's: what `connect` and `disconnect` write about themselves.
    if kind == _CONNECTED:
        return "claude_code.connected", {"openinference.span.kind": "AGENT"}, False
    if kind == _DISCONNECTED:
        return "claude_code.disconnected", {"openinference.span.kind": "AGENT"}, False
    return None


def _load_config() -> dict | None:
    try:
        with open(config_path(), encoding="utf-8") as handle:
            config = _json.load(handle)
    except FileNotFoundError:
        return None
    if not isinstance(config, dict) or not config.get("endpoint") or not config.get("api_key"):
        raise ValueError(f"{config_path()} does not hold an endpoint and a key: run connect again")
    return config


class _Rejected(Exception):
    """The server answered, and refused the receipt."""


class _Keep(_SpanProcessor):
    """Holds the span once it ends, for `record` to send itself."""

    def __init__(self) -> None:
        self.spans: list[_ReadableSpan] = []

    def on_end(self, span: _ReadableSpan) -> None:
        self.spans.append(span)


def record(event: dict, endpoint: str, api_key: str, show: bool = False) -> None:
    """Sends one hook event to the server as one span, and waits for the answer.

    The span goes through the same filter as the rest of the package
    (`_filtered_span`): a salted digest of each input and output, nothing else
    of them. Raises `_Rejected` with the server's reason when it refuses the
    span, and an `OSError` when the server cannot be reached.
    """
    span = _span_for(event)
    if span is None:
        return
    name, attributes, failed = span
    session = str(event.get("session_id") or "unknown")
    provider = _TracerProvider(
        resource=_Resource.create({"service.name": _agent_name(event), "sigillo.client": CLIENT}),
        id_generator=_SessionTraceIds(session),
    )
    kept = _Keep()
    provider.add_span_processor(kept)
    tracer = provider.get_tracer("sigillo.claude_code")
    with tracer.start_as_current_span(name, attributes=attributes, record_exception=False) as current:
        current.set_status(_StatusCode.ERROR if failed else _StatusCode.OK)

    filtered = [_filtered_span(ended) for ended in kept.spans]
    if show:
        for ended in filtered:
            _show_span(ended)
    request = _urllib_request.Request(
        _traces_endpoint(endpoint),
        data=_encode_spans(filtered).SerializeToString(),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/x-protobuf"},
        method="POST",
    )
    try:
        with _urllib_request.urlopen(request, timeout=10):
            pass
    except _urllib_error.HTTPError as error:
        try:
            reason = _json.loads(error.read()).get("error")
        except (ValueError, AttributeError):
            reason = None
        raise _Rejected(str(reason or f"HTTP {error.code}")) from None


def _hook_command(python: str) -> str:
    # Forward slashes: Claude Code runs hooks through bash, Git Bash on Windows too.
    return f'"{python.replace(chr(92), "/")}" -m {_MARK} hook'


def _read_settings(path: _pathlib.Path) -> dict:
    if not path.exists():
        return {}
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return {}
    settings = _json.loads(text)  # an unreadable file is left alone: the caller says so
    if not isinstance(settings, dict):
        raise ValueError(f"{path} is not a JSON object")
    return settings


def _without_ours(groups: object) -> list:
    """An event's hook groups, minus any that run this module."""
    kept = []
    for group in groups if isinstance(groups, list) else []:
        hooks = group.get("hooks") if isinstance(group, dict) else None
        if isinstance(hooks, list) and any(_MARK in str(hook.get("command", "")) for hook in hooks if isinstance(hook, dict)):
            continue
        kept.append(group)
    return kept


def _write_settings(path: _pathlib.Path, settings: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".sigillo-tmp")
    temporary.write_text(_json.dumps(settings, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    _os.replace(temporary, path)


def connect(endpoint: str, api_key: str, python: str | None = None) -> None:
    """Saves the endpoint and key, sends a first receipt, and adds the hooks.

    The receipt goes first: a key the server refuses, or a server out of reach,
    stops here, before Claude Code is changed at all.
    """
    endpoint = endpoint.strip().rstrip("/")
    api_key = api_key.strip()
    if not endpoint or not api_key:
        raise ValueError("both the endpoint and the key are needed")
    settings_file = settings_path()
    settings = _read_settings(settings_file)

    record({"hook_event_name": _CONNECTED, "session_id": "connect"}, endpoint, api_key)

    config_file = config_path()
    config_file.parent.mkdir(parents=True, exist_ok=True)
    descriptor = _os.open(config_file, _os.O_WRONLY | _os.O_CREAT | _os.O_TRUNC, 0o600)
    with _os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        _json.dump({"endpoint": endpoint, "api_key": api_key}, handle)
    _os.chmod(config_file, 0o600)

    hooks = settings.get("hooks")
    hooks = dict(hooks) if isinstance(hooks, dict) else {}
    command = _hook_command(python or _sys.executable)
    for event, run_async in _EVENTS.items():
        entry: dict[str, object] = {"type": "command", "command": command, "timeout": _TIMEOUT_SECONDS}
        if run_async:
            entry["async"] = True
        hooks[event] = _without_ours(hooks.get(event)) + [{"hooks": [entry]}]
    settings["hooks"] = hooks
    _write_settings(settings_file, settings)


def disconnect() -> bool:
    """Removes the hooks and the saved key; says so on the chain first, when it can.

    Returns whether anything was connected.
    """
    settings_file = settings_path()
    settings = _read_settings(settings_file)
    try:
        config = _load_config()
    except ValueError:
        config = None
    if config is not None:
        try:
            record({"hook_event_name": _DISCONNECTED, "session_id": "disconnect"}, config["endpoint"], config["api_key"])
        except Exception:  # noqa: BLE001 - disconnecting must work with the server out of reach too
            pass

    found = config_path().exists()
    hooks = settings.get("hooks")
    if isinstance(hooks, dict):
        for event in list(hooks):
            before = hooks[event]
            if not isinstance(before, list):
                continue
            kept = _without_ours(before)
            if len(kept) != len(before):
                found = True
            if kept:
                hooks[event] = kept
            else:
                del hooks[event]
        if not hooks:
            del settings["hooks"]
        _write_settings(settings_file, settings)
    config_path().unlink(missing_ok=True)
    return found


def _hook(stdin: str) -> int:
    """What Claude Code runs. Never blocks Claude Code: a failure is reported
    on standard error with status 1, which Claude Code shows as a hook error
    and goes on."""
    try:
        config = _load_config()
        if config is None:
            return 0
        event = _json.loads(stdin)
        if not isinstance(event, dict):
            raise ValueError("Claude Code sent something other than a JSON object")
        record(event, config["endpoint"], config["api_key"])
    except _Rejected as refused:
        print(f"sigillo: the server refused this action: {refused}", file=_sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - a hook must never take Claude Code down
        print(f"sigillo: this action was not recorded ({type(error).__name__}: {error})", file=_sys.stderr)
        return 1
    return 0


def main(argv: _Sequence[str] | None = None) -> int:
    parser = _argparse.ArgumentParser(
        prog="sigillo-claude-code",
        description="Record every Claude Code session on this computer on a sigillo server.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    connecting = commands.add_parser("connect", help="add the hooks to Claude Code's user settings")
    connecting.add_argument("--endpoint", required=True, help="the sigillo server, e.g. https://get-sigillo.eu")
    connecting.add_argument("--key", required=True, help="the system's key, sigillo_...")
    commands.add_parser("disconnect", help="remove the hooks and the saved key")
    commands.add_parser("hook", help="what Claude Code runs: one event as JSON on standard input")
    arguments = parser.parse_args(argv)

    if arguments.command == "hook":
        return _hook(_sys.stdin.read())
    if arguments.command == "connect":
        try:
            connect(arguments.endpoint, arguments.key)
        except _Rejected as refused:
            print(f"sigillo: the server refused the key: {refused}", file=_sys.stderr)
            return 1
        except _json.JSONDecodeError as error:
            print(f"sigillo: {settings_path()} is not valid JSON ({error}); fix it and run connect again", file=_sys.stderr)
            return 1
        except Exception as error:  # noqa: BLE001 - one plain sentence for the person at the terminal
            print(f"sigillo: could not connect ({type(error).__name__}: {error})", file=_sys.stderr)
            return 1
        print("Connected. Restart Claude Code: from now on every session on this computer is recorded on sigillo.")
        return 0
    found = disconnect()
    print("Disconnected: Claude Code no longer sends anything to sigillo." if found else "Nothing was connected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
