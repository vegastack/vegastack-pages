//! Output layer.
//!
//! `Writer` chooses one of three behaviors based on the user's flags
//! + the TTY state:
//!   - **Interactive** (default when stdout is a TTY): renders pretty
//!     tables via `output::table` and chatty status lines via `status()`.
//!     `emit_value()` falls back to a pretty-printed JSON envelope so
//!     callers can stay JSON-first without losing readability.
//!   - **Json** (auto-selected when stdout is piped, or with `--json`):
//!     pretty-printed JSON envelope on stdout, pretty-printed JSON error
//!     on stderr, exit codes mapped by `errors::VpgError`.
//!   - **Agent** (`--agent`): the same JSON envelope but COMPACT
//!     single-line so line-by-line parsers can `JSON.parse` each line.
//!     Streaming commands (`events`, `pages wait`) emit NDJSON.

pub mod table;

use std::io::{self, Write};

use serde_json::{json, Value};

use crate::errors::VpgError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputMode {
    Interactive,
    Json,
    Agent,
}

#[derive(Clone, Debug)]
pub struct Writer {
    pub mode: OutputMode,
    pub quiet: bool,
}

impl Writer {
    pub fn new(mode: OutputMode, quiet: bool, _verbose: bool) -> Self {
        use is_terminal::IsTerminal;
        let stdout_is_tty = io::stdout().is_terminal();
        // Auto-degrade to JSON when stdout is not a TTY in Interactive mode —
        // matches the behavior of gh / wrangler / ntn when piped.
        let resolved = match mode {
            OutputMode::Interactive if !stdout_is_tty => OutputMode::Json,
            other => other,
        };
        Self {
            mode: resolved,
            quiet,
        }
    }

    pub fn is_interactive(&self) -> bool {
        matches!(self.mode, OutputMode::Interactive)
    }

    pub fn is_agent(&self) -> bool {
        matches!(self.mode, OutputMode::Agent)
    }

    /// Emit a success payload as JSON.
    ///
    /// - Agent mode: single-line compact JSON (machine-parseable).
    /// - Json / Interactive (degraded to Json): pretty-printed multi-line.
    ///
    /// `--quiet` suppresses chatty interactive status lines but NEVER the
    /// agent/JSON data envelope — that's the actual result. Use
    /// `> /dev/null` if you want to throw it away.
    pub fn emit_value(&self, value: &Value) {
        if self.quiet && self.is_interactive() {
            return;
        }
        let envelope = json!({
            "data": value,
            "meta": { "version": env!("CARGO_PKG_VERSION") },
        });
        let serialized = if self.is_agent() {
            serde_json::to_string(&envelope)
        } else {
            serde_json::to_string_pretty(&envelope)
        }
        .unwrap_or_else(|_| "{}".to_string());
        let mut out = io::stdout().lock();
        let _ = out.write_all(serialized.as_bytes());
        let _ = out.write_all(b"\n");
    }

    /// Emit one NDJSON line to stdout (streaming commands).
    pub fn emit_ndjson(&self, value: &Value) {
        let serialized = serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string());
        let mut out = io::stdout().lock();
        let _ = out.write_all(serialized.as_bytes());
        let _ = out.write_all(b"\n");
    }

    /// Emit a structured error to stderr.
    ///
    /// Agent mode emits single-line compact JSON so line-by-line parsers
    /// (the contract for `--agent`) work without preprocessing. Interactive
    /// + JSON modes keep pretty-print for human readability.
    pub fn emit_error(&self, err: &VpgError) {
        let payload = json!({
            "error": {
                "code": err.code(),
                "message": err.message(),
                "details": err.details(),
            },
        });
        let serialized = if self.is_agent() {
            serde_json::to_string(&payload)
        } else {
            serde_json::to_string_pretty(&payload)
        }
        .unwrap_or_else(|_| "{}".to_string());
        let mut out = io::stderr().lock();
        let _ = out.write_all(serialized.as_bytes());
        let _ = out.write_all(b"\n");
    }

    /// Interactive-only status line on stderr. Quiet + non-interactive modes
    /// drop the line silently — agents shouldn't see chatter.
    pub fn status(&self, msg: impl AsRef<str>) {
        if self.quiet || !self.is_interactive() {
            return;
        }
        let mut out = io::stderr().lock();
        let _ = writeln!(out, "{}", msg.as_ref());
    }
}
