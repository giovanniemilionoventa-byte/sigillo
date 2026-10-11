"""The door in front of a local model (Ollama and the like).

    python -m sigillo.door --endpoint https://... --system-id ... --upstream http://127.0.0.1:11435

listens where the agent expects the model (127.0.0.1:11434 by default), lets
through only requests that carry the system's sigillo key as their bearer
token, and forwards them to the model, which is moved to the `--upstream`
address. Every request it forwards becomes a receipt, written by this process
and not by the agent: the model is reachable through the key and nothing else,
as with a cloud model whose key sigillo holds. The key is read from
`--api-key` or, better, from the SIGILLO_API_KEY variable.

The request and the answer go through untouched and are never stored: the
receipt carries their hashes, as for every other call. Standard library only,
besides the sigillo package itself.
"""

from __future__ import annotations

import argparse
import hmac
import http.server
import json
import os
import sys
import urllib.error
import urllib.request

# Headers that describe one connection, not the message: not passed on.
_NOT_FORWARDED = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "content-length", "host"}


def _handler(upstream: str, token: str, tracer: object) -> type[http.server.BaseHTTPRequestHandler]:
    from . import _stdlib

    _stdlib._tracer = tracer  # type: ignore[assignment]

    class Door(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - the name is the base class's
            pass

        def _allowed(self) -> bool:
            given = self.headers.get("Authorization", "")
            given = given[7:] if given[:7].lower() == "bearer " else self.headers.get("x-api-key", "")
            return hmac.compare_digest(given.encode(), token.encode())

        def _refuse(self, code: int, message: str) -> None:
            body = json.dumps({"error": message}).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _serve(self) -> None:
            if not self._allowed():
                return self._refuse(401, "the sigillo key is required to reach this model")
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length > 0 else None
            headers = {k: v for k, v in self.headers.items() if k.lower() not in _NOT_FORWARDED}
            headers.pop("Authorization", None)
            headers.pop("x-api-key", None)
            url = upstream + self.path
            request = urllib.request.Request(url, data=body, method=self.command, headers=headers)
            name, attributes = _stdlib._url_attributes(url, body)
            if "llm.system" in attributes:
                attributes["llm.system"] = "ollama"  # whatever address the model was moved to
            failed: Exception | None = None
            try:
                with _stdlib._span(name, attributes):
                    try:
                        answer = urllib.request.urlopen(request, timeout=600)  # noqa: S310
                    except urllib.error.HTTPError as error:
                        answer, failed = error, error
                    self.send_response(answer.status if failed is None else answer.code)
                    for key, value in answer.headers.items():
                        if key.lower() not in _NOT_FORWARDED:
                            self.send_header(key, value)
                    self.end_headers()
                    while chunk := answer.read1(65536):  # streamed answers stay streamed
                        self.wfile.write(chunk)
                        self.wfile.flush()
                    if failed is not None:
                        raise failed
            except urllib.error.HTTPError:
                pass  # already passed on to the caller; the span says error
            except (urllib.error.URLError, OSError):
                if not self.wfile.closed:
                    try:
                        self._refuse(502, "the model did not answer")
                    except OSError:
                        pass

        do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = _serve

    return Door


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m sigillo.door", description=__doc__.split("\n\n")[0])
    parser.add_argument("--endpoint", required=True, help="the sigillo server's address")
    parser.add_argument("--system-id", required=True)
    parser.add_argument("--api-key", default=os.environ.get("SIGILLO_API_KEY"), help="default: SIGILLO_API_KEY")
    parser.add_argument("--upstream", required=True, help="where the model now listens, e.g. http://127.0.0.1:11435")
    parser.add_argument("--port", type=int, default=11434, help="where the agent expects the model")
    args = parser.parse_args(argv)
    if not args.api_key:
        sys.exit("sigillo door: the key is missing (--api-key or SIGILLO_API_KEY)")

    import sigillo

    tracing = sigillo.init(
        endpoint=args.endpoint, api_key=args.api_key, system_id=args.system_id, instrument=[], strict=False
    )
    tracer = tracing.provider.get_tracer("sigillo.door")  # type: ignore[attr-defined]
    server = http.server.ThreadingHTTPServer(
        ("127.0.0.1", args.port), _handler(args.upstream.rstrip("/"), args.api_key, tracer)
    )
    print(f"sigillo door: 127.0.0.1:{args.port} -> {args.upstream}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        tracing.provider.shutdown()  # type: ignore[attr-defined]


if __name__ == "__main__":
    main()
