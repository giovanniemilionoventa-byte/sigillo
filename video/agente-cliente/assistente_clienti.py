"""Assistente clienti: risponde alle domande dei clienti della giornata."""
import json
import pathlib

RISPOSTE = {
    "rimborso": "I rimborsi vengono eseguiti entro 5 giorni lavorativi.",
    "consegna": "La consegna standard richiede da 2 a 4 giorni lavorativi.",
    "fattura": "La fattura è allegata all'email di conferma dell'ordine.",
}


def rispondi(domanda: str) -> str:
    for parola, risposta in RISPOSTE.items():
        if parola in domanda.lower():
            return risposta
    return "Ho passato la tua domanda a un collega."


domande = json.loads(pathlib.Path("domande.json").read_text())
uscita = pathlib.Path("risposte")
uscita.mkdir(exist_ok=True)
for voce in domande:
    risposta = rispondi(voce["testo"])
    (uscita / f"{voce['id']}.txt").write_text(risposta)
    print(f"{voce['id']}: {risposta}")
print("Fatto")
