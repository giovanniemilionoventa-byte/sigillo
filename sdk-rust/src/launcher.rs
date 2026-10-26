//! `sigillo-run`: an agent that is already compiled, connected without
//! changing its code.
//!
//! ```text
//! sigillo-run --env-file sigillo.env [--strict] [--watch FILE] -- ./my-agent --its --own --arguments
//! ```
//!
//! The launcher reads the settings (`SIGILLO_ENDPOINT`, `SIGILLO_API_KEY`,
//! `SIGILLO_SYSTEM_ID`, and the model gateway's variables, such as
//! `OPENAI_BASE_URL` and `OPENAI_API_KEY`) from the file the console gives,
//! or from the environment, and starts the agent with them. For as long as
//! the agent runs, it sends the heartbeat for it, with the SHA-256 of the
//! agent's executable (or of `--watch`, for an agent run by an interpreter),
//! so that an agent that stopped, or whose program changed, is written on
//! the chain as it would be with the crate inside it. With `--strict`, the
//! launcher checks the program every few seconds and ends the agent, status
//! 70, when it changes or when three beats in a row do not get through.
//!
//! What it cannot do from outside the program: record the agent's own tool
//! calls. Its model calls are recorded by the gateway, when the gateway's
//! variables are in the file and the provider's real key is not given to the
//! agent any other way.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::heartbeat::hash_of_file;
use crate::{guard, Config};

const USAGE: &str = "usage: sigillo-run [--env-file FILE] [--strict] [--watch FILE] [--show-sent] -- PROGRAM [ARGUMENTS...]";

/// Runs the launcher with these arguments (without the launcher's own name); the exit status.
pub fn main(arguments: Vec<String>) -> i32 {
    let mut env_file = None;
    let mut strict = false;
    let mut show = false;
    let mut watch = None;
    let mut rest = arguments.into_iter();
    let mut command = Vec::new();
    while let Some(argument) = rest.next() {
        match argument.as_str() {
            "--env-file" => env_file = rest.next(),
            "--strict" => strict = true,
            "--show-sent" => show = true,
            "--watch" => watch = rest.next().map(PathBuf::from),
            "--help" | "-h" => {
                println!("{USAGE}");
                return 0;
            }
            "--" => {
                command.extend(rest.by_ref());
                break;
            }
            other if other.starts_with("--") => {
                eprintln!("sigillo-run: unknown option {other}\n{USAGE}");
                return 2;
            }
            _ => {
                command.push(argument);
                command.extend(rest.by_ref());
                break;
            }
        }
    }
    let Some(program) = command.first().cloned() else {
        eprintln!("{USAGE}");
        return 2;
    };

    let mut settings: BTreeMap<String, String> = BTreeMap::new();
    if let Some(path) = &env_file {
        match std::fs::read_to_string(path) {
            Ok(text) => settings.extend(parse_env_file(&text)),
            Err(error) => {
                eprintln!("sigillo-run: cannot read {path}: {error}");
                return 2;
            }
        }
    }
    let setting = |name: &str| settings.get(name).cloned().or_else(|| std::env::var(name).ok()).filter(|value| !value.is_empty());
    let (Some(endpoint), Some(api_key), Some(system_id)) = (setting("SIGILLO_ENDPOINT"), setting("SIGILLO_API_KEY"), setting("SIGILLO_SYSTEM_ID")) else {
        eprintln!("sigillo-run: SIGILLO_ENDPOINT, SIGILLO_API_KEY and SIGILLO_SYSTEM_ID are needed, in --env-file or in the environment");
        return 2;
    };
    let strict = strict || matches!(setting("SIGILLO_STRICT").as_deref(), Some("1") | Some("true") | Some("yes"));

    let watched = watch.or_else(|| find_program(&program));
    let Some(watched) = watched else {
        eprintln!("sigillo-run: {program} was not found");
        return 127;
    };

    // The agent gets every setting in the file; it never needs the sigillo
    // ones, but a program of the customer's may read them, and the gateway's
    // are the reason the file exists.
    let mut child = match Command::new(&program).args(&command[1..]).envs(&settings).stdin(Stdio::inherit()).spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("sigillo-run: {program} could not start: {error}");
            return 127;
        }
    };
    let pid = child.id();
    let on_halt = move |reason: &str| {
        eprintln!("sigillo-run: stopping the agent: {reason}");
        guard::end(pid);
        std::process::exit(70);
    };
    let mut config = Config::new(&endpoint, &api_key, &system_id).strict(strict).show_sent(show).on_halt(on_halt);
    if let Some(key) = setting("SIGILLO_CUSTOMER_KEY") {
        config = config.customer_key(key.as_bytes());
    }
    let sigillo = match crate::start_watching(config, Some(watched.clone()), pid) {
        Ok(sigillo) => sigillo,
        Err(error) => {
            eprintln!("sigillo-run: {error}");
            guard::end(pid);
            return 2;
        }
    };

    let started = hash_of_file(&watched);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => break child.wait().expect("the agent's status"),
        }
        thread::sleep(Duration::from_millis(500));
        // Strict: what the guard process does beside an agent with the crate
        // inside it, done here, since the launcher is already a process apart.
        if strict && hash_of_file(&watched) != started {
            sigillo.flush();
            let transport = crate::transport::Transport::new(&api_key, Duration::from_secs(10));
            let hash = hash_of_file(&watched).map(|hash| format!("\"{hash}\"")).unwrap_or_else(|| "null".into());
            let session = sigillo.session().unwrap_or_default().to_string();
            let beat = format!("{{\"session\":\"{session}\",\"event\":\"beat\",\"script_hash\":{hash}}}");
            let _ = transport.post(&format!("{}/api/v1/heartbeat", sigillo.endpoint()), &beat);
            eprintln!("sigillo-run: the agent's program changed: ending the agent");
            guard::end(pid);
            std::process::exit(70);
        }
    };
    sigillo.shutdown();
    status.code().unwrap_or(1)
}

