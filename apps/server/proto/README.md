# Vendored OpenTelemetry protocol definitions

These `.proto` files are copied verbatim from the OpenTelemetry protocol
repository so that sigillo can decode OTLP/HTTP protobuf bodies without taking a
dependency on a generated-code package.

- Source: <https://github.com/open-telemetry/opentelemetry-proto>
- Version: tag **v1.7.0**
- Licence: Apache License 2.0, as stated in the header of each file
- Copied on: 2026-09-21

SHA-256 of each file as copied (first 16 hex characters):

| file | digest |
|---|---|
| `opentelemetry/proto/collector/trace/v1/trace_service.proto` | `03c8cc4e3e101087` |
| `opentelemetry/proto/common/v1/common.proto` | `f9eba928880a8496` |
| `opentelemetry/proto/resource/v1/resource.proto` | `be315021ab29992f` |
| `opentelemetry/proto/trace/v1/trace.proto` | `94b0201460115874` |

Only the four files needed to decode `ExportTraceServiceRequest` are vendored.
The directory layout matches the `import` paths inside the files, because
protobufjs resolves imports relative to this directory.

To update: fetch the same four paths at the new tag, replace the files, update
the version, date and digests above, and run the test suite. The fixtures in
`apps/server/test/fixtures/` are real OTLP payloads and will catch a decoding
change.

## Files not vendored

`trace_service.proto` declares a gRPC service. sigillo serves OTLP over HTTP
only, so the service definition is unused; it is kept because the file is copied
verbatim rather than edited.
