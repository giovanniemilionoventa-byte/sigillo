"""Audit the Python dependencies for known vulnerabilities, with pip-audit.

What is audited, as a single resolution:

- the SDK's own dependencies and every one of its extras, read from
  sdk-python/pyproject.toml, so that nothing has to be copied here by hand and
  a new extra is audited the day it is added;
- sdk-python/examples/requirements.txt and demo/selezione-cv/requirements.txt.

None of these are pinned, so this audits the versions a user would install
today, which is exactly what can change without a commit: run it on a
schedule, not only on push.

pip-audit resolves the requirements in a throwaway virtual environment and
looks every resolved package up in the PyPI advisory database. The exit code is
pip-audit's own: 0 when nothing is known to be vulnerable, 1 when something is.
`--strict` makes a dependency that cannot be resolved a failure too, rather than
a silently shorter audit.

    pip install pip-audit
    python3 scripts/audit_python.py

Needs Python 3.11 or later (tomllib) and network access to PyPI. No sigillo
code and no third-party package is imported here.
"""

from __future__ import annotations

import importlib.util
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PYPROJECT = ROOT / "sdk-python" / "pyproject.toml"
REQUIREMENT_FILES = (
    ROOT / "sdk-python" / "examples" / "requirements.txt",
    ROOT / "demo" / "selezione-cv" / "requirements.txt",
)


def sdk_requirements() -> list[str]:
    """The SDK's dependencies and all of its extras, as PEP 508 strings."""
    import tomllib

    project = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]
    requirements = list(project.get("dependencies", []))
    for extra in project.get("optional-dependencies", {}).values():
        requirements.extend(extra)
    return requirements


def main() -> int:
    if sys.version_info < (3, 11):
        print("audit_python.py needs Python 3.11 or later (for tomllib)", file=sys.stderr)
        return 2
    if importlib.util.find_spec("pip_audit") is None:
        print("pip-audit is not installed: pip install pip-audit", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory() as directory:
        sdk = pathlib.Path(directory) / "sdk-requirements.txt"
        sdk.write_text("\n".join(sdk_requirements()) + "\n", encoding="utf-8")

        command = [sys.executable, "-m", "pip_audit", "--strict", "--progress-spinner", "off"]
        for requirements in (sdk, *REQUIREMENT_FILES):
            command += ["-r", str(requirements)]

        print("auditing:", ", ".join(str(path.relative_to(ROOT)) for path in (PYPROJECT, *REQUIREMENT_FILES)))
        return subprocess.run(command, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main())
