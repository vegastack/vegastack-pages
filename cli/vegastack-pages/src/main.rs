use clap::{Parser, Subcommand, ValueEnum};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::thread;
use std::time::{Duration, Instant};

const SKILL_NAME: &str = "vegastack-pages";
const DEFAULT_BASE_URL: &str = "https://pages.vegastack.com";
const SKILL_FILES: &[(&str, &str)] = &[
    (
        "SKILL.md",
        include_str!("../../../skills/vegastack-pages/SKILL.md"),
    ),
    (
        "agents/openai.yaml",
        include_str!("../../../skills/vegastack-pages/agents/openai.yaml"),
    ),
    (
        "references/mcp.md",
        include_str!("../../../skills/vegastack-pages/references/mcp.md"),
    ),
    (
        "references/cli.md",
        include_str!("../../../skills/vegastack-pages/references/cli.md"),
    ),
    (
        "references/comments.md",
        include_str!("../../../skills/vegastack-pages/references/comments.md"),
    ),
    (
        "references/workflows.md",
        include_str!("../../../skills/vegastack-pages/references/workflows.md"),
    ),
    (
        "references/templates.md",
        include_str!("../../../skills/vegastack-pages/references/templates.md"),
    ),
    (
        "references/security.md",
        include_str!("../../../skills/vegastack-pages/references/security.md"),
    ),
];

#[derive(Parser, Debug)]
#[command(name = "vpg", version, about = "VegaStack Pages CLI")]
struct Cli {
    #[arg(long, global = true)]
    json: bool,

    #[arg(
        long,
        global = true,
        env = "VPG_BASE_URL",
        default_value = DEFAULT_BASE_URL
    )]
    base_url: String,

    #[arg(long, global = true, env = "VPG_WORKSPACE")]
    workspace: Option<String>,

    #[arg(long, global = true, env = "VPG_TOKEN")]
    token: Option<String>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Sign in to VegaStack Pages. With no flags, opens a browser via RFC 8628
    /// device-code; with `--token`, stores the provided workspace token.
    Login {
        /// Use a pasted workspace-scoped token instead of the browser flow.
        #[arg(long, env = "VPG_TOKEN")]
        token: Option<String>,
        /// Skip the automatic browser launch (still prints the URL).
        #[arg(long)]
        no_browser: bool,
    },
    Logout,
    Whoami,
    Workspaces,
    Use {
        workspace: String,
    },
    Create {
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        stdin: bool,
        #[arg(long = "type", default_value = "markdown")]
        source_type: SourceType,
        #[arg(long)]
        folder_path: Option<String>,
        #[arg(long)]
        template: Option<String>,
        #[arg(long = "set", value_parser = parse_kv)]
        set: Vec<(String, String)>,
    },
    Templates {
        #[command(subcommand)]
        command: TemplateCommand,
    },
    Pages {
        #[command(subcommand)]
        command: PageCommand,
    },
    Attachments {
        #[command(subcommand)]
        command: AttachmentCommand,
    },
    Members {
        #[command(subcommand)]
        command: MemberCommand,
    },
    Wait {
        page: String,
        #[arg(long, default_value = "first-response")]
        until: WaitCondition,
        #[arg(long, default_value_t = 600)]
        timeout_seconds: u64,
        #[arg(long, default_value_t = 2)]
        poll_seconds: u64,
        #[arg(long)]
        after_id: Option<String>,
    },
    Comments {
        page: String,
        #[arg(long, default_value = "open")]
        status: String,
    },
    Comment {
        page: String,
        #[arg(long)]
        body: String,
        #[arg(long)]
        anchor_json: Option<String>,
        #[arg(long)]
        anchor_file: Option<String>,
        #[arg(long)]
        selected_text: Option<String>,
        #[arg(long)]
        source_start: Option<i64>,
        #[arg(long)]
        source_end: Option<i64>,
        #[arg(long, default_value = "")]
        prefix_text: String,
        #[arg(long, default_value = "")]
        suffix_text: String,
        #[arg(long, default_value = "text")]
        anchor_kind: AnchorKind,
        #[arg(long, default_value = "prose")]
        surface: AnchorSurface,
        #[arg(long)]
        confidence: Option<AnchorConfidence>,
    },
    Reply {
        thread: String,
        #[arg(long)]
        body: String,
        #[arg(long)]
        agent_name: Option<String>,
        #[arg(long)]
        agent_model: Option<String>,
        #[arg(long)]
        agent_session: Option<String>,
    },
    Resolve {
        thread: String,
    },
    Unresolve {
        thread: String,
    },
    UpdateAnchor {
        thread: String,
        #[arg(long)]
        anchor_json: Option<String>,
        #[arg(long)]
        anchor_file: Option<String>,
        #[arg(long)]
        selected_text: Option<String>,
        #[arg(long)]
        source_start: Option<i64>,
        #[arg(long)]
        source_end: Option<i64>,
        #[arg(long, default_value = "")]
        prefix_text: String,
        #[arg(long, default_value = "")]
        suffix_text: String,
        #[arg(long, default_value = "text")]
        anchor_kind: AnchorKind,
        #[arg(long, default_value = "prose")]
        surface: AnchorSurface,
        #[arg(long)]
        confidence: Option<AnchorConfidence>,
    },
    DeleteThread {
        thread: String,
    },
    CompleteThread {
        thread: String,
        #[arg(long)]
        body: String,
        #[arg(long)]
        resolve: bool,
        #[arg(long)]
        agent_name: Option<String>,
        #[arg(long)]
        agent_model: Option<String>,
        #[arg(long)]
        agent_session_id: Option<String>,
    },
    PublishPage {
        page: String,
        #[arg(long, default_value = "view")]
        permission: PublicationPermission,
        #[arg(long)]
        expires_at: Option<String>,
        #[arg(long)]
        password: Option<String>,
        #[arg(long)]
        indexing_enabled: Option<bool>,
    },
    PublishFolder {
        folder: String,
        #[arg(long, default_value = "view")]
        permission: PublicationPermission,
        #[arg(long)]
        expires_at: Option<String>,
        #[arg(long)]
        password: Option<String>,
        #[arg(long)]
        indexing_enabled: Option<bool>,
    },
    RevokePublication {
        publication: String,
    },
    UpdatePublication {
        publication: String,
        #[arg(long)]
        permission: Option<PublicationPermission>,
        #[arg(long)]
        expires_at: Option<String>,
        #[arg(long)]
        clear_expires_at: bool,
        #[arg(long)]
        password: Option<String>,
        #[arg(long)]
        clear_password: bool,
        #[arg(long)]
        indexing_enabled: Option<bool>,
    },
    Search {
        query: String,
        #[arg(long = "type", default_value = "all")]
        resource_type: SearchType,
        #[arg(long, default_value_t = 10)]
        limit: u16,
    },
    Events {
        #[arg(long)]
        page: Option<String>,
        #[arg(long)]
        workspace: Option<String>,
        #[arg(long)]
        after_id: Option<String>,
        #[arg(long, default_value_t = 50)]
        limit: u16,
    },
    Tree {
        #[arg(long)]
        workspace: Option<String>,
    },
    Export {
        workspace: Option<String>,
    },
    Deploy {
        #[arg(long, default_value = "cloudflare")]
        target: String,
        #[arg(long, default_value = "vegastack-pages.yaml")]
        config: String,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        managed: bool,
        #[arg(long)]
        apply_migrations: bool,
        #[arg(long)]
        skip_migrations: bool,
    },
    Doctor,
    Skills {
        #[command(subcommand)]
        command: SkillCommand,
    },
    /// Upgrade vpg to the latest release from npm.
    Update {
        /// Only check for a newer version; don't install.
        #[arg(long)]
        check: bool,
        /// Force a release channel ("latest" or "next"). Defaults to whichever
        /// matches your current version.
        #[arg(long)]
        channel: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum TemplateCommand {
    List {
        #[arg(long)]
        category: Option<String>,
    },
    Show {
        template: String,
    },
    Render {
        template: String,
        #[arg(long)]
        title: String,
        #[arg(long = "set", value_parser = parse_kv)]
        set: Vec<(String, String)>,
    },
    Create {
        #[arg(long, help = "JSON object containing CLI JSON arguments")]
        args: Option<String>,
        #[arg(
            long,
            help = "Path to a JSON object containing CLI JSON arguments, or - for stdin"
        )]
        args_file: Option<String>,
        #[arg(
            long = "set",
            value_parser = parse_kv,
            help = "Set or override an argument key=value; dotted paths are supported"
        )]
        set: Vec<(String, String)>,
    },
    Update {
        template: String,
        #[arg(long)]
        args: Option<String>,
        #[arg(long)]
        args_file: Option<String>,
        #[arg(long = "set", value_parser = parse_kv)]
        set: Vec<(String, String)>,
    },
}

#[derive(Subcommand, Debug)]
enum PageCommand {
    Get {
        page: String,
    },
    Rendered {
        page: String,
    },
    Versions {
        page: String,
    },
    Snapshot {
        page: String,
        #[arg(long)]
        label: Option<String>,
    },
    RestoreVersion {
        page: String,
        version_id: String,
    },
    PrepareEdit {
        page: String,
    },
    UpdateSource {
        page: String,
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        stdin: bool,
        #[arg(long)]
        base_version_id: String,
        #[arg(long)]
        base_content_hash: Option<String>,
        #[arg(long)]
        checkpoint: bool,
        #[arg(long)]
        checkpoint_label: Option<String>,
        #[arg(long)]
        allow_noop: bool,
    },
    Patch {
        page: String,
        #[arg(long)]
        find: String,
        #[arg(long, default_value = "")]
        replace: String,
        #[arg(long)]
        replace_all: bool,
        #[arg(long)]
        expected_replacements: Option<u32>,
        #[arg(long)]
        base_version_id: String,
        #[arg(long)]
        base_content_hash: Option<String>,
        #[arg(long)]
        checkpoint: bool,
        #[arg(long)]
        checkpoint_label: Option<String>,
    },
    Validate {
        #[arg(long)]
        page: Option<String>,
        #[arg(long)]
        source: Option<String>,
        #[arg(long)]
        file: Option<String>,
        #[arg(long)]
        stdin: bool,
        #[arg(long = "type")]
        source_type: Option<SourceType>,
    },
    Move {
        page: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        folder_path: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum AttachmentCommand {
    Upload {
        page: String,
        #[arg(long)]
        filename: String,
        #[arg(long)]
        content_type: String,
        #[arg(long)]
        base64_body: Option<String>,
        #[arg(long)]
        base64_file: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum MemberCommand {
    Invite {
        #[arg(long)]
        email: String,
        #[arg(long)]
        display_name: Option<String>,
        #[arg(long, default_value = "reader")]
        role: WorkspaceRole,
        #[arg(long)]
        workspace: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum SkillCommand {
    Path,
    Print,
    Doctor,
    Install {
        #[arg(long, default_value = "all")]
        agent: SkillAgent,
        #[arg(long, default_value = "user")]
        scope: SkillScope,
        #[arg(long)]
        dir: Option<String>,
        #[arg(long)]
        force: bool,
        #[arg(long)]
        dry_run: bool,
    },
    Update {
        #[arg(long, default_value = "all")]
        agent: SkillAgent,
        #[arg(long, default_value = "user")]
        scope: SkillScope,
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Clone, Debug, ValueEnum)]
enum SearchType {
    All,
    Page,
    Folder,
    Comment,
}

impl SearchType {
    fn as_api_value(&self) -> &'static str {
        match self {
            SearchType::All => "all",
            SearchType::Page => "page",
            SearchType::Folder => "folder",
            SearchType::Comment => "comment",
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum SkillAgent {
    All,
    Codex,
    #[value(alias = "claude-code")]
    Claude,
    Cursor,
    #[value(alias = "gemini-cli")]
    Gemini,
    #[value(alias = "openclaw")]
    OpenClaw,
    #[value(alias = "opencode")]
    OpenCode,
    Hermes,
    Aider,
    Pi,
    Generic,
}

impl SkillAgent {
    fn as_slug(self) -> &'static str {
        match self {
            SkillAgent::Codex => "codex",
            SkillAgent::All => "all",
            SkillAgent::Claude => "claude",
            SkillAgent::Cursor => "cursor",
            SkillAgent::Gemini => "gemini",
            SkillAgent::OpenClaw => "openclaw",
            SkillAgent::OpenCode => "opencode",
            SkillAgent::Hermes => "hermes",
            SkillAgent::Aider => "aider",
            SkillAgent::Pi => "pi",
            SkillAgent::Generic => "generic",
        }
    }
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum SkillScope {
    User,
    Project,
}

#[derive(Clone, Debug, ValueEnum)]
enum WorkspaceRole {
    Reader,
    Commenter,
    Editor,
    Admin,
}

impl WorkspaceRole {
    fn as_api_value(&self) -> &'static str {
        match self {
            WorkspaceRole::Reader => "reader",
            WorkspaceRole::Commenter => "commenter",
            WorkspaceRole::Editor => "editor",
            WorkspaceRole::Admin => "admin",
        }
    }
}

fn parse_kv(input: &str) -> Result<(String, String), String> {
    let (key, value) = input
        .split_once('=')
        .ok_or_else(|| format!("expected key=value, got: {input}"))?;
    Ok((key.trim().to_string(), value.to_string()))
}

#[derive(Clone, Debug, ValueEnum)]
enum SourceType {
    Markdown,
    Mdx,
    Html,
}

impl SourceType {
    fn as_api_value(&self) -> &'static str {
        match self {
            SourceType::Markdown => "markdown",
            SourceType::Mdx => "mdx",
            SourceType::Html => "html",
        }
    }
}

#[derive(Clone, Debug, ValueEnum)]
enum PublicationPermission {
    View,
    Comment,
    Edit,
}

impl PublicationPermission {
    fn as_api_value(&self) -> &'static str {
        match self {
            PublicationPermission::View => "view",
            PublicationPermission::Comment => "comment",
            PublicationPermission::Edit => "edit",
        }
    }
}

#[derive(Clone, Debug, ValueEnum)]
enum AnchorKind {
    Text,
    Point,
}

impl AnchorKind {
    fn as_api_value(&self) -> &'static str {
        match self {
            AnchorKind::Text => "text",
            AnchorKind::Point => "point",
        }
    }
}

#[derive(Clone, Debug, ValueEnum)]
enum AnchorSurface {
    Prose,
    Html,
}

impl AnchorSurface {
    fn as_api_value(&self) -> &'static str {
        match self {
            AnchorSurface::Prose => "prose",
            AnchorSurface::Html => "html",
        }
    }
}

#[derive(Clone, Debug, ValueEnum)]
enum AnchorConfidence {
    Active,
    Reanchored,
    Fuzzy,
    Manual,
    Stale,
}

impl AnchorConfidence {
    fn as_api_value(&self) -> &'static str {
        match self {
            AnchorConfidence::Active => "active",
            AnchorConfidence::Reanchored => "reanchored",
            AnchorConfidence::Fuzzy => "fuzzy",
            AnchorConfidence::Manual => "manual",
            AnchorConfidence::Stale => "stale",
        }
    }
}

#[derive(Clone, Debug, ValueEnum)]
enum WaitCondition {
    FirstResponse,
    NewComment,
    AllThreadsResolved,
    Timeout,
}

fn wait_condition_api_value(condition: &WaitCondition) -> &'static str {
    match condition {
        WaitCondition::FirstResponse => "first_response",
        WaitCondition::NewComment => "new_comment",
        WaitCondition::AllThreadsResolved => "all_threads_resolved",
        WaitCondition::Timeout => "timeout",
    }
}

#[derive(Serialize)]
struct StatusOutput<'a> {
    status: &'a str,
    message: &'a str,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct StoredConfig {
    #[serde(default, skip_serializing)]
    token: Option<String>,
    workspace: Option<String>,
    base_url: Option<String>,
}

