use clap::{Args, Subcommand};
use serde_json::{json, Value};

use crate::api::{with_workspace_query, Api};
use crate::cli::Cli;
use crate::config::resolved_workspace;
use crate::errors::VpgError;
use crate::output::Writer;
use crate::commands::shared::{
    build_property_object, default_title, parse_kv_list, read_source_value, resolve_page_id,
    resolve_template_id,
};

#[derive(Subcommand, Debug)]
pub enum PagesCommand {
    Create(CreateArgs),
    Get(GetArgs),
    Update(UpdateArgs),
    Move(MoveArgs),
    Restore(RestoreArgs),
    Versions(VersionsArgs),
    Wait(WaitArgs),
    /// Soft-delete (move to trash) or hard-delete a page.
    Delete(DeleteArgs),
    /// Restore a soft-deleted page from the trash.
    Undelete(UndeleteArgs),
    /// List soft-deleted pages.
    Trash(TrashArgs),
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    #[arg(long)]
    pub title: Option<String>,
    #[arg(long)]
    pub file: Option<String>,
    #[arg(long)]
    pub stdin: bool,
    #[arg(long = "type", default_value = "markdown")]
    pub source_type: String,
    #[arg(long = "folder-path")]
    pub folder_path: Option<String>,
    #[arg(long)]
    pub template: Option<String>,
    #[arg(long = "set")]
    pub set: Vec<String>,
}

#[derive(Args, Debug)]
pub struct GetArgs {
    pub page: String,
    #[arg(long, value_delimiter = ',')]
    pub include: Vec<String>,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    pub page: String,
    #[arg(long = "base-version-id")]
    pub base_version_id: String,
    #[arg(long)]
    pub source: Option<String>,
    #[arg(long)]
    pub file: Option<String>,
    #[arg(long)]
    pub stdin: bool,
    #[arg(long)]
    pub find: Option<String>,
    #[arg(long)]
    pub replace: Option<String>,
    #[arg(long = "replace-all")]
    pub replace_all: bool,
    #[arg(long = "expected-replacements")]
    pub expected_replacements: Option<u32>,
    #[arg(long)]
    pub checkpoint: bool,
    #[arg(long = "checkpoint-label")]
    pub checkpoint_label: Option<String>,
    #[arg(long = "allow-noop")]
    pub allow_noop: bool,
    #[arg(long = "base-content-hash")]
    pub base_content_hash: Option<String>,
}

#[derive(Args, Debug)]
pub struct MoveArgs {
    pub page: String,
    #[arg(long)]
    pub title: Option<String>,
    #[arg(long = "folder-path")]
    pub folder_path: Option<String>,
}

#[derive(Args, Debug)]
pub struct RestoreArgs {
    pub page: String,
    pub version_id: String,
}

#[derive(Args, Debug)]
pub struct VersionsArgs {
    pub page: String,
}

#[derive(Args, Debug)]
pub struct WaitArgs {
    pub page: String,
    /// Wait condition. One of `first_response`, `new_comment`,
    /// `all_threads_resolved`, or `timeout` (immediately returns timeout).
    /// Matches the MCP `wait_for_review.until` enum exactly.
    #[arg(long, default_value = "first_response")]
    pub until: String,
    #[arg(long = "timeout", default_value_t = 600)]
    pub timeout_seconds: u64,
    #[arg(long = "poll", default_value_t = 2)]
    pub poll_seconds: u64,
    #[arg(long = "after-id")]
    pub after_id: Option<String>,
}

#[derive(Args, Debug)]
pub struct DeleteArgs {
    pub page: String,
    /// Skip the trash window and hard-delete immediately. Requires
    /// workspace admin. Defaults to soft-delete.
    #[arg(long)]
    pub permanent: bool,
}

#[derive(Args, Debug)]
pub struct UndeleteArgs {
    pub page: String,
}

#[derive(Args, Debug)]
pub struct TrashArgs {
    /// "mine" returns just the pages this user trashed (default);
    /// "workspace" returns the workspace-wide trash (editor+).
    #[arg(long, default_value = "mine")]
    pub scope: String,
}

pub async fn dispatch(
    cli: &Cli,
    writer: &Writer,
    cmd: &PagesCommand,
) -> Result<(), VpgError> {
    match cmd {
        PagesCommand::Create(args) => create(cli, writer, args).await,
        PagesCommand::Get(args) => get(cli, writer, args).await,
        PagesCommand::Update(args) => update(cli, writer, args).await,
        PagesCommand::Move(args) => move_page(cli, writer, args).await,
        PagesCommand::Restore(args) => restore(cli, writer, args).await,
        PagesCommand::Versions(args) => versions(cli, writer, args).await,
        PagesCommand::Wait(args) => wait(cli, writer, args).await,
        PagesCommand::Delete(args) => delete_page(cli, writer, args).await,
        PagesCommand::Undelete(args) => undelete_page(cli, writer, args).await,
        PagesCommand::Trash(args) => trash_list(cli, writer, args).await,
    }
}

