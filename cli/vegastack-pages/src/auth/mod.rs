//! Authentication: device-code flow + file-backed token storage.
//!
//! Token storage lives in `~/.config/vegastack-pages/token` with 0600
//! permissions on Unix. Native OS keychain integration (macOS Keychain
//! / Windows Credential Manager) is a future addition via the `keyring`
//! crate — the file fallback is the only path today.

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::api::Api;
use crate::cli::Cli;
use crate::errors::VpgError;

#[derive(Debug, Deserialize)]
pub struct DeviceAuthResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
    #[serde(default = "default_device_expires")]
    pub expires_in: u64,
    #[serde(default = "default_device_interval")]
    pub interval: u64,
}

fn default_device_expires() -> u64 { 900 }
fn default_device_interval() -> u64 { 5 }

#[derive(Debug, Deserialize)]
pub struct DeviceTokenSuccess {
    pub access_token: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OAuthErrorBody {
    pub error: String,
    #[serde(default)]
    pub error_description: Option<String>,
}

pub async fn device_authorize(_cli: &Cli, api: &Api) -> Result<DeviceAuthResponse, VpgError> {
    let value = api
        .post("/oauth/device/authorize", &json!({ "client_id": "vpg-cli" }))
        .await?;
    serde_json::from_value(value)
        .map_err(|e| VpgError::generic(format!("invalid device-authorize response: {e}")))
}

pub async fn poll_device_token(
    api: &Api,
    device_code: &str,
    interval: u64,
    expires_in: u64,
) -> Result<DeviceTokenSuccess, VpgError> {
    let started = std::time::Instant::now();
    let deadline = Duration::from_secs(expires_in);
    let mut wait = Duration::from_secs(interval.max(1));
    loop {
        if started.elapsed() > deadline {
            return Err(VpgError::auth("device code expired before authorization"));
        }
        tokio::time::sleep(wait).await;
        let res = api
            .post(
                "/oauth/device/token",
                &json!({
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                    "device_code": device_code,
                    "client_id": "vpg-cli",
                }),
            )
            .await;
        match res {
            Ok(value) => {
                if let Ok(success) = serde_json::from_value::<DeviceTokenSuccess>(value.clone()) {
                    return Ok(success);
                }
                if let Ok(err) = serde_json::from_value::<OAuthErrorBody>(value) {
                    match err.error.as_str() {
                        "authorization_pending" => {}
                        "slow_down" => wait += Duration::from_secs(5),
                        "expired_token" => {
                            return Err(VpgError::auth("device code expired"));
                        }
                        "access_denied" => {
                            return Err(VpgError::auth("authorization denied"));
                        }
                        other => {
                            return Err(VpgError::auth(format!(
                                "device flow error: {other}{}",
                                err.error_description
                                    .map(|d| format!(" ({d})"))
                                    .unwrap_or_default()
                            )));
                        }
                    }
                }
            }
            Err(e) => {
                // Surface non-OAuth API errors as auth failures.
                if e.code() == "VPG_AUTH" || e.code() == "VPG_VALIDATION" {
                    return Err(e);
                }
            }
        }
    }
}

pub fn try_open_browser(url: &str) -> bool {
    let cmd = if cfg!(target_os = "macos") {
        ("open", vec![url])
    } else if cfg!(target_os = "windows") {
        ("cmd", vec!["/C", "start", "", url])
    } else {
        ("xdg-open", vec![url])
    };
    std::process::Command::new(cmd.0)
        .args(&cmd.1)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
