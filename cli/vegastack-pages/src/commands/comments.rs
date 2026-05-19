use clap::{Args, Subcommand};
use serde_json::{json, Value};

use crate::api::{with_workspace_query, Api};
use crate::cli::Cli;
use crate::commands::shared::{build_comment_anchor_body, resolve_page_id};
use crate::config::resolved_workspace;
use crate::errors::VpgError;
use crate::output::Writer;

#[derive(Subcommand, Debug)]
pub enum CommentsCommand {
    List(ListArgs),
    Create(CreateArgs),
    Reply(ReplyArgs),
    Resolve(ThreadArgs),
    Reopen(ThreadArgs),
    Delete(ThreadArgs),
    Complete(CompleteArgs),
    MoveAnchor(MoveAnchorArgs),
}

#[derive(Args, Debug)]
pub struct ListArgs {
    pub page: String,
    #[arg(long, default_value = "open")]
    pub status: String,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    pub page: String,
    #[arg(long)]
    pub body: String,
    #[arg(long = "anchor-json")]
    pub anchor_json: Option<String>,
    #[arg(long = "anchor-file")]
    pub anchor_file: Option<String>,
    #[arg(long = "selected-text")]
    pub selected_text: Option<String>,
    #[arg(long = "source-start")]
    pub source_start: Option<i64>,
    #[arg(long = "source-end")]
    pub source_end: Option<i64>,
    #[arg(long = "prefix-text", default_value = "")]
    pub prefix_text: String,
    #[arg(long = "suffix-text", default_value = "")]
    pub suffix_text: String,
    #[arg(long = "anchor-kind", default_value = "text")]
    pub anchor_kind: String,
    #[arg(long, default_value = "prose")]
    pub surface: String,
    #[arg(long)]
    pub confidence: Option<String>,
}

#[derive(Args, Debug)]
pub struct ReplyArgs {
    pub thread: String,
    #[arg(long)]
    pub body: String,
    #[arg(long = "agent-name")]
    pub agent_name: Option<String>,
    #[arg(long = "agent-model")]
    pub agent_model: Option<String>,
    /// Stable session id for the agent issuing the reply. Stored in the
    /// reply's `agent_session_id` field. Same flag name as `comments
    /// complete --agent-session-id`.
    #[arg(long = "agent-session-id")]
    pub agent_session_id: Option<String>,
}

#[derive(Args, Debug)]
pub struct ThreadArgs {
    pub thread: String,
}

#[derive(Args, Debug)]
pub struct CompleteArgs {
    pub thread: String,
    #[arg(long)]
    pub body: String,
    #[arg(long)]
    pub resolve: bool,
    #[arg(long = "agent-name")]
    pub agent_name: Option<String>,
    #[arg(long = "agent-model")]
    pub agent_model: Option<String>,
    #[arg(long = "agent-session-id")]
    pub agent_session_id: Option<String>,
}

#[derive(Args, Debug)]
pub struct MoveAnchorArgs {
    pub thread: String,
    #[arg(long = "anchor-json")]
    pub anchor_json: Option<String>,
    #[arg(long = "anchor-file")]
    pub anchor_file: Option<String>,
    #[arg(long = "selected-text")]
    pub selected_text: Option<String>,
    #[arg(long = "source-start")]
    pub source_start: Option<i64>,
    #[arg(long = "source-end")]
    pub source_end: Option<i64>,
    #[arg(long = "prefix-text", default_value = "")]
    pub prefix_text: String,
    #[arg(long = "suffix-text", default_value = "")]
    pub suffix_text: String,
    #[arg(long = "anchor-kind", default_value = "text")]
    pub anchor_kind: String,
    #[arg(long, default_value = "prose")]
    pub surface: String,
    #[arg(long)]
    pub confidence: Option<String>,
}

pub async fn dispatch(
    cli: &Cli,
    writer: &Writer,
    cmd: &CommentsCommand,
) -> Result<(), VpgError> {
    match cmd {
        CommentsCommand::List(args) => list(cli, writer, args).await,
        CommentsCommand::Create(args) => create(cli, writer, args).await,
        CommentsCommand::Reply(args) => reply(cli, writer, args).await,
        CommentsCommand::Resolve(args) => resolve(cli, writer, args).await,
        CommentsCommand::Reopen(args) => reopen(cli, writer, args).await,
        CommentsCommand::Delete(args) => delete(cli, writer, args).await,
        CommentsCommand::Complete(args) => complete(cli, writer, args).await,
        CommentsCommand::MoveAnchor(args) => move_anchor(cli, writer, args).await,
    }
}

