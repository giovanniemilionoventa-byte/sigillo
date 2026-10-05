# Model gateway demo agent

`agente_demo.py` is a tiny agent that calls OpenAI only through sigillo's
model gateway (`docs/API.md`, `/llm/...`). It holds the sigillo key of its
system and nothing else; the OpenAI key is saved in the console, on the
system's Manage page ("AI model"). It makes two model calls (pick a candidate,
write the invitation), so the system's chain gains two `llm_call` receipts.

Standard library only, Python 3.8 or newer:

    python agente_demo.py

It asks for the sigillo key when `SIGILLO_KEY` is empty in the file and not set
in the environment. `SIGILLO_URL` (default `https://get-sigillo.eu`) can be set
in the environment too. The gateway is open to the operator's own systems only
until `SIGILLO_LLM_GATEWAY=all`.
