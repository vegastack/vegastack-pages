mod api;
mod auth;
mod cli;
mod commands;
mod config;
mod errors;
mod output;

use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    cli::run().await
}
