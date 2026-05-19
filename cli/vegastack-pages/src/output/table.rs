//! Pretty table rendering. Interactive only.

use comfy_table::{presets::UTF8_FULL, Cell, Table};

use crate::output::Writer;

pub fn render_rows(writer: &Writer, headers: &[&str], rows: Vec<Vec<String>>) {
    if !writer.is_interactive() {
        return;
    }
    let mut table = Table::new();
    table.load_preset(UTF8_FULL);
    table.set_header(headers.iter().map(|h| Cell::new(h)));
    for row in rows {
        table.add_row(row.into_iter().map(Cell::new));
    }
    println!("{table}");
}
