//! The heartbeat: every minute, busy or idle, the agent tells the server it is
//! still connected (docs/API.md, `POST /api/v1/heartbeat`).
//!
//! The server writes a receipt when the agent connects, closes, goes silent
//! without closing (the code removed, the process killed, the computer
//! switched off, the network cut) and comes back; an ordinary beat writes
//! nothing. The same protocol as the Python SDK's, beat for beat.
//!
//! Each beat also carries the SHA-256 of the agent's program, read again at
//! every beat. In Python that is the main script; here it is the compiled
//! executable, which holds the agent's code and this crate's together, so a
//! rebuilt or replaced program is written on the chain as
//! `sigillo.connection.script_changed`, exactly as an edited script is.

use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::digest::{canonical_string, hex, random_bytes, sha256_hex};
use crate::transport::Transport;

/// Three beats in a row that do not get through end a strict agent.
const STRICT_MISSED_BEATS: u32 = 3;

/// What strict mode does when the record cannot be kept: once, and only in strict mode.
pub(crate) struct Halt {
    strict: bool,
    on_halt: Option<Box<dyn Fn(&str) + Send + Sync>>,
    halted: AtomicBool,
}

impl Halt {
    pub(crate) fn new(strict: bool, on_halt: Option<Box<dyn Fn(&str) + Send + Sync>>) -> Halt {
        Halt { strict, on_halt, halted: AtomicBool::new(false) }
    }

    /// Whether strict mode ends the process by itself (no `on_halt` of the caller's own).
    pub(crate) fn ends_process(&self) -> bool {
        self.strict && self.on_halt.is_none()
    }

    pub(crate) fn halt(&self, reason: &str) {
        if !self.strict || self.halted.swap(true, Ordering::SeqCst) {
            return;
        }
        crate::warn(&format!("sigillo strict mode: {reason}"));
        match &self.on_halt {
            Some(on_halt) => on_halt(reason),
            None => halt_process(reason),
        }
    }
}

/// What strict mode does by default: say why on standard error and end the process, status 70.
pub(crate) fn halt_process(reason: &str) -> ! {
    eprintln!("sigillo: stopping this agent: {reason}");
    std::process::exit(70)
}

/// SHA-256 of a file's bytes, or `None` when it can no longer be read.
pub(crate) fn hash_of_file(path: &PathBuf) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| sha256_hex(&bytes))
}

/// The program whose hash the beats carry: this process's executable.
pub(crate) fn this_program() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

pub(crate) struct Heartbeat {
    pub(crate) session: String,
    stop: Mutex<Option<Sender<()>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
    beat: Arc<Beat>,
}

/// What one beat needs, shared by the heartbeat's thread and `close`.
pub(crate) struct Beat {
    pub(crate) transport: Transport,
    pub(crate) url: String,
    pub(crate) session: String,
    pub(crate) program: Option<PathBuf>,
    pub(crate) show: bool,
    pub(crate) halt: Arc<Halt>,
    pub(crate) guard: Mutex<Option<Child>>,
    missed: AtomicU32,
}

impl Heartbeat {
    pub(crate) fn start(
        transport: Transport,
        url: String,
        program: Option<PathBuf>,
        interval: Duration,
        show: bool,
        halt: Arc<Halt>,
        guard: impl FnOnce(&str) -> Option<Child>,
    ) -> Heartbeat {
        let session = hex(&random_bytes::<16>());
        let beat = Arc::new(Beat {
            transport,
            url,
            session: session.clone(),
            program,
            show,
            halt,
            guard: Mutex::new(None),
            missed: AtomicU32::new(0),
        });
        // Strict mode that ends the process by itself also starts the guard
        // process (guard.rs); an `on_halt` of the caller's own replaces how the
        // agent is stopped, so there is nothing for a guard to kill.
        if beat.halt.ends_process() {
            *beat.guard.lock().unwrap() = guard(&session);
        }
        let (stop, stopped) = mpsc::channel::<()>();
        let running = Arc::clone(&beat);
        let thread = thread::Builder::new()
            .name("sigillo-heartbeat".into())
            .spawn(move || {
                running.send("start");
                loop {
                    match stopped.recv_timeout(interval) {
                        Err(RecvTimeoutError::Timeout) => running.send("beat"),
                        _ => return,
                    }
                }
            })
            .expect("the sigillo heartbeat thread could not start");
        Heartbeat { session, stop: Mutex::new(Some(stop)), thread: Mutex::new(Some(thread)), beat }
    }

    /// Tells the server the agent closed normally. Once; later calls do nothing.
    pub(crate) fn close(&self) {
        let Some(stop) = self.stop.lock().unwrap().take() else { return };
        let _ = stop.send(());
        if let Some(thread) = self.thread.lock().unwrap().take() {
            // The thread may be in the middle of a beat; it never takes longer than the transport's timeout.
            let _ = thread.join();
        }
        self.beat.send("stop");
        // The guard ends when its standard input closes.
        if let Some(mut guard) = self.beat.guard.lock().unwrap().take() {
            drop(guard.stdin.take());
            let _ = guard.wait();
        }
    }
}

impl Beat {
    fn send(&self, event: &str) {
        let mut payload = format!("{{\"session\":\"{}\",\"event\":\"{event}\"", self.session);
        if event != "stop" {
            if let Some(program) = &self.program {
                let hash = hash_of_file(program).map(|hash| format!("\"{hash}\"")).unwrap_or_else(|| "null".into());
                payload.push_str(&format!(",\"script_hash\":{hash}"));
            }
            let gone = match self.guard.lock().unwrap().as_mut() {
                Some(guard) => !matches!(guard.try_wait(), Ok(None)),
                None => false,
            };
            if gone {
                self.halt.halt("the sigillo guard process is no longer running");
            }
        }
        payload.push('}');
        if self.show {
            crate::show_sent("heartbeat", &payload);
        }
        match self.transport.post(&self.url, &payload) {
            Ok((status, answer)) if (200..300).contains(&status) => {
                self.missed.store(0, Ordering::SeqCst);
                if says_true(&answer, "script_changed") {
                    self.halt.halt("this agent's program is not the one it started with");
                }
            }
            outcome => {
                let why = match outcome {
                    Ok((status, _)) => format!("status {status}"),
                    Err(error) => error,
                };
                crate::warn(&format!("sigillo heartbeat {} not delivered: {why}", canonical_string(event)));
                if event != "stop" {
                    let missed = self.missed.fetch_add(1, Ordering::SeqCst) + 1;
                    if missed >= STRICT_MISSED_BEATS {
                        self.halt.halt(&format!("sigillo could not record for {missed} heartbeats in a row"));
                    }
                }
            }
        }
    }
}

/// Whether a JSON answer carries `"<name>": true` at its top level. The
/// server's answers are small objects it writes itself; this reads the one
/// member that matters without a JSON library.
pub(crate) fn says_true(answer: &str, name: &str) -> bool {
    let needle = format!("\"{name}\"");
    let Some(at) = answer.find(&needle) else { return false };
    let rest = answer[at + needle.len()..].trim_start();
    let Some(rest) = rest.strip_prefix(':') else { return false };
    rest.trim_start().starts_with("true")
}
