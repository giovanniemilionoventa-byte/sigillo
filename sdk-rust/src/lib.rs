//! Send an AI agent's actions to a sigillo server.
//!
//! The Rust counterpart of the Python SDK (`sdk-python/`), with the same
//! guarantees, held to the same test vectors. There is one function to call
//! to start, at the top of `main`, before anything else:
//!
//! ```no_run
//! let sigillo = sigillo::init(
//!     sigillo::Config::new("https://sigillo.example/", "sigillo_...", "acme-support-bot"),
//! )
//! .expect("sigillo");
//!
//! let call = sigillo.tool("cerca_ordine");
//! call.input("ordine 1234");
//! let found = "spedito"; // the tool's own work
//! call.output(found);
//! call.ok();
//! ```
//!
//! What it does, as the Python SDK does:
//!
//! - **Digests, never content.** An input or an output is hashed here, in this
//!   process, before anything is sent: SHA-256 under a fresh 32-byte nonce,
//!   sent beside it (docs/FORMAT.md, 2.7), or under a nonce made from the
//!   customer's own key and never sent at all (`Config::customer_key`). A
//!   document attached to an action is sent as its fingerprints only.
//! - **The heartbeat.** Every minute, busy or idle, the agent tells the server
//!   it is still connected; a silence of three minutes becomes a signed
//!   `sigillo.connection.lost` receipt. Each beat carries the SHA-256 of this
//!   program's executable, so a program rebuilt or replaced is written on the
//!   chain as `script_changed`.
//! - **Strict mode.** `Config::strict` makes the agent stop itself (exit
//!   status 70) when its program changes or three beats in a row do not get
//!   through, with a guard process beside it that checks the program every
//!   few seconds.
//! - **The model gateway.** `Config::env` sets the variables the model clients
//!   read their address and key from (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`
//!   and so on) before the agent makes one, so that every model call goes
//!   through sigillo and becomes a receipt, with a key that only sigillo holds
//!   the real counterpart of.
//! - **A model on this computer.** With `Config::local_model` and strict mode,
//!   the door in front of Ollama (or LM Studio, llama.cpp, vLLM) starts here.
//!
//! Model calls through the gateway or the door are recorded by sigillo itself;
//! a tool the agent runs is recorded with `tool`, which Rust needs written by
//! hand: there is no instrumentation to hook into a compiled program, as
//! OpenInference hooks into LangChain or CrewAI in Python.
//!
//! What this crate does not do: it does not sign anything, and it does not
//! decide where a receipt lands. The API key does.

use std::any::type_name;
use std::cell::RefCell;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub mod digest;
pub mod door;
mod export;
mod guard;
mod heartbeat;
#[doc(hidden)]
pub mod launcher;
mod span;
pub mod text;
mod transport;

pub use digest::{nonce_for, pseudonym, Role};

use crate::digest::{random_bytes, sha256_hex};
use crate::export::{Exporter, Message};
use crate::heartbeat::{Halt, Heartbeat};
use crate::span::{now_unix_nano, Event, Span, Status};
use crate::transport::Transport;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const TRACES_PATH: &str = "/v1/traces";
const HEARTBEAT_PATH: &str = "/api/v1/heartbeat";
const RECEIPTS_PATH: &str = "/api/v1/receipts";

/// What went wrong starting sigillo.
#[derive(Debug)]
pub enum Error {
    /// A setting that cannot work as given.
    Config(String),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Config(message) => write!(formatter, "sigillo: {message}"),
        }
    }
}

impl std::error::Error for Error {}

/// How to reach the server, and what to do besides recording.
pub struct Config {
    endpoint: String,
    api_key: String,
    system_id: String,
    customer_key: Option<Vec<u8>>,
    salt_content: bool,
    heartbeat: Option<Duration>,
    show_sent: bool,
    strict: bool,
    on_halt: Option<Box<dyn Fn(&str) + Send + Sync>>,
    local_model: Option<u16>,
    env: Vec<(String, String)>,
    guard_period: Duration,
}