async fn create(cli: &Cli, writer: &Writer, args: &CreateArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;

    let value = if let Some(template) = &args.template {
        // create-from-template path
        let template_id = resolve_template_id(&api, &workspace, template).await?;
        let property_pairs = parse_kv_list(&args.set)?;
        let body = json!({
            "title": default_title(&args.file, &args.title),
            "folder_path": args.folder_path,
            "properties": build_property_object(&property_pairs),
        });
        api.post(
            &with_workspace_query(
                &format!("/api/templates/{template_id}/pages"),
                &workspace,
            ),
            &body,
        )
        .await?
    } else {
        // plain page creation
        let source = read_source_value(&None, &args.file, args.stdin)?;
        let body = json!({
            "title": default_title(&args.file, &args.title),
            "source": source,
            "source_type": args.source_type,
            "folder_path": args.folder_path,
        });
        api.post(
            &format!("/api/workspaces/{workspace}/pages"),
            &body,
        )
        .await?
    };
    writer.emit_value(&value);
    Ok(())
}

async fn get(cli: &Cli, writer: &Writer, args: &GetArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    // Resolve slug → pg_… so `vpg pages get <slug>` works the same as
    // every other page command. Previously `get` used `args.page` raw,
    // making it the only page command that didn't accept slugs.
    // (Audit cycle 5 finding.)
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    let include_csv = if args.include.is_empty() {
        "metadata,source".to_string()
    } else {
        args.include.join(",")
    };
    // edit_tokens triggers the dedicated /source endpoint with intent=edit,
    // which is the "prepare_page_edit" fold that the planning doc calls out.
    if include_csv.split(',').any(|p| p.trim() == "edit_tokens") {
        let source = api
            .get(
                &format!("/api/pages/{page_id}/source"),
                &[
                    ("intent", "edit".to_string()),
                    ("workspace_id", workspace.clone()),
                ],
            )
            .await?;
        writer.emit_value(&json!({
            "workspace_id": workspace,
            "page_id": page_id,
            "source": source.get("source").cloned().unwrap_or(Value::String(String::new())),
            "base_version_id": source.get("version_id").cloned().unwrap_or(Value::Null),
            "base_content_hash": source.get("etag").cloned().unwrap_or(Value::Null),
        }));
        return Ok(());
    }
    let value = api
        .get(
            &format!("/api/pages/{page_id}"),
            &[
                ("workspace_id", workspace),
                ("include", include_csv),
            ],
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn update(cli: &Cli, writer: &Writer, args: &UpdateArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;

    // Mode resolution: find/replace > checkpoint-noop > full source replace.
    if args.find.is_some() {
        let find = args.find.clone().unwrap();
        let replace = args.replace.clone().unwrap_or_default();
        // Build the body field-by-field so absent fields are omitted (not
        // serialized as `null`) — the patch endpoint treats `null` for
        // numeric/string fields like `expected_replacements` and
        // `base_content_hash` as a validation failure.
        let mut body = serde_json::Map::new();
        body.insert("find".into(), Value::String(find));
        body.insert("replace".into(), Value::String(replace));
        body.insert("replace_all".into(), Value::Bool(args.replace_all));
        if let Some(n) = args.expected_replacements {
            body.insert("expected_replacements".into(), json!(n));
        }
        body.insert(
            "base_version_id".into(),
            Value::String(args.base_version_id.clone()),
        );
        if let Some(h) = &args.base_content_hash {
            body.insert("base_content_hash".into(), Value::String(h.clone()));
        }
        if args.checkpoint {
            body.insert("checkpoint".into(), Value::Bool(true));
        }
        if let Some(l) = &args.checkpoint_label {
            body.insert("checkpoint_label".into(), Value::String(l.clone()));
        }
        let body = Value::Object(body);
        let value = api
            .post(
                &with_workspace_query(&format!("/api/pages/{page_id}/patch"), &workspace),
                &body,
            )
            .await?;
        writer.emit_value(&value);
        return Ok(());
    }

    if args.checkpoint && args.source.is_none() && args.file.is_none() && !args.stdin {
        // Snapshot-only mode (no source provided + --checkpoint set).
        let body = json!({ "label": args.checkpoint_label });
        let value = api
            .post(
                &with_workspace_query(&format!("/api/pages/{page_id}/snapshot"), &workspace),
                &body,
            )
            .await?;
        writer.emit_value(&value);
        return Ok(());
    }

    // Full source replace. Omit absent optional fields (see find/replace
    // branch for rationale).
    let source = read_source_value(&args.source, &args.file, args.stdin)?;
    let mut body = serde_json::Map::new();
    body.insert("source".into(), Value::String(source));
    body.insert(
        "base_version_id".into(),
        Value::String(args.base_version_id.clone()),
    );
    if let Some(h) = &args.base_content_hash {
        body.insert("base_content_hash".into(), Value::String(h.clone()));
    }
    if args.checkpoint {
        body.insert("checkpoint".into(), Value::Bool(true));
    }
    if let Some(l) = &args.checkpoint_label {
        body.insert("checkpoint_label".into(), Value::String(l.clone()));
    }
    if args.allow_noop {
        body.insert("allow_noop".into(), Value::Bool(true));
    }
    let body = Value::Object(body);
    let value = api
        .put(
            &with_workspace_query(&format!("/api/pages/{page_id}/source"), &workspace),
            &body,
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn move_page(cli: &Cli, writer: &Writer, args: &MoveArgs) -> Result<(), VpgError> {
    if args.title.is_none() && args.folder_path.is_none() {
        return Err(VpgError::validation(
            "vpg pages move requires --title and/or --folder-path",
        ));
    }
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    // Omit absent optional fields so the server doesn't see `title: null`
    // (which can be interpreted as "clear the title"). (Audit cycle 5.)
    let mut body = serde_json::Map::new();
    if let Some(t) = &args.title {
        body.insert("title".into(), Value::String(t.clone()));
    }
    if let Some(p) = &args.folder_path {
        body.insert("folder_path".into(), Value::String(p.clone()));
    }
    let value = api
        .post(
            &with_workspace_query(&format!("/api/pages/{page_id}/move"), &workspace),
            &Value::Object(body),
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn restore(cli: &Cli, writer: &Writer, args: &RestoreArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    let body = json!({ "version_id": args.version_id });
    let value = api
        .post(
            &with_workspace_query(&format!("/api/pages/{page_id}/versions"), &workspace),
            &body,
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn versions(cli: &Cli, writer: &Writer, args: &VersionsArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let value = api
        .get(
            &format!("/api/pages/{}", args.page),
            &[
                ("workspace_id", workspace),
                ("include", "versions".to_string()),
            ],
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn wait(cli: &Cli, writer: &Writer, args: &WaitArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    let timeout_seconds = args.timeout_seconds.min(600);
    let started = std::time::Instant::now();
    let deadline = std::time::Duration::from_secs(timeout_seconds);
    let poll = std::time::Duration::from_secs(args.poll_seconds.max(1));
    let mut cursor = args.after_id.clone();

    loop {
        // Hit /api/pages/{page}/review-status — the server-side wait
        // endpoint that actually understands the `until` condition and
        // returns `status: "matched"` when met. (`/api/review-events` is
        // a simple list and doesn't drive wait semantics.)
        let mut params: Vec<(&str, String)> = vec![
            ("workspace_id", workspace.clone()),
            ("until", args.until.clone()),
            ("limit", "50".to_string()),
        ];
        if let Some(after) = &cursor {
            params.push(("after_id", after.clone()));
        }
        let status = api
            .get(
                &format!("/api/pages/{page_id}/review-status"),
                &params,
            )
            .await?;

        let events = status
            .get("events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for ev in &events {
            writer.emit_ndjson(ev);
        }
        if let Some(next) = status.get("next_cursor").and_then(Value::as_str) {
            cursor = Some(next.to_string());
        }
        let matched = status.get("status").and_then(Value::as_str) == Some("matched");
        if matched {
            writer.emit_value(&status);
            return Ok(());
        }
        if started.elapsed() >= deadline {
            // Emit a final timeout envelope so agents can distinguish
            // "matched" vs "timeout" without re-polling.
            let mut timeout_payload = status.clone();
            if let Some(obj) = timeout_payload.as_object_mut() {
                obj.insert(
                    "status".to_string(),
                    Value::String("timeout".to_string()),
                );
            }
            writer.emit_value(&timeout_payload);
            return Ok(());
        }
        tokio::time::sleep(poll).await;
    }
}

async fn delete_page(cli: &Cli, writer: &Writer, args: &DeleteArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    let value = if args.permanent {
        api
            .delete(&with_workspace_query(
                &format!("/api/pages/{page_id}/trash"),
                &workspace,
            ))
            .await?
    } else {
        api
            .post(
                &with_workspace_query(&format!("/api/pages/{page_id}/trash"), &workspace),
                &json!({}),
            )
            .await?
    };
    writer.emit_value(&value);
    Ok(())
}

async fn undelete_page(cli: &Cli, writer: &Writer, args: &UndeleteArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    let value = api
        .post(
            &with_workspace_query(&format!("/api/pages/{page_id}/restore"), &workspace),
            &json!({}),
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn trash_list(cli: &Cli, writer: &Writer, args: &TrashArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let value = api
        .get(
            &format!("/api/workspaces/{workspace}/trash"),
            &[("scope", args.scope.clone())],
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

