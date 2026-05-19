//! `VpgError` + exit-code mapping.
//!
//! Exit codes (agent mode parses on these):
//! - 1: generic
//! - 2: validation / bad input
//! - 3: authentication
//! - 4: not found
//! - 5: permission denied
//! - 6: conflict (e.g. version_id mismatch)
//! - 7: network
//! - 8: rate limited

use reqwest::StatusCode;
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum VpgError {
    #[error("{message}")]
    Generic { code: String, message: String, details: Option<Value> },
}

impl VpgError {
    pub fn generic(message: impl Into<String>) -> Self {
        Self::Generic {
            code: "VPG_ERROR".to_string(),
            message: message.into(),
            details: None,
        }
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::Generic {
            code: "VPG_VALIDATION".to_string(),
            message: message.into(),
            details: None,
        }
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::Generic {
            code: "VPG_AUTH".to_string(),
            message: message.into(),
            details: None,
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::Generic {
            code: "VPG_NOT_FOUND".to_string(),
            message: message.into(),
            details: None,
        }
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::Generic {
            code: "VPG_NETWORK".to_string(),
            message: message.into(),
            details: None,
        }
    }

    pub fn from_api(
        status: StatusCode,
        code: String,
        message: String,
        details: Option<Value>,
    ) -> Self {
        let mapped_code = match status.as_u16() {
            400 | 422 => "VPG_VALIDATION",
            401 => "VPG_AUTH",
            403 => "VPG_PERMISSION",
            404 => "VPG_NOT_FOUND",
            409 | 412 => "VPG_CONFLICT",
            429 => "VPG_RATE_LIMITED",
            500..=599 => "VPG_NETWORK",
            _ => code.as_str(),
        };
        Self::Generic {
            code: mapped_code.to_string(),
            message,
            details,
        }
    }

    pub fn from_status(status: StatusCode, message: String) -> Self {
        Self::from_api(status, "VPG_ERROR".to_string(), message, None)
    }

    pub fn code(&self) -> &str {
        match self {
            Self::Generic { code, .. } => code,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Generic { message, .. } => message,
        }
    }

    pub fn details(&self) -> Option<&Value> {
        match self {
            Self::Generic { details, .. } => details.as_ref(),
        }
    }

    pub fn exit_code(&self) -> u8 {
        match self.code() {
            "VPG_VALIDATION" => 2,
            "VPG_AUTH" => 3,
            "VPG_NOT_FOUND" => 4,
            "VPG_PERMISSION" => 5,
            "VPG_CONFLICT" => 6,
            "VPG_NETWORK" => 7,
            "VPG_RATE_LIMITED" => 8,
            _ => 1,
        }
    }
}
