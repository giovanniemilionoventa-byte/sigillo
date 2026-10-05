"""A demo agent that calls its cloud model through sigillo's model gateway.

The agent holds no OpenAI key: it holds only the sigillo key of its system,
and sigillo calls OpenAI with the key saved in the console (the system's
Manage page, "AI model" block). Every call becomes a signed receipt on the
system's chain.

Python 3.8 or newer, nothing to install: only the standard library. A real
agent would use the OpenAI SDK in the same way:

    client = OpenAI(base_url=f"{SIGILLO_URL}/llm/openai/v1", api_key=SIGILLO_KEY)

Run:  python agente_demo.py   (on Windows also: py agente_demo.py)
"""

import json
import os
import ssl
import sys
import urllib.error
import urllib.request

# --- Settings -------------------------------------------------------------
# The sigillo key of the system (console: the system's page). Left empty, the
# program asks for it when it starts, or reads SIGILLO_KEY from the environment.
SIGILLO_KEY = ""
SIGILLO_URL = os.environ.get("SIGILLO_URL", "https://get-sigillo.eu")
MODEL = "gpt-4o-mini"
# ---------------------------------------------------------------------------

CANDIDATES = """\
A) Marco, 34 anni: 6 anni come magazziniere, patentino per il muletto, turni notturni.
B) Sara, 27 anni: 2 anni in logistica, gestionale SAP, coordinamento di 4 persone.
C) Luca, 41 anni: 10 anni come autista, nessuna esperienza di magazzino."""


def ask(key: str, question: str) -> str:
    """One call to the model through sigillo: one receipt on the chain."""
    body = json.dumps(
        {"model": MODEL, "messages": [{"role": "user", "content": question}]}
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{SIGILLO_URL.rstrip('/')}/llm/openai/v1/chat/completions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "x-sigillo-agent": "agente-demo",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            answer = json.load(response)
    except urllib.error.HTTPError as error:
        explain(error.code, error.read().decode("utf-8", "replace"))
        sys.exit(1)
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            print("Python non trova i certificati HTTPS.")
            print("Sul Mac: apri la cartella Applicazioni > Python 3.x e fai doppio clic su")
            print("'Install Certificates.command', poi riprova.")
        else:
            print(f"Non riesco a raggiungere {SIGILLO_URL}: {error.reason}")
        sys.exit(1)
    return answer["choices"][0]["message"]["content"].strip()


def explain(status: int, detail: str) -> None:
    reasons = {
        401: "La chiave Sigillo non è giusta. Copiala di nuovo dalla pagina del sistema.",
        403: "Il collegamento al modello non è ancora attivo per questo account.",
        409: "Nella console manca la chiave OpenAI: sistema > Gestisci > Modello AI.",
        429: "Troppe richieste, o limite mensile raggiunto. Riprova più tardi.",
        503: "Sigillo non può firmare la ricevuta in questo momento: la risposta non è stata data.",
    }
    if status in (401, 429) and not any(word in detail.lower() for word in ("sigillo", "receipts")):
        # The provider's own refusal, passed on by sigillo: the OpenAI key or its account.
        reasons[status] = "OpenAI ha rifiutato: la chiave OpenAI non è valida o l'account non ha credito."
    print(f"Errore {status}: {reasons.get(status, 'risposta inattesa.')}")
    print(f"Dettaglio: {detail[:300]}")


def main() -> None:
    key = SIGILLO_KEY.strip() or os.environ.get("SIGILLO_KEY", "").strip()
    if not key:
        key = input("Incolla la chiave Sigillo del sistema e premi Invio: ").strip()
    if not key:
        print("Nessuna chiave: mi fermo.")
        sys.exit(1)

    print("1/2  Chiedo al modello chi è il candidato migliore...")
    choice = ask(
        key,
        "Selezioni un addetto di magazzino con esperienza. Candidati:\n"
        f"{CANDIDATES}\n"
        "Rispondi con la lettera del migliore e una riga di motivazione.",
    )
    print(f"\n{choice}\n")

    print("2/2  Chiedo al modello di scrivere l'email al candidato scelto...")
    email = ask(
        key,
        f"Scrivi un'email breve e cordiale per invitare a un colloquio il candidato scelto qui:\n{choice}",
    )
    print(f"\n{email}\n")

    print("Fatto. Apri la console di Sigillo: il sistema ha 2 ricevute nuove, una per ogni chiamata al modello.")


if __name__ == "__main__":
    main()
