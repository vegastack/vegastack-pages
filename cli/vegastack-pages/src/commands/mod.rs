//! Command implementations.
//!
//! Each top-level command or noun group has its own module here. Modules
//! own their clap arg structs (re-exported via `pub` for `cli.rs`) and a
//! single `run` or `dispatch` async function that owns the work.

pub mod shared;

pub mod attachments;
pub mod comments;
pub mod completions;
pub mod doctor;
pub mod events;
pub mod login;
pub mod pages;
pub mod publish;
pub mod search;
pub mod templates;
pub mod validate;
pub mod workspaces;
