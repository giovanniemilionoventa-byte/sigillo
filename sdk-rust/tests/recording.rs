//! What the crate sends, read off the wire by a stand-in server: the digests
//! and never the content, the heartbeat's protocol, and strict mode.
//!
//! The stand-in only records requests and answers them; every digest in what
//! it receives is checked by recomputing it with the crate's own functions,
//! which `vectors.rs` holds to the shared vectors and to Python.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use sigillo::digest::{salted_digest, sha256_hex};
use sigillo::{nonce_for, ArtifactRole, Config, Role};

const KEY: &str = "sigillo_0123456789abcdef_0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Clone, Debug)]
struct Received {
    path: String,
    authorization: String,
    body: String,
}

/// Answers every request; `answer` decides the status and body for a path.
fn stand_in(answer: impl Fn(&str) -> (u16, String) + Send + Sync + 'static) -> (String, Arc<Mutex<Vec<Received>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let received = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&received);
    let answer = Arc::new(answer);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let (log, answer) = (Arc::clone(&log), Arc::clone(&answer));
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut writer = stream;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                    let (mut length, mut authorization) = (0usize, String::new());
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).unwrap();
                        let header = header.trim_end().to_string();
                        if header.is_empty() {
                            break;
                        }
                        let (name, value) = header.split_once(':').unwrap();
                        match name.to_ascii_lowercase().as_str() {
                            "content-length" => length = value.trim().parse().unwrap(),
                            "authorization" => authorization = value.trim().to_string(),
                            _ => {}
                        }
                    }
                    let mut body = vec![0u8; length];
                    reader.read_exact(&mut body).unwrap();
                    log.lock().unwrap().push(Received { path: path.clone(), authorization, body: String::from_utf8(body).unwrap() });
                    let (status, text) = answer(&path);
                    let reply = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{text}", text.len());
                    if writer.write_all(reply.as_bytes()).is_err() {
                        return;
                    }
                }
            });
        }
    });
    (address, received)
}