struct Api {
    base_url: String,
    client: Client,
}

impl Api {
    fn new(cli: &Cli) -> Result<Self, String> {
        let token = cli.token.clone().or_else(read_stored_token);
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(token) = &token {
            let value = HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| {
                "VPG_TOKEN contains characters that are not valid in an HTTP header".to_string()
            })?;
            headers.insert(AUTHORIZATION, value);
        }
        let client = Client::builder()
            .default_headers(headers)
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|error| format!("failed to create HTTP client: {error}"))?;
        Ok(Self {
            base_url: cli.base_url.trim_end_matches('/').to_string(),
            client,
        })
    }

    fn get(&self, path: &str, params: &[(&str, String)]) -> Result<Value, String> {
        let url = reqwest::Url::parse_with_params(&format!("{}{}", self.base_url, path), params)
            .map_err(|error| format!("invalid URL: {error}"))?;
        let response = self
            .client
            .get(url)
            .send()
            .map_err(|error| error.to_string())?;
        Self::read_response(response)
    }

    fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        let response = self
            .client
            .post(format!("{}{}", self.base_url, path))
            .json(&body)
            .send()
            .map_err(|error| error.to_string())?;
        Self::read_response(response)
    }

    fn put(&self, path: &str, body: Value) -> Result<Value, String> {
        let response = self
            .client
            .put(format!("{}{}", self.base_url, path))
            .json(&body)
            .send()
            .map_err(|error| error.to_string())?;
        Self::read_response(response)
    }

    fn patch(&self, path: &str, body: Value) -> Result<Value, String> {
        let response = self
            .client
            .patch(format!("{}{}", self.base_url, path))
            .json(&body)
            .send()
            .map_err(|error| error.to_string())?;
        Self::read_response(response)
    }

    fn delete(&self, path: &str) -> Result<Value, String> {
        let response = self
            .client
            .delete(format!("{}{}", self.base_url, path))
            .send()
            .map_err(|error| error.to_string())?;
        Self::read_response(response)
    }

    fn read_response(response: reqwest::blocking::Response) -> Result<Value, String> {
        let status = response.status();
        let value = response
            .json::<Value>()
            .map_err(|error| format!("invalid JSON response: {error}"))?;
        if status.is_success() {
            Ok(value)
        } else {
            let error = value.get("error").unwrap_or(&value);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("request failed");
            let details = error.get("details");
            match details {
                Some(details) => Err(format!("{message}: {details}")),
                None => Err(message.to_string()),
            }
        }
    }

    fn download(&self, path: &str) -> Result<Vec<u8>, String> {
        let response = self
            .client
            .get(format!("{}{}", self.base_url, path))
            .send()
            .map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("download failed with HTTP {status}"));
        }
        response
            .bytes()
            .map(|bytes| bytes.to_vec())
            .map_err(|error| error.to_string())
    }
}

fn encode_query_component(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn with_workspace_query(path: &str, workspace: &str) -> String {
    let separator = if path.contains('?') { '&' } else { '?' };
    format!(
        "{path}{separator}workspace_id={}",
        encode_query_component(workspace)
    )
}

fn config_path() -> Result<PathBuf, String> {
    if let Ok(path) = env::var("VPG_CONFIG_PATH") {
        return Ok(PathBuf::from(path));
    }
    if let Ok(path) = env::var("VPG_CONFIG_HOME") {
        return Ok(PathBuf::from(path).join("config.json"));
    }
    if let Ok(path) = env::var("XDG_CONFIG_HOME") {
        return Ok(PathBuf::from(path)
            .join("vegastack-pages")
            .join("config.json"));
    }
    home_dir()
        .map(|home| {
            home.join(".config")
                .join("vegastack-pages")
                .join("config.json")
        })
        .ok_or_else(|| {
            "HOME/USERPROFILE is not set; pass --token or set VPG_TOKEN for non-interactive use"
                .to_string()
        })
}

fn token_path() -> Result<PathBuf, String> {
    let config = config_path()?;
    Ok(config.with_file_name("token"))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("USERPROFILE").map(PathBuf::from))
}

fn source_skill_dir() -> Option<PathBuf> {
    let cwd = env::current_dir().ok()?;
    for ancestor in cwd.ancestors() {
        let candidate = ancestor.join("skills").join(SKILL_NAME);
        if candidate.join("SKILL.md").exists() {
            return Some(candidate);
        }
    }
    None
}

fn skill_print_payload() -> Value {
    let files = SKILL_FILES
        .iter()
        .map(|(path, content)| ((*path).to_string(), Value::String((*content).to_string())))
        .collect();
    json!({
        "name": SKILL_NAME,
        "source": source_skill_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "embedded".to_string()),
        "files": Value::Object(files)
    })
}

fn skill_adapter_files(agent: SkillAgent) -> Vec<(&'static str, String)> {
    match agent {
        SkillAgent::All => Vec::new(),
        SkillAgent::Cursor => vec![("vegastack-pages.mdc", cursor_rule())],
        SkillAgent::Gemini => vec![
            ("GEMINI.md", gemini_extension_prompt()),
            ("extension.json", gemini_extension_json()),
        ],
        _ => SKILL_FILES
            .iter()
            .map(|(path, content)| (*path, (*content).to_string()))
            .collect(),
    }
}

fn concrete_skill_agents(agent: SkillAgent) -> Vec<SkillAgent> {
    match agent {
        SkillAgent::All => vec![
            SkillAgent::Codex,
            SkillAgent::Claude,
            SkillAgent::Cursor,
            SkillAgent::Gemini,
            SkillAgent::OpenClaw,
            SkillAgent::OpenCode,
            SkillAgent::Hermes,
            SkillAgent::Aider,
            SkillAgent::Pi,
            SkillAgent::Generic,
        ],
        other => vec![other],
    }
}

fn cursor_rule() -> String {
    format!(
        r#"---
description: Use VegaStack Pages through MCP or the vpg CLI for review workflows, page edits, comments, and templates.
alwaysApply: false
---

# VegaStack Pages

Prefer the VegaStack Pages MCP tools when they are connected. Use the `vpg` CLI when MCP tools are unavailable or when working from shell scripts.

{skill}
"#,
        skill = SKILL_FILES[0].1
    )
}

fn gemini_extension_prompt() -> String {
    format!(
        r#"# VegaStack Pages

Use this extension when working with VegaStack Pages documents, comments, templates, or review workflows.

Prefer a configured VegaStack Pages MCP server. If MCP is unavailable, use the `vpg` CLI with `--base-url`, `--workspace`, and `VPG_TOKEN` or stored login.

{skill}
"#,
        skill = SKILL_FILES[0].1
    )
}

fn gemini_extension_json() -> String {
    serde_json::to_string_pretty(&json!({
        "name": SKILL_NAME,
        "version": env!("CARGO_PKG_VERSION"),
        "description": "VegaStack Pages MCP and CLI workflows for agents.",
        "contextFileName": "GEMINI.md"
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

fn default_skill_install_dir(agent: SkillAgent, scope: SkillScope) -> Result<PathBuf, String> {
    if matches!(agent, SkillAgent::All) {
        return Err("--agent all expands to concrete agent install paths".to_string());
    }
    let base = match scope {
        SkillScope::Project => env::current_dir().map_err(|error| error.to_string())?,
        SkillScope::User => {
            home_dir().ok_or_else(|| "HOME/USERPROFILE is required for --scope user".to_string())?
        }
    };
    let path = match (agent, scope) {
        (SkillAgent::Codex, SkillScope::Project) => {
            base.join(".agents").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::Codex, SkillScope::User) => {
            base.join(".codex").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::Claude, SkillScope::Project) => {
            base.join(".claude").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::Claude, SkillScope::User) => {
            base.join(".claude").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::Cursor, SkillScope::Project) => base.join(".cursor").join("rules"),
        (SkillAgent::Cursor, SkillScope::User) => base.join(".cursor").join("rules"),
        (SkillAgent::Gemini, SkillScope::Project) => {
            base.join(".gemini").join("extensions").join(SKILL_NAME)
        }
        (SkillAgent::Gemini, SkillScope::User) => {
            base.join(".gemini").join("extensions").join(SKILL_NAME)
        }
        (SkillAgent::OpenCode, SkillScope::Project) => {
            base.join(".opencode").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::OpenCode, SkillScope::User) => base
            .join(".config")
            .join("opencode")
            .join("skills")
            .join(SKILL_NAME),
        (SkillAgent::OpenClaw, SkillScope::Project) => {
            base.join(".openclaw").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::OpenClaw, SkillScope::User) => {
            base.join(".openclaw").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::Hermes, SkillScope::Project) => {
            base.join(".hermes").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::Hermes, SkillScope::User) => {
            base.join(".hermes").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::Aider, SkillScope::Project) => {
            base.join(".aider").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::Aider, SkillScope::User) => {
            base.join(".aider").join("skills").join(SKILL_NAME)
        }
        (SkillAgent::Pi, SkillScope::Project) => base.join(".pi").join("skills").join(SKILL_NAME),
        (SkillAgent::Pi, SkillScope::User) => base.join(".pi").join("skills").join(SKILL_NAME),
        (SkillAgent::Generic, SkillScope::Project) => base.join("skills").join(SKILL_NAME),
        (SkillAgent::Generic, SkillScope::User) => base.join(".agent-skills").join(SKILL_NAME),
        (SkillAgent::All, _) => unreachable!("--agent all is expanded before resolving paths"),
    };
    Ok(path)
}

fn install_one_skill(
    agent: SkillAgent,
    scope: SkillScope,
    dir: &Option<String>,
    force: bool,
    dry_run: bool,
) -> Result<Value, String> {
    let target_dir = match dir {
        Some(path) => PathBuf::from(path),
        None => default_skill_install_dir(agent, scope)?,
    };
    let files = skill_adapter_files(agent);
    let mut planned = Vec::new();
    for (relative, content) in files {
        let target = target_dir.join(relative);
        if target.exists() && !force {
            let existing = fs::read_to_string(&target).unwrap_or_default();
            if existing != content {
                return Err(format!(
                    "{} already exists; pass --force to overwrite",
                    target.display()
                ));
            }
        }
        planned.push((target, content));
    }
    if !dry_run {
        for (target, content) in &planned {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
            }
            fs::write(target, content)
                .map_err(|error| format!("failed to write {}: {error}", target.display()))?;
        }
    }
    Ok(json!({
        "status": if dry_run { "dry_run" } else { "ok" },
        "agent": agent.as_slug(),
        "scope": format!("{scope:?}").to_lowercase(),
        "target": target_dir.display().to_string(),
        "files": planned.iter().map(|(path, _)| path.display().to_string()).collect::<Vec<_>>(),
        "note": match agent {
            SkillAgent::Cursor => "Cursor uses a rules adapter, not native SKILL.md loading.",
            SkillAgent::Gemini => "Gemini CLI uses an extension adapter, not native SKILL.md loading.",
            _ => "Installed portable SKILL.md bundle."
        }
    }))
}

fn install_skill(
    agent: SkillAgent,
    scope: SkillScope,
    dir: &Option<String>,
    force: bool,
    dry_run: bool,
) -> Result<Value, String> {
    let agents = concrete_skill_agents(agent);
    if agents.len() > 1 && dir.is_some() {
        return Err("--dir cannot be used with --agent all".to_string());
    }
    if agents.len() == 1 {
        return install_one_skill(agents[0], scope, dir, force, dry_run);
    }
    let mut installs = Vec::new();
    let mut errors = Vec::new();
    for concrete in agents {
        match install_one_skill(concrete, scope, &None, force, dry_run) {
            Ok(value) => installs.push(value),
            Err(error) => errors.push(json!({
                "agent": concrete.as_slug(),
                "error": error,
            })),
        }
    }
    Ok(json!({
        "status": if errors.is_empty() {
            if dry_run { "dry_run" } else { "ok" }
        } else {
            "partial"
        },
        "agent": "all",
        "scope": format!("{scope:?}").to_lowercase(),
        "installed": installs,
        "errors": errors
    }))
}

fn skill_doctor() -> Value {
    let missing = SKILL_FILES
        .iter()
        .filter(|(_, content)| content.trim().is_empty())
        .map(|(path, _)| *path)
        .collect::<Vec<_>>();
    let skill = SKILL_FILES[0].1;
    let valid_frontmatter =
        skill.starts_with("---\nname: vegastack-pages\n") && skill.contains("\ndescription: ");
    json!({
        "status": if missing.is_empty() && valid_frontmatter { "ok" } else { "error" },
        "name": SKILL_NAME,
        "source": source_skill_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "embedded".to_string()),
        "file_count": SKILL_FILES.len(),
        "missing_or_empty": missing,
        "valid_frontmatter": valid_frontmatter,
        "supported_agents": ["codex", "claude", "cursor", "gemini", "openclaw", "opencode", "hermes", "aider", "pi", "generic"]
    })
}

fn read_stored_config() -> Result<StoredConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(StoredConfig::default());
    }
    let bytes =
        fs::read(&path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid CLI config at {}: {error}", path.display()))
}

fn create_private_file(path: &Path) -> Result<fs::File, String> {
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))
}

