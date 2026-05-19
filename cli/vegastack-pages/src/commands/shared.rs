//! Shared helpers used by multiple command modules.

use std::fs;
use std::io::{self, Read};
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::api::Api;
use crate::errors::VpgError;

/// Parse `key=value` CLI flag values.
pub fn parse_kv(input: &str) -> Result<(String, String), VpgError> {
    let (key, value) = input
        .split_once('=')
        .ok_or_else(|| VpgError::validation(format!("expected key=value, got: {input}")))?;
    Ok((key.trim().to_string(), value.to_string()))
}

/// Parse a list of `--set k=v` flag values into (key, value) pairs.
pub fn parse_kv_list(inputs: &[String]) -> Result<Vec<(String, String)>, VpgError> {
    inputs.iter().map(|s| parse_kv(s)).collect()
}

/// Read page source from file or stdin (returns empty string when neither set).
pub fn read_source(file: &Option<String>, use_stdin: bool) -> Result<String, VpgError> {
    if use_stdin {
        let mut source = String::new();
        io::stdin()
            .read_to_string(&mut source)
            .map_err(|e| VpgError::generic(format!("read stdin: {e}")))?;
        return Ok(source);
    }
    if let Some(file) = file {
        return fs::read_to_string(file)
            .map_err(|e| VpgError::generic(format!("read {file}: {e}")));
    }
    Ok(String::new())
}

/// Like `read_source` but accepts an inline `--source` string too.
pub fn read_source_value(
    inline: &Option<String>,
    file: &Option<String>,
    use_stdin: bool,
) -> Result<String, VpgError> {
    if inline.is_some() && (file.is_some() || use_stdin) {
        return Err(VpgError::validation(
            "--source cannot be combined with --file or --stdin",
        ));
    }
    if let Some(source) = inline {
        return Ok(source.clone());
    }
    read_source(file, use_stdin)
}

/// Read attachment body — accepts either base64 inline or a file path.
pub fn read_attachment_base64_body(
    inline: &Option<String>,
    file: &Option<String>,
) -> Result<String, VpgError> {
    match (inline, file) {
        (Some(_), Some(_)) => Err(VpgError::validation(
            "--base64-body and --base64-file cannot be combined",
        )),
        (Some(value), None) => Ok(value.clone()),
        (None, Some(path)) => fs::read_to_string(path)
            .map_err(|e| VpgError::generic(format!("read {path}: {e}"))),
        (None, None) => Err(VpgError::validation(
            "--base64-body or --base64-file is required",
        )),
    }
}

pub fn build_validate_source_body(
    workspace_id: Option<String>,
    page_id: Option<String>,
    source: Option<String>,
    source_type: Option<&str>,
) -> Value {
    let mut body = Map::new();
    if let Some(workspace_id) = workspace_id {
        body.insert("workspace_id".to_string(), Value::String(workspace_id));
    }
    if let Some(page_id) = page_id {
        body.insert("page_id".to_string(), Value::String(page_id));
    }
    if let Some(source) = source {
        body.insert("source".to_string(), Value::String(source));
    }
    if let Some(source_type) = source_type {
        body.insert(
            "source_type".to_string(),
            Value::String(source_type.to_string()),
        );
    }
    Value::Object(body)
}

pub fn build_publish_body(
    permission: &str,
    expires_at: &Option<String>,
    password: &Option<String>,
    indexing_enabled: &Option<bool>,
) -> Value {
    let mut body = Map::new();
    body.insert(
        "permission".to_string(),
        Value::String(permission.to_string()),
    );
    if let Some(expires_at) = expires_at {
        body.insert("expires_at".to_string(), Value::String(expires_at.clone()));
    }
    if let Some(password) = password {
        body.insert("password".to_string(), Value::String(password.clone()));
    }
    if let Some(indexing_enabled) = indexing_enabled {
        body.insert(
            "indexing_enabled".to_string(),
            Value::Bool(*indexing_enabled),
        );
    }
    Value::Object(body)
}

