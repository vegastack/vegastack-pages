use clap::Args;

use crate::api::Api;
use crate::cli::Cli;
use crate::config::resolved_workspace;
use crate::errors::VpgError;
use crate::output::Writer;

#[derive(Args, Debug)]
pub struct SearchArgs {
    pub query: String,
    /// Resource type filter. Singular forms match the MCP `search.type`
    /// enum exactly: `all`, `page`, `folder`, `comment_thread`, `comment`.
    #[arg(
        long = "type",
        default_value = "all",
        value_parser = ["all", "page", "folder", "comment_thread", "comment"],
    )]
    pub resource_type: String,
    #[arg(long, default_value_t = 10)]
    pub limit: u16,
}

pub async fn run(cli: &Cli, writer: &Writer, args: &SearchArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let value = api
        .get(
            "/api/search",
            &[
                ("workspace_id", workspace),
                ("q", args.query.clone()),
                ("type", args.resource_type.clone()),
                ("limit", args.limit.to_string()),
            ],
        )
        .await?;
    writer.emit_value(&value);
    Ok(())
}