fn write_stored_config(config: &StoredConfig) -> Result<PathBuf, String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let bytes = serde_json::to_vec_pretty(config)
        .map_err(|error| format!("failed to serialize CLI config: {error}"))?;
    let mut file = create_private_file(&path)?;
    file.write_all(&bytes)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(path)
}

fn keychain_disabled() -> bool {
    env::var("VPG_DISABLE_KEYCHAIN").is_ok()
}

#[cfg(target_os = "macos")]
fn read_keychain_token() -> Result<Option<String>, String> {
    if keychain_disabled() {
        return Ok(None);
    }
    let output = ProcessCommand::new("security")
        .args([
            "find-generic-password",
            "-a",
            "default",
            "-s",
            "vegastack-pages",
            "-w",
        ])
        .output()
        .map_err(|error| format!("failed to read macOS keychain: {error}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!token.is_empty()).then_some(token))
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_token() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn write_keychain_token(token: &str) -> Result<bool, String> {
    if keychain_disabled() {
        return Ok(false);
    }
    let _ = ProcessCommand::new("security")
        .args([
            "delete-generic-password",
            "-a",
            "default",
            "-s",
            "vegastack-pages",
        ])
        .status();
    let status = ProcessCommand::new("security")
        .args([
            "add-generic-password",
            "-a",
            "default",
            "-s",
            "vegastack-pages",
            "-w",
            token,
            "-U",
        ])
        .status()
        .map_err(|error| format!("failed to write macOS keychain: {error}"))?;
    Ok(status.success())
}

#[cfg(not(target_os = "macos"))]
fn write_keychain_token(_token: &str) -> Result<bool, String> {
    Ok(false)
}

#[cfg(target_os = "macos")]
fn delete_keychain_token() {
    if keychain_disabled() {
        return;
    }
    let _ = ProcessCommand::new("security")
        .args([
            "delete-generic-password",
            "-a",
            "default",
            "-s",
            "vegastack-pages",
        ])
        .status();
}

#[cfg(not(target_os = "macos"))]
fn delete_keychain_token() {}

fn read_fallback_token() -> Result<Option<String>, String> {
    let path = token_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let token = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let token = token.trim().to_string();
    Ok((!token.is_empty()).then_some(token))
}

fn read_stored_token() -> Option<String> {
    read_keychain_token()
        .ok()
        .flatten()
        .or_else(|| read_fallback_token().ok().flatten())
        .or_else(|| read_stored_config().ok().and_then(|config| config.token))
}

fn write_fallback_token(token: &str) -> Result<PathBuf, String> {
    let path = token_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let mut file = create_private_file(&path)?;
    file.write_all(token.as_bytes())
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    file.write_all(b"\n")
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(path)
}

fn write_stored_token(token: &str) -> Result<String, String> {
    if write_keychain_token(token)? {
        if let Ok(path) = token_path() {
            let _ = fs::remove_file(path);
        }
        return Ok("keychain".to_string());
    }
    write_fallback_token(token).map(|path| path.display().to_string())
}

fn update_stored_config(mut update: impl FnMut(&mut StoredConfig)) -> Result<PathBuf, String> {
    let mut config = read_stored_config().unwrap_or_default();
    update(&mut config);
    write_stored_config(&config)
}

fn remove_stored_token() -> Result<PathBuf, String> {
    delete_keychain_token();
    if let Ok(path) = token_path() {
        let _ = fs::remove_file(path);
    }
    update_stored_config(|config| {
        config.token = None;
    })
}

// ---------------------------------------------------------------------------
// RFC 8628 device-code login flow.
//
// Server side (apps/web/src/pages/oauth/device.ts + token.ts) is workspace-
// aware: the verification page asks the user to pick a workspace, and the
// token-issuance response returns `workspace_id` alongside the access token.
// That lets the CLI store the workspace without an extra round-trip.
// ---------------------------------------------------------------------------

const VPG_CLI_CLIENT_ID: &str = "oac_vpg_cli";
const DEVICE_MIN_POLL_INTERVAL_S: u64 = 5;
const DEVICE_DEFAULT_EXPIRES_S: u64 = 600;
const DEVICE_SLOW_DOWN_BUMP_S: u64 = 5;

#[derive(Debug, Deserialize)]
struct DeviceAuthResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    #[serde(default = "default_device_expires")]
    expires_in: u64,
    #[serde(default = "default_device_interval")]
    interval: u64,
}

fn default_device_expires() -> u64 {
    DEVICE_DEFAULT_EXPIRES_S
}

fn default_device_interval() -> u64 {
    DEVICE_MIN_POLL_INTERVAL_S
}

#[derive(Debug, Deserialize)]
struct DeviceTokenSuccess {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OAuthErrorBody {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

fn device_authorize(client: &Client, base_url: &str) -> Result<DeviceAuthResponse, String> {
    let url = format!("{}/oauth/device", base_url.trim_end_matches('/'));
    let response = client
        .post(&url)
        .header(CONTENT_TYPE, "application/json")
        .json(&json!({
            "client_id": VPG_CLI_CLIENT_ID,
            "scope": "mcp",
        }))
        .send()
        .map_err(|error| format!("device authorization request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body: OAuthErrorBody = response
            .json()
            .unwrap_or(OAuthErrorBody {
                error: "server_error".to_string(),
                error_description: Some(format!("HTTP {status}")),
            });
        return Err(format!(
            "device authorization failed ({}): {}",
            body.error,
            body.error_description
                .unwrap_or_else(|| "no description".to_string()),
        ));
    }
    response
        .json::<DeviceAuthResponse>()
        .map_err(|error| format!("device authorization response was not valid JSON: {error}"))
}

fn poll_device_token(
    client: &Client,
    base_url: &str,
    device_code: &str,
    initial_interval_s: u64,
    expires_in_s: u64,
) -> Result<DeviceTokenSuccess, String> {
    let url = format!("{}/oauth/token", base_url.trim_end_matches('/'));
    let deadline = Instant::now() + Duration::from_secs(expires_in_s);
    let mut interval_s = initial_interval_s.max(DEVICE_MIN_POLL_INTERVAL_S);
    loop {
        if Instant::now() >= deadline {
            return Err(
                "device code expired before authorization completed. Run `vpg login` again."
                    .to_string(),
            );
        }
        thread::sleep(Duration::from_secs(interval_s));
        // Use JSON instead of application/x-www-form-urlencoded so the request
        // is not treated as a cross-site form POST by Astro's built-in CSRF
        // protection on adapter=node. Both content types are accepted by
        // apps/web/src/pages/oauth/token.ts; JSON works against every adapter.
        let response = client
            .post(&url)
            .json(&json!({
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "device_code": device_code,
                "client_id": VPG_CLI_CLIENT_ID,
            }))
            .send()
            .map_err(|error| format!("device token poll failed: {error}"))?;
        let status = response.status();
        if status.is_success() {
            return response
                .json::<DeviceTokenSuccess>()
                .map_err(|error| format!("device token response was not valid JSON: {error}"));
        }
        let body: OAuthErrorBody = response.json().unwrap_or(OAuthErrorBody {
            error: "server_error".to_string(),
            error_description: Some(format!("HTTP {status}")),
        });
        match body.error.as_str() {
            "authorization_pending" => {
                // Keep polling at the current interval.
            }
            "slow_down" => {
                interval_s = interval_s.saturating_add(DEVICE_SLOW_DOWN_BUMP_S);
            }
            "access_denied" => {
                return Err(
                    "authorization denied. Re-run `vpg login` to try again.".to_string(),
                );
            }
            "expired_token" => {
                return Err(
                    "device code expired before authorization completed. Run `vpg login` again."
                        .to_string(),
                );
            }
            other => {
                return Err(format!(
                    "device token error ({}): {}",
                    other,
                    body.error_description
                        .unwrap_or_else(|| "no description".to_string())
                ));
            }
        }
    }
}

fn try_open_browser(url: &str) -> bool {
    if env::var("VPG_NO_OPEN").is_ok() {
        return false;
    }
    #[cfg(target_os = "macos")]
    let opener = ("open", &[url][..]);
    #[cfg(all(unix, not(target_os = "macos")))]
    let opener = ("xdg-open", &[url][..]);
    #[cfg(target_os = "windows")]
    let opener = ("cmd", &["/C", "start", "", url][..]);
    #[cfg(not(any(target_os = "macos", unix, target_os = "windows")))]
    {
        let _ = url;
        return false;
    }
    #[cfg(any(target_os = "macos", unix, target_os = "windows"))]
    {
        ProcessCommand::new(opener.0)
            .args(opener.1)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|mut child| {
                // Don't wait — the browser may stay attached for a while.
                let _ = child.try_wait();
                true
            })
            .unwrap_or(false)
    }
}

fn run_device_login(cli: &Cli, no_browser: bool) -> Result<Value, String> {
    let base_url = cli.base_url.trim_end_matches('/').to_string();
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("failed to build HTTP client: {error}"))?;
    let auth = device_authorize(&client, &base_url)?;
    let visit_url = auth
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| auth.verification_uri.clone());

    // Human-readable progress goes to stderr so JSON output stays parseable
    // when scripts pipe stdout.
    eprintln!();
    eprintln!("Sign in to VegaStack Pages");
    eprintln!("──────────────────────────");
    eprintln!();
    eprintln!("  1. Open this URL in your browser:");
    eprintln!("       {visit_url}");
    eprintln!();
    eprintln!("  2. Confirm the code matches:");
    eprintln!("       {}", auth.user_code);
    eprintln!();
    eprintln!("  3. Pick a workspace and click Allow.");
    eprintln!();
    let opened = if no_browser {
        false
    } else {
        try_open_browser(&visit_url)
    };
    if opened {
        eprintln!("  (Your browser should open automatically. Waiting…)");
    } else {
        eprintln!("  (Waiting for authorization in your browser…)");
    }
    eprintln!();

    let token = poll_device_token(
        &client,
        &base_url,
        &auth.device_code,
        auth.interval,
        auth.expires_in,
    )?;

    let workspace = token
        .workspace_id
        .clone()
        .or_else(|| cli.workspace.clone())
        .ok_or_else(|| {
            "login completed but the server did not return a workspace_id".to_string()
        })?;

    let token_storage = write_stored_token(&token.access_token)?;
    let path = update_stored_config(|config| {
        config.token = None;
        config.base_url = Some(base_url.clone());
        config.workspace = Some(workspace.clone());
    })?;

    eprintln!("✓ Logged in. Workspace: {workspace}");
    eprintln!();

    Ok(json!({
        "status": "ok",
        "message": "Signed in via browser device flow. Use vpg logout to remove the token.",
        "config": path.display().to_string(),
        "token_storage": token_storage,
        "base_url": base_url,
        "workspace": workspace,
        "expires_in": token.expires_in,
        "has_refresh_token": token.refresh_token.is_some(),
        "flow": "device"
    }))
}

fn resolved_workspace(cli: &Cli) -> Result<String, String> {
    cli.workspace
        .clone()
        .or_else(|| {
            read_stored_config()
                .ok()
                .and_then(|config| config.workspace)
        })
        .ok_or_else(|| {
            "workspace_id is required; pass --workspace <id> or run `vpg use <workspace>`."
                .to_string()
        })
}

fn resolved_token_source(cli: &Cli) -> &'static str {
    if cli.token.is_some() {
        "flag_or_env"
    } else if read_stored_token().is_some() {
        "stored"
    } else {
        "none"
    }
}

fn read_source(file: &Option<String>, use_stdin: bool) -> Result<String, String> {
    if use_stdin {
        let mut source = String::new();
        io::stdin()
            .read_to_string(&mut source)
            .map_err(|error| format!("failed to read stdin: {error}"))?;
        return Ok(source);
    }
    if let Some(file) = file {
        return fs::read_to_string(file).map_err(|error| format!("failed to read {file}: {error}"));
    }
    Ok(String::new())
}

fn read_source_value(
    inline: &Option<String>,
    file: &Option<String>,
    use_stdin: bool,
) -> Result<String, String> {
    if inline.is_some() && (file.is_some() || use_stdin) {
        return Err("--source cannot be combined with --file or --stdin".to_string());
    }
    if let Some(source) = inline {
        return Ok(source.clone());
    }
    read_source(file, use_stdin)
}

fn read_attachment_base64_body(
    inline: &Option<String>,
    file: &Option<String>,
) -> Result<String, String> {
    match (inline, file) {
        (Some(_), Some(_)) => Err("--base64-body and --base64-file cannot be combined".to_string()),
        (Some(value), None) => Ok(value.clone()),
        (None, Some(path)) => {
            fs::read_to_string(path).map_err(|error| format!("failed to read {path}: {error}"))
        }
        (None, None) => Err("--base64-body or --base64-file is required".to_string()),
    }
}

fn build_validate_source_body(
    workspace_id: Option<String>,
    page_id: Option<String>,
    source: Option<String>,
    source_type: Option<&SourceType>,
) -> Value {
    let mut body = serde_json::Map::new();
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
            Value::String(source_type.as_api_value().to_string()),
        );
    }
    Value::Object(body)
}

