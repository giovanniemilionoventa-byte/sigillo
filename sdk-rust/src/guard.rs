//! The guard process that strict mode starts beside the agent.
//!
//! The Python SDK's `_watchdog.py`, for a compiled program. It is this same
//! program, started again with `SIGILLO_GUARD_PROCESS` set: `init` sees the
//! variable before anything else and runs the guard instead of returning, so
//! no second executable has to be shipped and none can go missing. It runs in
//! a process of its own, so nothing inside the agent can stop it short of
//! killing it, and then the agent's beats go on saying the guard is gone and
//! strict mode ends the agent. Every few seconds it takes the program's hash
//! again: if it differs from what the agent started with, it tells the server
//! at once (a beat with the new hash, which the server writes as
//! `script_changed`) and ends the agent. With a local model, it also checks
//! that the model does not answer without the sigillo key.
//!
//! It ends by itself when the agent's end of its standard input closes, which
//! is how it learns the agent is gone, on every operating system.

use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::heartbeat::hash_of_file;
use crate::transport::Transport;

pub(crate) const GUARD_VARIABLE: &str = "SIGILLO_GUARD_PROCESS";

/// What the guard is told, one line each, in this order.
pub(crate) struct GuardConfig {
    pub(crate) url: String,
    pub(crate) api_key: String,
    pub(crate) session: String,
    pub(crate) program: Option<PathBuf>,
    pub(crate) program_hash: Option<String>,
    /// The process to end: the agent itself, or what `sigillo-run` started.
    pub(crate) target: u32,
    pub(crate) period: Duration,
    /// Where the local model is expected, when there is one.
    pub(crate) probe: Option<String>,
    /// A model already open when the agent started: said in a receipt, not ended.
    pub(crate) keep: bool,
    pub(crate) receipts: String,
}

impl GuardConfig {
    fn lines(&self) -> String {
        let optional = |value: &Option<String>| value.clone().unwrap_or_else(|| "-".into());
        [
            self.url.clone(),
            self.api_key.clone(),
            self.session.clone(),
            optional(&self.program.as_ref().map(|path| path.to_string_lossy().into_owned())),
            optional(&self.program_hash),
            self.target.to_string(),
            self.period.as_millis().to_string(),
            optional(&self.probe),
            if self.keep { "1".into() } else { "0".into() },
            self.receipts.clone(),
        ]
        .join("\n")
            + "\n"
    }

    fn read(input: &mut impl BufRead) -> Option<GuardConfig> {
        let mut next = || {
            let mut line = String::new();
            input.read_line(&mut line).ok()?;
            Some(line.trim_end_matches(['\r', '\n']).to_string())
        };
        let optional = |value: String| if value == "-" { None } else { Some(value) };
        Some(GuardConfig {
            url: next()?,
            api_key: next()?,
            session: next()?,
            program: optional(next()?).map(PathBuf::from),
            program_hash: optional(next()?),
            target: next()?.parse().ok()?,
            period: Duration::from_millis(next()?.parse().ok()?),
            probe: optional(next()?),
            keep: next()? == "1",
            receipts: next()?,
        })
    }
}

/// Starts the guard: this program again, told what to watch on its standard input.
pub(crate) fn start(config: &GuardConfig) -> Option<Child> {
    let program = std::env::current_exe().ok()?;
    let mut child = Command::new(program)
        .env(GUARD_VARIABLE, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| crate::warn(&format!("sigillo guard process not started: {error}")))
        .ok()?;
    let written = child.stdin.as_mut().map(|stdin| stdin.write_all(config.lines().as_bytes()).and_then(|_| stdin.flush()));
    if !matches!(written, Some(Ok(()))) {
        let _ = child.kill();
        crate::warn("sigillo guard process not started: it could not be told what to watch");
        return None;
    }
    Some(child)
}

/// The guard itself, in the process `start` started. Never returns.
pub(crate) fn run() -> ! {
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let Some(config) = GuardConfig::read(&mut input) else { std::process::exit(0) };
    drop(input);
    // The agent is gone when its end of our standard input closes.
    thread::spawn(|| {
        let mut rest = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut rest);
        std::process::exit(0);
    });
    let transport = Transport::new(&config.api_key, Duration::from_secs(10));
    let mut was = ModelState::None;
    loop {
        thread::sleep(config.period);
        if let Some(probe) = &config.probe {
            let now = model_state(probe);
            if now == ModelState::Open && was != ModelState::Open {
                say_open(&transport, &config.receipts);
                if !config.keep {
                    eprintln!("sigillo: the local model answers without the sigillo key: ending the agent");
                    end(config.target);
                    std::process::exit(0);
                }
            }
            was = now;
        }
        let now = config.program.as_ref().and_then(hash_of_file);
        if config.program.is_some() && now != config.program_hash {
            let hash = now.map(|hash| format!("\"{hash}\"")).unwrap_or_else(|| "null".into());
            let beat = format!("{{\"session\":\"{}\",\"event\":\"beat\",\"script_hash\":{hash}}}", config.session);
            let _ = transport.post(&config.url, &beat);
            eprintln!("sigillo: the agent's program changed: ending the agent");
            end(config.target);
            std::process::exit(0);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ModelState {
    /// Answers a request that carries no key.
    Open,
    /// Asks for one.
    Closed,
    /// Nothing answers there.
    None,
}

/// Whether the local model at `base` answers without the sigillo key.
pub(crate) fn model_state(base: &str) -> ModelState {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(2)))
        .http_status_as_error(false)
        .build()
        .into();
    match agent.get(&format!("{}/api/tags", base.trim_end_matches('/'))).call() {
        Ok(response) if matches!(response.status().as_u16(), 401 | 403) => ModelState::Closed,
        Ok(_) => ModelState::Open,
        Err(_) => ModelState::None,
    }
}

/// The receipt that says the model can be reached without sigillo.
pub(crate) fn say_open(transport: &Transport, receipts: &str) {
    let body = r#"{"actor":{"agent":"sigillo-guard"},"action":{"kind":"decision","name":"sigillo.local_model.open"},"outcome":"error"}"#;
    let _ = transport.post(receipts, body);
}

/// Ends a process by its id, the way each operating system allows from outside it.
pub(crate) fn end(pid: u32) {
    let status = if cfg!(windows) {
        Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    } else {
        Command::new("kill").args(["-9", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status()
    };
    if !matches!(status, Ok(done) if done.success()) {
        eprintln!("sigillo: the agent (process {pid}) could not be ended");
    }
}
