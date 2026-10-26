//! The whole path, with every process that runs in production.
//!
//! A real signer holding a real key, a real server, this crate inside a Rust
//! agent, and the open-source verifier checking the export afterwards. The
//! same harness as sdk-python/tests/test_end_to_end.py. Nothing is stubbed.
//!
//! Skipped when the Node packages have not been built (`pnpm build`), so that
//! `cargo test` still works on its own. The export is read with Python's
//! zipfile, an independent reader, as the Python test does.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use sigillo::digest::sha256_hex;
use sigillo::{nonce_for, ArtifactRole, Config, Role};

const SYSTEM: &str = "acme-rust-bot";

fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn built(relative: &str) -> PathBuf {
    repository().join(relative)
}

/// Why the test cannot run here, if it cannot.
fn missing() -> Option<String> {
    if Command::new("node").arg("--version").output().is_err() {
        return Some("node is not on the PATH".into());
    }
    if Command::new("python3").arg("--version").output().is_err() {
        return Some("python3 is not on the PATH".into());
    }
    for path in ["apps/signer/dist/cli.js", "apps/server/dist/cli.js", "packages/verifier/dist/cli.js"] {
        if !built(path).exists() {
            return Some(format!("{path} is missing: run pnpm build first"));
        }
    }
    None
}

struct Stack {
    work: PathBuf,
    db: PathBuf,
    socket: PathBuf,
    port: u16,
    token: String,
    processes: Vec<Child>,
}

impl Drop for Stack {
    fn drop(&mut self) {
        for process in &mut self.processes {
            let _ = process.kill();
            let _ = process.wait();
        }
        let _ = std::fs::remove_dir_all(&self.work);
    }
}