fn build_publish_body(
    permission: &PublicationPermission,
    expires_at: &Option<String>,
    password: &Option<String>,
    indexing_enabled: &Option<bool>,
) -> Value {
    let mut body = serde_json::Map::new();
    body.insert(
        "permission".to_string(),
        Value::String(permission.as_api_value().to_string()),
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

fn default_title(file: &Option<String>, title: &Option<String>) -> String {
    if let Some(title) = title {
        return title.clone();
    }
    file.as_deref()
        .and_then(|value| Path::new(value).file_stem())
        .and_then(|value| value.to_str())
        .map(|value| value.replace(['-', '_'], " "))
        .unwrap_or_else(|| "Untitled".to_string())
}

fn resolve_template_id(api: &Api, workspace: &str, identifier: &str) -> Result<String, String> {
    if identifier.starts_with("tpl_") {
        return Ok(identifier.to_string());
    }
    let list = api.get(&format!("/api/workspaces/{workspace}/templates"), &[])?;
    let templates = list
        .get("templates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let matched = templates.iter().find(|template| {
        template.get("slug").and_then(Value::as_str) == Some(identifier)
            || template.get("name").and_then(Value::as_str) == Some(identifier)
    });
    match matched {
        Some(template) => template
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "template entry missing id".to_string()),
        None => Err(format!(
            "template not found in workspace {workspace}: {identifier}"
        )),
    }
}

fn build_property_object(entries: &[(String, String)]) -> Value {
    let mut map = serde_json::Map::new();
    for (key, value) in entries {
        map.insert(key.clone(), parse_cli_value(value));
    }
    Value::Object(map)
}

fn parse_cli_value(value: &str) -> Value {
    if value.contains(',') {
        let list: Vec<Value> = value
            .split(',')
            .map(|part| Value::String(part.trim().to_string()))
            .filter(|entry| matches!(entry, Value::String(text) if !text.is_empty()))
            .collect();
        return Value::Array(list);
    }
    if value == "true" || value == "false" {
        return Value::Bool(value == "true");
    }
    if let Ok(number) = value.parse::<f64>() {
        return serde_json::Number::from_f64(number)
            .map(Value::Number)
            .unwrap_or_else(|| Value::String(value.to_string()));
    }
    Value::String(value.to_string())
}

fn read_json_text(
    source: &Option<String>,
    file: &Option<String>,
) -> Result<Option<String>, String> {
    match (source, file) {
        (Some(_), Some(_)) => Err("--args and --args-file cannot be used together".to_string()),
        (Some(value), None) => Ok(Some(value.clone())),
        (None, Some(path)) if path == "-" => {
            let mut text = String::new();
            io::stdin()
                .read_to_string(&mut text)
                .map_err(|error| format!("failed to read stdin: {error}"))?;
            Ok(Some(text))
        }
        (None, Some(path)) => fs::read_to_string(path)
            .map(Some)
            .map_err(|error| format!("failed to read {path}: {error}")),
        (None, None) => Ok(None),
    }
}

fn read_json_arguments(
    source: &Option<String>,
    file: &Option<String>,
    set: &[(String, String)],
    workspace: Option<String>,
) -> Result<Value, String> {
    let mut args = match read_json_text(source, file)? {
        Some(text) if !text.trim().is_empty() => serde_json::from_str::<Value>(&text)
            .map_err(|error| format!("invalid JSON arguments: {error}"))?,
        _ => json!({}),
    };
    if !args.is_object() {
        return Err("CLI JSON arguments must be a JSON object".to_string());
    }
    if let Some(workspace) = workspace {
        let object = args
            .as_object_mut()
            .ok_or_else(|| "CLI JSON arguments must be a JSON object".to_string())?;
        object
            .entry("workspace_id")
            .or_insert_with(|| Value::String(workspace));
    }
    for (key, value) in set {
        set_json_path(&mut args, key, parse_cli_value(value))?;
    }
    Ok(args)
}

fn read_optional_json_object(
    inline: &Option<String>,
    file: &Option<String>,
    label: &str,
) -> Result<Option<Value>, String> {
    match (inline, file) {
        (Some(_), Some(_)) => Err(format!(
            "--{label}-json and --{label}-file cannot be used together"
        )),
        (Some(value), None) => parse_json_object(value, label).map(Some),
        (None, Some(path)) if path == "-" => {
            let mut text = String::new();
            io::stdin()
                .read_to_string(&mut text)
                .map_err(|error| format!("failed to read stdin: {error}"))?;
            parse_json_object(&text, label).map(Some)
        }
        (None, Some(path)) => {
            let text = fs::read_to_string(path)
                .map_err(|error| format!("failed to read {path}: {error}"))?;
            parse_json_object(&text, label).map(Some)
        }
        (None, None) => Ok(None),
    }
}

fn parse_json_object(text: &str, label: &str) -> Result<Value, String> {
    let value = serde_json::from_str::<Value>(text)
        .map_err(|error| format!("invalid {label} JSON: {error}"))?;
    if !value.is_object() {
        return Err(format!("{label} JSON must be an object"));
    }
    Ok(value)
}

