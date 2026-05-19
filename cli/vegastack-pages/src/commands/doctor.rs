use crate::api::Api;
use crate::cli::Cli;
use crate::errors::VpgError;
use crate::output::Writer;

pub async fn run(cli: &Cli, writer: &Writer) -> Result<(), VpgError> {
    let api = Api::new(cli)?;
    let value = api.get("/api/setup/status", &[]).await?;
    writer.emit_value(&value);
    Ok(())
}