async fn list(cli: &Cli, writer: &Writer, args: &ListArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    let value = api
        .get(
            &format!("/api/pages/{page_id}/comments"),
            &[
                ("status", args.status.clone()),
                ("workspace_id", workspace),
            ],
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn create(cli: &Cli, writer: &Writer, args: &CreateArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    let anchor = build_comment_anchor_body(
        &args.anchor_json,
        &args.anchor_file,
        &args.selected_text,
        &args.source_start,
        &args.source_end,
        &args.prefix_text,
        &args.suffix_text,
        &args.anchor_kind,
        &args.surface,
        &args.confidence,
    )?;
    let body = json!({ "body": args.body, "anchor": anchor });
    let value: Value = api
        .post(
            &with_workspace_query(&format!("/api/pages/{page_id}/comments"), &workspace),
            &body,
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn reply(cli: &Cli, writer: &Writer, args: &ReplyArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    // Omit absent optional fields so the server doesn't see `agent_name: null`
    // etc. — strict server-side validators reject null where a string is
    // expected. (Audit cycle 5 finding.)
    let mut body = serde_json::Map::new();
    body.insert("body".into(), Value::String(args.body.clone()));
    if let Some(v) = &args.agent_name {
        body.insert("agent_name".into(), Value::String(v.clone()));
    }
    if let Some(v) = &args.agent_model {
        body.insert("agent_model".into(), Value::String(v.clone()));
    }
    if let Some(v) = &args.agent_session_id {
        body.insert("agent_session_id".into(), Value::String(v.clone()));
    }
    let value = api
        .post(
            &with_workspace_query(
                &format!("/api/comment-threads/{}/replies", args.thread),
                &workspace,
            ),
            &Value::Object(body),
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn resolve(cli: &Cli, writer: &Writer, args: &ThreadArgs) -> Result<(), VpgError> {
    thread_status(cli, writer, &args.thread, "resolve").await
}

async fn reopen(cli: &Cli, writer: &Writer, args: &ThreadArgs) -> Result<(), VpgError> {
    thread_status(cli, writer, &args.thread, "unresolve").await
}

async fn thread_status(
    cli: &Cli,
    writer: &Writer,
    thread: &str,
    action: &str,
) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let value = api
        .post(
            &with_workspace_query(
                &format!("/api/comment-threads/{thread}/{action}"),
                &workspace,
            ),
            &json!({}),
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn delete(cli: &Cli, writer: &Writer, args: &ThreadArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let value = api
        .delete(&with_workspace_query(
            &format!("/api/comment-threads/{}", args.thread),
            &workspace,
        ))
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn complete(cli: &Cli, writer: &Writer, args: &CompleteArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let mut body = serde_json::Map::new();
    body.insert("body".into(), Value::String(args.body.clone()));
    if args.resolve {
        body.insert("resolve".into(), Value::Bool(true));
    }
    if let Some(v) = &args.agent_name {
        body.insert("agent_name".into(), Value::String(v.clone()));
    }
    if let Some(v) = &args.agent_model {
        body.insert("agent_model".into(), Value::String(v.clone()));
    }
    if let Some(v) = &args.agent_session_id {
        body.insert("agent_session_id".into(), Value::String(v.clone()));
    }
    let value = api
        .post(
            &with_workspace_query(
                &format!("/api/comment-threads/{}/complete", args.thread),
                &workspace,
            ),
            &Value::Object(body),
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn move_anchor(cli: &Cli, writer: &Writer, args: &MoveAnchorArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let anchor = build_comment_anchor_body(
        &args.anchor_json,
        &args.anchor_file,
        &args.selected_text,
        &args.source_start,
        &args.source_end,
        &args.prefix_text,
        &args.suffix_text,
        &args.anchor_kind,
        &args.surface,
        &args.confidence,
    )?;
    let value = api
        .patch(
            &with_workspace_query(
                &format!("/api/comment-threads/{}/anchor", args.thread),
                &workspace,
            ),
            &json!({ "anchor": anchor }),
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}
