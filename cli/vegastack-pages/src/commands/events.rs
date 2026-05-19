use clap::Args;
use serde_json::Value;

use crate::api::Api;
use crate::cli::Cli;
use crate::config::resolved_workspace;
use crate::errors::VpgError;
use crate::output::Writer;

#[derive(Args, Debug)]
pub struct EventsArgs {
    #[arg(long)]
    pub page: Option<String>,
    #[arg(long)]
    pub workspace: Option<String>,
    #[arg(long = "after-id")]
    pub after_id: Option<String>,
    #[arg(long, default_value_t = 50)]
    pub limit: u16,
}

pub async fn run(cli: &Cli, writer: &Writer, args: &EventsArgs) -> Result<(), VpgError> {
    let workspace = match &args.workspace {
        Some(w) => w.clone(),
        None => resolved_workspace(cli)?,
    };
    let api = Api::new(cli)?;
    let mut params: Vec<(&str, String)> = vec![
        ("workspace_id", workspace),
        ("limit", args.limit.to_string()),
    ];
    if let Some(p) = &args.page {
        params.push(("page_id", p.clone()));
    }
    if let Some(a) = &args.after_id {
        params.push(("after_id", a.clone()));
    }
    let value = api.get("/api/review-events", &params).await?;
    let events = value
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for ev in &events {
        writer.emit_ndjson(ev);
    }
    Ok(())
}
