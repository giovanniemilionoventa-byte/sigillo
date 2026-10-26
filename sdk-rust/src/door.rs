//! The door in front of a local model (Ollama, LM Studio, llama.cpp, vLLM and the like).
//!
//! The Python SDK's `door.py`, in Rust, so that an agent written in Rust does
//! not need Python on the computer. It listens where the agent expects the
//! model (127.0.0.1:11434 by default), lets through only requests that carry
//! the system's sigillo key, and forwards them to the model, which is moved to
//! another address. Every request it forwards becomes a receipt, written by
//! the door and not by the agent: the model is reachable through the key and
//! nothing else, as a cloud model whose key sigillo holds.
//!
//! The key is accepted as a bearer token, as `x-api-key`, or as the password
//! of HTTP basic authentication, which is what a client sends when the key is
//! written into the model's address (`http://sigillo:<key>@127.0.0.1:11434`):
//! the one way to give it to a client, such as ollama-rs, that has no setting
//! for a key.
//!
//! The request and the answer go through untouched and are never stored: the
//! receipt carries the request's salted digest, as for every other call.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::guard::{model_state, ModelState};
use crate::{Call, Sigillo};

/// Headers that describe one connection, not the message: not passed on.
const NOT_FORWARDED: &[&str] =
    &["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "content-length", "host", "authorization", "x-api-key"];

/// The paths a model is called at, by the servers and API shapes the door knows.
const MODEL_PATHS: &[&str] = &[
    "/api/chat",
    "/api/generate",
    "/api/embeddings",
    "/api/embed",
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/responses",
    "/v1/messages",
];

/// The local servers by the port they usually listen on.
pub const LOCAL_SERVERS: &[(u16, &str)] = &[(11434, "ollama"), (1234, "lm-studio"), (8080, "llama.cpp"), (8000, "vllm"), (1337, "jan")];

pub(crate) const DOOR_VARIABLE: &str = "SIGILLO_DOOR_PROCESS";

pub fn server_name(port: u16) -> &'static str {
    LOCAL_SERVERS.iter().find(|(known, _)| *known == port).map(|(_, name)| *name).unwrap_or("local-model")
}

/// Whether a request carries the key, in any of the three ways a client can send it.
pub(crate) fn allowed(headers: &[(String, String)], key: &str) -> bool {
    let header = |name: &str| headers.iter().find(|(given, _)| given.eq_ignore_ascii_case(name)).map(|(_, value)| value.trim());
    let given = match header("authorization") {
        Some(value) if value.len() > 7 && value[..7].eq_ignore_ascii_case("bearer ") => value[7..].trim().to_string(),
        Some(value) if value.len() > 6 && value[..6].eq_ignore_ascii_case("basic ") => {
            let decoded = base64_decode(value[6..].trim()).and_then(|bytes| String::from_utf8(bytes).ok()).unwrap_or_default();
            decoded.split_once(':').map(|(_, password)| password.to_string()).unwrap_or_default()
        }
        _ => header("x-api-key").unwrap_or("").to_string(),
    };
    // Compared as digests, byte by byte to the end: the time taken says nothing about the key.
    let (given, key) = (ring::digest::digest(&ring::digest::SHA256, given.as_bytes()), ring::digest::digest(&ring::digest::SHA256, key.as_bytes()));
    given.as_ref().iter().zip(key.as_ref()).fold(0u8, |differ, (a, b)| differ | (a ^ b)) == 0
}

/// Serves the door at `127.0.0.1:<port>`, forwarding to `upstream`. Never returns while it can listen.
pub fn serve(sigillo: Sigillo, key: String, port: u16, upstream: String) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let upstream = Arc::new(upstream.trim_end_matches('/').to_string());
    let key = Arc::new(key);
    let server = server_name(port);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(600)))
        .http_status_as_error(false)
        .allow_non_standard_methods(true)
        .max_redirects(0)
        .build()
        .into();
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let (sigillo, key, upstream, agent) = (sigillo.clone(), Arc::clone(&key), Arc::clone(&upstream), agent.clone());
        thread::spawn(move || {
            let _ = handle(stream, &sigillo, &key, &upstream, &agent, server);
        });
    }
    Ok(())
}

