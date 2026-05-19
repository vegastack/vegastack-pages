use clap::{Args, Subcommand};
use serde_json::json;

use crate::api::{with_workspace_query, Api};
use crate::cli::Cli;
use crate::commands::shared::{build_publish_body, resolve_page_id};
use crate::config::resolved_workspace;
use crate::errors::VpgError;
use crate::output::Writer;

#[derive(Subcommand, Debug)]
pub enum PublishCommand {
    Page(PageArgs),
    Folder(FolderArgs),
    Update(UpdateArgs),
    Revoke(RevokeArgs),
}

#[derive(Args, Debug)]
pub struct PageArgs {
    pub page: String,
    #[arg(long, default_value = "view")]
    pub permission: String,
    #[arg(long = "expires-at")]
    pub expires_at: Option<String>,
    #[arg(long)]
    pub password: Option<String>,
    #[arg(long = "indexing-enabled")]
    pub indexing_enabled: Option<bool>,
}

#[derive(Args, Debug)]
pub struct FolderArgs {
    pub folder: String,
    #[arg(long, default_value = "view")]
    pub permission: String,
    #[arg(long = "expires-at")]
    pub expires_at: Option<String>,
    #[arg(long)]
    pub password: Option<String>,
    #[arg(long = "indexing-enabled")]
    pub indexing_enabled: Option<bool>,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    pub publication: String,
    #[arg(long)]
    pub permission: Option<String>,
    #[arg(long = "expires-at")]
    pub expires_at: Option<String>,
    #[arg(long = "clear-expires-at")]
    pub clear_expires_at: bool,
    #[arg(long)]
    pub password: Option<String>,
    #[arg(long = "clear-password")]
    pub clear_password: bool,
    #[arg(long = "indexing-enabled")]
    pub indexing_enabled: Option<bool>,
}

#[derive(Args, Debug)]
pub struct RevokeArgs {
    pub publication: String,
}

pub async fn dispatch(
    cli: &Cli,
    writer: &Writer,
    cmd: &PublishCommand,
) -> Result<(), VpgError> {
    match cmd {
        PublishCommand::Page(args) => publish_page(cli, writer, args).await,
        PublishCommand::Folder(args) => publish_folder(cli, writer, args).await,
        PublishCommand::Update(args) => update(cli, writer, args).await,
        PublishCommand::Revoke(args) => revoke(cli, writer, args).await,
    }
}

async fn publish_page(cli: &Cli, writer: &Writer, args: &PageArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    let body = build_publish_body(
        &args.permission,
        &args.expires_at,
        &args.password,
        &args.indexing_enabled,
    );
    let value = api
        .put(
            &with_workspace_query(&format!("/api/pages/{page_id}/publication"), &workspace),
            &body,
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn publish_folder(cli: &Cli, writer: &Writer, args: &FolderArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let body = build_publish_body(
        &args.permission,
        &args.expires_at,
        &args.password,
        &args.indexing_enabled,
    );
    let value = api
        .put(
            &with_workspace_query(
                &format!("/api/folders/{}/publication", args.folder),
                &workspace,
            ),
            &body,
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn update(cli: &Cli, writer: &Writer, args: &UpdateArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let mut body = serde_json::Map::new();
    if let Some(p) = &args.permission {
        body.insert("permission".into(), json!(p));
    }
    if args.clear_expires_at {
        body.insert("expires_at".into(), serde_json::Value::Null);
    } else if let Some(v) = &args.expires_at {
        body.insert("expires_at".into(), json!(v));
    }
    if args.clear_password {
        body.insert("password".into(), serde_json::Value::Null);
    } else if let Some(v) = &args.password {
        body.insert("password".into(), json!(v));
    }
    if let Some(v) = &args.indexing_enabled {
        body.insert("indexing_enabled".into(), json!(v));
    }
    let value = api
        .patch(
            &with_workspace_query(
                &format!("/api/publications/{}", args.publication),
                &workspace,
            ),
            &serde_json::Value::Object(body),
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn revoke(cli: &Cli, writer: &Writer, args: &RevokeArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let value = api
        .delete(&with_workspace_query(
            &format!("/api/publications/{}", args.publication),
            &workspace,
        ))
        .await?;
    writer.emit_value(&value);
    Ok(())
}
