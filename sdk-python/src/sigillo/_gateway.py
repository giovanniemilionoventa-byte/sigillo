"""Point the model clients that read no address from the environment at the gateway.

An agent uploaded with "more security" reaches its cloud model through
sigillo's model gateway: the lines added to its file set the address each
client reads (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`
and so on) before anything else runs. Mistral's own client, `mistralai`, reads
its key from `MISTRAL_API_KEY` but its address from nothing but its
`server_url` argument, so that an agent calling `Mistral(api_key=...)` would
take the sigillo key straight to Mistral. Here, when `MISTRAL_BASE_URL` is
set, a `Mistral` client made without an address of its own is given that one.
An address the agent passes itself is left as it is.
"""

from __future__ import annotations

import functools as _functools
import importlib as _importlib
import os as _os

# Where the client lives: `mistralai` up to 1.x, `mistralai.client` from 2.0.
_MISTRAL_MODULES = ("mistralai", "mistralai.client")


def point_clients() -> list[str]:
    """Patches the clients that need it, if installed; answers which were patched."""
    address = _os.environ.get("MISTRAL_BASE_URL")
    if not address:
        return []
    patched = []
    for name in _MISTRAL_MODULES:
        try:
            client = getattr(_importlib.import_module(name), "Mistral")
        except (ImportError, AttributeError):
            continue
        if getattr(client.__init__, "_sigillo_address", None) is not None:
            continue
        client.__init__ = _with_address(client.__init__, address.rstrip("/").removesuffix("/v1"))
        patched.append(name)
    return patched


def _with_address(original, address: str):  # type: ignore[no-untyped-def]
    @_functools.wraps(original)
    def init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        if not kwargs.get("server_url"):
            kwargs["server_url"] = address
        original(self, *args, **kwargs)

    init._sigillo_address = address  # type: ignore[attr-defined]
    return init
