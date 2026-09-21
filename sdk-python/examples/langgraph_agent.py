"""A minimal LangGraph agent, recorded by sigillo.

The agent looks up an order and answers. It never calls a real model: the model
is a fake that replays a fixed script, and the tool is a dictionary. Everything
interesting here is the wiring, not the intelligence.

Run it against a running server:

    pip install -e sdk-python -r sdk-python/examples/requirements.txt
    export SIGILLO_ENDPOINT=http://127.0.0.1:8080
    export SIGILLO_API_KEY=sigillo_...
    python sdk-python/examples/langgraph_agent.py

Then export the chain and check it:

    sigillo-server export acme-support-bot --db ... --signer-socket ... --out ./fascicolo
    sigillo-verify ./fascicolo
"""

from __future__ import annotations

import os
import sys
from typing import Annotated, TypedDict

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AnyMessage, HumanMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

import sigillo

SYSTEM_ID = os.environ.get("SIGILLO_SYSTEM_ID", "acme-support-bot")

ORDERS = {
    "A-1099": {"status": "shipped", "carrier": "DHL"},
    "A-1100": {"status": "preparing", "carrier": None},
}


@tool
def search_orders(order_id: str) -> str:
    """Look up the status of a customer order."""
    order = ORDERS.get(order_id)
    if order is None:
        return f"no order {order_id}"
    return f"{order_id} is {order['status']}"


class State(TypedDict):
    messages: Annotated[list[AnyMessage], add_messages]


def build_agent() -> StateGraph:
    """Two nodes: the model decides, the tool answers, the model replies."""
    model = GenericFakeChatModel(
        messages=iter(
            [
                AIMessage(content="I will look that order up."),
                AIMessage(content="Your order A-1099 has shipped with DHL."),
            ]
        )
    )

    def decide(state: State) -> State:
        return {"messages": [model.invoke(state["messages"])]}

    def use_tool(state: State) -> State:
        result = search_orders.invoke({"order_id": "A-1099"})
        return {"messages": [ToolMessage(content=result, tool_call_id="call_1")]}

    graph = StateGraph(State)
    graph.add_node("decide", decide)
    graph.add_node("use_tool", use_tool)
    graph.add_node("answer", decide)
    graph.add_edge(START, "decide")
    graph.add_edge("decide", "use_tool")
    graph.add_edge("use_tool", "answer")
    graph.add_edge("answer", END)
    return graph.compile()


def main() -> int:
    endpoint = os.environ.get("SIGILLO_ENDPOINT")
    api_key = os.environ.get("SIGILLO_API_KEY")
    if not endpoint or not api_key:
        print("set SIGILLO_ENDPOINT and SIGILLO_API_KEY first", file=sys.stderr)
        return 2

    tracing = sigillo.init(
        endpoint=endpoint,
        api_key=api_key,
        system_id=SYSTEM_ID,
        instrument=["langchain"],
    )
    print(f"recording {SYSTEM_ID} to {tracing.endpoint}")
    print(f"instrumentations: {', '.join(tracing.instrumented) or 'none'}")

    agent = build_agent()
    final = agent.invoke({"messages": [HumanMessage(content="where is my order A-1099?")]})

    print(f"agent said: {final['messages'][-1].content}")

    # A short-lived process has to push what is still buffered before it exits.
    tracing.flush()
    tracing.shutdown()
    print("receipts sent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
