# Prova con Ollama (Llama 3.2 da 3 miliardi), su Windows

`agente.py` è un agente di assistenza clienti come lo scriverebbe una software house: usa la libreria `openai` verso Ollama, senza nulla di Sigillo. La prova serve a vedere che Sigillo lo protegge con il solo caricamento del file.

Prima di cominciare: la PR 92 deve essere unita e il server aggiornato, e la protezione deve essere accesa per il tuo account (`SIGILLO_AGENT_PROTECTION`).

## Preparazione (una volta)
1. Installa Python da python.org (spunta "Add Python to PATH") e Ollama da ollama.com.
2. In PowerShell: `ollama pull llama3.2:3b` e poi `pip install openai`.
3. **Chiudi Ollama** (icona vicino all'orologio, tasto destro, Quit). Deve essere spento prima di cominciare.

## La prova
1. Nella console crea un sistema, apri la pagina per caricare l'agente, **spunta "Più sicurezza"** e carica `agente.py`. Scarica il file riscritto.
2. In PowerShell, nella cartella del file scaricato: `python agente.py`. Il file installa da solo il resto (la prima volta qualche minuto) e fa partire la porta e Ollama dietro di essa. Deve stampare tre risposte del modello.
3. Nella console, nella cronologia del sistema, devi vedere una ricevuta per ognuna delle tre chiamate al modello.

## Se qualcuno chiama Ollama direttamente
Con l'agente **ancora in esecuzione** (aggiungi `input()` in fondo al file se finisce subito), in un altro PowerShell:
- `curl.exe -i http://127.0.0.1:11434/v1/models` deve rispondere **401** (serve la chiave di Sigillo).
- `curl.exe -i -H "Authorization: Bearer LA_TUA_CHIAVE" http://127.0.0.1:11434/v1/models` risponde 200 e lascia una ricevuta.
- Avvia `ollama serve` a mano mentre l'agente gira: la guardia scrive una ricevuta d'errore (`sigillo.local_model.open`) e ferma l'agente.

Limite noto: Ollama resta raggiungibile anche sulla sua porta privata, la 11435, da chi sa cercarla. Una chiamata lì non passa dalla porta: non lascia ricevuta.