impl Config {
    /// `endpoint` is the server's base URL (or its full `/v1/traces` URL),
    /// `api_key` the key issued for the system, which decides which chain the
    /// receipts join, `system_id` the name the actions are sent under.
    pub fn new(endpoint: &str, api_key: &str, system_id: &str) -> Config {
        Config {
            endpoint: endpoint.to_string(),
            api_key: api_key.to_string(),
            system_id: system_id.to_string(),
            customer_key: None,
            salt_content: true,
            heartbeat: Some(Duration::from_secs(60)),
            show_sent: false,
            strict: false,
            on_halt: None,
            local_model: None,
            env: Vec::new(),
            guard_period: Duration::from_secs(5),
        }
    }

    /// The settings from the environment, for a program that is configured
    /// where it runs rather than in its code: `SIGILLO_ENDPOINT`,
    /// `SIGILLO_API_KEY` and `SIGILLO_SYSTEM_ID` (required), and
    /// `SIGILLO_CUSTOMER_KEY`, `SIGILLO_STRICT`, `SIGILLO_LOCAL_MODEL` (`1` for
    /// Ollama, or a port), `SIGILLO_SHOW_SENT`, `SIGILLO_HEARTBEAT_SECONDS`.
    pub fn from_env() -> Result<Config, Error> {
        let required = |name: &str| {
            std::env::var(name).ok().filter(|value| !value.is_empty()).ok_or_else(|| Error::Config(format!("{name} is not set")))
        };
        let flag = |name: &str| matches!(std::env::var(name).as_deref(), Ok("1") | Ok("true") | Ok("yes"));
        let mut config = Config::new(&required("SIGILLO_ENDPOINT")?, &required("SIGILLO_API_KEY")?, &required("SIGILLO_SYSTEM_ID")?);
        if let Ok(key) = std::env::var("SIGILLO_CUSTOMER_KEY") {
            if !key.is_empty() {
                config = config.customer_key(key.as_bytes());
            }
        }
        config = config.strict(flag("SIGILLO_STRICT")).show_sent(flag("SIGILLO_SHOW_SENT"));
        match std::env::var("SIGILLO_LOCAL_MODEL").as_deref() {
            Ok("1") | Ok("true") | Ok("yes") => config = config.local_model(11434),
            Ok(port) if !port.is_empty() && port != "0" => {
                let port = port.parse().map_err(|_| Error::Config("SIGILLO_LOCAL_MODEL is 1 or a port number".into()))?;
                config = config.local_model(port);
            }
            _ => {}
        }
        if let Ok(seconds) = std::env::var("SIGILLO_HEARTBEAT_SECONDS") {
            let seconds: u64 = seconds.parse().map_err(|_| Error::Config("SIGILLO_HEARTBEAT_SECONDS is a number of seconds".into()))?;
            config = config.heartbeat(Duration::from_secs(seconds));
        }
        Ok(config)
    }

    /// The customer's own secret: each digest is then salted with a nonce made
    /// from this key and the action (`nonce_for`), and the nonce is not sent,
    /// only the word "customer" in its place. Sigillo receives a digest and
    /// nothing that opens it; the customer, with the key, can rebuild the
    /// nonce of any receipt and show what it was of. Keep a copy: once it is
    /// lost, nobody can open the digests it salted.
    pub fn customer_key(mut self, key: impl AsRef<[u8]>) -> Config {
        self.customer_key = Some(key.as_ref().to_vec());
        self
    }

    /// True by default: each digest is salted with a fresh 32-byte nonce, so a
    /// short value ("score: 7") cannot be found from it. Turn it off only for a
    /// server older than October 2026, which would misrecord a salted digest.
    pub fn salt_content(mut self, salt: bool) -> Config {
        self.salt_content = salt;
        self
    }

    /// How often the agent tells the server it is still connected, every
    /// minute by default. The server calls an agent disconnected after three
    /// minutes without a beat, so keep it well under that.
    pub fn heartbeat(mut self, every: Duration) -> Config {
        self.heartbeat = Some(every);
        self
    }

