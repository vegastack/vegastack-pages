use clap::{Args, CommandFactory};
use clap_complete::{generate, Shell};

use crate::cli::Cli;
use crate::errors::VpgError;
use crate::output::Writer;

#[derive(Args, Debug)]
pub struct CompletionsArgs {
    pub shell: Shell,
}

pub async fn run(
    _cli: &Cli,
    _writer: &Writer,
    args: &CompletionsArgs,
) -> Result<(), VpgError> {
    let mut cmd = Cli::command();
    let bin_name = cmd.get_name().to_string();
    generate(args.shell, &mut cmd, bin_name, &mut std::io::stdout());
    Ok(())
}