pub fn default_title(file: &Option<String>, title: &Option<String>) -> String {
    if let Some(title) = title {
        return title.clone();
    }
    file.as_deref()
        .and_then(|v| Path::new(v).file_stem())
        .and_then(|v| v.to_str())
        .map(|v| v.replace(['-', '_'], " "))
        .unwrap_or_else(|| "Untitled".to_string())
}

pub async fn resolve_template_id(
    api: &Api,
    workspace: &str,
    identifier: &str,
) -> Result<String, VpgError> {
    if identifier.starts_with("tpl_") {
        return Ok(identifier.to_string());
    }
    let list = api
        .get(&format!("/api/workspaces/{workspace}/templates"), &[])
        .await?;
    let templates = list
        .get("templates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let matched = templates.iter().find(|t| {
        t.get("slug").and_then(Value::as_str) == Some(identifier)
            || t.get("name").and_then(Value::as_str) == Some(identifier)
    });
    match matched {
        Some(t) => t
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| VpgError::generic("template entry missing id")),
        None => Err(VpgError::not_found(format!(
            "template not found in workspace {workspace}: {identifier}"
        ))),
    }
}

pub fn build_property_object(entries: &[(String, String)]) -> Value {
    let mut map = Map::new();
    for (key, value) in entries {
        map.insert(key.clone(), parse_cli_value(value));
    }
    Value::Object(map)
}

pub fn parse_cli_value(value: &str) -> Value {
    if value.contains(',') {
        let list: Vec<Value> = value
            .split(',')
            .map(|p| Value::String(p.trim().to_string()))
            .filter(|e| matches!(e, Value::String(t) if !t.is_empty()))
            .collect();
        return Value::Array(list);
    }
    if value == "true" || value == "false" {
        return Value::Bool(value == "true");
    }
    if let Ok(n) = value.parse::<f64>() {
        return serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(value.to_string()));
    }
    Value::String(value.to_string())
}

pub fn read_json_text(
    source: &Option<String>,
    file: &Option<String>,
) -> Result<Option<String>, VpgError> {
    match (source, file) {
        (Some(_), Some(_)) => Err(VpgError::validation(
            "--args and --args-file cannot be used together",
        )),
        (Some(value), None) => Ok(Some(value.clone())),
        (None, Some(path)) if path == "-" => {
            let mut text = String::new();
            io::stdin()
                .read_to_string(&mut text)
                .map_err(|e| VpgError::generic(format!("read stdin: {e}")))?;
            Ok(Some(text))
        }
        (None, Some(path)) => fs::read_to_string(path)
            .map(Some)
            .map_err(|e| VpgError::generic(format!("read {path}: {e}"))),
        (None, None) => Ok(None),
    }
}

pub fn read_json_arguments(
    source: &Option<String>,
    file: &Option<String>,
    set: &[(String, String)],
    workspace: Option<String>,
) -> Result<Value, VpgError> {
    let mut args = match read_json_text(source, file)? {
        Some(text) if !text.trim().is_empty() => serde_json::from_str::<Value>(&text)
            .map_err(|e| VpgError::validation(format!("invalid JSON arguments: {e}")))?,
        _ => json!({}),
    };
    if !args.is_object() {
        return Err(VpgError::validation(
            "CLI JSON arguments must be a JSON object",
        ));
    }
    if let Some(workspace) = workspace {
        let obj = args.as_object_mut().expect("verified object above");
        obj.entry("workspace_id")
            .or_insert_with(|| Value::String(workspace));
    }
    for (key, value) in set {
        set_json_path(&mut args, key, parse_cli_value(value))?;
    }
    Ok(args)
}

pub fn read_optional_json_object(
    inline: &Option<String>,
    file: &Option<String>,
    label: &str,
) -> Result<Option<Value>, VpgError> {
    match (inline, file) {
        (Some(_), Some(_)) => Err(VpgError::validation(format!(
            "--{label}-json and --{label}-file cannot be used together"
        ))),
        (Some(value), None) => parse_json_object(value, label).map(Some),
        (None, Some(path)) if path == "-" => {
            let mut text = String::new();
            io::stdin()
                .read_to_string(&mut text)
                .map_err(|e| VpgError::generic(format!("read stdin: {e}")))?;
            parse_json_object(&text, label).map(Some)
        }
        (None, Some(path)) => {
            let text = fs::read_to_string(path)
                .map_err(|e| VpgError::generic(format!("read {path}: {e}")))?;
            parse_json_object(&text, label).map(Some)
        }
        (None, None) => Ok(None),
    }
}

