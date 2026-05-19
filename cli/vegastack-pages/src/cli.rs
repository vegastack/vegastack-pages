//! Top-level clap parser + dispatch.
//!
//! The Cli struct holds global flags (--agent, --json, --workspace, --token,
//! --base-url, --yes, --quiet, --verbose) that apply across every command.
//! The Command enum follows the noun-first hierarchy modeled on gh + wrangler
//! + ntn — top-level for hot path and cross-cutting verbs, noun groups for
//! resource CRUD.

use std::process::ExitCode;

use clap::{Parser, Subcommand};

use crate::commands;
use crate::errors::VpgError;
use crate::output::{OutputMode, Writer};

#[derive(Parser, Debug)]
#[command(name = "vpg", version, about = "VegaStack Pages CLI", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Command,

    /// Non-interactive agent mode: JSON to stdout, structured errors to
    /// stderr, no prompts, no progress decorations. Streaming commands
    /// emit NDJSON. Destructive operations still require --yes.
    #[arg(long, global = true)]
    pub agent: bool,

    /// JSON output only (otherwise behave interactively).
    #[arg(long, global = true)]
    pub json: bool,

    /// Skip confirmation prompts on destructive operations.
    #[arg(long = "yes", short = 'y', global = true)]
    pub yes: bool,

    /// Override the active workspace.
    #[arg(long, global = true)]
    pub workspace: Option<String>,

    /// Override the stored token (also reads VPG_TOKEN).
    #[arg(long, env = "VPG_TOKEN", global = true)]
    pub token: Option<String>,

    /// Override the API base URL (also reads VPG_BASE_URL). Falls back
    /// to the stored config value, then https://pages.vegastack.com.
    ///
    /// Kept as Option<String> so commands can distinguish "user passed
    /// --base-url explicitly" from "this is the default" — `vpg use`
    /// previously persisted the clap default into the config and
    /// silently wiped any custom base_url. (Audit cycle 5 finding.)
    #[arg(long = "base-url", env = "VPG_BASE_URL", global = true)]
    pub base_url: Option<String>,

    /// Suppress non-error output.
    #[arg(long, short = 'q', global = true)]
    pub quiet: bool,

    /// Verbose diagnostic output to stderr.
    #[arg(long, short = 'v', global = true)]
    pub verbose: bool,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    // ---- auth + hot path (top-level) ----
    /// Sign in via the device-code flow (or `--token` for a paste).
    Login(commands::login::LoginArgs),
    /// Clear stored credentials.
    Logout,
    /// Show the active workspace + auth state.
    Whoami,
    /// Switch the active workspace.
    Use(commands::workspaces::UseArgs),

    // ---- cross-cutting (top-level) ----
    /// Search pages / folders / comments across the workspace.
    Search(commands::search::SearchArgs),
    /// Stream or list review events.
    Events(commands::events::EventsArgs),
    /// Validate Markdown / MDX / HTML source.
    Validate(commands::validate::ValidateArgs),
    /// Diagnose CLI + backend connectivity.
    Doctor,
    /// Print shell completions.
    Completions(commands::completions::CompletionsArgs),

    // ---- noun groups ----
    /// Pages — create, read, update, restore.
    Pages {
        #[command(subcommand)]
        command: commands::pages::PagesCommand,
    },
    /// Comments — list, reply, resolve, delete.
    Comments {
        #[command(subcommand)]
        command: commands::comments::CommentsCommand,
    },
    /// Publications — page / folder / update / revoke.
    Publish {
        #[command(subcommand)]
        command: commands::publish::PublishCommand,
    },
    /// Templates — list, create, render.
    Templates {
        #[command(subcommand)]
        command: commands::templates::TemplatesCommand,
    },
    /// Workspaces — list, tree, export, members.
    Workspaces {
        #[command(subcommand)]
        command: commands::workspaces::WorkspacesCommand,
    },
    /// Attachments — upload binary assets to a page.
    Attachments {
        #[command(subcommand)]
        command: commands::attachments::AttachmentsCommand,
    },
}

/// Entry point. Parses args, builds the writer, dispatches to a command
/// module, and maps any returned `VpgError` to an exit code.
pub async fn run() -> ExitCode {
    let cli = Cli::parse();
    let mode = if cli.agent {
        OutputMode::Agent
    } else if cli.json {
        OutputMode::Json
    } else {
        OutputMode::Interactive
    };
    let writer = Writer::new(mode, cli.quiet, cli.verbose);
    let result = dispatch(&cli, &writer).await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            writer.emit_error(&err);
            ExitCode::from(err.exit_code())
        }
    }
}

async fn dispatch(cli: &Cli, writer: &Writer) -> Result<(), VpgError> {
    match &cli.command {
        Command::Login(args) => commands::login::run(cli, writer, args).await,
        Command::Logout => commands::login::logout(cli, writer).await,
        Command::Whoami => commands::login::whoami(cli, writer).await,
        Command::Use(args) => commands::workspaces::run_use(cli, writer, args).await,
        Command::Search(args) => commands::search::run(cli, writer, args).await,
        Command::Events(args) => commands::events::run(cli, writer, args).await,
        Command::Validate(args) => commands::validate::run(cli, writer, args).await,
        Command::Doctor => commands::doctor::run(cli, writer).await,
        Command::Completions(args) => commands::completions::run(cli, writer, args).await,
        Command::Pages { command } => commands::pages::dispatch(cli, writer, command).await,
        Command::Comments { command } => commands::comments::dispatch(cli, writer, command).await,
        Command::Publish { command } => commands::publish::dispatch(cli, writer, command).await,
        Command::Templates { command } => commands::templates::dispatch(cli, writer, command).await,
        Command::Workspaces { command } => commands::workspaces::dispatch(cli, writer, command).await,
        Command::Attachments { command } => commands::attachments::dispatch(cli, writer, command).await,
    }
}
