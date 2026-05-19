//! Async HTTP client for the VegaStack Pages REST API.
//!
//! Single `Client` per process (gzip+brotli+http2 negotiated by default);
//! retry-with-backoff on 5xx/429/network; structured `VpgError` on failure.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde_json::Value;

use crate::cli::Cli;
use crate::config::{read_stored_token, resolved_base_url};
use crate::errors::VpgError;

const USER_AGENT: &str = concat!("vpg/", env!("CARGO_PKG_VERSION"));
const REQUEST_TIMEOUT_SECS: u64 = 300;
const MAX_RETRIES: u8 = 3;

#[derive(Clone)]
pub struct Api {
    pub base_url: String,
    client: Client,
}

impl Api {
    pub fn new(cli: &Cli) -> Result<Self, VpgError> {
        let token = cli.token.clone().or_else(read_stored_token);
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(token) = &token {
            let value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| VpgError::auth("VPG_TOKEN contains invalid header characters"))?;
            headers.insert(AUTHORIZATION, value);
        }
        let client = Client::builder()
            .user_agent(USER_AGENT)
            .default_headers(headers)
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|e| VpgError::network(format!("failed to create HTTP client: {e}")))?;
        Ok(Self {
            base_url: resolved_base_url(cli),
            client,
        })
    }

    pub async fn get(&self, path: &str, params: &[(&str, String)]) -> Result<Value, VpgError> {
        let url = reqwest::Url::parse_with_params(&self.url(path), params)
            .map_err(|e| VpgError::validation(format!("invalid URL: {e}")))?;
        // GET is idempotent — safe to retry on 5xx, 429, and network errors.
        self.send(self.client.get(url), Retry::Idempotent).await
    }

    pub async fn post<T: Serialize>(&self, path: &str, body: &T) -> Result<Value, VpgError> {
        // POST may have already committed server-side before returning a 5xx,
        // so we MUST NOT retry it — duplicate writes (create_page,
        // create_comment, snapshot, attachment upload) would silently occur.
        // 429 still gets retried (no commit possible). (Audit cycle 5.)
        self.send(self.client.post(self.url(path)).json(body), Retry::NonIdempotent)
            .await
    }

    pub async fn put<T: Serialize>(&self, path: &str, body: &T) -> Result<Value, VpgError> {
        // PUT is idempotent per RFC 7231 — same key, same body, same result.
        self.send(self.client.put(self.url(path)).json(body), Retry::Idempotent)
            .await
    }

    pub async fn patch<T: Serialize>(&self, path: &str, body: &T) -> Result<Value, VpgError> {
        // PATCH is NOT defined as idempotent. Treat like POST.
        self.send(self.client.patch(self.url(path)).json(body), Retry::NonIdempotent)
            .await
    }

    pub async fn delete(&self, path: &str) -> Result<Value, VpgError> {
        // DELETE is idempotent in spirit (the resource is gone either way)
        // but several of our endpoints emit side-effects (review events,
        // audit logs, cache purges) on every call — treat as non-idempotent.
        self.send(self.client.delete(self.url(path)), Retry::NonIdempotent)
            .await
    }

    pub async fn download(&self, path: &str) -> Result<Vec<u8>, VpgError> {
        let response = self
            .client
            .get(self.url(path))
            .send()
            .await
            .map_err(|e| VpgError::network(e.to_string()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(VpgError::from_status(status, format!("download failed: HTTP {status}")));
        }
        response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| VpgError::network(e.to_string()))
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn send(
        &self,
        builder: reqwest::RequestBuilder,
        retry: Retry,
    ) -> Result<Value, VpgError> {
        let mut attempt: u8 = 0;
        loop {
            attempt += 1;
            // try_clone returns None for streaming bodies; we don't ship any
            // yet, but bail to a structured error instead of panicking.
            let Some(request) = builder.try_clone() else {
                return Err(VpgError::network(
                    "request body is not cloneable; cannot retry",
                ));
            };
            let response_result = request.send().await;
            match response_result {
                Ok(response) => {
                    let status = response.status();
                    let retryable_status = status == StatusCode::TOO_MANY_REQUESTS
                        || (status.is_server_error() && retry.allows_5xx());
                    if retryable_status && attempt < MAX_RETRIES {
                        backoff_sleep(attempt).await;
                        continue;
                    }
                    return Self::read_response(response).await;
                }
                Err(e) => {
                    let is_pre_send = e.is_timeout() || e.is_connect() || e.is_request();
                    // Pre-send errors (DNS failure, connect refused, TLS
                    // handshake fail) are always safe to retry — the request
                    // never reached the server, so no commit could have
                    // happened. Idempotent methods can additionally retry on
                    // mid-flight errors; non-idempotent methods cannot.
                    let retryable = is_pre_send || retry.allows_5xx();
                    if retryable && attempt < MAX_RETRIES {
                        backoff_sleep(attempt).await;
                        continue;
                    }
                    return Err(VpgError::network(e.to_string()));
                }
            }
        }
    }

    async fn read_response(response: reqwest::Response) -> Result<Value, VpgError> {
        let status = response.status();
        let text = response.text().await.map_err(|e| VpgError::network(e.to_string()))?;
        let value: Value = if text.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(&text)
                .map_err(|e| VpgError::network(format!("invalid JSON response: {e}")))?
        };
        if status.is_success() {
            Ok(value)
        } else {
            let error = value.get("error").unwrap_or(&value);
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("API_ERROR")
                .to_string();
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("request failed")
                .to_string();
            let details = error.get("details").cloned();
            Err(VpgError::from_api(status, code, message, details))
        }
    }
}

/// How aggressively a request may be retried. Idempotent methods can
/// retry on every recoverable failure including 5xx. Non-idempotent
/// methods retry only on pre-send errors and 429 (no commit possible).
#[derive(Clone, Copy, Debug)]
enum Retry {
    Idempotent,
    NonIdempotent,
}

impl Retry {
    /// Whether 5xx responses are eligible for retry. 429 is always retried
    /// regardless of this flag because the server explicitly says "try again".
    fn allows_5xx(self) -> bool {
        matches!(self, Retry::Idempotent)
    }
}

async fn backoff_sleep(attempt: u8) {
    // Exponential backoff: 250ms, 500ms, 1000ms. Real jitter (not the
    // previous deterministic `attempt * 37 % 100` which had every client
    // synchronizing). Uses the system clock as a cheap seed — we don't
    // need cryptographic randomness here.
    let base_ms: u64 = 250u64 * (1 << (attempt as u64 - 1));
    let jitter: u64 = {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64)
            .unwrap_or(0);
        nanos % 100
    };
    tokio::time::sleep(Duration::from_millis(base_ms + jitter)).await;
}

pub fn encode_query_component(value: &str) -> String {
    let mut buf = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                buf.push(byte as char)
            }
            _ => buf.push_str(&format!("%{byte:02X}")),
        }
    }
    buf
}

pub fn with_workspace_query(path: &str, workspace: &str) -> String {
    let sep = if path.contains('?') { '&' } else { '?' };
    format!("{path}{sep}workspace_id={}", encode_query_component(workspace))
}