fn parse_json_object(text: &str, label: &str) -> Result<Value, VpgError> {
    let value = serde_json::from_str::<Value>(text)
        .map_err(|e| VpgError::validation(format!("invalid {label} JSON: {e}")))?;
    if !value.is_object() {
        return Err(VpgError::validation(format!(
            "{label} JSON must be an object"
        )));
    }
    Ok(value)
}

#[allow(clippy::too_many_arguments)]
pub fn build_comment_anchor_body(
    anchor_json: &Option<String>,
    anchor_file: &Option<String>,
    selected_text: &Option<String>,
    source_start: &Option<i64>,
    source_end: &Option<i64>,
    prefix_text: &str,
    suffix_text: &str,
    anchor_kind: &str,
    surface: &str,
    confidence: &Option<String>,
) -> Result<Value, VpgError> {
    let mut anchor =
        read_optional_json_object(anchor_json, anchor_file, "anchor")?.unwrap_or_else(|| json!({}));
    let obj = anchor.as_object_mut().expect("read_optional_json_object guarantees object");
    obj.entry("anchor_kind".to_string())
        .or_insert_with(|| Value::String(anchor_kind.to_string()));
    obj.entry("surface".to_string())
        .or_insert_with(|| Value::String(surface.to_string()));
    if let Some(v) = selected_text {
        obj.insert("selected_text".to_string(), Value::String(v.clone()));
    }
    if let Some(v) = source_start {
        obj.insert(
            "source_start".to_string(),
            Value::Number(serde_json::Number::from(*v)),
        );
    }
    if let Some(v) = source_end {
        obj.insert(
            "source_end".to_string(),
            Value::Number(serde_json::Number::from(*v)),
        );
    }
    if !prefix_text.is_empty() {
        obj.insert(
            "prefix_text".to_string(),
            Value::String(prefix_text.to_string()),
        );
    }
    if !suffix_text.is_empty() {
        obj.insert(
            "suffix_text".to_string(),
            Value::String(suffix_text.to_string()),
        );
    }
    if let Some(v) = confidence {
        obj.insert("confidence".to_string(), Value::String(v.clone()));
    }
    Ok(anchor)
}

fn set_json_path(target: &mut Value, path: &str, value: Value) -> Result<(), VpgError> {
    let parts: Vec<&str> = path.split('.').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return Err(VpgError::validation("CLI --set keys must not be empty"));
    }
    let mut current = target;
    for part in &parts[..parts.len() - 1] {
        if !current.is_object() {
            *current = json!({});
        }
        let obj = current.as_object_mut().expect("checked object above");
        current = obj
            .entry((*part).to_string())
            .or_insert_with(|| json!({}));
    }
    let obj = current
        .as_object_mut()
        .ok_or_else(|| VpgError::validation("CLI JSON arguments must be a JSON object"))?;
    obj.insert(parts[parts.len() - 1].to_string(), value);
    Ok(())
}

/// Resolve a page identifier (id, slug, or slug_id) to a canonical `pg_*` id.
pub async fn resolve_page_id(
    api: &Api,
    page: &str,
    workspace: &str,
) -> Result<String, VpgError> {
    if page.starts_with("pg_") {
        return Ok(page.to_string());
    }
    let response = api
        .get(
            &format!("/api/pages/{page}"),
            &[
                ("workspace_id", workspace.to_string()),
                ("include", "metadata".to_string()),
            ],
        )
        .await?;
    response
        .get("page_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            response
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .ok_or_else(|| {
            VpgError::not_found(format!("page not found in workspace {workspace}: {page}"))
        })
}
