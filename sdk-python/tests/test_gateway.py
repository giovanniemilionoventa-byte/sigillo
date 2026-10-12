"""The clients pointed at the model gateway by sigillo itself (sigillo/_gateway.py).

    python -m unittest discover -s sdk-python/tests -t sdk-python
"""

from __future__ import annotations

import os
import sys
import types
import unittest
import unittest.mock

from sigillo import _gateway

GATEWAY = "https://sigillo.example/llm/mistral/v1"


def _fake_mistral(module: str) -> type:
    """A stand-in for mistralai's client, which remembers the address it was given."""

    class Mistral:
        def __init__(self, api_key: str | None = None, server_url: str | None = None) -> None:
            self.api_key = api_key
            self.server_url = server_url

    sys.modules[module] = types.SimpleNamespace(Mistral=Mistral)  # type: ignore[assignment]
    return Mistral


class PointClientsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.saved = {name: sys.modules.get(name) for name in _gateway._MISTRAL_MODULES}

    def tearDown(self) -> None:
        for name, module in self.saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_gives_a_mistral_client_with_no_address_the_gateway(self) -> None:
        for module in _gateway._MISTRAL_MODULES:
            with self.subTest(module=module):
                for name in _gateway._MISTRAL_MODULES:
                    sys.modules[name] = None  # type: ignore[assignment] # not installed
                client = _fake_mistral(module)
                with unittest.mock.patch.dict(os.environ, {"MISTRAL_BASE_URL": GATEWAY}):
                    self.assertEqual(_gateway.point_clients(), [module])
                    self.assertEqual(_gateway.point_clients(), [], "patched once, not twice")
                self.assertEqual(client(api_key="k").server_url, "https://sigillo.example/llm/mistral")
                self.assertEqual(client("k", server_url=None).server_url, "https://sigillo.example/llm/mistral")
                self.assertEqual(client(server_url="https://own.example").server_url, "https://own.example")

    def test_does_nothing_without_the_gateway_or_the_client(self) -> None:
        client = _fake_mistral("mistralai")
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_gateway.point_clients(), [])
        self.assertIsNone(client(api_key="k").server_url)
        for name in _gateway._MISTRAL_MODULES:
            sys.modules[name] = None  # type: ignore[assignment]
        with unittest.mock.patch.dict(os.environ, {"MISTRAL_BASE_URL": GATEWAY}):
            self.assertEqual(_gateway.point_clients(), [])


if __name__ == "__main__":
    unittest.main()
