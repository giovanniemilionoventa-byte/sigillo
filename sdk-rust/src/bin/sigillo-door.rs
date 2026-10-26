//! The door in front of a local model, on its own: see `sigillo::door`.
//!
//! ```text
//! sigillo-door --endpoint https://... --system-id ... --upstream http://127.0.0.1:11435 --serve
//! ```
//!
//! The key is read from `--api-key` or, better, from SIGILLO_API_KEY.

fn main() {
    let mut endpoint = None;
    let mut system_id = None;
    let mut api_key = std::env::var("SIGILLO_API_KEY").ok();
    let mut upstream = None;
    let mut port: u16 = 11434;
    let mut serve = false;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--endpoint" => endpoint = arguments.next(),
            "--system-id" => system_id = arguments.next(),
            "--api-key" => api_key = arguments.next(),
            "--upstream" => upstream = arguments.next(),
            "--port" => port = arguments.next().and_then(|port| port.parse().ok()).unwrap_or_else(|| fail("--port is a number")),
            "--serve" => serve = true,
            "--help" | "-h" => {
                println!("usage: sigillo-door --endpoint URL --system-id ID --upstream URL [--port 11434] [--serve] [--api-key KEY]");
                return;
            }
            other => fail(&format!("unknown argument {other}")),
        }
    }
    let endpoint = endpoint.unwrap_or_else(|| fail("--endpoint is required"));
    let system_id = system_id.unwrap_or_else(|| fail("--system-id is required"));
    let api_key = api_key.filter(|key| !key.is_empty()).unwrap_or_else(|| fail("the key is missing (--api-key or SIGILLO_API_KEY)"));
    let upstream = upstream.unwrap_or_else(|| fail("--upstream is required"));
    let server = sigillo::door::server_name(port);
    if serve && server != "ollama" && server != "local-model" {
        fail("--serve starts only ollama; start the model yourself at the --upstream address");
    }
    let model = if serve { sigillo::door::serve_model(&upstream).unwrap_or_else(|why| fail(&why)) } else { None };
    let sigillo = sigillo::init(sigillo::Config::new(&endpoint, &api_key, &system_id)).unwrap_or_else(|error| fail(&error.to_string()));
    println!("sigillo door: 127.0.0.1:{port} -> {upstream}");
    let result = sigillo::door::serve(sigillo, api_key, port, upstream);
    if let Some(mut model) = model {
        let _ = model.kill();
    }
    if let Err(error) = result {
        fail(&format!("cannot listen on 127.0.0.1:{port}: {error}"));
    }
}

fn fail(message: &str) -> ! {
    eprintln!("sigillo door: {message}");
    std::process::exit(2)
}
