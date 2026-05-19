use clap::Args;
use serde_json::{json, Value};

use crate::api::Api;
use crate::auth;
use crate::cli::Cli;
use crate::config::{
    read_stored_config, remove_stored_token, resolved_workspace, update_stored_config,
    write_stored_token,
};
use crate::errors::VpgError;
use crate::output::Writer;

#[derive(Args, Debug)]
pub struct LoginArgs {
    /// Use a pasted workspace-scoped token instead of the browser flow.
    #[arg(long)]
    pub token: Option<String>,
    /// Skip the automatic browser launch (still prints the URL).
    #[arg(long = "no-browser")]
    pub no_browser: bool,
}

pub async fn run(cli: &Cli, writer: &Writer, args: &LoginArgs) -> Result<(), VpgError> {
    if let Some(token) = &args.token {
        return run_token_login(cli, writer, token).await;
    }
    run_device_login(cli, writer, args.no_browser).await
}

async fn run_token_login(cli: &Cli, writer: &Writer, token: &str) -> Result<(), VpgError> {
    let base_url = crate::config::resolved_base_url(cli);
    let storage = write_stored_token(token)?;
    update_stored_config(|c| c.base_url = Some(base_url.clone()))?;
    // Token verification is intentionally skipped here — users can run
    // `vpg whoami` to verify. Token-only logins don't return workspace_id;
    // the user picks one with `vpg use <id>` after.
    emit_login_result(writer, &base_url, "token", storage, None, None);
    Ok(())
}

async fn run_device_login(cli: &Cli, writer: &Writer, no_browser: bool) -> Result<(), VpgError> {
    let base_url = crate::config::resolved_base_url(cli);
    let api = Api::new(cli)?;
    let auth_resp = auth::device_authorize(cli, &api).await?;
    let visit_url = auth_resp
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| auth_resp.verification_uri.clone());

    if writer.is_interactive() {
        writer.status("");
        writer.status("Sign in to VegaStack Pages");
        writer.status("──────────────────────────");
        writer.status("");
        writer.status(format!("  1. Open this URL in your browser:"));
        writer.status(format!("       {visit_url}"));
        writer.status("");
        writer.status(format!("  2. Confirm the code matches:"));
        writer.status(format!("       {}", auth_resp.user_code));
        writer.status("");
        writer.status("  3. Pick a workspace and click Allow.");
        writer.status("");
    }

    let opened = if no_browser { false } else { auth::try_open_browser(&visit_url) };
    if writer.is_interactive() {
        if opened {
            writer.status("  (Your browser should open automatically. Waiting…)");
        } else {
            writer.status("  (Waiting for authorization in your browser…)");
        }
    }

    let token = auth::poll_device_token(
        &api,
        &auth_resp.device_code,
        auth_resp.interval,
        auth_resp.expires_in,
    )
    .await?;

    let storage = write_stored_token(&token.access_token)?;
    let workspace_id = token.workspace_id.clone().or_else(|| cli.workspace.clone());
    update_stored_config(|c| {
        c.base_url = Some(base_url.clone());
        if let Some(w) = &workspace_id {
            c.workspace_id = Some(w.clone());
        }
    })?;

    if writer.is_interactive() {
        match &workspace_id {
            Some(w) => writer.status(format!("✓ Logged in. Workspace: {w}")),
            None => writer.status("✓ Logged in (no default workspace set)."),
        }
    }

    emit_login_result(writer, &base_url, "device", storage, workspace_id, None);
    Ok(())
}

fn emit_login_result(
    writer: &Writer,
    base_url: &str,
    flow: &str,
    storage: String,
    workspace_id: Option<String>,
    me: Option<Value>,
) {
    let payload = json!({
        "status": "ok",
        "flow": flow,
        "base_url": base_url,
        "token_storage": storage,
        "workspace_id": workspace_id,
        "me": me,
    });
    writer.emit_value(&payload);
}

pub async fn logout(_cli: &Cli, writer: &Writer) -> Result<(), VpgError> {
    let path = remove_stored_token()?;
    writer.emit_value(&json!({
        "status": "ok",
        "message": "Stored CLI token removed.",
        "token_path": path.display().to_string(),
    }));
    Ok(())
}

pub async fn whoami(cli: &Cli, writer: &Writer) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli).ok();
    let stored = read_stored_config().unwrap_or_default();
    let api = Api::new(cli)?;
    let me = api.get("/api/me", &[]).await.ok();
    writer.emit_value(&json!({
        "status": "ok",
        "workspace_id": workspace,
        "base_url": cli.base_url.clone().unwrap_or_else(|| crate::config::resolved_base_url(cli)),
        "stored_base_url": stored.base_url,
        "me": me,
    }));
    Ok(())
}

