use std::fs;

use clap::{Args, Subcommand};
use serde_json::{json, Value};

use crate::api::Api;
use crate::cli::Cli;
use crate::config::{resolved_workspace, update_stored_config};
use crate::errors::VpgError;
use crate::output::table::render_rows;
use crate::output::Writer;

#[derive(Subcommand, Debug)]
pub enum WorkspacesCommand {
    /// List workspaces visible to the active user.
    List,
    /// Print the workspace folder/page tree.
    Tree(TreeArgs),
    /// Export the workspace as a zip.
    Export(ExportArgs),
    /// List members of a workspace.
    Members(MembersArgs),
    /// Invite a member by email.
    Invite(InviteArgs),
}

#[derive(Args, Debug)]
pub struct UseArgs {
    pub workspace: String,
}

#[derive(Args, Debug)]
pub struct TreeArgs {
    #[arg(long)]
    pub workspace: Option<String>,
}

#[derive(Args, Debug)]
pub struct ExportArgs {
    #[arg(long)]
    pub workspace: Option<String>,
    #[arg(long)]
    pub out: Option<String>,
}

#[derive(Args, Debug)]
pub struct MembersArgs {
    #[arg(long)]
    pub workspace: Option<String>,
}

#[derive(Args, Debug)]
pub struct InviteArgs {
    #[arg(long)]
    pub email: String,
    #[arg(long = "display-name")]
    pub display_name: Option<String>,
    #[arg(long, default_value = "reader")]
    pub role: String,
    #[arg(long)]
    pub workspace: Option<String>,
}

pub async fn dispatch(
    cli: &Cli,
    writer: &Writer,
    cmd: &WorkspacesCommand,
) -> Result<(), VpgError> {
    match cmd {
        WorkspacesCommand::List => list(cli, writer).await,
        WorkspacesCommand::Tree(args) => tree(cli, writer, args).await,
        WorkspacesCommand::Export(args) => export(cli, writer, args).await,
        WorkspacesCommand::Members(args) => members(cli, writer, args).await,
        WorkspacesCommand::Invite(args) => invite(cli, writer, args).await,
    }
}

pub async fn run_use(cli: &Cli, writer: &Writer, args: &UseArgs) -> Result<(), VpgError> {
    let path = update_stored_config(|c| {
        c.workspace_id = Some(args.workspace.clone());
        // Only persist base_url when the user actually passed --base-url
        // (or set VPG_BASE_URL). Previously the clap default
        // https://pages.vegastack.com was always written, wiping any
        // existing custom value. (Audit cycle 5 finding.)
        if let Some(url) = &cli.base_url {
            c.base_url = Some(url.trim_end_matches('/').to_string());
        }
    })?;
    writer.emit_value(&json!({
        "status": "ok",
        "workspace_id": args.workspace,
        "config_path": path.display().to_string(),
    }));
    Ok(())
}

async fn list(cli: &Cli, writer: &Writer) -> Result<(), VpgError> {
    let api = Api::new(cli)?;
    let value = api.get("/api/workspaces", &[]).await?;
    if writer.is_interactive() {
        let workspaces = value
            .get("workspaces")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let rows: Vec<Vec<String>> = workspaces
            .iter()
            .map(|w| {
                vec![
                    w.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
                    w.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    w.get("slug").and_then(Value::as_str).unwrap_or("").to_string(),
                    w.get("role").and_then(Value::as_str).unwrap_or("").to_string(),
                ]
            })
            .collect();
        render_rows(writer, &["ID", "Name", "Slug", "Role"], rows);
    } else {
        writer.emit_value(&value);
    }
    Ok(())
}

async fn tree(cli: &Cli, writer: &Writer, args: &TreeArgs) -> Result<(), VpgError> {
    let workspace = match &args.workspace {
        Some(w) => w.clone(),
        None => resolved_workspace(cli)?,
    };
    let api = Api::new(cli)?;
    let value = api
        .get(&format!("/api/workspaces/{workspace}/tree"), &[])
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn export(cli: &Cli, writer: &Writer, args: &ExportArgs) -> Result<(), VpgError> {
    let workspace = match &args.workspace {
        Some(w) => w.clone(),
        None => resolved_workspace(cli)?,
    };
    let api = Api::new(cli)?;
    let bytes = api
        .download(&format!("/api/workspaces/{workspace}/export"))
        .await?;
    let filename = args.out.clone().unwrap_or_else(|| {
        // Sanitize workspace_id when interpolating into a default filename:
        // a hostile id containing `/` or `..` could otherwise write
        // outside the current directory. (Audit cycle 5 finding.)
        let safe: String = workspace
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        format!("{safe}-vegastack-pages.zip")
    });
    fs::write(&filename, &bytes).map_err(|e| {
        VpgError::generic(format!("failed to write {filename}: {e}"))
    })?;
    writer.emit_value(&json!({
        "status": "ok",
        "workspace_id": workspace,
        "out": filename,
        "bytes": bytes.len(),
    }));
    Ok(())
}

async fn members(cli: &Cli, writer: &Writer, args: &MembersArgs) -> Result<(), VpgError> {
    let workspace = match &args.workspace {
        Some(w) => w.clone(),
        None => resolved_workspace(cli)?,
    };
    let api = Api::new(cli)?;
    let value = api
        .get(&format!("/api/workspaces/{workspace}/members"), &[])
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn invite(cli: &Cli, writer: &Writer, args: &InviteArgs) -> Result<(), VpgError> {
    let workspace = match &args.workspace {
        Some(w) => w.clone(),
        None => resolved_workspace(cli)?,
    };
    let api = Api::new(cli)?;
    let body = json!({
        "email": args.email,
        "display_name": args.display_name,
        "role": args.role,
    });
    let value = api
        .post(&format!("/api/workspaces/{workspace}/invites"), &body)
        .await?;
    writer.emit_value(&value);
    Ok(())
}