/// `NAME=value` lines; blank lines and `#` comments are skipped, and a value
/// may be quoted. `export NAME=value` is read too, so the file can be sourced
/// by a shell as well.
pub fn parse_env_file(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let line = line.strip_prefix("export ").unwrap_or(line);
            let (name, value) = line.split_once('=')?;
            let value = value.trim();
            let value = value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .or_else(|| value.strip_prefix('\'').and_then(|value| value.strip_suffix('\'')))
                .unwrap_or(value);
            Some((name.trim().to_string(), value.to_string()))
        })
        .collect()
}

/// The file a program name runs: itself when it names a path, otherwise the
/// first match on `PATH` (with Windows' extensions).
fn find_program(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.components().count() > 1 || path.is_absolute() {
        return path.is_file().then(|| path.to_path_buf());
    }
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into()).split(';').map(str::to_string).collect()
    } else {
        vec![String::new()]
    };
    let directories = std::env::var_os("PATH")?;
    for directory in std::env::split_paths(&directories) {
        for extension in &extensions {
            let candidate = directory.join(format!("{program}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    path.is_file().then(|| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_env_file_is_read_as_a_shell_would() {
        let text = "# sigillo\nSIGILLO_ENDPOINT=https://s.example\nexport OPENAI_API_KEY=\"sigillo_x\"\n\nOPENAI_BASE_URL='https://s.example/llm/openai/v1'\n";
        assert_eq!(
            parse_env_file(text),
            vec![
                ("SIGILLO_ENDPOINT".to_string(), "https://s.example".to_string()),
                ("OPENAI_API_KEY".to_string(), "sigillo_x".to_string()),
                ("OPENAI_BASE_URL".to_string(), "https://s.example/llm/openai/v1".to_string()),
            ]
        );
    }
}
