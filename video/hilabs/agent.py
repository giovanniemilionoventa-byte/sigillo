"""Pharmacy review assistant: reads each policy or contract in ./documents
and writes a short review note for the pharmacist in ./review-notes.

No AI model is needed for the demo: the note is built from the document itself.
"""
import pathlib

try:  # optional: when it is installed, each document used is sealed by fingerprint
    from opentelemetry import trace
    from sigillo import artifact as seal_document
except ImportError:
    seal_document = None

SIGNALS = {
    "policy": "pharmacy policy",
    "agreement": "contract",
    "procedure": "incident procedure",
}


def kind_of(text: str) -> str:
    lowered = text.lower()
    for word, kind in SIGNALS.items():
        if word in lowered:
            return kind
    return "document"


def review(path: pathlib.Path) -> str:
    text = path.read_text(encoding="utf-8")
    numbers = [line for line in text.splitlines() if any(c.isdigit() for c in line)][:3]
    return (
        f"Document: {path.name}\n"
        f"Type: {kind_of(text)}\n"
        f"Length: {len(text.split())} words\n"
        "Key figures to check:\n" + "\n".join(f"- {line.strip()}" for line in numbers) + "\n"
    )


def main() -> None:
    folder = pathlib.Path("documents")
    notes = pathlib.Path("review-notes")
    notes.mkdir(exist_ok=True)
    for path in sorted(folder.glob("*.txt")):
        if seal_document is not None:
            with trace.get_tracer("pharmacy-assistant").start_as_current_span("review_document") as span:
                span.set_attribute("gen_ai.operation.name", "execute_tool")
                span.set_attribute("tool.name", "review_document")
                seal_document(path, role="input", label="clinical document")
                note = review(path)
        else:
            note = review(path)
        (notes / f"{path.stem}.md").write_text(note, encoding="utf-8")
        print(f"Reviewed {path.name}")
    print("Done")


main()