    /// No heartbeat at all: for a short program that is not an agent, such as
    /// a test. The server then cannot tell when the program was disconnected.
    pub fn without_heartbeat(mut self) -> Config {
        self.heartbeat = None;
        self
    }

    /// Prints on standard error everything this crate sends to the server,
    /// one line per action and per heartbeat, exactly as it leaves the
    /// process: how a customer checks, on their own computer, that no content
    /// leaves it.
    pub fn show_sent(mut self, show: bool) -> Config {
        self.show_sent = show;
        self
    }

    /// Makes the agent stop itself, with a message on standard error and exit
    /// status 70, if the server says its program is not the one it started
    /// with, or if three heartbeats in a row do not get through: it does not
    /// go on without the record. Also starts the guard process.
    pub fn strict(mut self, strict: bool) -> Config {
        self.strict = strict;
        self
    }

    /// Replaces how strict mode stops the agent: called once, from the
    /// heartbeat's thread, with the reason as a sentence.
    pub fn on_halt(mut self, on_halt: impl Fn(&str) + Send + Sync + 'static) -> Config {
        self.on_halt = Some(Box::new(on_halt));
        self
    }

    /// For an agent that uses a model on this computer, at this port (11434
    /// for Ollama, 1234 LM Studio, 8080 llama.cpp, 8000 vLLM). With strict
    /// mode, the door in front of it starts here, for as long as the agent
    /// runs, and the guard checks that the model does not answer there
    /// without the key. Only Ollama is started by the door; another server is
    /// started by whoever runs the agent, on the next port up.
    pub fn local_model(mut self, port: u16) -> Config {
        self.local_model = Some(port);
        self
    }

    /// Sets an environment variable before the agent makes its first client:
    /// how a model client is pointed at the gateway (`OPENAI_BASE_URL`) and
    /// given the sigillo key in place of the provider's (`OPENAI_API_KEY`).
    pub fn env(mut self, name: &str, value: &str) -> Config {
        self.env.push((name.to_string(), value.to_string()));
        self
    }

    #[doc(hidden)]
    pub fn guard_period(mut self, period: Duration) -> Config {
        self.guard_period = period;
        self
    }
}

/// Starts recording. Call it first thing in `main`, and keep what it returns
/// for as long as the agent runs (`let _sigillo = ...`, not `let _ = ...`,
/// which would drop it at once): when it is dropped, what is still queued is
/// sent, and the server is told the agent closed normally.
///
/// In a process this crate started itself (the guard, the door), this runs
/// that process instead and never returns.
pub fn init(config: Config) -> Result<Sigillo, Error> {
    if std::env::var_os(guard::GUARD_VARIABLE).is_some() {
        guard::run();
    }
    if std::env::var_os(door::DOOR_VARIABLE).is_some() {
        door::run_process();
    }
    start(config)
}

/// `init(Config::from_env()?)`.
pub fn init_from_env() -> Result<Sigillo, Error> {
    if std::env::var_os(guard::GUARD_VARIABLE).is_some() {
        guard::run();
    }
    if std::env::var_os(door::DOOR_VARIABLE).is_some() {
        door::run_process();
    }
    start(Config::from_env()?)
}

pub(crate) fn start(config: Config) -> Result<Sigillo, Error> {
    start_watching(config, heartbeat::this_program(), std::process::id())
}

