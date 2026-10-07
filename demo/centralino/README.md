# Model gateway demo: an existing Gemini agent, connected to sigillo

`agente_gemini.py` stands for an agent a customer already runs: it calls
Google Gemini directly with its own Gemini key, and knows nothing of sigillo.
Standard library only, Python 3.8 or newer.

Connecting it is what a customer would do:

1. In the console, create a system and keep its sigillo key.
2. On the system's Manage page, block "AI model", save the Gemini key.
   (That block was removed from the console on 2026-10-07; a key saved before
   then keeps working.)
3. In the agent, change two settings and nothing else:

       GEMINI_URL = "https://get-sigillo.eu/llm/gemini"
       GEMINI_KEY = "<the sigillo key of the system>"

From then on the agent no longer holds the Gemini key, and each of its two
model calls is an `llm_call` receipt on the system's chain. The gateway is open
to the operator's own systems only until `SIGILLO_LLM_GATEWAY=all`.
