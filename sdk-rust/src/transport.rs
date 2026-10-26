//! The one HTTP client the crate uses, with the sigillo key on every request.

use std::time::Duration;

#[derive(Clone)]
pub(crate) struct Transport {
    agent: ureq::Agent,
    authorization: String,
}

impl Transport {
    pub(crate) fn new(api_key: &str, timeout: Duration) -> Transport {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            // A 4xx or 5xx is an answer to read, not an error.
            .http_status_as_error(false)
            .user_agent(concat!("sigillo-rust/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Transport { agent, authorization: format!("Bearer {api_key}") }
    }

    /// POSTs a JSON body; the answer's status and body, or why there was none.
    pub(crate) fn post(&self, url: &str, body: &str) -> Result<(u16, String), String> {
        let mut response = self
            .agent
            .post(url)
            .header("Authorization", &self.authorization)
            .header("Content-Type", "application/json")
            .send(body)
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().unwrap_or_default();
        Ok((status, text))
    }
}
