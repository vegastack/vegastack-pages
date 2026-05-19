//! Stored config + token storage paths.
//!
//! Config lives under $HOME/.config/vegastack-pages/config.json. Tokens
//! prefer the system keychain; fall back to a 0600-perm file beside the
//! config when the keychain is unavailable.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cli::Cli;
use crate::errors::VpgError;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct StoredConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

pub fn config_dir() -> Result<PathBuf, VpgError> {
    let home = home_dir().ok_or_else(|| VpgError::generic("could not determine home directory"))?;
    Ok(home.join(".config").join("vegastack-pages"))
}

pub fn config_path() -> Result<PathBuf, VpgError> {
    Ok(config_dir()?.join("config.json"))
}

pub fn token_path() -> Result<PathBuf, VpgError> {
    Ok(config_dir()?.join("token"))
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

pub fn read_stored_config() -> Result<StoredConfig, VpgError> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(StoredConfig::default());
    }
    let contents = fs::read_to_string(&path)
        .map_err(|e| VpgError::generic(format!("read config: {e}")))?;
    serde_json::from_str(&contents).map_err(|e| VpgError::generic(format!("parse config: {e}")))
}

pub fn write_stored_config(config: &StoredConfig) -> Result<PathBuf, VpgError> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir).map_err(|e| VpgError::generic(format!("mkdir: {e}")))?;
    let path = config_path()?;
    let serialized = serde_json::to_string_pretty(config)
        .map_err(|e| VpgError::generic(format!("serialize config: {e}")))?;
    fs::write(&path, serialized).map_err(|e| VpgError::generic(format!("write config: {e}")))?;
    Ok(path)
}

pub fn update_stored_config<F: FnMut(&mut StoredConfig)>(mut update: F) -> Result<PathBuf, VpgError> {
    let mut config = read_stored_config()?;
    update(&mut config);
    write_stored_config(&config)
}

pub const DEFAULT_BASE_URL: &str = "https://pages.vegastack.com";

/// Resolve the base URL: explicit --base-url flag wins, then stored
/// config, then the hardcoded default. Keeps the clap default out of
/// callers so `vpg use` doesn't accidentally persist it.
pub fn resolved_base_url(cli: &Cli) -> String {
    cli.base_url
        .clone()
        .or_else(|| read_stored_config().ok().and_then(|c| c.base_url))
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Resolve the workspace ID from --workspace flag or stored config.
pub fn resolved_workspace(cli: &Cli) -> Result<String, VpgError> {
    if let Some(w) = &cli.workspace {
        return Ok(w.clone());
    }
    read_stored_config()?
        .workspace_id
        .ok_or_else(|| VpgError::validation(
            "no workspace selected; pass --workspace <id> or run `vpg use <workspace>`",
        ))
}

pub fn read_stored_token() -> Option<String> {
    read_fallback_token().ok().flatten()
}

pub fn write_stored_token(token: &str) -> Result<String, VpgError> {
    write_fallback_token(token).map(|p| p.display().to_string())
}

pub fn remove_stored_token() -> Result<PathBuf, VpgError> {
    let path = token_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| VpgError::generic(format!("remove token: {e}")))?;
    }
    Ok(path)
}

fn read_fallback_token() -> Result<Option<String>, VpgError> {
    let path = token_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let token = fs::read_to_string(&path)
        .map_err(|e| VpgError::generic(format!("read token: {e}")))?
        .trim()
        .to_string();
    if token.is_empty() {
        Ok(None)
    } else {
        Ok(Some(token))
    }
}

fn write_fallback_token(token: &str) -> Result<PathBuf, VpgError> {
    let dir = config_dir()?;
    fs::create_dir_all(&dir).map_err(|e| VpgError::generic(format!("mkdir: {e}")))?;
    let path = token_path()?;
    let mut file = create_private_file(&path)?;
    use io::Write;
    file.write_all(token.as_bytes())
        .map_err(|e| VpgError::generic(format!("write token: {e}")))?;
    Ok(path)
}

fn create_private_file(path: &Path) -> Result<fs::File, VpgError> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|e| VpgError::generic(format!("create token file: {e}")))
}