fn handle(stream: TcpStream, sigillo: &Sigillo, key: &str, upstream: &str, agent: &ureq::Agent, server: &str) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut writer = stream;
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (Some(method), Some(path)) = (parts.next(), parts.next()) else { return Ok(()) };
    let (method, path) = (method.to_string(), path.to_string());
    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    if !allowed(&headers, key) {
        return refuse(&mut writer, 401, "the sigillo key is required to reach this model");
    }
    let length: usize = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;

    let call = model_call(sigillo, &path, &body, server);
    let mut request = ureq::http::Request::builder().method(method.as_str()).uri(format!("{upstream}{path}"));
    for (name, value) in &headers {
        if !NOT_FORWARDED.contains(&name.to_ascii_lowercase().as_str()) {
            request = request.header(name.as_str(), value.as_str());
        }
    }
    let Ok(request) = request.body(body) else { return refuse(&mut writer, 400, "the request could not be read") };
    let mut answer = match agent.run(request) {
        Ok(answer) => answer,
        Err(_) => {
            if let Some(call) = call {
                call.error_named("upstream_unreachable");
            }
            return refuse(&mut writer, 502, "the model did not answer");
        }
    };
    let status = answer.status();
    let mut head = format!("HTTP/1.0 {} {}\r\n", status.as_u16(), status.canonical_reason().unwrap_or(""));
    for (name, value) in answer.headers() {
        if !NOT_FORWARDED.contains(&name.as_str()) {
            head.push_str(&format!("{}: {}\r\n", name, value.to_str().unwrap_or("")));
        }
    }
    head.push_str("Connection: close\r\n\r\n");
    writer.write_all(head.as_bytes())?;
    // Streamed answers stay streamed: passed on as they arrive.
    let mut reader = answer.body_mut().as_reader();
    let mut chunk = [0u8; 65536];
    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        writer.write_all(&chunk[..read])?;
        writer.flush()?;
    }
    if let Some(call) = call {
        if status.is_client_error() || status.is_server_error() {
            call.error_named(&format!("http_{}", status.as_u16()));
        } else {
            call.ok();
        }
    }
    Ok(())
}

/// The model call a request is, with the request as its input; `None` for a
/// request that calls no model (a list of models, a version).
fn model_call(sigillo: &Sigillo, path: &str, body: &[u8], server: &str) -> Option<Call> {
    let bare = path.split('?').next().unwrap_or("").trim_end_matches('/');
    let generates = MODEL_PATHS.iter().any(|known| bare.ends_with(known)) || bare.contains(":generateContent") || bare.contains(":streamGenerateContent");
    if !generates {
        return None;
    }
    let model = model_of(body).unwrap_or_else(|| "unknown".into());
    let call = sigillo.local_model_call(&model, server);
    call.input(&String::from_utf8_lossy(body));
    Some(call)
}

/// The top-level `"model"` of a JSON request body, read without a JSON library:
/// the first `"model": "<name>"` in it, as every API shape the door knows puts it.
pub(crate) fn model_of(body: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    let at = text.find("\"model\"")?;
    let rest = text[at + 7..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    let model = &rest[..end];
    (!model.is_empty() && !model.contains('\\')).then(|| model.to_string())
}

fn refuse(writer: &mut TcpStream, code: u16, message: &str) -> std::io::Result<()> {
    let body = format!("{{\"error\":{}}}", crate::digest::canonical_string(message));
    let reason = if code == 401 { "Unauthorized" } else if code == 502 { "Bad Gateway" } else { "Bad Request" };
    let head = format!(
        "HTTP/1.0 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    writer.write_all(head.as_bytes())?;
    writer.write_all(body.as_bytes())?;
    writer.flush()
}

/// Starts `ollama serve` listening at `upstream`, unless something already answers there.
pub fn serve_model(upstream: &str) -> Result<Option<Child>, String> {
    if model_state(upstream) != ModelState::None {
        return Ok(None);
    }
    let address = upstream.trim_start_matches("http://").trim_end_matches('/');
    let mut command = Command::new("ollama");
    command.arg("serve").env("OLLAMA_HOST", address).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| "ollama was not found; install it from https://ollama.com".to_string())?;
    for _ in 0..30 {
        if model_state(upstream) != ModelState::None {
            return Ok(Some(child));
        }
        thread::sleep(Duration::from_secs(1));
    }
    let _ = child.kill();
    Err("ollama did not start; try 'ollama serve' by hand".into())
}

/// What `ensure` found or did.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ensured {
    /// The door answers at the local address, asking for the key.
    Door,
    /// The model itself answers there, without a key: it was already open.
    ModelOpen,
    Failed,
}

/// How a door process is started: this program again, told what to do on its standard input.
pub(crate) struct DoorOrder {
    pub(crate) endpoint: String,
    pub(crate) api_key: String,
    pub(crate) system_id: String,
    pub(crate) port: u16,
    pub(crate) upstream: String,
    pub(crate) serve: bool,
}

impl DoorOrder {
    fn lines(&self) -> String {
        format!(
            "{}\n{}\n{}\n{}\n{}\n{}\n",
            self.endpoint,
            self.api_key,
            self.system_id,
            self.port,
            self.upstream,
            if self.serve { "1" } else { "0" }
        )
    }

    pub(crate) fn read(input: &mut impl BufRead) -> Option<DoorOrder> {
        let mut next = || {
            let mut line = String::new();
            input.read_line(&mut line).ok()?;
            Some(line.trim_end_matches(['\r', '\n']).to_string())
        };
        Some(DoorOrder {
            endpoint: next()?,
            api_key: next()?,
            system_id: next()?,
            port: next()?.parse().ok()?,
            upstream: next()?,
            serve: next()? == "1",
        })
    }
}