fn build_comment_anchor_body(
    anchor_json: &Option<String>,
    anchor_file: &Option<String>,
    selected_text: &Option<String>,
    source_start: &Option<i64>,
    source_end: &Option<i64>,
    prefix_text: &str,
    suffix_text: &str,
    anchor_kind: &AnchorKind,
    surface: &AnchorSurface,
    confidence: &Option<AnchorConfidence>,
) -> Result<Value, String> {
    let mut anchor =
        read_optional_json_object(anchor_json, anchor_file, "anchor")?.unwrap_or_else(|| json!({}));
    let object = anchor
        .as_object_mut()
        .ok_or_else(|| "anchor JSON must be an object".to_string())?;
    object
        .entry("anchor_kind".to_string())
        .or_insert_with(|| Value::String(anchor_kind.as_api_value().to_string()));
    object
        .entry("surface".to_string())
        .or_insert_with(|| Value::String(surface.as_api_value().to_string()));
    if let Some(value) = selected_text {
        object.insert("selected_text".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = source_start {
        object.insert(
            "source_start".to_string(),
            Value::Number(serde_json::Number::from(*value)),
        );
    }
    if let Some(value) = source_end {
        object.insert(
            "source_end".to_string(),
            Value::Number(serde_json::Number::from(*value)),
        );
    }
    if !prefix_text.is_empty() {
        object.insert(
            "prefix_text".to_string(),
            Value::String(prefix_text.to_string()),
        );
    }
    if !suffix_text.is_empty() {
        object.insert(
            "suffix_text".to_string(),
            Value::String(suffix_text.to_string()),
        );
    }
    if let Some(value) = confidence {
        object.insert(
            "confidence".to_string(),
            Value::String(value.as_api_value().to_string()),
        );
    }
    Ok(anchor)
}

fn set_json_path(target: &mut Value, path: &str, value: Value) -> Result<(), String> {
    let parts: Vec<&str> = path.split('.').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return Err("CLI --set keys must not be empty".to_string());
    }
    let mut current = target;
    for part in &parts[..parts.len() - 1] {
        if !current.is_object() {
            *current = json!({});
        }
        let object = current
            .as_object_mut()
            .ok_or_else(|| "CLI JSON arguments must be a JSON object".to_string())?;
        current = object
            .entry((*part).to_string())
            .or_insert_with(|| json!({}));
    }
    let object = current
        .as_object_mut()
        .ok_or_else(|| "CLI JSON arguments must be a JSON object".to_string())?;
    object.insert(parts[parts.len() - 1].to_string(), value);
    Ok(())
}

fn resolve_page_id(api: &Api, page: &str, workspace: &str) -> Result<String, String> {
    if page.starts_with("pg_") {
        return Ok(page.to_string());
    }
    let response = api.get(
        &format!("/api/pages/{page}"),
        &[
            ("workspace_id", workspace.to_string()),
            ("include", "metadata".to_string()),
        ],
    )?;
    response
        .get("page_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "page lookup did not return page_id".to_string())
}

fn run(cli: &Cli) -> Result<Value, String> {
    let api = Api::new(cli)?;
    match &cli.command {
        Some(Command::Workspaces) => api.get("/api/workspaces", &[]),
        Some(Command::Create {
            title,
            file,
            stdin,
            source_type,
            folder_path,
            template,
            set,
        }) => {
            let active_workspace = resolved_workspace(cli)?;
            if let Some(template) = template {
                let resolved_title = default_title(file, title);
                let properties = build_property_object(set);
                let template_id = resolve_template_id(&api, &active_workspace, template)?;
                api.post(
                    &with_workspace_query(
                        &format!("/api/templates/{template_id}/pages"),
                        &active_workspace,
                    ),
                    json!({
                        "title": resolved_title,
                        "folder_path": folder_path,
                        "properties": properties,
                    }),
                )
            } else {
                let source = read_source(file, *stdin)?;
                api.post(
                    &format!("/api/workspaces/{active_workspace}/pages"),
                    json!({
                        "title": default_title(file, title),
                        "source_type": source_type.as_api_value(),
                        "folder_path": folder_path,
                        "source": source
                    }),
                )
            }
        }
        Some(Command::Templates { command }) => match command {
            TemplateCommand::List { category } => {
                let active_workspace = resolved_workspace(cli)?;
                let mut params = Vec::new();
                if let Some(value) = category {
                    params.push(("category", value.clone()));
                }
                let path = format!("/api/workspaces/{active_workspace}/templates");
                api.get(&path, &params)
            }
            TemplateCommand::Show { template } => {
                let active_workspace = resolved_workspace(cli)?;
                let template_id = resolve_template_id(&api, &active_workspace, template)?;
                api.get(
                    &format!("/api/templates/{template_id}"),
                    &[("workspace_id", active_workspace)],
                )
            }
            TemplateCommand::Render {
                template,
                title,
                set,
            } => {
                let active_workspace = resolved_workspace(cli)?;
                let template_id = resolve_template_id(&api, &active_workspace, template)?;
                let properties = build_property_object(set);
                api.post(
                    &with_workspace_query(
                        &format!("/api/templates/{template_id}/render"),
                        &active_workspace,
                    ),
                    json!({
                        "title": title,
                        "properties": properties,
                    }),
                )
            }
            TemplateCommand::Create {
                args,
                args_file,
                set,
            } => {
                let active_workspace = resolved_workspace(cli)?;
                let body = read_json_arguments(args, args_file, set, None)?;
                api.post(
                    &format!("/api/workspaces/{active_workspace}/templates"),
                    body,
                )
            }
            TemplateCommand::Update {
                template,
                args,
                args_file,
                set,
            } => {
                let active_workspace = resolved_workspace(cli)?;
                let template_id = resolve_template_id(&api, &active_workspace, template)?;
                let body = read_json_arguments(args, args_file, set, None)?;
                api.patch(
                    &with_workspace_query(
                        &format!("/api/templates/{template_id}"),
                        &active_workspace,
                    ),
                    body,
                )
            }
        },
        Some(Command::Pages { command }) => {
            let active_workspace = resolved_workspace(cli)?;
            match command {
                PageCommand::Get { page } => {
                    api.get(
                        &format!("/api/pages/{page}"),
                        &[
                            ("workspace_id", active_workspace.clone()),
                            ("include", "source".to_string()),
                        ],
                    )
                }
                PageCommand::Rendered { page } => {
                    let value = api.get(
                        &format!("/api/pages/{page}"),
                        &[
                            ("workspace_id", active_workspace.clone()),
                            ("include", "rendered".to_string()),
                        ],
                    )?;
                    Ok(value.get("rendered").cloned().unwrap_or(value))
                }
                PageCommand::Versions { page } => {
                    api.get(
                        &format!("/api/pages/{page}"),
                        &[
                            ("workspace_id", active_workspace.clone()),
                            ("include", "versions".to_string()),
                        ],
                    )
                }
                PageCommand::Snapshot { page, label } => {
                    let page_id = resolve_page_id(&api, page, &active_workspace)?;
                    api.post(
                        &with_workspace_query(
                            &format!("/api/pages/{page_id}/snapshot"),
                            &active_workspace,
                        ),
                        json!({ "label": label }),
                    )
                }
                PageCommand::RestoreVersion { page, version_id } => {
                    let page_id = resolve_page_id(&api, page, &active_workspace)?;
                    api.post(
                        &with_workspace_query(
                            &format!("/api/pages/{page_id}/versions"),
                            &active_workspace,
                        ),
                        json!({ "version_id": version_id }),
                    )
                }
                PageCommand::PrepareEdit { page } => {
                    let page_id = resolve_page_id(&api, page, &active_workspace)?;
                    let source = api.get(
                        &format!("/api/pages/{page_id}/source"),
                        &[
                            ("intent", "edit".to_string()),
                            ("workspace_id", active_workspace.clone()),
                        ],
                    )?;
                    Ok(json!({
                        "workspace_id": active_workspace,
                        "page_id": page_id,
                        "source": source.get("source").cloned().unwrap_or(Value::String(String::new())),
                        "base_version_id": source.get("version_id").cloned().unwrap_or(Value::Null),
                        "base_content_hash": source.get("etag").cloned().unwrap_or(Value::Null),
                        "update_page_arguments": {
                            "workspace_id": active_workspace,
                            "page_id": page_id,
                            "source": source.get("source").cloned().unwrap_or(Value::String(String::new())),
                            "base_version_id": source.get("version_id").cloned().unwrap_or(Value::Null),
                            "base_content_hash": source.get("etag").cloned().unwrap_or(Value::Null)
                        }
                    }))
                }
                PageCommand::UpdateSource {
                    page,
                    source,
                    file,
                    stdin,
                    base_version_id,
                    base_content_hash,
                    checkpoint,
                    checkpoint_label,
                    allow_noop,
                } => {
                    let page_id = resolve_page_id(&api, page, &active_workspace)?;
                    let source = read_source_value(source, file, *stdin)?;
                    api.put(
                        &with_workspace_query(
                            &format!("/api/pages/{page_id}/source"),
                            &active_workspace,
                        ),
                        json!({
                            "source": source,
                            "base_version_id": base_version_id,
                            "base_content_hash": base_content_hash,
                            "checkpoint": checkpoint,
                            "checkpoint_label": checkpoint_label,
                            "allow_noop": allow_noop
                        }),
                    )
                }
                PageCommand::Patch {
                    page,
                    find,
                    replace,
                    replace_all,
                    expected_replacements,
                    base_version_id,
                    base_content_hash,
                    checkpoint,
                    checkpoint_label,
                } => {
                    let page_id = resolve_page_id(&api, page, &active_workspace)?;
                    api.post(
                        &with_workspace_query(
                            &format!("/api/pages/{page_id}/patch"),
                            &active_workspace,
                        ),
                        json!({
                            "find": find,
                            "replace": replace,
                            "replace_all": replace_all,
                            "expected_replacements": expected_replacements,
                            "base_version_id": base_version_id,
                            "base_content_hash": base_content_hash,
                            "checkpoint": checkpoint,
                            "checkpoint_label": checkpoint_label
                        }),
                    )
                }
                PageCommand::Validate {
                    page,
                    source,
                    file,
                    stdin,
                    source_type,
                } => {
                    let source = if source.is_some() || file.is_some() || *stdin {
                        Some(read_source_value(source, file, *stdin)?)
                    } else {
                        None
                    };
                    let page_id = match page {
                        Some(value) => Some(resolve_page_id(&api, value, &active_workspace)?),
                        None => None,
                    };
                    api.post(
                        &with_workspace_query("/api/validate-source", &active_workspace),
                        build_validate_source_body(
                            Some(active_workspace),
                            page_id,
                            source,
                            source_type.as_ref(),
                        ),
                    )
                }
                PageCommand::Move {
                    page,
                    title,
                    folder_path,
                } => {
                    let page_id = resolve_page_id(&api, page, &active_workspace)?;
                    api.post(
                        &with_workspace_query(
                            &format!("/api/pages/{page_id}/move"),
                            &active_workspace,
                        ),
                        json!({ "title": title, "folder_path": folder_path }),
                    )
                }
            }
        }
        Some(Command::Attachments { command }) => match command {
            AttachmentCommand::Upload {
                page,
                filename,
                content_type,
                base64_body,
                base64_file,
            } => {
                let active_workspace = resolved_workspace(cli)?;
                let page_id = resolve_page_id(&api, page, &active_workspace)?;
                let base64_body = read_attachment_base64_body(base64_body, base64_file)?;
                api.post(
                    &with_workspace_query(
                        &format!("/api/pages/{page_id}/attachments"),
                        &active_workspace,
                    ),
                    json!({
                        "filename": filename,
                        "content_type": content_type,
                        "base64_body": base64_body
                    }),
                )
            }
        },
        Some(Command::Members { command }) => match command {
            MemberCommand::Invite {
                email,
                display_name,
                role,
                workspace,
            } => {
                let active_workspace = workspace.clone().unwrap_or(resolved_workspace(cli)?);
                api.post(
                    &format!("/api/workspaces/{active_workspace}/invites"),
                    json!({
                        "email": email,
                        "display_name": display_name,
                        "role": role.as_api_value()
                    }),
                )
            }
        },
        Some(Command::Comments { page, status }) => {
            let active_workspace = resolved_workspace(cli)?;
            let page_id = resolve_page_id(&api, page, &active_workspace)?;
            api.get(
                &format!("/api/pages/{page_id}/comments"),
                &[
                    ("status", status.to_string()),
                    ("workspace_id", active_workspace),
                ],
            )
        }
        Some(Command::Comment {
            page,
            body,
            anchor_json,
            anchor_file,
            selected_text,
            source_start,
            source_end,
            prefix_text,
            suffix_text,
            anchor_kind,
            surface,
            confidence,
        }) => {
            let active_workspace = resolved_workspace(cli)?;
            let page_id = resolve_page_id(&api, page, &active_workspace)?;
            let anchor = build_comment_anchor_body(
                anchor_json,
                anchor_file,
                selected_text,
                source_start,
                source_end,
                prefix_text,
                suffix_text,
                anchor_kind,
                surface,
                confidence,
            )?;
            api.post(
                &with_workspace_query(&format!("/api/pages/{page_id}/comments"), &active_workspace),
                json!({
                    "body": body,
                    "anchor": anchor
                }),
            )
        }
        Some(Command::Reply {
            thread,
            body,
            agent_name,
            agent_model,
            agent_session,
        }) => {
            if agent_name.is_some() || agent_model.is_some() || agent_session.is_some() {
                return Err("use complete-thread for agent-attributed replies; omit --agent-* flags for user replies".to_string());
            }
            let active_workspace = resolved_workspace(cli)?;
            api.post(
                &with_workspace_query(
                    &format!("/api/comment-threads/{thread}/replies"),
                    &active_workspace,
                ),
                json!({
                    "body": body
                }),
            )
        }
        Some(Command::Resolve { thread }) => {
            let active_workspace = resolved_workspace(cli)?;
            api.post(
                &with_workspace_query(
                    &format!("/api/comment-threads/{thread}/resolve"),
                    &active_workspace,
                ),
                json!({}),
            )
        }
        Some(Command::Unresolve { thread }) => {
            let active_workspace = resolved_workspace(cli)?;
            api.post(
                &with_workspace_query(
                    &format!("/api/comment-threads/{thread}/unresolve"),
                    &active_workspace,
                ),
                json!({}),
            )
        }
        Some(Command::UpdateAnchor {
            thread,
            anchor_json,
            anchor_file,
            selected_text,
            source_start,
            source_end,
            prefix_text,
            suffix_text,
            anchor_kind,
            surface,
            confidence,
        }) => {
            let active_workspace = resolved_workspace(cli)?;
            let anchor = build_comment_anchor_body(
                anchor_json,
                anchor_file,
                selected_text,
                source_start,
                source_end,
                prefix_text,
                suffix_text,
                anchor_kind,
                surface,
                confidence,
            )?;
            api.patch(
                &with_workspace_query(
                    &format!("/api/comment-threads/{thread}/anchor"),
                    &active_workspace,
                ),
                json!({ "anchor": anchor }),
            )
        }
        Some(Command::DeleteThread { thread }) => {
            let active_workspace = resolved_workspace(cli)?;
            api.delete(&with_workspace_query(
                &format!("/api/comment-threads/{thread}"),
                &active_workspace,
            ))
        }
        Some(Command::CompleteThread {
            thread,
            body,
            resolve,
            agent_name,
            agent_model,
            agent_session_id,
        }) => {
            let active_workspace = resolved_workspace(cli)?;
            api.post(
                &with_workspace_query(
                    &format!("/api/comment-threads/{thread}/complete"),
                    &active_workspace,
                ),
                json!({
                    "body": body,
                    "resolve": resolve,
                    "agent_name": agent_name,
                    "agent_model": agent_model,
                    "agent_session_id": agent_session_id
                }),
            )
        }
        Some(Command::PublishPage {
            page,
            permission,
            expires_at,
            password,
            indexing_enabled,
        }) => {
            let active_workspace = resolved_workspace(cli)?;
            let page_id = resolve_page_id(&api, page, &active_workspace)?;
            api.put(
                &with_workspace_query(
                    &format!("/api/pages/{page_id}/publication"),
                    &active_workspace,
                ),
                build_publish_body(permission, expires_at, password, indexing_enabled),
            )
        }
        Some(Command::PublishFolder {
            folder,
            permission,
            expires_at,
            password,
            indexing_enabled,
        }) => {
            let active_workspace = resolved_workspace(cli)?;
            api.put(
                &with_workspace_query(
                    &format!("/api/folders/{folder}/publication"),
                    &active_workspace,
                ),
                build_publish_body(permission, expires_at, password, indexing_enabled),
            )
        }
        Some(Command::RevokePublication { publication }) => {
            let active_workspace = resolved_workspace(cli)?;
            api.delete(&with_workspace_query(
                &format!("/api/publications/{publication}"),
                &active_workspace,
            ))
        }
        Some(Command::UpdatePublication {
            publication,
            permission,
            expires_at,
            clear_expires_at,
            password,
            clear_password,
            indexing_enabled,
        }) => {
            let active_workspace = resolved_workspace(cli)?;
            let mut body = serde_json::Map::new();
            if let Some(permission) = permission {
                body.insert(
                    "permission".to_string(),
                    Value::String(permission.as_api_value().to_string()),
                );
            }
            if *clear_expires_at {
                body.insert("expires_at".to_string(), Value::Null);
            } else if let Some(expires_at) = expires_at {
                body.insert("expires_at".to_string(), Value::String(expires_at.clone()));
            }
            if *clear_password {
                body.insert("password".to_string(), Value::Null);
            } else if let Some(password) = password {
                body.insert("password".to_string(), Value::String(password.clone()));
            }
            if let Some(indexing_enabled) = indexing_enabled {
                body.insert(
                    "indexing_enabled".to_string(),
                    Value::Bool(*indexing_enabled),
                );
            }
            api.patch(
                &with_workspace_query(
                    &format!("/api/publications/{publication}"),
                    &active_workspace,
                ),
                Value::Object(body),
            )
        }
        Some(Command::Search {
            query,
            resource_type,
            limit,
        }) => {
            let active_workspace = resolved_workspace(cli)?;
            let mut value = api.get(
                "/api/search",
                &[
                    ("workspace_id", active_workspace),
                    ("q", query.clone()),
                    ("type", resource_type.as_api_value().to_string()),
                    ("limit", limit.to_string()),
                ],
            )?;
            if let Some(object) = value.as_object_mut() {
                object.insert("format".to_string(), json!("search_results"));
            }
            Ok(value)
        }
        Some(Command::Events {
            page,
            workspace,
            after_id,
            limit,
        }) => {
            let active_workspace = workspace.clone().unwrap_or(resolved_workspace(cli)?);
            let mut params = vec![
                ("limit", limit.to_string()),
                ("workspace_id", active_workspace.clone()),
            ];
            if let Some(page) = page {
                params.push(("page_id", resolve_page_id(&api, page, &active_workspace)?));
            }
            if let Some(after_id) = after_id {
                params.push(("after_id", after_id.clone()));
            }
            api.get("/api/review-events", &params)
        }
        Some(Command::Tree { workspace }) => {
            let workspace = workspace.clone().unwrap_or(resolved_workspace(cli)?);
            api.get(&format!("/api/workspaces/{workspace}/tree"), &[])
        }
        Some(Command::Wait {
            page,
            until,
            timeout_seconds,
            poll_seconds,
            after_id,
        }) => {
            let active_workspace = resolved_workspace(cli)?;
            wait_for_review(
                &api,
                page,
                &active_workspace,
                until,
                *timeout_seconds,
                *poll_seconds,
                after_id.as_deref(),
            )
        }
        Some(Command::Doctor) => api.get("/api/setup/status", &[]),
        Some(Command::Skills { command }) => match command {
            SkillCommand::Path => Ok(json!({
                "status": "ok",
                "name": SKILL_NAME,
                "source": source_skill_dir()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|| "embedded".to_string())
            })),
            SkillCommand::Print => Ok(skill_print_payload()),
            SkillCommand::Doctor => Ok(skill_doctor()),
            SkillCommand::Install {
                agent,
                scope,
                dir,
                force,
                dry_run,
            } => install_skill(*agent, *scope, dir, *force, *dry_run),
            SkillCommand::Update {
                agent,
                scope,
                dry_run,
            } => install_skill(*agent, *scope, &None, true, *dry_run),
        },
        Some(Command::Login { token, no_browser }) => {
            if let Some(token) = token.as_ref().or(cli.token.as_ref()) {
                let active_workspace = resolved_workspace(cli)?;
                let token_storage = write_stored_token(token)?;
                let path = update_stored_config(|config| {
                    config.token = None;
                    config.base_url = Some(cli.base_url.clone());
                    config.workspace = Some(active_workspace.clone());
                })?;
                Ok(json!({
                    "status": "ok",
                    "message": "CLI token stored. Use vpg logout to remove it.",
                    "config": path.display().to_string(),
                    "token_storage": token_storage,
                    "base_url": cli.base_url,
                    "workspace": active_workspace,
                    "flow": "manual"
                }))
            } else {
                run_device_login(cli, *no_browser)
            }
        }
        Some(Command::Logout) => {
            let path = remove_stored_token()?;
            Ok(json!({
                "status": "ok",
                "message": "Stored CLI token removed.",
                "config": path.display().to_string()
            }))
        }
        Some(Command::Whoami) => Ok(json!({
            "status": "ok",
            "workspace": resolved_workspace(cli).ok(),
            "base_url": cli.base_url,
            "auth_source": resolved_token_source(cli)
        })),
        Some(Command::Use { workspace }) => {
            let path = update_stored_config(|config| {
                config.workspace = Some(workspace.clone());
                config.base_url = Some(cli.base_url.clone());
            })?;
            Ok(json!({
                "status": "ok",
                "message": format!("Default workspace set to {workspace}."),
                "workspace": workspace,
                "config": path.display().to_string()
            }))
        }
        Some(Command::Export { workspace }) => {
            let active_workspace = match workspace {
                Some(value) => value.clone(),
                None => resolved_workspace(cli)?,
            };
            let workspace = active_workspace.as_str();
            let bytes = api.download(&format!("/api/workspaces/{workspace}/export"))?;
            let filename = format!("{workspace}-vegastack-pages.zip");
            let mut file = fs::File::create(&filename)
                .map_err(|error| format!("failed to create {filename}: {error}"))?;
            file.write_all(&bytes)
                .map_err(|error| format!("failed to write {filename}: {error}"))?;
            Ok(json!({
                "status": "ok",
                "workspace": workspace,
                "file": filename,
                "bytes": bytes.len()
            }))
        }
        Some(Command::Deploy {
            target,
            config,
            dry_run,
            managed,
            apply_migrations,
            skip_migrations,
        }) => deploy(
            target,
            config,
            *dry_run,
            *managed,
            *apply_migrations,
            *skip_migrations,
        ),
        Some(Command::Update { check, channel }) => run_update(*check, channel.clone()),
        None => Ok(json!(StatusOutput {
            status: "ok",
            message: "VegaStack Pages CLI"
        })),
    }
}

fn wait_for_review(
    api: &Api,
    page: &str,
    workspace: &str,
    until: &WaitCondition,
    timeout_seconds: u64,
    poll_seconds: u64,
    after_id: Option<&str>,
) -> Result<Value, String> {
    let timeout_seconds = timeout_seconds.min(600);
    let started = Instant::now();
    let mut cursor = after_id.map(str::to_string);
    loop {
        let event_params: Vec<(&str, String)> = vec![
            ("limit", "50".to_string()),
            ("workspace_id", workspace.to_string()),
            ("until", wait_condition_api_value(until).to_string()),
        ];
        let mut status_params = event_params;
        if let Some(after) = cursor.as_deref() {
            status_params.push(("after_id", after.to_string()));
        }
        let status = api.get(
            &format!("/api/pages/{page}/review-status"),
            &status_params,
        )?;
        let page_id = status
            .get("page_id")
            .and_then(Value::as_str)
            .unwrap_or(page)
            .to_string();
        let event_items = status
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let threads = status
            .get("threads")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let condition_met = status.get("status").and_then(Value::as_str) == Some("matched");
        if condition_met {
            return Ok(json!({
                "status": "matched",
                "page_id": page_id,
                "condition": format!("{until:?}"),
                "timeout_seconds": timeout_seconds,
                "threads": threads,
                "events": event_items
            }));
        }
        if let Some(next_cursor) = status.get("next_cursor").and_then(Value::as_str) {
            cursor = Some(next_cursor.to_string());
        }
        if started.elapsed() >= Duration::from_secs(timeout_seconds) {
            return Ok(json!({
                "status": "timeout",
                "page_id": page_id,
                "condition": format!("{until:?}"),
                "timeout_seconds": timeout_seconds,
                "threads": threads,
                "events": event_items
            }));
        }
        thread::sleep(Duration::from_secs(poll_seconds.max(1)));
    }
}

fn deploy(
    target: &str,
    config: &str,
    dry_run: bool,
    managed: bool,
    apply_migrations: bool,
    skip_migrations: bool,
) -> Result<Value, String> {
    if apply_migrations && skip_migrations {
        return Err("--apply-migrations and --skip-migrations cannot be used together".to_string());
    }
    match target {
        "cloudflare" => {
            let mut args = vec!["deploy:cloudflare".to_string(), "--".to_string()];
            if managed {
                args.push("--managed".to_string());
            }
            if apply_migrations || !skip_migrations {
                args.push("--apply-migrations".to_string());
            }
            if !dry_run {
                args.push("--deploy".to_string());
            }
            let status = ProcessCommand::new("pnpm")
                .args(&args)
                .env("VPG_CONFIG_PATH", config)
                .status()
                .map_err(|error| format!("failed to start Cloudflare deploy: {error}"))?;
            if !status.success() {
                return Err(format!("Cloudflare deploy failed with status {status}"));
            }
            Ok(json!({
                "status": "ok",
                "target": target,
                "config": config,
                "managed": managed,
                "deployed": !dry_run,
                "migrations_applied": apply_migrations || !skip_migrations
            }))
        }
        "docker" => Ok(json!({
            "status": "manual_step_required",
            "message": "Run docker compose from install/docker for the Node self-host target.",
            "target": target,
            "config": config
        })),
        _ => Err(format!("unsupported deploy target: {target}")),
    }
}

fn run_update(check_only: bool, channel_arg: Option<String>) -> Result<Value, String> {
    let current = env!("CARGO_PKG_VERSION");
    let channel = match channel_arg.as_deref() {
        Some("latest") | Some("next") => channel_arg.unwrap(),
        Some(other) => {
            return Err(format!(
                "unknown channel '{other}' — expected 'latest' or 'next'"
            ));
        }
        None => {
            if current.contains('-') {
                "next".to_string()
            } else {
                "latest".to_string()
            }
        }
    };

    eprintln!("Checking for updates…");
    let target = fetch_dist_tag(&channel)?;

    if compare_versions(current, &target) != std::cmp::Ordering::Less {
        return Ok(json!({
            "current": current,
            "target": target,
            "channel": channel,
            "update_available": false,
            "upgraded": false,
            "message": format!("You're up to date ({current})."),
        }));
    }

    if check_only {
        return Ok(json!({
            "current": current,
            "target": target,
            "channel": channel,
            "update_available": true,
            "upgraded": false,
            "message": format!("Update available: {current} → {target}"),
        }));
    }

    eprintln!("Update available: {current} → {target}");

    let installer = detect_installer();
    match installer {
        Installer::LocalDev => {
            return Err(
                "This looks like a local development build of vpg. Rebuild with: \
                 node scripts/build-native.mjs (inside cli/vegastack-pages)."
                    .into(),
            );
        }
        Installer::Unknown => {
            let spec = format!("@vegastack/pages@{channel}");
            return Err(format!(
                "Couldn't detect which package manager installed vpg.\n\
                 Run one of these to upgrade:\n  \
                 npm  i -g {spec}\n  \
                 pnpm add -g {spec}\n  \
                 bun  add -g {spec}\n  \
                 yarn global add {spec}"
            ));
        }
        _ => {}
    }

    // Windows holds the running .exe with a sharing-violation lock, so a
    // package manager that tries to replace the file in place will fail
    // partway through. Print the exact command to run from a fresh shell
    // instead of attempting the upgrade ourselves.
    if cfg!(windows) {
        let cmd = installer.upgrade_command(&channel);
        return Ok(json!({
            "current": current,
            "target": target,
            "channel": channel,
            "update_available": true,
            "upgraded": false,
            "installer": installer.name(),
            "message": format!(
                "Update available: {current} → {target}.\n\
                 On Windows, vpg can't replace its own .exe while it's running.\n\
                 Open a new terminal and run:\n  {cmd}"
            ),
        }));
    }

    eprintln!("Upgrading with {}…", installer.name());
    let status = installer.run_upgrade(&channel)?;
    if !status.success() {
        return Err(format!(
            "{} exited with status {} — vpg was not upgraded.",
            installer.name(),
            status.code().unwrap_or(-1)
        ));
    }

    Ok(json!({
        "current": current,
        "target": target,
        "channel": channel,
        "update_available": true,
        "upgraded": true,
        "installer": installer.name(),
        "message": format!("Updated to {target}."),
    }))
}

fn fetch_dist_tag(channel: &str) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("vpg/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("failed to create HTTP client: {error}"))?;
    let response = client
        .get("https://registry.npmjs.org/-/package/@vegastack/pages/dist-tags")
        .send()
        .map_err(|error| {
            format!(
                "Couldn't reach the npm registry. Check your connection and try again. ({error})"
            )
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "npm registry returned {} when fetching dist-tags for @vegastack/pages",
            status.as_u16()
        ));
    }
    let data: Value = response
        .json()
        .map_err(|error| format!("invalid response from npm registry: {error}"))?;
    data.get(channel)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("no @vegastack/pages release on the '{channel}' channel yet"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Installer {
    Npm,
    Pnpm,
    Bun,
    Yarn,
    LocalDev,
    Unknown,
}

impl Installer {
    fn name(&self) -> &'static str {
        match self {
            Installer::Npm => "npm",
            Installer::Pnpm => "pnpm",
            Installer::Bun => "bun",
            Installer::Yarn => "yarn",
            Installer::LocalDev => "local-dev",
            Installer::Unknown => "unknown",
        }
    }

    fn upgrade_argv(&self, channel: &str) -> Option<(&'static str, Vec<String>)> {
        let spec = format!("@vegastack/pages@{channel}");
        Some(match self {
            Installer::Npm => ("npm", vec!["install".into(), "-g".into(), spec]),
            Installer::Pnpm => ("pnpm", vec!["add".into(), "-g".into(), spec]),
            Installer::Bun => ("bun", vec!["add".into(), "-g".into(), spec]),
            Installer::Yarn => ("yarn", vec!["global".into(), "add".into(), spec]),
            Installer::LocalDev | Installer::Unknown => return None,
        })
    }

    fn upgrade_command(&self, channel: &str) -> String {
        match self.upgrade_argv(channel) {
            Some((cmd, args)) => format!("{cmd} {}", args.join(" ")),
            None => format!("@vegastack/pages@{channel}"),
        }
    }

    fn run_upgrade(&self, channel: &str) -> Result<std::process::ExitStatus, String> {
        let (cmd, args) = self
            .upgrade_argv(channel)
            .ok_or_else(|| "internal: run_upgrade called for non-runnable installer".to_string())?;
        ProcessCommand::new(cmd)
            .args(&args)
            .status()
            .map_err(|error| format!("failed to run {cmd}: {error}"))
    }
}

fn detect_installer() -> Installer {
    classify_install_path(env::var("VPG_INSTALL_BINARY").ok().as_deref())
}

fn classify_install_path(path: Option<&str>) -> Installer {
    let Some(raw) = path else {
        return Installer::Unknown;
    };
    if raw.is_empty() {
        return Installer::Unknown;
    }
    let p = raw.replace('\\', "/").to_lowercase();
    if p.contains("/cli/vegastack-pages/dist/") || p.contains("/vegastack-pages/dist/") {
        return Installer::LocalDev;
    }
    if p.contains("/.pnpm/")
        || p.contains("/pnpm/global/")
        || p.contains("/pnpm-global/")
        || p.contains("/library/pnpm/")
    {
        return Installer::Pnpm;
    }
    if p.contains("/.bun/") || p.contains("/bun/install/") {
        return Installer::Bun;
    }
    if p.contains("/.yarn/") || p.contains("/yarn/global/") {
        return Installer::Yarn;
    }
    if p.contains("/node_modules/") || p.contains("/lib/node_modules/") {
        return Installer::Npm;
    }
    Installer::Unknown
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let parse = |v: &str| -> (Vec<u64>, Option<String>) {
        let (core, pre) = match v.split_once('-') {
            Some((c, p)) => (c, Some(p.to_string())),
            None => (v, None),
        };
        let nums: Vec<u64> = core.split('.').map(|p| p.parse().unwrap_or(0)).collect();
        (nums, pre)
    };
    let (a_nums, a_pre) = parse(a);
    let (b_nums, b_pre) = parse(b);
    for i in 0..a_nums.len().max(b_nums.len()) {
        let x = a_nums.get(i).copied().unwrap_or(0);
        let y = b_nums.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    match (a_pre, b_pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(ap), Some(bp)) => compare_prerelease(&ap, &bp),
    }
}

fn compare_prerelease(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let a_parts: Vec<&str> = a.split('.').collect();
    let b_parts: Vec<&str> = b.split('.').collect();
    for i in 0..a_parts.len().max(b_parts.len()) {
        match (a_parts.get(i), b_parts.get(i)) {
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let ord = match (x.parse::<u64>().ok(), y.parse::<u64>().ok()) {
                    (Some(xn), Some(yn)) => xn.cmp(&yn),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (None, None) => break,
        }
    }
    Ordering::Equal
}

fn print_output(cli: &Cli, value: Value) {
    if cli.json {
        let mut output = value;
        if let Some(object) = output.as_object_mut() {
            object.remove("format");
        }
        println!(
            "{}",
            serde_json::to_string_pretty(&output).expect("serialize JSON output")
        );
    } else if value.get("format").and_then(Value::as_str) == Some("search_results") {
        print_search_results(&value);
    } else if let Some(message) = value.get("message").and_then(Value::as_str) {
        println!("{message}");
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&value).expect("serialize JSON output")
        );
    }
}

