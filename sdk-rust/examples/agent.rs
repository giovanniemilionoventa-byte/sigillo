//! A small support agent, as a customer's would look with sigillo in it.
//!
//! ```text
//! SIGILLO_ENDPOINT=https://... SIGILLO_API_KEY=sigillo_... SIGILLO_SYSTEM_ID=acme-support-bot \
//!     cargo run --example agent -- A-1099
//! ```
//!
//! Its one tool looks an order up; the model it would ask is left out, since
//! a model call through sigillo's gateway is recorded by sigillo itself. What
//! reaches the server is the tool call with the digests of its input and
//! output, and the heartbeat: never the order, never the answer.
//! `SIGILLO_EXAMPLE_STAY=<seconds>` keeps it running that long afterwards,
//! for the end-to-end test of strict mode.

use std::time::Duration;

fn look_up(order: &str) -> Result<String, std::io::Error> {
    Ok(format!("l'ordine {order} è partito ieri con DHL"))
}

fn main() {
    let sigillo = sigillo::init_from_env().expect("sigillo");

    let order = std::env::args().nth(1).unwrap_or_else(|| "A-1099".to_string());
    let call = sigillo.tool("cerca_ordine");
    call.agent("agente-supporto").input(&format!("dov'è il mio ordine {order}?"));
    let answer = call.run(|| look_up(&order)).expect("the order");
    println!("{answer}");

    if let Some(seconds) = std::env::var("SIGILLO_EXAMPLE_STAY").ok().and_then(|seconds| seconds.parse().ok()) {
        sigillo.flush();
        std::thread::sleep(Duration::from_secs(seconds));
    }
}
