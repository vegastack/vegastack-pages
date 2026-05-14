export type Vendor = {
  id: string;
  label: string;
  matchers: Array<{ clientName?: RegExp; redirectHost?: RegExp }>;
};

export const VENDORS: Vendor[] = [
  {
    id: "claude",
    label: "Claude",
    matchers: [
      { clientName: /^claude/i },
      { redirectHost: /(^|\.)claude\.ai$/i },
      { redirectHost: /(^|\.)anthropic\.com$/i },
    ],
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    matchers: [
      { clientName: /chatgpt|openai/i },
      { redirectHost: /(^|\.)chatgpt\.com$/i },
      { redirectHost: /(^|\.)openai\.com$/i },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    matchers: [
      { clientName: /^cursor/i },
      { redirectHost: /(^|\.)cursor\.(com|sh)$/i },
    ],
  },
  {
    id: "windsurf",
    label: "Windsurf",
    matchers: [
      { clientName: /windsurf/i },
      { redirectHost: /(^|\.)codeium\.com$/i },
      { redirectHost: /(^|\.)windsurf\.(com|ai)$/i },
    ],
  },
  {
    id: "continue",
    label: "Continue",
    matchers: [{ clientName: /^continue/i }],
  },
  {
    id: "cline",
    label: "Cline",
    matchers: [{ clientName: /^cline/i }],
  },
  {
    id: "codex",
    label: "Codex",
    matchers: [{ clientName: /^codex/i }],
  },
  {
    id: "vpg-cli",
    label: "VegaStack CLI",
    matchers: [{ clientName: /^vpg|^vegastack/i }],
  },
  {
    id: "generic",
    label: "MCP client",
    matchers: [],
  },
];

export function vendorForClient(input: {
  clientName?: string | null;
  redirectUris?: string[] | null;
}): Vendor {
  const name = (input.clientName ?? "").trim();
  const hosts = (input.redirectUris ?? [])
    .map((value) => {
      try {
        return new URL(value).hostname;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  for (const vendor of VENDORS) {
    for (const matcher of vendor.matchers) {
      if (matcher.clientName && name && matcher.clientName.test(name)) {
        return vendor;
      }
      if (matcher.redirectHost) {
        for (const host of hosts) {
          if (matcher.redirectHost.test(host)) return vendor;
        }
      }
    }
  }
  return VENDORS[VENDORS.length - 1]!;
}
