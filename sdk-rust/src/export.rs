//! Sends finished spans to the server's `/v1/traces`, from a thread of its own.
//!
//! What the Python SDK's BatchSpanProcessor and OTLP exporter do together: a
//! span is queued when it ends, and the queue goes out in one request every
//! couple of seconds, or at once when it fills up, on `flush` and on
//! `shutdown`. A request the server could not take (no answer, 429, a 5xx:
//! the signer away, a write that failed) is sent again, a few times, with a
//! growing pause; the server recognises a span it already has, so a resent
//! batch is never written twice. One it refused (a 4xx) is not sent again.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::span::{export_request, Span};
use crate::transport::Transport;

const BATCH: usize = 256;
const EVERY: Duration = Duration::from_secs(2);
const RETRIES: u32 = 5;

pub(crate) enum Message {
    Span(Box<Span>),
    Flush(Sender<bool>),
    Stop(Sender<bool>),
}

pub(crate) struct Exporter {
    sender: Sender<Message>,
    thread: Option<JoinHandle<()>>,
}

impl Exporter {
    pub(crate) fn start(transport: Transport, url: String, resource: Vec<(String, String)>, show: bool) -> Exporter {
        let (sender, receiver) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("sigillo-export".into())
            .spawn(move || run(receiver, transport, url, resource, show))
            .expect("the sigillo export thread could not start");
        Exporter { sender, thread: Some(thread) }
    }

    pub(crate) fn sender(&self) -> Sender<Message> {
        self.sender.clone()
    }

    /// Sends what is queued; true when all of it got through in time.
    pub(crate) fn flush(&self, timeout: Duration) -> bool {
        let (answer, wait) = mpsc::channel();
        if self.sender.send(Message::Flush(answer)).is_err() {
            return false;
        }
        wait.recv_timeout(timeout).unwrap_or(false)
    }

    /// Sends what is queued and ends the thread.
    pub(crate) fn stop(&mut self, timeout: Duration) -> bool {
        let (answer, wait) = mpsc::channel();
        if self.sender.send(Message::Stop(answer)).is_err() {
            return false;
        }
        let sent = wait.recv_timeout(timeout).unwrap_or(false);
        if let Some(thread) = self.thread.take() {
            if sent {
                let _ = thread.join();
            }
        }
        sent
    }
}

fn run(receiver: Receiver<Message>, transport: Transport, url: String, resource: Vec<(String, String)>, show: bool) {
    let mut queue: Vec<Span> = Vec::new();
    let mut due = Instant::now() + EVERY;
    loop {
        let wait = due.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(wait) {
            Ok(Message::Span(span)) => {
                if show {
                    crate::show_sent("action", &span.shown());
                }
                queue.push(*span);
                if queue.len() >= BATCH {
                    send(&transport, &url, &resource, &mut queue);
                }
            }
            Ok(Message::Flush(answer)) => {
                let _ = answer.send(send(&transport, &url, &resource, &mut queue));
            }
            Ok(Message::Stop(answer)) => {
                let _ = answer.send(send(&transport, &url, &resource, &mut queue));
                return;
            }
            Err(RecvTimeoutError::Timeout) => {
                send(&transport, &url, &resource, &mut queue);
                due = Instant::now() + EVERY;
            }
            // Every handle is gone: whatever is left goes out, and the thread ends.
            Err(RecvTimeoutError::Disconnected) => {
                send(&transport, &url, &resource, &mut queue);
                return;
            }
        }
    }
}

/// One batch, sent until it gets through or there is no point; the queue is emptied either way.
fn send(transport: &Transport, url: &str, resource: &[(String, String)], queue: &mut Vec<Span>) -> bool {
    if queue.is_empty() {
        return true;
    }
    let body = export_request(resource, queue);
    queue.clear();
    let mut pause = Duration::from_millis(500);
    for attempt in 0..=RETRIES {
        match transport.post(url, &body) {
            Ok((status, _)) if (200..300).contains(&status) => return true,
            Ok((status, _)) if status != 429 && (400..500).contains(&status) => {
                crate::warn(&format!("sigillo: the server refused {} action(s) ({status}); they are not sent again", count(&body)));
                return false;
            }
            _ if attempt < RETRIES => {
                thread::sleep(pause);
                pause *= 2;
            }
            _ => {}
        }
    }
    crate::warn("sigillo: actions not delivered after several attempts");
    false
}

fn count(body: &str) -> usize {
    body.matches("\"spanId\"").count()
}
