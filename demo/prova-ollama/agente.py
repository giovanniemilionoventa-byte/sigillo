"""Customer-support triage agent, as a software house might write it.

It reads a support ticket and asks a local Ollama model for a category and a
one-line summary. It knows nothing about sigillo: no import, no key, no
special setup.

    pip install openai
    ollama pull llama3.2:3b
    python agente.py
"""

from openai import OpenAI

client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")

TICKETS = [
    "Buongiorno, la fattura di settembre riporta un importo diverso dal preventivo. Potete verificare?",
    "Non riesco ad accedere al portale da ieri, la password non viene accettata.",
    "Vorrei sapere se è possibile avere uno sconto per un ordine di 50 licenze.",
]


def triage(ticket: str) -> str:
    reply = client.chat.completions.create(
        model="llama3.2:3b",
        messages=[
            {"role": "system", "content": "Sei un assistente del supporto clienti. Rispondi con la categoria (fatturazione, accesso, commerciale) e un riassunto di una riga."},
            {"role": "user", "content": ticket},
        ],
    )
    return reply.choices[0].message.content


if __name__ == "__main__":
    for ticket in TICKETS:
        print("-", ticket)
        print("  ->", triage(ticket))
