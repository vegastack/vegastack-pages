use clap::{Args, Subcommand};
use serde_json::json;

use crate::api::{with_workspace_query, Api};
use crate::cli::Cli;
use crate::commands::shared::{read_attachment_base64_body, resolve_page_id};
use crate::config::resolved_workspace;
use crate::errors::VpgError;
use crate::output::Writer;

#[derive(Subcommand, Debug)]
pub enum AttachmentsCommand {
    Upload(UploadArgs),
}

#[derive(Args, Debug)]
pub struct UploadArgs {
    pub page: String,
    #[arg(long)]
    pub filename: String,
    #[arg(long = "content-type")]
    pub content_type: String,
    #[arg(long = "base64-body")]
    pub base64_body: Option<String>,
    #[arg(long = "base64-file")]
    pub base64_file: Option<String>,
}

pub async fn dispatch(
    cli: &Cli,
    writer: &Writer,
    cmd: &AttachmentsCommand,
) -> Result<(), VpgError> {
    match cmd {
        AttachmentsCommand::Upload(args) => upload(cli, writer, args).await,
    }
}

async fn upload(cli: &Cli, writer: &Writer, args: &UploadArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let page_id = resolve_page_id(&api, &args.page, &workspace).await?;
    let base64_body = read_attachment_base64_body(&args.base64_body, &args.base64_file)?;
    let body = json!({
        "filename": args.filename,
        "content_type": args.content_type,
        "base64_body": base64_body,
    });
    let value = api
        .post(
            &with_workspace_query(&format!("/api/pages/{page_id}/attachments"), &workspace),
            &body,
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}
