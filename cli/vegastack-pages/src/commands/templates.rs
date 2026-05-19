use clap::{Args, Subcommand};
use serde_json::Value;

use crate::api::Api;
use crate::cli::Cli;
use crate::commands::shared::{
    build_property_object, parse_kv_list, read_json_arguments, resolve_template_id,
};
use crate::config::resolved_workspace;
use crate::errors::VpgError;
use crate::output::Writer;

#[derive(Subcommand, Debug)]
pub enum TemplatesCommand {
    List(ListArgs),
    Get(GetArgs),
    Create(CreateArgs),
    Update(UpdateArgs),
    Render(RenderArgs),
}

#[derive(Args, Debug)]
pub struct ListArgs {
    #[arg(long)]
    pub category: Option<String>,
}

#[derive(Args, Debug)]
pub struct GetArgs {
    pub template: String,
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    #[arg(long)]
    pub args: Option<String>,
    #[arg(long = "args-file")]
    pub args_file: Option<String>,
    #[arg(long = "set")]
    pub set: Vec<String>,
}

#[derive(Args, Debug)]
pub struct UpdateArgs {
    pub template: String,
    #[arg(long)]
    pub args: Option<String>,
    #[arg(long = "args-file")]
    pub args_file: Option<String>,
    #[arg(long = "set")]
    pub set: Vec<String>,
}

#[derive(Args, Debug)]
pub struct RenderArgs {
    pub template: String,
    #[arg(long)]
    pub title: String,
    #[arg(long = "set")]
    pub set: Vec<String>,
}

pub async fn dispatch(
    cli: &Cli,
    writer: &Writer,
    cmd: &TemplatesCommand,
) -> Result<(), VpgError> {
    match cmd {
        TemplatesCommand::List(args) => list(cli, writer, args).await,
        TemplatesCommand::Get(args) => get(cli, writer, args).await,
        TemplatesCommand::Create(args) => create(cli, writer, args).await,
        TemplatesCommand::Update(args) => update(cli, writer, args).await,
        TemplatesCommand::Render(args) => render(cli, writer, args).await,
    }
}

async fn list(cli: &Cli, writer: &Writer, args: &ListArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let mut value = api
        .get(&format!("/api/workspaces/{workspace}/templates"), &[])
        .await?;
    if let Some(category) = &args.category {
        if let Some(arr) = value.get_mut("templates").and_then(Value::as_array_mut) {
            arr.retain(|t| {
                t.get("category").and_then(Value::as_str) == Some(category.as_str())
            });
        }
    }
    writer.emit_value(&value);
    Ok(())
}

async fn get(cli: &Cli, writer: &Writer, args: &GetArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let template_id = resolve_template_id(&api, &workspace, &args.template).await?;
    let value = api
        .get(&format!("/api/templates/{template_id}"), &[])
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn create(cli: &Cli, writer: &Writer, args: &CreateArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let pairs = parse_kv_list(&args.set)?;
    let body = read_json_arguments(&args.args, &args.args_file, &pairs, Some(workspace.clone()))?;
    let value = api
        .post(&format!("/api/workspaces/{workspace}/templates"), &body)
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn update(cli: &Cli, writer: &Writer, args: &UpdateArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let template_id = resolve_template_id(&api, &workspace, &args.template).await?;
    let pairs = parse_kv_list(&args.set)?;
    let body = read_json_arguments(&args.args, &args.args_file, &pairs, Some(workspace))?;
    let value = api
        .patch(&format!("/api/templates/{template_id}"), &body)
        .await?;
    writer.emit_value(&value);
    Ok(())
}

async fn render(cli: &Cli, writer: &Writer, args: &RenderArgs) -> Result<(), VpgError> {
    let workspace = resolved_workspace(cli)?;
    let api = Api::new(cli)?;
    let template_id = resolve_template_id(&api, &workspace, &args.template).await?;
    let pairs = parse_kv_list(&args.set)?;
    let body = serde_json::json!({
        "title": args.title,
        "properties": build_property_object(&pairs),
    });
    let value = api
        .post(&format!("/api/templates/{template_id}/render"), &body)
        .await?;
    writer.emit_value(&value);
    Ok(())
}