fn ok(path: &str) -> (u16, String) {
    if path == "/v1/traces" {
        (200, r#"{"partialSuccess":{}}"#.into())
    } else {
        (200, r#"{"ok":true}"#.into())
    }
}

fn wait_for(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

fn spans(received: &[Received]) -> Vec<Value> {
    received
        .iter()
        .filter(|request| request.path == "/v1/traces")
        .flat_map(|request| {
            let body: Value = serde_json::from_str(&request.body).unwrap();
            body["resourceSpans"][0]["scopeSpans"][0]["spans"].as_array().unwrap().clone()
        })
        .collect()
}

fn attribute(span: &Value, name: &str) -> Option<String> {
    span["attributes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["key"] == name)
        .map(|item| item["value"]["stringValue"].as_str().unwrap().to_string())
}

#[test]
fn a_tool_call_leaves_as_digests_only() {
    let (address, received) = stand_in(ok);
    let sigillo = sigillo::init(Config::new(&address, KEY, "acme-support-bot").without_heartbeat()).unwrap();
    let secret_input = "il CV di Mario Rossi, nato il 3 marzo";
    let secret_output = "punteggio: 7";
    let call = sigillo.tool("valuta_candidato");
    call.agent("agente-cv").input(secret_input).output(secret_output);
    call.artifact("Ciao,\r\nmondo.\r\n".as_bytes(), ArtifactRole::Input, Some("curriculum"), "text/plain");
    call.ok();
    assert!(sigillo.flush());

    let received = received.lock().unwrap().clone();
    assert!(received.iter().all(|request| request.authorization == format!("Bearer {KEY}")));
    let everything: String = received.iter().map(|request| request.body.as_str()).collect();
    assert!(!everything.contains("Mario"), "the input's content left the process");
    assert!(!everything.contains("punteggio"), "the output's content left the process");
    assert!(!everything.contains("mondo"), "the document's content left the process");

    let spans = spans(&received);
    assert_eq!(spans.len(), 1);
    let span = &spans[0];
    assert_eq!(span["status"]["code"], "STATUS_CODE_OK");
    assert_eq!(attribute(span, "gen_ai.operation.name").as_deref(), Some("execute_tool"));
    assert_eq!(attribute(span, "gen_ai.tool.name").as_deref(), Some("valuta_candidato"));
    assert_eq!(attribute(span, "gen_ai.agent.name").as_deref(), Some("agente-cv"));
    for (role, value) in [("input", secret_input), ("output", secret_output)] {
        let nonce: [u8; 32] = (0..32)
            .map(|at| u8::from_str_radix(&attribute(span, &format!("sigillo.{role}.nonce")).unwrap()[at * 2..at * 2 + 2], 16).unwrap())
            .collect::<Vec<u8>>()
            .try_into()
            .unwrap();
        assert_eq!(attribute(span, &format!("sigillo.{role}.sha256")).unwrap(), salted_digest(value, &nonce));
    }
    let event = &span["events"][0];
    assert_eq!(event["name"], "sigillo.artifact");
    assert_eq!(attribute(event, "sigillo.artifact.sha256").unwrap(), sha256_hex(b"Ciao,\r\nmondo.\r\n"));
    assert_eq!(attribute(event, "sigillo.artifact.text_sha256").unwrap(), "54a58d6fbf86b8113c5183a32142c3069884460d0ec47b4ee7e435dfd5b23319");
    assert_eq!(attribute(event, "sigillo.artifact.label").as_deref(), Some("curriculum"));
    sigillo.shutdown();
}

#[test]
fn with_the_customer_key_no_nonce_leaves_the_process() {
    let (address, received) = stand_in(ok);
    let customer_key = "c0ffee".repeat(10);
    let sigillo = sigillo::init(Config::new(&address, KEY, "acme").without_heartbeat().customer_key(&customer_key)).unwrap();
    let call = sigillo.tool("t");
    call.input("ammessa");
    let (trace, span_id) = call.ids();
    call.ok();
    assert!(sigillo.flush());
    let received = received.lock().unwrap().clone();
    let span = &spans(&received)[0];
    assert_eq!(attribute(span, "sigillo.input.nonce").as_deref(), Some("customer"));
    let nonce = nonce_for(customer_key.as_bytes(), &trace, &span_id, Role::Input).unwrap();
    let everything: String = received.iter().map(|request| request.body.as_str()).collect();
    assert!(!everything.contains(&nonce), "the nonce left the process");
    assert!(!everything.contains(&customer_key), "the key left the process");
    let nonce: [u8; 32] = (0..32).map(|at| u8::from_str_radix(&nonce[at * 2..at * 2 + 2], 16).unwrap()).collect::<Vec<u8>>().try_into().unwrap();
    assert_eq!(attribute(span, "sigillo.input.sha256").unwrap(), salted_digest("ammessa", &nonce));
}

#[test]
fn a_failure_names_the_error_type_and_never_its_message() {
    let (address, received) = stand_in(ok);
    let sigillo = sigillo::init(Config::new(&address, KEY, "acme").without_heartbeat()).unwrap();
    let result: Result<(), std::io::Error> =
        sigillo.tool("scrivi_file").run(|| Err(std::io::Error::new(std::io::ErrorKind::Other, "/home/mario.rossi/cv.pdf")));
    assert!(result.is_err());
    assert!(sigillo.flush());
    let received = received.lock().unwrap().clone();
    let span = &spans(&received)[0];
    assert_eq!(span["status"]["code"], "STATUS_CODE_ERROR");
    assert_eq!(attribute(span, "error.type").as_deref(), Some("std::Error"));
    assert!(!received.iter().any(|request| request.body.contains("mario")));
}

#[test]
fn the_heartbeat_says_start_beat_and_stop_with_the_programs_hash() {
    let (address, received) = stand_in(ok);
    let sigillo = sigillo::init(Config::new(&address, KEY, "acme").heartbeat(Duration::from_millis(100))).unwrap();
    let session = sigillo.session().unwrap().to_string();
    assert_eq!(session.len(), 32);
    wait_for("two beats", || received.lock().unwrap().iter().filter(|request| request.body.contains("\"beat\"")).count() >= 2);
    sigillo.shutdown();
    let program = sha256_hex(&std::fs::read(std::env::current_exe().unwrap()).unwrap());
    let beats: Vec<Value> = received
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.path == "/api/v1/heartbeat")
        .map(|request| serde_json::from_str(&request.body).unwrap())
        .collect();
    assert_eq!(beats.first().unwrap()["event"], "start");
    assert_eq!(beats.last().unwrap()["event"], "stop");
    for beat in &beats {
        assert_eq!(beat["session"], session.as_str());
        if beat["event"] != "stop" {
            assert_eq!(beat["script_hash"], program.as_str());
        }
    }
}

#[test]
fn strict_mode_halts_when_the_server_says_the_program_changed() {
    let (address, _received) =
        stand_in(|path| if path == "/api/v1/heartbeat" { (200, r#"{"ok":true,"script_changed": true}"#.into()) } else { ok(path) });
    let reasons = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&reasons);
    let sigillo = sigillo::init(
        Config::new(&address, KEY, "acme")
            .heartbeat(Duration::from_millis(100))
            .strict(true)
            .on_halt(move |reason| seen.lock().unwrap().push(reason.to_string())),
    )
    .unwrap();
    wait_for("the halt", || !reasons.lock().unwrap().is_empty());
    thread::sleep(Duration::from_millis(300));
    assert_eq!(reasons.lock().unwrap().as_slice(), ["this agent's program is not the one it started with"], "halted once");
    sigillo.shutdown();
}

#[test]
fn strict_mode_halts_after_three_beats_that_do_not_get_through() {
    let (address, _received) = stand_in(|path| if path == "/api/v1/heartbeat" { (503, "{}".into()) } else { ok(path) });
    let reasons = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&reasons);
    let sigillo = sigillo::init(
        Config::new(&address, KEY, "acme")
            .heartbeat(Duration::from_millis(50))
            .strict(true)
            .on_halt(move |reason| seen.lock().unwrap().push(reason.to_string())),
    )
    .unwrap();
    wait_for("the halt", || !reasons.lock().unwrap().is_empty());
    assert_eq!(reasons.lock().unwrap()[0], "sigillo could not record for 3 heartbeats in a row");
    sigillo.shutdown();
}

#[test]
fn without_strict_mode_nothing_halts() {
    let (address, received) = stand_in(|path| if path == "/api/v1/heartbeat" { (200, r#"{"script_changed":true}"#.into()) } else { ok(path) });
    let sigillo = sigillo::init(Config::new(&address, KEY, "acme").heartbeat(Duration::from_millis(50))).unwrap();
    wait_for("three beats", || received.lock().unwrap().len() >= 3);
    sigillo.shutdown();
}

#[test]
fn the_gateway_variables_are_set_before_the_agent_runs() {
    let (address, _received) = stand_in(ok);
    let gateway = format!("{address}/llm/openai/v1");
    let sigillo = sigillo::init(
        Config::new(&address, KEY, "acme")
            .without_heartbeat()
            .env("SIGILLO_TEST_OPENAI_BASE_URL", &gateway)
            .env("SIGILLO_TEST_OPENAI_API_KEY", KEY),
    )
    .unwrap();
    assert_eq!(std::env::var("SIGILLO_TEST_OPENAI_BASE_URL").unwrap(), gateway);
    assert_eq!(std::env::var("SIGILLO_TEST_OPENAI_API_KEY").unwrap(), KEY);
    sigillo.shutdown();
}

#[test]
fn settings_that_cannot_work_are_refused() {
    assert!(sigillo::init(Config::new("", KEY, "acme")).is_err());
    assert!(sigillo::init(Config::new("ftp://x", KEY, "acme")).is_err());
    assert!(sigillo::init(Config::new("http://127.0.0.1:9", "", "acme")).is_err());
    assert!(sigillo::init(Config::new("http://127.0.0.1:9", KEY, "")).is_err());
    assert!(sigillo::init(Config::new("http://127.0.0.1:9", KEY, "acme").customer_key("<la tua chiave>")).is_err());
    assert!(sigillo::init(Config::new("http://127.0.0.1:9", KEY, "acme").customer_key("k").salt_content(false)).is_err());
}

#[test]
fn a_full_traces_url_is_taken_as_well_as_the_base() {
    let (address, received) = stand_in(ok);
    let sigillo = sigillo::init(Config::new(&format!("{address}/v1/traces/"), KEY, "acme").without_heartbeat()).unwrap();
    sigillo.tool("t").ok();
    assert!(sigillo.flush());
    assert_eq!(received.lock().unwrap()[0].path, "/v1/traces");
}