/// `start`, with the program the beats carry the hash of, and the process
/// strict mode ends, named: this program and this process for an agent,
/// the program `sigillo-run` started for the launcher.
pub(crate) fn start_watching(config: Config, program: Option<PathBuf>, target: u32) -> Result<Sigillo, Error> {
    if config.api_key.is_empty() {
        return Err(Error::Config("api_key must not be empty".into()));
    }
    if config.system_id.is_empty() {
        return Err(Error::Config("system_id must not be empty".into()));
    }
    if let Some(key) = &config.customer_key {
        if key.is_empty() {
            return Err(Error::Config("customer_key must not be empty".into()));
        }
        if key.starts_with(b"<") {
            return Err(Error::Config(
                "customer_key is still the placeholder: put your own secret there, 64 hex characters from a secure random source".into(),
            ));
        }
        if !config.salt_content {
            return Err(Error::Config("customer_key salts the digests made here: it needs salt_content".into()));
        }
    }
    if matches!(config.heartbeat, Some(every) if every.is_zero()) {
        return Err(Error::Config("the heartbeat must be a positive number of seconds".into()));
    }
    let base = base_url(&config.endpoint)?;

    // Through the model gateway: the variables the clients read, set before the agent makes one.
    for (name, value) in &config.env {
        std::env::set_var(name, value);
    }

    let transport = Transport::new(&config.api_key, Duration::from_secs(30));
    let resource = vec![
        ("service.name".to_string(), config.system_id.clone()),
        ("telemetry.sdk.language".to_string(), "rust".to_string()),
        ("telemetry.sdk.name".to_string(), "sigillo".to_string()),
        ("telemetry.sdk.version".to_string(), VERSION.to_string()),
    ];
    let exporter = Exporter::start(transport, format!("{base}{TRACES_PATH}"), resource, config.show_sent);

    // A model on this computer, with strict mode: the door, and Ollama behind it, start with the agent.
    let mut door_process = None;
    let mut local_open = false;
    let mut local_url = None;
    if let (Some(port), true) = (config.local_model, config.strict) {
        let order = door::DoorOrder {
            endpoint: base.clone(),
            api_key: config.api_key.clone(),
            system_id: config.system_id.clone(),
            port,
            upstream: format!("http://127.0.0.1:{}", port + 1),
            serve: port == 11434,
        };
        match door::ensure(&order) {
            (door::Ensured::Door, child) => {
                door_process = child;
                local_url = Some(format!("http://127.0.0.1:{port}"));
                if port != 11434 {
                    warn(&format!("sigillo: the door waits on port {port}; start your model on port {} (the door cannot start it)", port + 1));
                }
            }
            (door::Ensured::ModelOpen, _) => {
                // The model was already open and cannot be moved: a door opens beside it on a
                // free port, the agent's calls that go there carry the key and become receipts,
                // and the open model is said in a receipt by the guard.
                let beside = free_port();
                let order = door::DoorOrder { port: beside, upstream: format!("http://127.0.0.1:{port}"), serve: false, ..order };
                if let (door::Ensured::Door, child) = door::ensure(&order) {
                    door_process = child;
                    local_open = true;
                    local_url = Some(format!("http://127.0.0.1:{beside}"));
                    warn(&format!("sigillo: the local model is already open on port {port}: the door is on port {beside} and the open model is recorded; close the model and start the agent again to seal it"));
                } else {
                    warn(&format!("sigillo: the local model is already open on port {port} and the door beside it did not start"));
                }
            }
            (door::Ensured::Failed, _) => warn("sigillo: the door in front of the local model did not start"),
        }
        if let Some(url) = &local_url {
            if port == 11434 {
                // The clients that read where Ollama is, and its key, from the environment.
                std::env::set_var("OLLAMA_API_KEY", &config.api_key);
                if local_open {
                    std::env::set_var("OLLAMA_HOST", url);
                    std::env::set_var("OLLAMA_API_BASE_URL", url);
                }
            }
        }
    }

    let halt = Arc::new(Halt::new(config.strict, config.on_halt));
    let heartbeat = config.heartbeat.map(|every| {
        let guard_config = |session: &str| guard::GuardConfig {
            url: format!("{base}{HEARTBEAT_PATH}"),
            api_key: config.api_key.clone(),
            session: session.to_string(),
            program: program.clone(),
            program_hash: program.as_ref().and_then(heartbeat::hash_of_file),
            target,
            period: config.guard_period,
            probe: config.local_model.filter(|_| local_url.is_some()).map(|port| format!("http://127.0.0.1:{port}")),
            keep: local_open,
            receipts: format!("{base}{RECEIPTS_PATH}"),
        };
        Heartbeat::start(
            Transport::new(&config.api_key, Duration::from_secs(10)),
            format!("{base}{HEARTBEAT_PATH}"),
            program.clone(),
            every,
            config.show_sent,
            Arc::clone(&halt),
            |session| guard::start(&guard_config(session)),
        )
    });

    Ok(Sigillo {
        inner: Arc::new(Inner {
            system_id: config.system_id,
            endpoint: base,
            sender: Mutex::new(exporter.sender()),
            exporter: Mutex::new(Some(exporter)),
            heartbeat,
            salt: config.salt_content,
            customer_key: config.customer_key,
            door: Mutex::new(door_process),
            local_url,
            closed: AtomicBool::new(false),
        }),
    })
}

