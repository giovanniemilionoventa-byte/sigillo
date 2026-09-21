# PROGRESS.md — stato del progetto sigillo

Legenda stato: `todo` · `in corso` · `fatto`

## Milestone

| # | Nome | Stato | Note |
|---|------|-------|------|
| M1 | Formato e impronta | todo | Tipi/zod ricevuta, canonicalizzazione, hash, vettori di test |
| M2 | Catena e storage | todo | SQLite append-only, transazioni IMMEDIATE, trigger |
| M3 | Firmatario | todo | Processo signer su socket Unix, keygen, protocollo |
| M4 | Verificatore v1 | todo | Export minimale + CLI verifica, test di manomissione |
| M5 | Ingest OTLP e API nativa | todo | `/v1/traces` protobuf+JSON, adattatore due dialetti, API key |
| M6 | SDK Python | todo | Pacchetto `sigillo`, esempio LangGraph, test e2e |
| M7 | Merkle e marca temporale | todo | RFC 6962, checkpoint firmati, RFC 3161 con retry |
| M8 | Fascicolo completo e verificatore v2 | todo | Export zip completo, tutti i controlli del verificatore |
| M9 | UI, deploy, documentazione | todo | UI minima, docker-compose, backup, doc finali |

## Note di sessione

### Sessione 1 — 2026-09-21
- Repository clonato vuoto (nessun commit precedente), branch di lavoro `claude/sigillo-project-setup-zx80r8`.
- Creati `SPEC.md` (copia integrale sezioni 1–9 del prompt), `CLAUDE.md` (regole permanenti sezione 10 + struttura repo), `PROGRESS.md` (questo file).
- Ambiente disponibile: Node v22.22.2, pnpm 10.33.0, Python 3.11.15, OpenSSL 3.0.13.
- Prossimo passo: presentare il piano sintetico e attendere il via libera prima di iniziare M1.

## Checklist di verifica finale M9 (da eseguire fuori dalla sessione cloud)

Da completare quando si arriverà a M9 — placeholder, verrà sostituito con i comandi esatti.
