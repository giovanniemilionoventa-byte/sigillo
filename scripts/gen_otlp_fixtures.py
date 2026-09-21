#!/usr/bin/env python3
"""Records real OTLP payloads for the ingest tests.

The payloads are produced by the official OpenTelemetry Python SDK and its
OTLP/HTTP exporter, captured off the wire by a throwaway HTTP server. Nothing
here is hand-written, so the fixtures are what a real agent would actually send.

Two dialects are recorded:
  * OpenTelemetry GenAI semantic conventions (gen_ai.*)
  * OpenInference (openinference.span.kind, tool.name, input.value, ...)

Three encodings per dialect:
  * .protobuf.bin  what the Python exporter sends, byte for byte
  * .hexids.json   OTLP/JSON as the specification defines it, ids as hex strings
  * .base64ids.json  OTLP/JSON as the proto3 JSON mapping produces it, ids as base64

Both JSON spellings exist in the wild, so the server has to accept both.

Requires: pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
Usage:    python3 scripts/gen_otlp_fixtures.py
"""
import base64
import binascii
import http.server
import json
import pathlib
import threading

from google.protobuf.json_format import MessageToDict
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.trace.id_generator import IdGenerator
from opentelemetry.trace import Status, StatusCode

FIXTURES = pathlib.Path(__file__).resolve().parent.parent / "apps" / "server" / "test" / "fixtures"

captured: list[bytes] = []


class Capture(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 - name fixed by the base class
        length = int(self.headers.get("Content-Length", "0"))
        captured.append(self.rfile.read(length))
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.end_headers()
        self.wfile.write(b"")

    def log_message(self, *_args):
        pass


class FixedIds(IdGenerator):
    """Predictable identifiers, so the tests can name the spans they expect."""

    def __init__(self):
        self.span_counter = 0
        self.trace_counter = 0

    def generate_span_id(self) -> int:
        self.span_counter += 1
        return 0x00F067AA0BA90000 + self.span_counter

    def generate_trace_id(self) -> int:
        self.trace_counter += 1
        return 0x4BF92F3577B34DA6A3CE929D0E0E0000 + self.trace_counter


def record(emit, service_name: str) -> bytes:
    captured.clear()
    server = http.server.HTTPServer(("127.0.0.1", 0), Capture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]

    provider = TracerProvider(
        resource=Resource.create({"service.name": service_name, "service.version": "1.4.2"}),
        id_generator=FixedIds(),
    )
    provider.add_span_processor(
        BatchSpanProcessor(
            OTLPSpanExporter(endpoint=f"http://127.0.0.1:{port}/v1/traces"),
            max_export_batch_size=64,
            schedule_delay_millis=60_000,
        )
    )
    tracer = provider.get_tracer("sigillo.fixtures")

    emit(tracer)

    provider.shutdown()
    server.shutdown()
    thread.join(timeout=5)

    if len(captured) != 1:
        raise SystemExit(f"expected one batched export, captured {len(captured)}")
    return captured[0]


def genai_spans(tracer):
    with tracer.start_as_current_span("invoke_agent support-agent") as span:
        span.set_attribute("gen_ai.operation.name", "invoke_agent")
        span.set_attribute("gen_ai.agent.name", "support-agent")
        span.set_attribute("gen_ai.provider.name", "anthropic")
        span.set_attribute("user.id", "urn:user:42")

    with tracer.start_as_current_span("chat claude-sonnet-5") as span:
        span.set_attribute("gen_ai.operation.name", "chat")
        span.set_attribute("gen_ai.provider.name", "anthropic")
        span.set_attribute("gen_ai.request.model", "claude-sonnet-5")
        span.set_attribute("gen_ai.usage.input_tokens", 812)
        span.set_attribute("gen_ai.usage.output_tokens", 210)
        span.set_status(Status(StatusCode.OK))

    with tracer.start_as_current_span("execute_tool search_orders") as span:
        span.set_attribute("gen_ai.operation.name", "execute_tool")
        span.set_attribute("gen_ai.tool.name", "search_orders")
        span.set_attribute("gen_ai.tool.call.id", "call_9f2a")
        span.set_status(Status(StatusCode.ERROR, "upstream timeout"))

    # The older spelling: gen_ai.system instead of gen_ai.provider.name, and no
    # operation name at all. Real deployments still emit this.
    with tracer.start_as_current_span("openai.chat") as span:
        span.set_attribute("gen_ai.system", "openai")
        span.set_attribute("gen_ai.request.model", "gpt-4o")

    # An operation name this build has never heard of, which must be tolerated
    # and reported rather than dropped silently.
    with tracer.start_as_current_span("gen_ai.rerank") as span:
        span.set_attribute("gen_ai.operation.name", "rerank_documents")
        span.set_attribute("gen_ai.agent.name", "support-agent")

    # Not an AI action at all: must be ignored and counted.
    with tracer.start_as_current_span("GET /healthz") as span:
        span.set_attribute("http.request.method", "GET")
        span.set_attribute("http.route", "/healthz")


def openinference_spans(tracer):
    with tracer.start_as_current_span("AgentExecutor") as span:
        span.set_attribute("openinference.span.kind", "AGENT")

    with tracer.start_as_current_span("ChatAnthropic") as span:
        span.set_attribute("openinference.span.kind", "LLM")
        span.set_attribute("llm.model_name", "claude-sonnet-5")
        span.set_attribute("input.value", '{"messages":[{"role":"user","content":"where is my order"}]}')
        span.set_attribute("output.value", '{"content":"Let me check that for you."}')
        span.set_status(Status(StatusCode.OK))

    with tracer.start_as_current_span("search_orders") as span:
        span.set_attribute("openinference.span.kind", "TOOL")
        span.set_attribute("tool.name", "search_orders")
        span.set_attribute("input.value", '{"order_id":"A-1099"}')
        span.set_attribute("output.value", '{"status":"shipped"}')

    with tracer.start_as_current_span("RunnableSequence") as span:
        span.set_attribute("openinference.span.kind", "CHAIN")

    with tracer.start_as_current_span("VectorStoreRetriever") as span:
        span.set_attribute("openinference.span.kind", "RETRIEVER")

    with tracer.start_as_current_span("psycopg.query") as span:
        span.set_attribute("db.system", "postgresql")


def hex_ids(value):
    """Rewrites the id fields from proto3 base64 to the hex OTLP/JSON asks for."""
    if isinstance(value, dict):
        return {
            key: binascii.hexlify(base64.b64decode(item)).decode()
            if key in ("traceId", "spanId", "parentSpanId") and isinstance(item, str)
            else hex_ids(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [hex_ids(item) for item in value]
    return value


def write(name: str, emit, service_name: str) -> None:
    payload = record(emit, service_name)
    request = ExportTraceServiceRequest()
    request.ParseFromString(payload)

    (FIXTURES / f"{name}.protobuf.bin").write_bytes(payload)

    as_dict = MessageToDict(request, preserving_proto_field_name=False)
    (FIXTURES / f"{name}.base64ids.json").write_text(json.dumps(as_dict, indent=2) + "\n")
    (FIXTURES / f"{name}.hexids.json").write_text(json.dumps(hex_ids(as_dict), indent=2) + "\n")

    spans = sum(
        len(scope.spans) for resource in request.resource_spans for scope in resource.scope_spans
    )
    print(f"{name}: {spans} spans, {len(payload)} protobuf bytes")


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    write("otel-genai", genai_spans, "acme-support-bot")
    write("openinference", openinference_spans, "acme-support-bot")


if __name__ == "__main__":
    main()