/// The server's base URL, from its base URL or its full traces URL.
fn base_url(endpoint: &str) -> Result<String, Error> {
    let cleaned = endpoint.trim().trim_end_matches('/');
    if cleaned.is_empty() {
        return Err(Error::Config("endpoint must not be empty".into()));
    }
    if !cleaned.starts_with("https://") && !cleaned.starts_with("http://") {
        return Err(Error::Config("endpoint is an http:// or https:// address".into()));
    }
    Ok(cleaned.strip_suffix(TRACES_PATH).unwrap_or(cleaned).to_string())
}

fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|probe| probe.local_addr()).map(|address| address.port()).unwrap_or(11435)
}

/// What `init` hands back: the way to record actions. Cheap to clone; every
/// clone is the same recording.
#[derive(Clone)]
pub struct Sigillo {
    inner: Arc<Inner>,
}

struct Inner {
    system_id: String,
    endpoint: String,
    sender: Mutex<Sender<Message>>,
    exporter: Mutex<Option<Exporter>>,
    heartbeat: Option<Heartbeat>,
    salt: bool,
    customer_key: Option<Vec<u8>>,
    door: Mutex<Option<Child>>,
    local_url: Option<String>,
    closed: AtomicBool,
}

impl Sigillo {
    /// Records one tool call, with its outcome.
    ///
    /// ```no_run
    /// # let sigillo = sigillo::init(sigillo::Config::new("https://s.example", "k", "s")).unwrap();
    /// # fn write_file(_: &str) -> std::io::Result<()> { Ok(()) }
    /// let call = sigillo.tool("scrivi_file");
    /// call.agent("agente-codice").input("report.txt");
    /// call.run(|| write_file("report.txt"))?;
    /// # Ok::<(), std::io::Error>(())
    /// ```
    pub fn tool(&self, name: &str) -> Call {
        let name = if name.is_empty() { "tool" } else { name };
        let call = Call::new(self, format!("execute_tool {name}"));
        call.set("gen_ai.operation.name", "execute_tool");
        call.set("gen_ai.tool.name", name);
        call
    }

    /// Records one call to a model that does not go through sigillo's gateway
    /// or door (whose calls sigillo records itself): the model's name and,
    /// when known, its provider.
    pub fn model_call(&self, model: &str, provider: Option<&str>) -> Call {
        let call = Call::new(self, format!("chat {model}"));
        call.set("gen_ai.operation.name", "chat");
        call.set("gen_ai.request.model", model);
        if let Some(provider) = provider {
            call.set("gen_ai.provider.name", provider);
        }
        call
    }

    pub(crate) fn local_model_call(&self, model: &str, server: &str) -> Call {
        self.model_call(model, Some(server))
    }

    /// Sends whatever is still queued; true when it got through.
    pub fn flush(&self) -> bool {
        match self.inner.exporter.lock().unwrap().as_ref() {
            Some(exporter) => exporter.flush(Duration::from_secs(30)),
            None => false,
        }
    }

    /// Sends what is queued, then tells the server this agent closed normally.
    /// Also what happens when the last handle is dropped.
    pub fn shutdown(&self) {
        self.inner.shutdown();
    }

    /// The heartbeat's session: 32 hex characters, new for every process.
    pub fn session(&self) -> Option<&str> {
        self.inner.heartbeat.as_ref().map(|heartbeat| heartbeat.session.as_str())
    }

    pub fn system_id(&self) -> &str {
        &self.inner.system_id
    }

    pub fn endpoint(&self) -> &str {
        &self.inner.endpoint
    }

