//! The door in front of a local model, between a stand-in model and a
//! stand-in sigillo server: only a request with the key gets through, the
//! answer comes back untouched, and the call leaves as a digest.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

const KEY: &str = "sigillo_0123456789abcdef_1111111111111111111111111111111111111111111111111111111111111111";

/// A tiny HTTP server: records each request's path and body and answers with `answer`.
fn serve(answer: &'static str) -> (u16, Arc<Mutex<Vec<(String, String, String)>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let log = Arc::clone(&log);
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut writer = stream;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        return;
                    }
                    let path = line.split_whitespace().nth(1).unwrap_or("").to_string();
                    let (mut length, mut authorization) = (0, String::new());
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
                    log.lock().unwrap().push((path, authorization, String::from_utf8(body).unwrap()));
                    let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{answer}", answer.len());
                    if writer.write_all(reply.as_bytes()).is_err() {
                        return;
                    }
                }
            });
        }
    });
    (port, seen)
}

/// One request to the door, as raw HTTP; the status and the body of the answer.
fn ask(port: u16, path: &str, authorization: Option<&str>, body: &str) -> (u16, String) {
    ask_with(port, "POST", path, authorization, body)
}

fn ask_with(port: u16, method: &str, path: &str, authorization: Option<&str>, body: &str) -> (u16, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\n", body.len());
    if let Some(authorization) = authorization {
        request.push_str(&format!("Authorization: {authorization}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).unwrap();
    let mut answer = String::new();
    stream.read_to_string(&mut answer).unwrap();
    let status = answer.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = answer.split_once("\r\n\r\n").map(|(_, body)| body.to_string()).unwrap_or_default();
    (status, body)
}

#[test]
fn only_the_key_opens_the_door_and_each_call_leaves_as_a_digest() {
    let (model_port, model_saw) = serve(r#"{"message":{"role":"assistant","content":"Roma"}}"#);
    let (sigillo_port, sigillo_saw) = serve(r#"{"partialSuccess":{}}"#);
    let door_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let sigillo = sigillo::init(sigillo::Config::new(&format!("http://127.0.0.1:{sigillo_port}"), KEY, "acme").without_heartbeat()).unwrap();
    let recording = sigillo.clone();
    thread::spawn(move || sigillo::door::serve(recording, KEY.to_string(), door_port, format!("http://127.0.0.1:{model_port}")));
    let deadline = Instant::now() + Duration::from_secs(10);
    while TcpStream::connect(("127.0.0.1", door_port)).is_err() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(20));
    }

    let question = r#"{"model":"llama3.2","messages":[{"role":"user","content":"Qual è la capitale d'Italia?"}]}"#;
    // Without the key: refused, and the model never sees the request.
    assert_eq!(ask(door_port, "/api/chat", None, question).0, 401);
    assert_eq!(ask(door_port, "/api/chat", Some("Bearer not-the-key"), question).0, 401);
    assert!(model_saw.lock().unwrap().is_empty());

    // With it, as a bearer token and as basic authentication (a key written in the address).
    let (status, answer) = ask(door_port, "/api/chat", Some(&format!("Bearer {KEY}")), question);
    assert_eq!((status, answer.as_str()), (200, r#"{"message":{"role":"assistant","content":"Roma"}}"#));
    let basic = "Basic c2lnaWxsbzpzaWdpbGxvXzAxMjM0NTY3ODlhYmNkZWZfMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExMQ==";
    assert_eq!(ask(door_port, "/api/chat", Some(basic), question).0, 200);
    {
        let model_saw = model_saw.lock().unwrap();
        assert_eq!(model_saw.len(), 2);
        // The model gets the request as it was, without the key.
        assert_eq!(model_saw[0].2, question);
        assert!(model_saw.iter().all(|(_, authorization, _)| authorization.is_empty()));
    }

    assert!(sigillo.flush());
    let sent: String = sigillo_saw.lock().unwrap().iter().map(|(_, _, body)| body.clone()).collect();
    assert!(!sent.contains("capitale"), "the question left the computer");
    assert!(!sent.contains("Roma"), "the answer left the computer");
    let spans: Vec<Value> = sigillo_saw
        .lock()
        .unwrap()
        .iter()
        .flat_map(|(_, _, body)| {
            let body: Value = serde_json::from_str(body).unwrap();
            body["resourceSpans"][0]["scopeSpans"][0]["spans"].as_array().unwrap().clone()
        })
        .collect();
    assert_eq!(spans.len(), 2);
    let attributes = |span: &Value| -> Vec<(String, String)> {
        span["attributes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| (item["key"].as_str().unwrap().to_string(), item["value"]["stringValue"].as_str().unwrap().to_string()))
            .collect()
    };
    let first = attributes(&spans[0]);
    let get = |name: &str| first.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
    assert_eq!(get("gen_ai.operation.name").as_deref(), Some("chat"));
    assert_eq!(get("gen_ai.request.model").as_deref(), Some("llama3.2"));
    let nonce: [u8; 32] = (0..32).map(|at| u8::from_str_radix(&get("sigillo.input.nonce").unwrap()[at * 2..at * 2 + 2], 16).unwrap()).collect::<Vec<_>>().try_into().unwrap();
    assert_eq!(get("sigillo.input.sha256").unwrap(), sigillo::digest::salted_digest(question, &nonce));
    assert_eq!(spans[0]["status"]["code"], "STATUS_CODE_OK");

    // A path that calls no model (the list of models) goes through and is not a receipt.
    assert_eq!(ask_with(door_port, "GET", "/api/tags", Some(&format!("Bearer {KEY}")), "").0, 200);
    assert!(sigillo.flush());
    assert_eq!(sigillo_saw.lock().unwrap().iter().filter(|(path, _, _)| path == "/v1/traces").count(), 1);
}