fn print_search_results(value: &Value) {
    let results = value
        .get("results")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if results.is_empty() {
        println!("No matches.");
        return;
    }
    println!(
        "{:<8}  {:<32}  {:<28}  {:<20}  {}",
        "TYPE", "TITLE", "PATH", "UPDATED", "URL"
    );
    for result in results {
        let kind = result.get("type").and_then(Value::as_str).unwrap_or("");
        let title = truncate(
            result.get("title").and_then(Value::as_str).unwrap_or(""),
            32,
        );
        let path = truncate(
            result
                .get("path")
                .or_else(|| result.get("subtitle"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            28,
        );
        let updated = truncate(
            result
                .get("updated_at")
                .or_else(|| result.get("updatedAt"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            20,
        );
        let url = result
            .get("url")
            .or_else(|| result.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        println!(
            "{:<8}  {:<32}  {:<28}  {:<20}  {}",
            kind, title, path, updated, url
        );
    }
}

fn truncate(value: &str, width: usize) -> String {
    let count = value.chars().count();
    if count <= width {
        return value.to_string();
    }
    if width <= 3 {
        return ".".repeat(width);
    }
    let mut output: String = value.chars().take(width - 3).collect();
    output.push_str("...");
    output
}

fn main() {
    let cli = Cli::parse();
    match run(&cli) {
        Ok(value) => print_output(&cli, value),
        Err(message) => {
            if cli.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "error": {
                            "code": "REQUEST_FAILED",
                            "message": message
                        }
                    }))
                    .expect("serialize error output")
                );
            } else {
                eprintln!("{message}");
            }
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn derives_title_from_file_when_title_is_omitted() {
        assert_eq!(
            default_title(&Some("plans/api-review.md".to_string()), &None),
            "api review"
        );
    }

    #[test]
    fn device_auth_response_defaults_apply_when_server_omits_them() {
        // The server is required to send expires_in + interval, but a robust
        // client should fall back if a deployment ever forgets.
        let body = r#"{
            "device_code": "abc",
            "user_code": "AAAA-BBBB",
            "verification_uri": "https://example.test/oauth/device/verify"
        }"#;
        let parsed: DeviceAuthResponse = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.device_code, "abc");
        assert_eq!(parsed.user_code, "AAAA-BBBB");
        assert_eq!(parsed.expires_in, DEVICE_DEFAULT_EXPIRES_S);
        assert_eq!(parsed.interval, DEVICE_MIN_POLL_INTERVAL_S);
        assert!(parsed.verification_uri_complete.is_none());
    }

    #[test]
    fn device_token_success_extracts_workspace_id_when_server_returns_it() {
        let body = r#"{
            "access_token": "mcp_abc",
            "refresh_token": "mcp_def",
            "expires_in": 3600,
            "workspace_id": "wks_42",
            "scope": "mcp"
        }"#;
        let parsed: DeviceTokenSuccess = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.access_token, "mcp_abc");
        assert_eq!(parsed.refresh_token.as_deref(), Some("mcp_def"));
        assert_eq!(parsed.workspace_id.as_deref(), Some("wks_42"));
        assert_eq!(parsed.expires_in, Some(3600));
    }

    #[test]
    fn cli_defaults_to_managed_service_base_url() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let previous = env::var_os("VPG_BASE_URL");
        env::remove_var("VPG_BASE_URL");

        let cli = Cli::try_parse_from(["vpg", "whoami"]).expect("parse cli");
        assert_eq!(cli.base_url, DEFAULT_BASE_URL);
        assert!(!cli.base_url.contains("127.0.0.1"));
        assert!(!cli.base_url.contains("localhost"));

        if let Some(value) = previous {
            env::set_var("VPG_BASE_URL", value);
        }
    }

    #[test]
    fn cli_uses_localhost_only_when_explicitly_configured() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let previous = env::var_os("VPG_BASE_URL");
        env::set_var("VPG_BASE_URL", "http://127.0.0.1:4322");

        let cli = Cli::try_parse_from(["vpg", "whoami"]).expect("parse cli");
        assert_eq!(cli.base_url, "http://127.0.0.1:4322");

        if let Some(value) = previous {
            env::set_var("VPG_BASE_URL", value);
        } else {
            env::remove_var("VPG_BASE_URL");
        }
    }

    #[test]
    fn source_type_matches_api_values() {
        assert_eq!(SourceType::Markdown.as_api_value(), "markdown");
        assert_eq!(SourceType::Mdx.as_api_value(), "mdx");
        assert_eq!(SourceType::Html.as_api_value(), "html");
    }

    #[test]
    fn json_arguments_merge_workspace_and_sets() {
        let args = read_json_arguments(
            &Some(r#"{"template":"tpl_123","properties":{"owner":"old"}}"#.to_string()),
            &None,
            &[
                ("title".to_string(), "Plan".to_string()),
                ("properties.owner".to_string(), "new".to_string()),
                ("properties.required".to_string(), "true".to_string()),
            ],
            Some("wks_123".to_string()),
        )
        .expect("json args");

        assert_eq!(args["workspace_id"], "wks_123");
        assert_eq!(args["template"], "tpl_123");
        assert_eq!(args["title"], "Plan");
        assert_eq!(args["properties"]["owner"], "new");
        assert_eq!(args["properties"]["required"], true);
    }

    #[test]
    fn json_arguments_do_not_overwrite_explicit_workspace() {
        let args = read_json_arguments(
            &Some(r#"{"workspace_id":"wks_explicit"}"#.to_string()),
            &None,
            &[],
            Some("wks_default".to_string()),
        )
        .expect("json args");

        assert_eq!(args["workspace_id"], "wks_explicit");
    }

    #[test]
    fn parses_rest_backed_parity_commands() {
        let cli = Cli::try_parse_from([
            "vpg",
            "pages",
            "patch",
            "pg_123",
            "--find",
            "old",
            "--replace",
            "new",
            "--base-version-id",
            "ver_123",
            "--base-content-hash",
            "hash_123",
            "--expected-replacements",
            "1",
        ])
        .expect("parse pages patch");
        match cli.command {
            Some(Command::Pages {
                command:
                    PageCommand::Patch {
                        page,
                        find,
                        replace,
                        base_version_id,
                        base_content_hash,
                        expected_replacements,
                        ..
                    },
            }) => {
                assert_eq!(page, "pg_123");
                assert_eq!(find, "old");
                assert_eq!(replace, "new");
                assert_eq!(base_version_id, "ver_123");
                assert_eq!(base_content_hash.as_deref(), Some("hash_123"));
                assert_eq!(expected_replacements, Some(1));
            }
            other => panic!("unexpected command: {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "vpg",
            "comment",
            "pg_123",
            "--body",
            "Looks good",
            "--selected-text",
            "heading",
            "--source-start",
            "2",
            "--source-end",
            "9",
        ])
        .expect("parse comment create");
        match cli.command {
            Some(Command::Comment {
                page,
                body,
                selected_text,
                source_start,
                source_end,
                ..
            }) => {
                assert_eq!(page, "pg_123");
                assert_eq!(body, "Looks good");
                assert_eq!(selected_text.as_deref(), Some("heading"));
                assert_eq!(source_start, Some(2));
                assert_eq!(source_end, Some(9));
            }
            other => panic!("unexpected command: {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "vpg",
            "update-anchor",
            "cmt_123",
            "--anchor-json",
            r#"{"anchor_kind":"point","surface":"html","selector":{"point":{"x":0.5,"y":0.25,"coordinateSpace":"document"}}}"#,
        ])
        .expect("parse anchor update");
        match cli.command {
            Some(Command::UpdateAnchor {
                thread,
                anchor_json,
                ..
            }) => {
                assert_eq!(thread, "cmt_123");
                assert!(anchor_json.as_deref().unwrap_or("").contains("point"));
            }
            other => panic!("unexpected command: {other:?}"),
        }

        let cli = Cli::try_parse_from([
            "vpg",
            "update-publication",
            "pub_123",
            "--clear-expires-at",
            "--clear-password",
            "--indexing-enabled",
            "false",
        ])
        .expect("parse publication update");
        match cli.command {
            Some(Command::UpdatePublication {
                publication,
                clear_expires_at,
                clear_password,
                indexing_enabled,
                ..
            }) => {
                assert_eq!(publication, "pub_123");
                assert!(clear_expires_at);
                assert!(clear_password);
                assert_eq!(indexing_enabled, Some(false));
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn parses_skill_install_command() {
        let cli = Cli::try_parse_from(["vpg", "skills", "install", "--dry-run"])
            .expect("parse skills install");

        match cli.command {
            Some(Command::Skills {
                command:
                    SkillCommand::Install {
                        agent,
                        scope,
                        dry_run,
                        ..
                    },
            }) => {
                assert!(matches!(agent, SkillAgent::All));
                assert!(matches!(scope, SkillScope::User));
                assert!(dry_run);
            }
            other => panic!("unexpected command: {other:?}"),
        }

        let update = Cli::try_parse_from(["vpg", "skills", "update", "--dry-run"])
            .expect("parse skills update");
        match update.command {
            Some(Command::Skills {
                command:
                    SkillCommand::Update {
                        agent,
                        scope,
                        dry_run,
                    },
            }) => {
                assert!(matches!(agent, SkillAgent::All));
                assert!(matches!(scope, SkillScope::User));
                assert!(dry_run);
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn skill_doctor_and_print_cover_every_embedded_file() {
        let doctor = skill_doctor();
        assert_eq!(doctor["status"], "ok");
        assert_eq!(doctor["file_count"], SKILL_FILES.len());
        assert_eq!(doctor["valid_frontmatter"], true);
        assert!(doctor["supported_agents"]
            .as_array()
            .expect("supported agents")
            .iter()
            .any(|agent| agent == "cursor"));

        let printed = skill_print_payload();
        let files = printed["files"].as_object().expect("files object");
        for (path, content) in SKILL_FILES {
            assert_eq!(
                files
                    .get(*path)
                    .and_then(Value::as_str)
                    .expect("printed file"),
                *content
            );
        }
    }

    #[test]
    fn skill_install_writes_adapter_without_network_and_updates_all() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = env::temp_dir().join(format!("vpg-skill-install-test-{stamp}"));
        let dir_arg = Some(dir.display().to_string());

        let result = install_skill(
            SkillAgent::Generic,
            SkillScope::Project,
            &dir_arg,
            false,
            false,
        )
        .expect("install skill");

        assert_eq!(result["status"], "ok");
        assert!(dir.join("SKILL.md").exists());
        assert!(dir.join("references").join("mcp.md").exists());
        let skill = fs::read_to_string(dir.join("SKILL.md")).expect("read skill");
        assert!(skill.contains("name: vegastack-pages"));
        assert!(skill.contains("prepare_page_edit"));

        let conflict = install_skill(
            SkillAgent::Generic,
            SkillScope::Project,
            &dir_arg,
            false,
            false,
        )
        .expect("same content is idempotent");
        assert_eq!(conflict["status"], "ok");

        fs::write(dir.join("SKILL.md"), "changed").expect("mutate skill");
        let error = install_skill(
            SkillAgent::Generic,
            SkillScope::Project,
            &dir_arg,
            false,
            false,
        )
        .expect_err("changed file should require force");
        assert!(error.contains("--force"));

        let _ = fs::remove_dir_all(dir);

        let root = env::temp_dir().join(format!("vpg-skill-all-test-{stamp}"));
        fs::create_dir_all(&root).expect("create all root");
        let _guard = ENV_LOCK.lock().expect("env lock");
        let old_home = env::var_os("HOME");
        let old_userprofile = env::var_os("USERPROFILE");
        env::set_var("HOME", &root);
        env::set_var("USERPROFILE", &root);

        let all = install_skill(SkillAgent::All, SkillScope::User, &None, true, false)
            .expect("install all");
        assert_eq!(all["status"], "ok");
        assert!(root
            .join(".codex")
            .join("skills")
            .join(SKILL_NAME)
            .join("SKILL.md")
            .exists());
        assert!(root
            .join(".claude")
            .join("skills")
            .join(SKILL_NAME)
            .join("SKILL.md")
            .exists());
        assert!(root
            .join(".cursor")
            .join("rules")
            .join("vegastack-pages.mdc")
            .exists());
        let cursor = fs::read_to_string(
            root.join(".cursor")
                .join("rules")
                .join("vegastack-pages.mdc"),
        )
        .expect("read cursor adapter");
        assert!(cursor.contains("alwaysApply: false"));
        assert!(cursor.contains("Prefer the VegaStack Pages MCP tools"));
        assert!(root
            .join(".gemini")
            .join("extensions")
            .join(SKILL_NAME)
            .join("GEMINI.md")
            .exists());
        let gemini_extension = fs::read_to_string(
            root.join(".gemini")
                .join("extensions")
                .join(SKILL_NAME)
                .join("extension.json"),
        )
        .expect("read gemini extension");
        assert!(gemini_extension.contains("\"contextFileName\": \"GEMINI.md\""));

        let dir_error = install_skill(
            SkillAgent::All,
            SkillScope::User,
            &Some(root.join("custom").display().to_string()),
            true,
            true,
        )
        .expect_err("all cannot use dir");
        assert!(dir_error.contains("--dir"));

        match old_home {
            Some(value) => env::set_var("HOME", value),
            None => env::remove_var("HOME"),
        }
        match old_userprofile {
            Some(value) => env::set_var("USERPROFILE", value),
            None => env::remove_var("USERPROFILE"),
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn skill_install_dry_run_does_not_write_files() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = env::temp_dir().join(format!("vpg-skill-dry-run-test-{stamp}"));
        let dir_arg = Some(dir.display().to_string());

        let result = install_skill(
            SkillAgent::Cursor,
            SkillScope::Project,
            &dir_arg,
            false,
            true,
        )
        .expect("dry-run install");

        assert_eq!(result["status"], "dry_run");
        assert!(!dir.exists());
    }

    #[test]
    fn skill_content_covers_mcp_cli_and_review_loop_scenarios() {
        let skill = SKILL_FILES[0].1;
        let mcp = SKILL_FILES
            .iter()
            .find(|(path, _)| *path == "references/mcp.md")
            .map(|(_, content)| *content)
            .expect("mcp reference");
        let cli = SKILL_FILES
            .iter()
            .find(|(path, _)| *path == "references/cli.md")
            .map(|(_, content)| *content)
            .expect("cli reference");
        let workflows = SKILL_FILES
            .iter()
            .find(|(path, _)| *path == "references/workflows.md")
            .map(|(_, content)| *content)
            .expect("workflow reference");

        assert!(skill.contains("If MCP tools"));
        assert!(skill.contains("If no MCP tools"));
        assert!(skill.contains("If both are available"));
        assert!(skill.contains("CLI workflows do not require MCP"));
        assert!(skill.contains("waiting for review for up to 10 minutes"));
        assert!(mcp.contains("timeout_ms: 600000") || mcp.contains("600000"));
        assert!(mcp.contains("Every MCP tool call requires an explicit `workspace_id`"));
        assert!(cli.contains("vpg skills install --agent all --scope user"));
        assert!(cli.contains("vpg skills update --agent all --scope user"));
        assert!(cli.contains("It does not call MCP"));
        assert!(cli.contains("supports the same page, comment, publication, template"));
        assert!(cli.contains("MCP can expose the same guidance"));
        assert!(cli.contains("clamps larger values to 600 seconds"));
        assert!(workflows.contains("act on them immediately"));
        assert!(workflows.contains("User Interruptions"));
    }

    #[test]
    fn skill_reference_mentions_every_mcp_tool_and_cli_command() {
        let mcp = SKILL_FILES
            .iter()
            .find(|(path, _)| *path == "references/mcp.md")
            .map(|(_, content)| *content)
            .expect("mcp reference");
        let cli = SKILL_FILES
            .iter()
            .find(|(path, _)| *path == "references/cli.md")
            .map(|(_, content)| *content)
            .expect("cli reference");
        let mcp_source = include_str!("../../../packages/mcp/src/index.ts");
        let names_start = mcp_source.find("export const mcpToolNames = [").unwrap();
        let names_end = mcp_source[names_start..].find("] as const").unwrap() + names_start;
        for line in mcp_source[names_start..names_end].lines() {
            let trimmed = line.trim();
            if let Some(name) = trimmed
                .strip_prefix('"')
                .and_then(|value| value.split('"').next())
            {
                assert!(
                    mcp.contains(name),
                    "MCP skill reference must mention tool {name}"
                );
            }
        }
        assert!(mcp_source.contains("maximum: 600000"));
        let events_start = mcp_source.find("name: \"list_review_events\"").unwrap();
        let events_end = mcp_source[events_start..]
            .find("name: \"search_workspace\"")
            .unwrap()
            + events_start;
        let events_spec = &mcp_source[events_start..events_end];
        assert!(events_spec.contains("workspace_id"));
        assert!(events_spec.contains("required: [\"workspace_id\"]"));

        for command in [
            "vpg login",
            "vpg logout",
            "vpg whoami",
            "vpg workspaces",
            "vpg use",
            "vpg create",
            "vpg templates list",
            "vpg templates show",
            "vpg templates render",
            "vpg templates create",
            "vpg templates update",
            "vpg pages get",
            "vpg pages rendered",
            "vpg pages versions",
            "vpg pages snapshot",
            "vpg pages restore-version",
            "vpg pages prepare-edit",
            "vpg pages update-source",
            "vpg pages patch",
            "vpg pages validate",
            "vpg pages move",
            "vpg attachments upload",
            "vpg members invite",
            "vpg wait",
            "vpg comments",
            "vpg comment",
            "vpg reply",
            "vpg resolve",
            "vpg unresolve",
            "vpg update-anchor",
            "vpg delete-thread",
            "vpg complete-thread",
            "vpg publish-page",
            "vpg publish-folder",
            "vpg revoke-publication",
            "vpg update-publication",
            "vpg search",
            "vpg events",
            "vpg tree",
            "vpg export",
            "vpg doctor",
            "vpg deploy",
            "vpg update",
            "vpg skills path",
            "vpg skills print",
            "vpg skills doctor",
            "vpg skills install",
            "vpg skills update",
        ] {
            assert!(
                cli.contains(command),
                "CLI skill reference must mention command {command}"
            );
        }
    }

    #[test]
    fn wait_defaults_to_ten_minutes_and_allows_cli_clamp() {
        let cli = Cli::try_parse_from(["vpg", "wait", "pg_123"]).expect("parse wait");
        match cli.command {
            Some(Command::Wait {
                timeout_seconds,
                poll_seconds,
                until,
                ..
            }) => {
                assert_eq!(timeout_seconds, 600);
                assert_eq!(poll_seconds, 2);
                assert!(matches!(until, WaitCondition::FirstResponse));
            }
            other => panic!("unexpected command: {other:?}"),
        }

        let source = include_str!("main.rs");
        assert!(source.contains("let timeout_seconds = timeout_seconds.min(600);"));
    }

    #[test]
    fn compare_versions_orders_semver_and_prereleases() {
        use std::cmp::Ordering;
        assert_eq!(compare_versions("0.1.1", "0.1.1"), Ordering::Equal);
        assert_eq!(compare_versions("0.1.1", "0.1.2"), Ordering::Less);
        assert_eq!(compare_versions("0.2.0", "0.1.9"), Ordering::Greater);
        // Prerelease ranks below the matching stable release
        assert_eq!(compare_versions("0.1.2-next.0", "0.1.2"), Ordering::Less);
        assert_eq!(compare_versions("0.1.2", "0.1.2-next.0"), Ordering::Greater);
        // Numeric prerelease segments sort numerically, not lexically
        assert_eq!(
            compare_versions("0.1.2-next.9", "0.1.2-next.10"),
            Ordering::Less
        );
    }

    #[test]
    fn classify_install_path_detects_each_installer() {
        assert_eq!(classify_install_path(None), Installer::Unknown);
        assert_eq!(classify_install_path(Some("")), Installer::Unknown);
        assert_eq!(
            classify_install_path(Some(
                "/Users/me/projects/vegastack-pages/cli/vegastack-pages/dist/darwin-arm64/vpg"
            )),
            Installer::LocalDev
        );
        assert_eq!(
            classify_install_path(Some(
                "/Users/me/Library/pnpm/global/5/node_modules/@vegastack/pages-darwin-arm64/bin/vpg"
            )),
            Installer::Pnpm
        );
        assert_eq!(
            classify_install_path(Some(
                "/Users/me/.bun/install/global/node_modules/@vegastack/pages-darwin-arm64/bin/vpg"
            )),
            Installer::Bun
        );
        assert_eq!(
            classify_install_path(Some(
                "/Users/me/.yarn/global/node_modules/@vegastack/pages-darwin-arm64/bin/vpg"
            )),
            Installer::Yarn
        );
        assert_eq!(
            classify_install_path(Some(
                "/usr/local/lib/node_modules/@vegastack/pages-linux-x64/bin/vpg"
            )),
            Installer::Npm
        );
        assert_eq!(
            classify_install_path(Some("C:\\Users\\me\\somewhere\\vpg.exe")),
            Installer::Unknown
        );
    }

    #[test]
    fn update_command_parses_with_flags() {
        let plain = Cli::try_parse_from(["vpg", "update"]).expect("parse update");
        match plain.command {
            Some(Command::Update { check, channel }) => {
                assert!(!check);
                assert!(channel.is_none());
            }
            other => panic!("unexpected command: {other:?}"),
        }

        let check = Cli::try_parse_from(["vpg", "update", "--check", "--channel", "next"])
            .expect("parse update with flags");
        match check.command {
            Some(Command::Update { check, channel }) => {
                assert!(check);
                assert_eq!(channel.as_deref(), Some("next"));
            }
            other => panic!("unexpected command: {other:?}"),
        }
    }

    #[test]
    fn validate_source_body_omits_source_when_only_page_is_supplied() {
        let body = build_validate_source_body(
            Some("wks_123".to_string()),
            Some("pg_123".to_string()),
            None,
            Some(&SourceType::Markdown),
        );

        assert_eq!(body["workspace_id"], "wks_123");
        assert_eq!(body["page_id"], "pg_123");
        assert_eq!(body["source_type"], "markdown");
        assert!(body.get("source").is_none());

        let inline = build_validate_source_body(
            Some("wks_123".to_string()),
            None,
            Some(String::new()),
            Some(&SourceType::Markdown),
        );
        assert_eq!(inline["workspace_id"], "wks_123");
        assert_eq!(inline["source"], "");
    }

    #[test]
    fn publish_body_omits_unset_optional_fields() {
        let omitted = build_publish_body(&PublicationPermission::Comment, &None, &None, &None);
        assert_eq!(omitted["permission"], "comment");
        assert!(omitted.get("expires_at").is_none());
        assert!(omitted.get("password").is_none());
        assert!(omitted.get("indexing_enabled").is_none());

        let full = build_publish_body(
            &PublicationPermission::View,
            &Some("2099-01-01T00:00:00.000Z".to_string()),
            &Some("strong-passphrase".to_string()),
            &Some(true),
        );
        assert_eq!(full["permission"], "view");
        assert_eq!(full["expires_at"], "2099-01-01T00:00:00.000Z");
        assert_eq!(full["password"], "strong-passphrase");
        assert_eq!(full["indexing_enabled"], true);
    }

    #[test]
    fn comment_anchor_body_supports_text_flags_and_html_json() {
        let text = build_comment_anchor_body(
            &None,
            &None,
            &Some("Selected".to_string()),
            &Some(4),
            &Some(12),
            "pre",
            "suf",
            &AnchorKind::Text,
            &AnchorSurface::Prose,
            &Some(AnchorConfidence::Active),
        )
        .expect("text anchor");
        assert_eq!(text["anchor_kind"], "text");
        assert_eq!(text["surface"], "prose");
        assert_eq!(text["selected_text"], "Selected");
        assert_eq!(text["source_start"], 4);
        assert_eq!(text["prefix_text"], "pre");

        let html = build_comment_anchor_body(
            &Some(
                r#"{"selector":{"point":{"x":0.5,"y":0.25,"coordinateSpace":"document"}}}"#
                    .to_string(),
            ),
            &None,
            &None,
            &None,
            &None,
            "",
            "",
            &AnchorKind::Point,
            &AnchorSurface::Html,
            &Some(AnchorConfidence::Manual),
        )
        .expect("html anchor");
        assert_eq!(html["anchor_kind"], "point");
        assert_eq!(html["surface"], "html");
        assert_eq!(html["confidence"], "manual");
        assert_eq!(html["selector"]["point"]["x"], 0.5);
    }

    #[test]
    fn workspace_query_is_added_to_resource_api_paths() {
        assert_eq!(
            with_workspace_query("/api/validate-source", "wks_123"),
            "/api/validate-source?workspace_id=wks_123"
        );
        assert_eq!(
            with_workspace_query("/api/pages/pg_123/comments?status=all", "wks space"),
            "/api/pages/pg_123/comments?status=all&workspace_id=wks%20space"
        );
    }

    #[test]
    fn attachment_base64_flags_are_strict_and_clear() {
        let both = read_attachment_base64_body(
            &Some("aGVsbG8=".to_string()),
            &Some("body.txt".to_string()),
        )
        .expect_err("both inputs should fail");
        assert_eq!(both, "--base64-body and --base64-file cannot be combined");

        let missing = read_attachment_base64_body(&None, &None).expect_err("missing input");
        assert_eq!(missing, "--base64-body or --base64-file is required");
    }

    #[test]
    fn missing_workspace_is_an_error_instead_of_demo_fallback() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = env::temp_dir().join(format!("vpg-cli-workspace-test-{stamp}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        env::set_var("VPG_CONFIG_PATH", dir.join("config.json"));

        let cli = Cli {
            json: false,
            base_url: "https://pages.example.test".to_string(),
            workspace: None,
            token: None,
            command: None,
        };

        let error = resolved_workspace(&cli).expect_err("missing workspace should fail");
        assert!(error.contains("workspace_id is required"));
        assert!(!error.contains("wks_demo"));

        env::remove_var("VPG_CONFIG_PATH");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn stores_tokens_outside_config_with_owner_only_permissions() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let dir = env::temp_dir().join(format!("vpg-cli-token-test-{stamp}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        let config_path = dir.join("config.json");
        env::set_var("VPG_CONFIG_PATH", &config_path);
        env::set_var("VPG_DISABLE_KEYCHAIN", "true");

        let storage = write_stored_token("mcp_secret_token").expect("write token");
        let config = StoredConfig {
            token: Some("legacy_secret".to_string()),
            workspace: Some("wks_test".to_string()),
            base_url: Some("https://pages.example.test".to_string()),
        };
        write_stored_config(&config).expect("write config");

        let config_text = fs::read_to_string(&config_path).expect("read config");
        assert!(!config_text.contains("legacy_secret"));
        assert!(!config_text.contains("mcp_secret_token"));
        assert_eq!(read_stored_token().as_deref(), Some("mcp_secret_token"));

        #[cfg(unix)]
        {
            let config_mode = fs::metadata(&config_path)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777;
            let token_mode = fs::metadata(token_path().expect("token path"))
                .expect("token metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(config_mode, 0o600);
            assert_eq!(token_mode, 0o600);
        }

        assert!(storage.ends_with("token"));
        env::remove_var("VPG_CONFIG_PATH");
        env::remove_var("VPG_DISABLE_KEYCHAIN");
        let _ = fs::remove_dir_all(dir);
    }
}