/// Starts the door, and Ollama behind it, for as long as this process runs,
/// unless the door is already there. The door is a process of its own that
/// ends when this one does (its standard input closes), and nothing on the
/// computer is changed. A model already answering at the local address
/// without a key is left alone.
pub(crate) fn ensure(order: &DoorOrder) -> (Ensured, Option<Child>) {
    let local = format!("http://127.0.0.1:{}", order.port);
    match model_state(&local) {
        ModelState::Closed => return (Ensured::Door, None),
        ModelState::Open => return (Ensured::ModelOpen, None),
        ModelState::None => {}
    }
    let Ok(program) = std::env::current_exe() else { return (Ensured::Failed, None) };
    let Ok(mut child) = Command::new(program).env(DOOR_VARIABLE, "1").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit()).spawn() else {
        return (Ensured::Failed, None);
    };
    let told = child.stdin.as_mut().map(|stdin| stdin.write_all(order.lines().as_bytes()).and_then(|_| stdin.flush()));
    if !matches!(told, Some(Ok(()))) {
        let _ = child.kill();
        return (Ensured::Failed, None);
    }
    for _ in 0..80 {
        if model_state(&local) == ModelState::Closed {
            return (Ensured::Door, Some(child));
        }
        if !matches!(child.try_wait(), Ok(None)) {
            return (Ensured::Failed, None);
        }
        thread::sleep(Duration::from_millis(500));
    }
    let _ = child.kill();
    (Ensured::Failed, None)
}

/// The door process `ensure` started. Never returns.
pub(crate) fn run_process() -> ! {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let Some(order) = DoorOrder::read(&mut input) else { std::process::exit(0) };
    drop(input);
    let model = if order.serve {
        match serve_model(&order.upstream) {
            Ok(model) => model,
            Err(why) => {
                eprintln!("sigillo door: {why}");
                std::process::exit(1);
            }
        }
    } else {
        None
    };
    let model = std::sync::Mutex::new(model);
    let model = Arc::new(model);
    let watching = Arc::clone(&model);
    // This process ends with the agent: when its end of our standard input closes.
    thread::spawn(move || {
        let mut rest = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut rest);
        if let Some(mut model) = watching.lock().unwrap().take() {
            let _ = model.kill();
        }
        std::process::exit(0);
    });
    let config = crate::Config::new(&order.endpoint, &order.api_key, &order.system_id);
    let sigillo = match crate::start(config) {
        Ok(sigillo) => sigillo,
        Err(error) => {
            eprintln!("sigillo door: {error}");
            std::process::exit(1);
        }
    };
    if let Err(error) = serve(sigillo, order.api_key.clone(), order.port, order.upstream.clone()) {
        eprintln!("sigillo door: cannot listen on 127.0.0.1:{}: {error}", order.port);
    }
    if let Some(mut model) = model.lock().unwrap().take() {
        let _ = model.kill();
    }
    std::process::exit(1)
}

/// Standard base64 (with or without padding), for HTTP basic authentication.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let value = |byte: u8| -> Option<u32> {
        Some(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let bytes: Vec<u8> = text.bytes().filter(|&byte| byte != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for group in bytes.chunks(4) {
        let mut accumulator = 0u32;
        for (index, &byte) in group.iter().enumerate() {
            accumulator |= value(byte)? << (18 - 6 * index);
        }
        let produced = match group.len() {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => return None,
        };
        for index in 0..produced {
            out.push((accumulator >> (16 - 8 * index)) as u8);
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_reads_what_basic_authentication_sends() {
        assert_eq!(base64_decode("c2lnaWxsbzprZXk=").unwrap(), b"sigillo:key");
        assert_eq!(base64_decode("c2lnaWxsbzprZXk").unwrap(), b"sigillo:key");
        assert!(base64_decode("not base64!").is_none());
    }

    #[test]
    fn the_key_is_taken_in_each_of_three_forms() {
        let key = "sigillo_0123456789abcdef_secret";
        let bearer = vec![("Authorization".to_string(), format!("Bearer {key}"))];
        let api_key = vec![("x-api-key".to_string(), key.to_string())];
        let basic = vec![("authorization".to_string(), "Basic c2lnaWxsbzpzaWdpbGxvXzAxMjM0NTY3ODlhYmNkZWZfc2VjcmV0".to_string())];
        assert!(allowed(&bearer, key));
        assert!(allowed(&api_key, key));
        assert!(allowed(&basic, key));
        assert!(!allowed(&[], key));
        assert!(!allowed(&[("Authorization".to_string(), "Bearer wrong".to_string())], key));
    }

    #[test]
    fn the_model_is_read_from_the_request() {
        assert_eq!(model_of(br#"{"model": "llama3.2", "messages": []}"#).as_deref(), Some("llama3.2"));
        assert_eq!(model_of(br#"{"messages":[],"model":"qwen2.5:7b"}"#).as_deref(), Some("qwen2.5:7b"));
        assert_eq!(model_of(b"{}"), None);
    }
}
