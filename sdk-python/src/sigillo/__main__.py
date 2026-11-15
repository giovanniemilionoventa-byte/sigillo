"""`python -m sigillo fingerprint <file>`: the agent program's fingerprint.

Prints the SHA-256 of the file exactly as the recorder computes it for the
heartbeat (the bytes of the main script the agent is started with), which the
server writes on the chain as the `agent program` artifact. An auditor compares
the printed 64 characters with the evidence pack (`sigillo-verify program`), so
the program file itself never has to be shown to anyone or leave the computer.
Reads the one file, sends nothing. `impronta` is the same command in Italian.
"""

from __future__ import annotations

import sys

from . import _host

_USAGE = "usage: python -m sigillo fingerprint <agent file>   (or: impronta <agent file>)\n"


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] not in ("fingerprint", "impronta"):
        sys.stderr.write(_USAGE)
        return 2
    digest = _host.file_hash(argv[1])
    if digest is None:
        sys.stderr.write(f"cannot read {argv[1]}\n")
        return 2
    sys.stdout.write(f"agent program fingerprint: {digest}\n")
    sys.stdout.write("Only this fingerprint was computed: nothing of the file is shown or sent.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