    /// Where the agent reaches its local model, when the door is in front of it.
    pub fn local_model_url(&self) -> Option<&str> {
        self.inner.local_url.as_deref()
    }

    fn send(&self, span: Span) {
        let _ = self.inner.sender.lock().unwrap().send(Message::Span(Box::new(span)));
    }
}

impl Inner {
    fn shutdown(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(mut exporter) = self.exporter.lock().unwrap().take() {
            exporter.stop(Duration::from_secs(30));
        }
        if let Some(heartbeat) = &self.heartbeat {
            heartbeat.close();
        }
        if let Some(mut door) = self.door.lock().unwrap().take() {
            drop(door.stdin.take());
            let _ = door.wait();
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// One action being recorded. Ends with `ok`, `error` or `run`; dropped
/// without either, it is `ok`, unless the thread is panicking, when it is
/// `error` (as a Python `with` block that returns or raises).
pub struct Call {
    sigillo: Sigillo,
    span: RefCell<Option<Span>>,
}

/// The two ends of a document's journey through an action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactRole {
    Input,
    Output,
}

impl Call {
    fn new(sigillo: &Sigillo, name: String) -> Call {
        Call { sigillo: sigillo.clone(), span: RefCell::new(Some(Span::new(name))) }
    }

    fn set(&self, key: &str, value: &str) {
        if let Some(span) = self.span.borrow_mut().as_mut() {
            span.set(key, value);
        }
    }

    /// The agent that acted, when it is not the system as a whole.
    pub fn agent(&self, name: &str) -> &Call {
        self.set("gen_ai.agent.name", name);
        self
    }

    /// Who the action was for. Recorded as a pseudonym token by the server;
    /// better still, pass `sigillo::pseudonym(id, key)` here.
    pub fn on_behalf_of(&self, person: &str) -> &Call {
        self.set("user.id", person);
        self
    }

    /// The action's input, hashed here: only its digest leaves the process.
    pub fn input(&self, value: &str) -> &Call {
        self.digest(Role::Input, value);
        self
    }

    /// The action's output, hashed here: only its digest leaves the process.
    pub fn output(&self, value: &str) -> &Call {
        self.digest(Role::Output, value);
        self
    }

    fn digest(&self, role: Role, value: &str) {
        let mut guard = self.span.borrow_mut();
        let Some(span) = guard.as_mut() else { return };
        let inner = &self.sigillo.inner;
        let (digest_name, nonce_name) = match role {
            Role::Input => ("sigillo.input.sha256", "sigillo.input.nonce"),
            Role::Output => ("sigillo.output.sha256", "sigillo.output.nonce"),
        };
        if let Some(key) = &inner.customer_key {
            let nonce = nonce_for(key, &span.trace_id, &span.span_id, role).expect("the span's identifiers are well formed");
            let nonce: [u8; 32] = digest::from_hex(&nonce).and_then(|bytes| bytes.try_into().ok()).expect("a nonce is 32 bytes");
            span.set(digest_name, digest::salted_digest(value, &nonce));
            span.set(nonce_name, "customer");
        } else if inner.salt {
            let nonce = random_bytes::<32>();
            span.set(digest_name, digest::salted_digest(value, &nonce));
            span.set(nonce_name, digest::hex(&nonce));
        } else {
            span.set(digest_name, digest::plain_digest(value));
        }
    }

    /// Attaches a document's fingerprint (never its content) to this action.
    /// `label` is a category such as "curriculum", never a filename, which
    /// can carry a person's name; without one, it is the role and the media
    /// type. A `text/plain` document that is UTF-8 also gets its
    /// sigillo-text/1 fingerprint, which a copy with other spacing or line
    /// breaks shares.
    pub fn artifact(&self, data: &[u8], role: ArtifactRole, label: Option<&str>, media_type: &str) -> &Call {
        let role = match role {
            ArtifactRole::Input => "input",
            ArtifactRole::Output => "output",
        };
        let mut attributes = vec![
            ("sigillo.artifact.role".to_string(), role.to_string()),
            ("sigillo.artifact.label".to_string(), label.map(str::to_string).unwrap_or_else(|| format!("{role} {media_type}"))),
            ("sigillo.artifact.media_type".to_string(), media_type.to_string()),
            ("sigillo.artifact.sha256".to_string(), sha256_hex(data)),
        ];
        if text::is_plain_text(media_type) {
            if let Some(digest) = text::text_sha256(data) {
                attributes.push(("sigillo.artifact.text_canon".to_string(), text::TEXT_CANON_1.to_string()));
                attributes.push(("sigillo.artifact.text_sha256".to_string(), digest));
            }
        }
        if let Some(span) = self.span.borrow_mut().as_mut() {
            span.events.push(Event { name: "sigillo.artifact".into(), time_unix_nano: now_unix_nano(), attributes });
        }
        self
    }

    /// `artifact` for a file, read here; the media type is guessed from its
    /// extension. The file's name is not sent.
    pub fn artifact_file(&self, path: impl AsRef<Path>, role: ArtifactRole, label: Option<&str>) -> std::io::Result<&Call> {
        let path = path.as_ref();
        let data = std::fs::read(path)?;
        Ok(self.artifact(&data, role, label, media_type_of(path)))
    }

    /// The receipt's `source` identifiers: 32 and 16 lowercase hex
    /// characters, as `nonce_for` takes them.
    pub fn ids(&self) -> (String, String) {
        let span = self.span.borrow();
        let span = span.as_ref().expect("a call is open until it ends");
        (span.trace_id.clone(), span.span_id.clone())
    }

    /// Ends the action as succeeded.
    pub fn ok(self) {
        self.finish(Status::Ok, None);
    }

    /// Ends the action as failed, naming the error's type, never its message,
    /// which can quote the very content this crate keeps from leaving the process.
    pub fn error<E: ?Sized>(self, _error: &E) {
        self.finish(Status::Error, Some(short_type_name::<E>()));
    }

    /// Ends the action as failed, with the failure's kind as given.
    pub fn error_named(self, kind: &str) {
        self.finish(Status::Error, Some(kind.to_string()));
    }

    /// Runs `work` as this action: `Ok` is succeeded, `Err` failed (by the
    /// error's type), and the result is handed back unchanged.
    pub fn run<T, E>(self, work: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
        let result = work();
        match &result {
            Ok(_) => self.ok(),
            Err(error) => self.error(error),
        }
        result
    }

    fn finish(&self, status: Status, error_type: Option<String>) {
        let Some(mut span) = self.span.borrow_mut().take() else { return };
        span.status = status;
        if let Some(error_type) = error_type {
            span.set("error.type", error_type);
        }
        span.end_unix_nano = now_unix_nano();
        self.sigillo.send(span);
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.finish(Status::Error, Some("panic".into()));
        } else {
            self.finish(Status::Ok, None);
        }
    }
}

/// `std::io::Error` for `std::io::Error`, `MyError` for `my_crate::errors::MyError<T>`.
fn short_type_name<E: ?Sized>() -> String {
    let full = type_name::<E>();
    let base = full.split('<').next().unwrap_or(full);
    let short = base.rsplit("::").next().unwrap_or(base);
    if base.starts_with("std::") || base.starts_with("core::") || base.starts_with("alloc::") {
        format!("std::{short}")
    } else {
        short.to_string()
    }
}

/// The media type of a file, from its extension; the usual documents only.
fn media_type_of(path: &Path) -> &'static str {
    let extension = path.extension().and_then(|extension| extension.to_str()).unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "txt" => "text/plain",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "csv" => "text/csv",
        "md" => "text/markdown",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "odt" => "application/vnd.oasis.opendocument.text",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// One line on standard error per thing sent, for `show_sent`: printed, so it
/// appears whatever the program does with its logs.
pub(crate) fn show_sent(kind: &str, what: &str) {
    eprintln!("[sigillo sends] {kind} {what}");
}

pub(crate) fn warn(message: &str) {
    eprintln!("{message}");
}

#[doc(hidden)]
pub fn program_hash(path: &PathBuf) -> Option<String> {
    heartbeat::hash_of_file(path)
}
