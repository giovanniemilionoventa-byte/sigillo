# What sigillo records, and what it does not

For customers, auditors and security reviewers. The technical source is
[SECURITY.md](SECURITY.md) ("What sigillo cannot detect", "Known limits");
this page is the short version.

**In one sentence:** sigillo guarantees that what it *received* was not changed
afterwards. It cannot guarantee that it *was sent* everything.

## The four ways in

| Source | What becomes a receipt |
|---|---|
| OpenTelemetry / OpenInference (LangChain, CrewAI, OpenAI instrumentation) | every span recognised as an AI action |
| Python SDK | the agent's actions, plus a heartbeat every minute that shows sigillo's code is running |
| Model gateway (`/llm/...`) | every call to a cloud model, and the tools the model *asked* to use |
| Native API (`POST /api/v1/receipts`) | whatever your code chooses to send, in any language |

## Event coverage

What an audit trail of an AI agent should hold, and where sigillo stands today.

| Event | Recorded? | How, and the limit |
|---|---|---|
| Tool calls | Yes | `tool_call` receipts from the SDK, OpenTelemetry or the native API. Only if the call goes through one of them |
| Tool call inputs and outputs | As fingerprints | SHA-256 only. The text itself is never stored (it stays with you) |
| Model calls | Yes | `llm_call` receipts, with model name and provider; through the gateway for every cloud model call |
| Tools the model asked for | Yes, at the gateway | `model_requested.<tool>`. A request is **not** proof that the tool ran |
| Blocked actions | If your code reports them | outcome `blocked`. sigillo cannot see a block it was not told about |
| Permissions and policy decisions | If your code reports them | recorded as `decision` receipts. sigillo does not read your permission system |
| Human approvals | Convention, see [API.md](API.md#human-approvals) | `approval.requested` / `granted` / `denied`; SDK helper and console view are planned |
| Model version | Name and provider; digest where the runtime exposes one | an exact version is only as precise as what the source sends |
| Prompt version | Only as a fingerprint of the input | there is no separate prompt-version field |
| Source documents | Yes, as fingerprints | `sigillo.artifact()`: SHA-256 of the file, optionally of its normalised text, to answer "was this document used?" |
| Time | Server clock, plus an RFC 3161 timestamp on each checkpoint | the agent's own `ts_event` is a claim, never verified |
| Silence of the agent | SDK only | more than 3 minutes without heartbeat becomes a signed `connection.lost` receipt |

## What sigillo cannot see

1. **An agent that falls silent.** Outside the SDK there is no heartbeat; the
   console turns yellow after a day without activity.
2. **Model calls outside the gateway:** a provider key copied into the agent, a
   local model, another provider.
3. **A requested tool is not an executed tool.** The gateway sees the model ask
   to send an email, not that your code sent it.
4. **Sigillo unreachable from the agent.** With the SDK defaults, actions
   emitted during an outage longer than about 10 seconds are lost: there is no
   local queue yet.
5. **A source that leaves things out.** sigillo attests what it received, not
   what happened.
6. **Well-formed false data** sent with a valid key is recorded and signed like
   true data.
7. **A stolen API key** writes as the agent until it is revoked.
8. **The agent's own timestamp** (`ts_event`) is not verified.
9. **Duplicates** when your code retries the native API.
10. **Qualified time.** The default timestamp authority is not an eIDAS
    qualified one (see [TRUST.md](TRUST.md)).

## How to close the gaps

- Use the gateway **and** keep the provider key out of the agent.
- Use the Python SDK, to get the heartbeat.
- Compare, from time to time, the number of actions you expect with the number
  on the chain.
- Keep an export and verify the next with `sigillo-verify --previous`, which
  catches a chain cut short.
