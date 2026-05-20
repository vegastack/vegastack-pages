// Frontmatter key → human label transformation.
//
// Convention: frontmatter keys are written in `snake_case` (the
// markdown / Notion / Hugo / Jekyll de-facto standard) and rendered
// in the UI as sentence-cased labels:
//
//   created_at      → "Created at"
//   updated_at      → "Updated at"
//   for_audience    → "For audience"
//   last_edited_by  → "Last edited by"
//   owner           → "Owner"
//   summary         → "Summary"
//
// This mirrors Rails `humanize`, Django `verbose_name` defaults, and
// Notion's property-name → display behavior. Calling this everywhere
// labels are produced keeps the convention enforceable from one place
// instead of growing per-key special cases.
//
// Rules (in order):
//   1. Trim surrounding whitespace
//   2. Replace runs of `_` or `-` with a single space
//   3. Insert a space before any internal capital letter (camelCase
//      keys still display sensibly: "forAudience" → "For audience")
//   4. Collapse runs of whitespace to one space
//   5. Sentence-case: uppercase the first character, lowercase the
//      rest. Tokens that are already ALL-CAPS short acronyms (≤4
//      chars: "URL", "API", "MCP", "CLI", "FAQ") are preserved.

const ACRONYM_LIKE = /^[A-Z]{2,4}$/u;

export function humanizeFrontmatterKey(key: string): string {
  if (!key) return "";
  const tokens = key
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens
    .map((token, index) => {
      if (ACRONYM_LIKE.test(token)) return token;
      const lower = token.toLowerCase();
      if (index === 0) {
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }
      return lower;
    })
    .join(" ");
}

// System-managed frontmatter-like fields synthesized from the page
// row on display. NOT written into the YAML source — keeping them
// out avoids churning the content hash + version history on every
// edit. The display layer reads `page.createdAt` / `page.updatedAt`
// and produces these labeled entries to render alongside user
// frontmatter.
export const MANAGED_METADATA_KEYS = ["created_at", "updated_at"] as const;
export type ManagedMetadataKey = (typeof MANAGED_METADATA_KEYS)[number];

export function isManagedMetadataKey(key: string): boolean {
  return (MANAGED_METADATA_KEYS as readonly string[]).includes(key);
}
