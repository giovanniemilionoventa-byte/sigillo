"""A small recruiting agent built on Google Gemini, with no sigillo in it.

It stands for an agent a customer already has: it calls Gemini directly with
its own Gemini key. Connecting it to sigillo's model gateway takes two lines
of the settings below, and no other change (see README.md):

    GEMINI_URL = "https://get-sigillo.eu/llm/gemini"
    GEMINI_KEY = "<the sigillo key of the system>"

Python 3.8 or newer, nothing to install: only the standard library.
Run:  python agente_gemini.py   (on Windows also: py agente_gemini.py)
"""

import json
import ssl
import sys
import urllib.error
import urllib.request

# --- Settings -------------------------------------------------------------
GEMINI_URL = "https://generativelanguage.googleapis.com"
GEMINI_KEY = ""
MODEL = "gemini-3.8-flash"
# ---------------------------------------------------------------------------

CANDIDATES = """\
A) Marco, 34 anni: 6 anni come magazziniere, patentino per il muletto, turni notturni.
B) Sara, 27 anni: 2 anni in logistica, gestionale SAP, coordinamento di 4 persone.
C) Luca, 41 anni: 10 anni come autista, nessuna esperienza di magazzino."""


def ask(question: str) -> str:
    """One question to the model."""
    request = urllib.request.Request(
        f"{GEMINI_URL.rstrip('/')}/v1beta/models/{MODEL}:generateContent",
        data=json.dumps({"contents": [{"role": "user", "parts": [{"text": question}]}]}).encode("utf-8"),
        method="POST",
        headers={"x-goog-api-key": GEMINI_KEY.strip(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            answer = json.load(response)
    except urllib.error.HTTPError as error:
        print(f"Errore {error.code} da {GEMINI_URL}:")
        print(error.read().decode("utf-8", "replace")[:500])
        sys.exit(1)
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            print("Python non trova i certificati HTTPS.")
            print("Sul Mac: apri Applicazioni > Python 3.x e fai doppio clic su 'Install Certificates.command'.")
        else:
            print(f"Non riesco a raggiungere {GEMINI_URL}: {error.reason}")
        sys.exit(1)
    return answer["candidates"][0]["content"]["parts"][0]["text"].strip()


def main() -> None:
    if not GEMINI_KEY.strip():
        print("Manca la chiave: scrivila nel file, nella riga GEMINI_KEY = \"\", tra le virgolette.")
        sys.exit(1)

    print("1/2  Scelgo il candidato migliore...")
    choice = ask(
        "Selezioni un addetto di magazzino con esperienza. Candidati:\n"
        f"{CANDIDATES}\n"
        "Rispondi con la lettera del migliore e una riga di motivazione."
    )
    print(f"\n{choice}\n")

    print("2/2  Scrivo l'email di invito al colloquio...")
    email = ask(f"Scrivi un'email breve e cordiale per invitare a un colloquio il candidato scelto qui:\n{choice}")
    print(f"\n{email}\n")
    print("Fatto.")


if __name__ == "__main__":
    main()
