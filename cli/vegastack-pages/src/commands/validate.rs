use clap::Args;

use crate::api::{with_workspace_query, Api};
use crate::cli::Cli;
use crate::commands::shared::{build_validate_source_body, read_source_value, resolve_page_id};
use crate::config::resolved_workspace;
use crate::errors::VpgError;
use crate::output::Writer;

#[derive(Args, Debug)]
pub struct ValidateArgs {
    #[arg(long)]
    pub page: Option<String>,
    #[arg(long)]
    pub source: Option<String>,
    #[arg(long)]
    pub file: Option<String>,
    #[arg(long)]
    pub stdin: bool,
    #[arg(long = "type")]
    pub source_type: Option<String>,
}

pub async fn run(cli: &Cli, writer: &Writer, args: &ValidateArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let source = if args.source.is_some() || args.file.is_some() || args.stdin {
        Some(read_source_value(&args.source, &args.file, args.stdin)?)
    } else {
        None
    };
    let page_id = match &args.page {
        Some(p) => Some(resolve_page_id(&api, p, &workspace).await?),
        None => None,
    };
    let body = build_validate_source_body(
        Some(workspace.clone()),
        page_id,
        source,
        args.source_type.as_deref(),
    );
    let value = api
        .post(&with_workspace_query("/api/validate-source", &workspace), &body)
        .await?;
    writer.emit_value(&value);
    Ok(())
}
