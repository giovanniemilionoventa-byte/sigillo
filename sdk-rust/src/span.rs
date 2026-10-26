//! One recorded action, and its OTLP/JSON form.
//!
//! The server's `/v1/traces` reads OTLP/JSON as well as protobuf
//! (docs/API.md), so this crate writes the JSON itself instead of carrying an
//! OpenTelemetry library: a span is a handful of attributes. Only what the
//! server reads is ever put on one (the list `KEPT_ATTRIBUTES` of the Python
//! SDK): the content of an input or an output never is, only its digest.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::digest::{canonical_string, hex, random_bytes};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Unset,
    Ok,
    Error,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub name: String,
    pub time_unix_nano: u128,
    pub attributes: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct Span {
    pub trace_id: String,
    pub span_id: String,
    pub name: String,
    pub start_unix_nano: u128,
    pub end_unix_nano: u128,
    pub status: Status,
    pub attributes: Vec<(String, String)>,
    pub events: Vec<Event>,
}

pub(crate) fn now_unix_nano() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_nanos()).unwrap_or(0)
}

impl Span {
    pub(crate) fn new(name: String) -> Span {
        Span {
            trace_id: hex(&random_bytes::<16>()),
            span_id: hex(&random_bytes::<8>()),
            name,
            start_unix_nano: now_unix_nano(),
            end_unix_nano: 0,
            status: Status::Unset,
            attributes: Vec::new(),
            events: Vec::new(),
        }
    }

    /// Sets an attribute, replacing one of the same name.
    pub(crate) fn set(&mut self, key: &str, value: impl Into<String>) {
        let value = value.into();
        match self.attributes.iter_mut().find(|(name, _)| name == key) {
            Some(slot) => slot.1 = value,
            None => self.attributes.push((key.to_string(), value)),
        }
    }

    /// The span as `show_sent` prints it: everything that could carry a
    /// value, its name, attributes, status and events; not its timing or
    /// identifiers, which are only numbers.
    pub(crate) fn shown(&self) -> String {
        let mut out = format!("{{\"name\":{},\"attributes\":{}", canonical_string(&self.name), object(&self.attributes));
        match self.status {
            Status::Ok => out.push_str(",\"status\":\"OK\""),
            Status::Error => out.push_str(",\"status\":\"ERROR\""),
            Status::Unset => {}
        }
        if !self.events.is_empty() {
            let events: Vec<String> = self
                .events
                .iter()
                .map(|event| format!("{{\"name\":{},\"attributes\":{}}}", canonical_string(&event.name), object(&event.attributes)))
                .collect();
            out.push_str(&format!(",\"events\":[{}]", events.join(",")));
        }
        out.push('}');
        out
    }

    fn otlp(&self) -> String {
        let status = match self.status {
            Status::Unset => "STATUS_CODE_UNSET",
            Status::Ok => "STATUS_CODE_OK",
            Status::Error => "STATUS_CODE_ERROR",
        };
        let events: Vec<String> = self
            .events
            .iter()
            .map(|event| {
                format!(
                    "{{\"timeUnixNano\":\"{}\",\"name\":{},\"attributes\":{}}}",
                    event.time_unix_nano,
                    canonical_string(&event.name),
                    key_values(&event.attributes)
                )
            })
            .collect();
        format!(
            "{{\"traceId\":\"{}\",\"spanId\":\"{}\",\"name\":{},\"kind\":1,\"startTimeUnixNano\":\"{}\",\"endTimeUnixNano\":\"{}\",\"attributes\":{},\"events\":[{}],\"status\":{{\"code\":\"{}\"}}}}",
            self.trace_id,
            self.span_id,
            canonical_string(&self.name),
            self.start_unix_nano,
            self.end_unix_nano,
            key_values(&self.attributes),
            events.join(","),
            status
        )
    }
}

/// An `ExportTraceServiceRequest` in OTLP/JSON, for one resource.
pub(crate) fn export_request(resource: &[(String, String)], spans: &[Span]) -> String {
    let spans: Vec<String> = spans.iter().map(Span::otlp).collect();
    format!(
        "{{\"resourceSpans\":[{{\"resource\":{{\"attributes\":{}}},\"scopeSpans\":[{{\"scope\":{{\"name\":\"sigillo\",\"version\":\"{}\"}},\"spans\":[{}]}}]}}]}}",
        key_values(resource),
        crate::VERSION,
        spans.join(",")
    )
}

fn key_values(attributes: &[(String, String)]) -> String {
    let items: Vec<String> = attributes
        .iter()
        .map(|(key, value)| format!("{{\"key\":{},\"value\":{{\"stringValue\":{}}}}}", canonical_string(key), canonical_string(value)))
        .collect();
    format!("[{}]", items.join(","))
}

fn object(attributes: &[(String, String)]) -> String {
    let items: Vec<String> =
        attributes.iter().map(|(key, value)| format!("{}:{}", canonical_string(key), canonical_string(value))).collect();
    format!("{{{}}}", items.join(","))
}