fn run(command: &mut Command) -> String {
    let output = command.current_dir(repository()).output().unwrap();
    assert!(output.status.success(), "{command:?}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}

fn node(script: &str) -> Command {
    let mut command = Command::new("node");
    command.arg(built(script));
    command
}

fn wait_for(what: &str, ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !ready() {
        assert!(Instant::now() < deadline, "{what} did not come up in time");
        thread::sleep(Duration::from_millis(200));
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

impl Stack {
    fn start(name: &str) -> Stack {
        let work = std::env::temp_dir().join(format!("sigillo-rust-e2e-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();
        let (key, socket, db) = (work.join("signer.key"), work.join("signer.sock"), work.join("sigillo.db"));
        let mut stack = Stack { work: work.clone(), db: db.clone(), socket: socket.clone(), port: free_port(), token: String::new(), processes: Vec::new() };
        run(node("apps/signer/dist/cli.js").args(["keygen", "--key"]).arg(&key));
        stack.spawn(node("apps/signer/dist/cli.js").args(["serve", "--key"]).arg(&key).arg("--socket").arg(&socket).arg("--state").arg(work.join("signer-state")));
        wait_for("the signer's socket", || socket.exists());
        run(node("apps/server/dist/cli.js").args(["system", "create", SYSTEM, "--db"]).arg(&db).arg("--signer-socket").arg(&socket));
        let issued = run(node("apps/server/dist/cli.js").args(["key", "create", SYSTEM, "--db"]).arg(&db));
        stack.token = issued.trim().lines().last().unwrap().to_string();
        assert!(stack.token.starts_with("sigillo_"));
        let port = stack.port.to_string();
        stack.spawn(
            node("apps/server/dist/cli.js")
                .args(["serve", "--db"])
                .arg(&db)
                .arg("--signer-socket")
                .arg(&socket)
                .args(["--port", &port])
                .env("SIGILLO_SCRIPT_GUARD", "all"),
        );
        let address = format!("127.0.0.1:{}", stack.port);
        wait_for("the server", || std::net::TcpStream::connect(&address).is_ok());
        stack
    }

    fn spawn(&mut self, command: &mut Command) {
        let child = command.current_dir(repository()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        self.processes.push(child);
    }

    fn endpoint(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The system's export, and its receipts as the independent zip reader reads them.
    fn export(&self, name: &str) -> (PathBuf, Vec<Value>) {
        let export = self.work.join(format!("{name}.zip"));
        run(node("apps/server/dist/cli.js")
            .args(["export", SYSTEM, "--db"])
            .arg(&self.db)
            .arg("--signer-socket")
            .arg(&self.socket)
            .arg("--out")
            .arg(&export));
        let text = run(Command::new("python3").args(["-I", "-c", "import sys, zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read('receipts.jsonl').decode())"]).arg(&export));
        (export, text.lines().filter(|line| !line.is_empty()).map(|line| serde_json::from_str(line).unwrap()).collect())
    }

    fn names(&self) -> Vec<String> {
        self.export("names").1.iter().map(|receipt| receipt["action"]["name"].as_str().unwrap().to_string()).collect()
    }
}

fn verify(export: &Path) -> String {
    run(node("packages/verifier/dist/cli.js").arg(export).arg("--quiet"))
}

#[test]
fn a_rust_agent_produces_a_verifiable_chain_with_digests_only() {
    if let Some(why) = missing() {
        eprintln!("skipped: {why}");
        return;
    }
    let stack = Stack::start("chain");
    let customer_key = "e2e-rust-".to_string() + &"7c".repeat(28);
    let content = "Maria Bianchi chiede il rimborso dell'ordine A-1099";
    let document = "il contenuto esatto del curriculum\r\ndi un candidato di prova,  per un test\r\n";

    let sigillo = sigillo::init(Config::new(&stack.endpoint(), &stack.token, SYSTEM).customer_key(&customer_key)).unwrap();
    let call = sigillo.tool("rimborso");
    call.agent("agente-rust").input(content).output("rimborso approvato");
    call.artifact(document.as_bytes(), ArtifactRole::Input, Some("curriculum"), "text/plain");
    let (trace_id, span_id) = call.ids();
    call.ok();
    let failed: Result<(), std::io::Error> = sigillo.tool("scrivi_file").run(|| Err(std::io::Error::other("/home/maria/cv.pdf")));
    assert!(failed.is_err());
    assert!(sigillo.flush());
    sigillo.shutdown();

    let (export, receipts) = stack.export("fascicolo");
    assert_eq!(receipts[0]["action"]["kind"], "genesis");
    for (index, receipt) in receipts.iter().enumerate() {
        assert_eq!(receipt["seq"], index);
        assert_eq!(receipt["system_id"], SYSTEM);
    }
    let names: Vec<&str> = receipts.iter().map(|receipt| receipt["action"]["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"sigillo.connection.start"), "{names:?}");
    assert!(names.contains(&"sigillo.connection.stop"), "{names:?}");

    let refund = receipts.iter().find(|receipt| receipt["action"]["name"] == "rimborso").unwrap();
    assert_eq!(refund["action"]["kind"], "tool_call");
    assert_eq!(refund["actor"]["agent"], "agente-rust");
    assert_eq!(refund["outcome"], "ok");
    assert_eq!(refund["v"], 4);
    assert_eq!(refund["input_hash_scheme"], "salted");
    assert_eq!(refund["output_hash_scheme"], "salted");
    assert_eq!(refund["source"]["trace_id"], trace_id.as_str());
    assert_eq!(refund["source"]["span_id"], span_id.as_str());
    assert_eq!(refund["artifacts"][0]["sha256"], sha256_hex(document.as_bytes()).as_str());
    assert_eq!(
        refund["artifacts"][0]["text"]["sha256"],
        sha256_hex("il contenuto esatto del curriculum di un candidato di prova, per un test".as_bytes()).as_str()
    );
    let failure = receipts.iter().find(|receipt| receipt["action"]["name"] == "scrivi_file").unwrap();
    assert_eq!(failure["outcome"], "error");

    // Nothing the agent said is in the record, nor anywhere in the server's files.
    let record: String = receipts.iter().map(Value::to_string).collect();
    let nonce = nonce_for(customer_key.as_bytes(), &trace_id, &span_id, Role::Input).unwrap();
    let stored: Vec<u8> = std::fs::read_dir(&stack.work)
        .unwrap()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("sigillo.db"))
        .flat_map(|entry| std::fs::read(entry.path()).unwrap())
        .collect();
    let stored = String::from_utf8_lossy(&stored);
    for secret in [content, "A-1099", "rimborso approvato", "curriculum\r\n", "/home/maria", nonce.as_str(), customer_key.as_str()] {
        assert!(!record.contains(secret), "{secret} is in the record");
        assert!(!stored.contains(secret), "{secret} is in the server's database");
    }

    let verdict = verify(&export);
    assert!(verdict.contains("OK"), "{verdict}");
    assert!(verdict.contains(&format!("{} receipts", receipts.len())), "{verdict}");

    // The customer, with the key, opens the digest with the open-source verifier.
    let seq = refund["seq"].as_u64().unwrap().to_string();
    let opened = run(node("packages/verifier/dist/cli.js").arg("open").arg(&export).args([seq.as_str(), "input", "--text", content, "--nonce", &nonce]));
    assert!(opened.contains("MATCH"), "{opened}");
}

/// Builds the example agent with the cargo that runs these tests, and
/// copies it where the test can replace it: the program being watched.
fn example_agent(into: &Path) -> PathBuf {
    let status = Command::new(env!("CARGO"))
        .args(["build", "--quiet", "--example", "agent"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .unwrap();
    assert!(status.success());
    let target = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
    let built = target.join("debug").join("examples").join(format!("agent{}", std::env::consts::EXE_SUFFIX));
    let copy = into.join(format!("agente{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(built, &copy).unwrap();
    copy
}

/// Replaces a program on disk the way a rebuild does: a new file renamed over the old.
fn replace(program: &Path) {
    let mut bytes = std::fs::read(program).unwrap();
    bytes.extend_from_slice(b"\0rebuilt");
    let next = program.with_extension("next");
    std::fs::write(&next, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::rename(next, program).unwrap();
}

fn finished(child: &mut Child, within: Duration) -> Option<Output> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() {
            let mut stderr = String::new();
            if let Some(mut pipe) = child.stderr.take() {
                use std::io::Read;
                let _ = pipe.read_to_string(&mut stderr);
            }
            return Some(Output { status: child.wait().unwrap(), stdout: Vec::new(), stderr: stderr.into_bytes() });
        }
        thread::sleep(Duration::from_millis(100));
    }
    None
}

#[test]
fn strict_mode_ends_an_agent_whose_program_was_replaced() {
    if let Some(why) = missing() {
        eprintln!("skipped: {why}");
        return;
    }
    let stack = Stack::start("strict");
    let program = example_agent(&stack.work);
    let mut agent = Command::new(&program)
        .env("SIGILLO_ENDPOINT", stack.endpoint())
        .env("SIGILLO_API_KEY", &stack.token)
        .env("SIGILLO_SYSTEM_ID", SYSTEM)
        .env("SIGILLO_STRICT", "1")
        .env("SIGILLO_EXAMPLE_STAY", "120")
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    wait_for("the agent's first receipts", || stack.names().iter().any(|name| name == "cerca_ordine"));
    assert!(stack.names().iter().any(|name| name == "sigillo.connection.start"));

    replace(&program);
    // The guard process checks every five seconds, and ends the agent.
    let ended = finished(&mut agent, Duration::from_secs(30));
    let Some(ended) = ended else {
        let _ = agent.kill();
        panic!("the agent was not ended after its program was replaced");
    };
    assert!(!ended.status.success());
    assert!(String::from_utf8_lossy(&ended.stderr).contains("program changed"), "{}", String::from_utf8_lossy(&ended.stderr));
    wait_for("the script_changed receipt", || stack.names().iter().any(|name| name == "sigillo.connection.script_changed"));
    let (export, _) = stack.export("strict");
    assert!(verify(&export).contains("OK"));
}

#[test]
fn the_launcher_connects_a_program_that_has_no_sigillo_in_it() {
    if let Some(why) = missing() {
        eprintln!("skipped: {why}");
        return;
    }
    let stack = Stack::start("launcher");
    // Any compiled program will do, one with no sigillo in it best: a copy of `sleep`.
    let sleep = ["/bin/sleep", "/usr/bin/sleep"].iter().map(PathBuf::from).find(|path| path.exists());
    let Some(sleep) = sleep else {
        eprintln!("skipped: no sleep program");
        return;
    };
    let program = stack.work.join("agente-compilato");
    std::fs::copy(&sleep, &program).unwrap();
    let env_file = stack.work.join("sigillo.env");
    std::fs::write(
        &env_file,
        format!("SIGILLO_ENDPOINT={}\nSIGILLO_API_KEY={}\nSIGILLO_SYSTEM_ID={SYSTEM}\nOPENAI_BASE_URL={}/llm/openai/v1\n", stack.endpoint(), stack.token, stack.endpoint()),
    )
    .unwrap();

    // A program that ends by itself: connected, then closed normally.
    let status = Command::new(env!("CARGO_BIN_EXE_sigillo-run"))
        .arg("--env-file")
        .arg(&env_file)
        .arg("--")
        .arg(&program)
        .arg("1")
        .status()
        .unwrap();
    assert!(status.success());
    let names = stack.names();
    assert!(names.contains(&"sigillo.connection.start".to_string()), "{names:?}");
    assert!(names.contains(&"sigillo.connection.stop".to_string()), "{names:?}");

    // Strict: the program replaced while it runs is written on the chain, and ended.
    let mut launcher = Command::new(env!("CARGO_BIN_EXE_sigillo-run"))
        .arg("--env-file")
        .arg(&env_file)
        .arg("--strict")
        .arg("--")
        .arg(&program)
        .arg("120")
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    wait_for("the second session", || stack.names().iter().filter(|name| *name == "sigillo.connection.start").count() >= 2);
    replace(&program);
    let Some(ended) = finished(&mut launcher, Duration::from_secs(30)) else {
        let _ = launcher.kill();
        panic!("the launcher did not end the agent");
    };
    assert_eq!(ended.status.code(), Some(70), "{}", String::from_utf8_lossy(&ended.stderr));
    wait_for("the script_changed receipt", || stack.names().iter().any(|name| name == "sigillo.connection.script_changed"));
}
