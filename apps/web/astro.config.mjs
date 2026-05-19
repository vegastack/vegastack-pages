import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";

function escapeHtml(input) {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function remarkMermaid() {
  return (tree) => {
    const walk = (parent) => {
      if (!parent?.children) return;
      for (let i = 0; i < parent.children.length; i += 1) {
        const node = parent.children[i];
        if (node?.type === "code" && node.lang === "mermaid") {
          parent.children[i] = {
            type: "html",
            value: `<div class="mermaid-block" data-mermaid-source>${escapeHtml(node.value)}</div>`,
          };
        } else if (node?.children) {
          walk(node);
        }
      }
    };
    walk(tree);
  };
}

const target =
  process.env.VPG_RUNTIME ??
  (process.env.NODE_ENV === "development" ? "node" : "cloudflare");
// Local-dev origin allowlist. Production base URL comes from
// VPG_BASE_URL; an optional VPG_TUNNEL_URL covers cloudflared / ngrok
// previews. Personal tunnels and developer-specific domains belong in
// the operator's environment, not the source tree.
const allowedDomainSources = [
  "http://127.0.0.1:4322",
  "http://localhost:4322",
  process.env.VPG_BASE_URL,
  process.env.VPG_TUNNEL_URL,
].filter(Boolean);

function toAllowedDomain(source) {
  const url = new URL(source);
  return {
    protocol: url.protocol.replace(":", ""),
    hostname: url.hostname,
    ...(url.port ? { port: url.port } : {}),
  };
}

export default defineConfig({
  output: "server",
  prefetch: {
    prefetchAll: false,
    defaultStrategy: "hover",
  },
  security: {
    // OAuth token/device endpoints must accept standards-compliant
    // application/x-www-form-urlencoded POSTs from MCP brokers. Astro's global
    // origin check runs before our route middleware and blocks those requests,
    // so CSRF enforcement lives in src/middleware.ts where OAuth/MCP routes can
    // be deliberately excluded while browser mutations remain protected.
    checkOrigin: false,
    allowedDomains: allowedDomainSources.map(toAllowedDomain),
  },
  adapter:
    target === "node"
      ? node({ mode: "standalone" })
      : cloudflare({
          imageService: { build: "compile", runtime: "passthrough" },
          prerenderEnvironment: "node",
        }),
  integrations: [react()],
  // Disable Astro's dev toolbar widget. Its bundled chunk frequently
  // 504s after HMR ("Outdated Optimize Dep"), flooding the console.
  // The toolbar is a developer convenience — we don't use it in this
  // project, and the noise drowns out real errors during dev.
  devToolbar: { enabled: false },
  fonts: [
    {
      name: "Geist",
      cssVariable: "--font-geist",
      provider: fontProviders.fontsource(),
      // Body + heading weights only. The full 100-900 axis added 80% bytes
      // for weights the UI never uses.
      weights: ["400", "500", "600", "700"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["sans-serif"],
      // `swap` shows Astro's metric-matched fallback while the web font
      // loads. `block` hid text for up to 3s and tanked LCP.
      display: "swap",
    },
    {
      name: "Geist Mono",
      cssVariable: "--font-geist-mono",
      provider: fontProviders.fontsource(),
      weights: ["400", "500", "600"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["monospace"],
      display: "swap",
    },
  ],
  markdown: {
    remarkPlugins: [remarkMermaid],
    syntaxHighlight: "prism",
  },
  build: {
    inlineStylesheets: "auto",
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    optimizeDeps: {
      // Pre-bundle every dep that's used by a lazily-mounted React
      // component (sidebar create menu, share dialog, command palette,
      // comments slide-over, etc). Vite's auto-discovery picks these
      // up on first dynamic-import miss, BUT that triggers an
      // invalidation cascade that 504s any chunk URL the browser
      // already has open — surfacing as `Outdated Optimize Dep`
      // errors and toast messages like "Share controls failed to
      // load." Listing them here makes the optimize pass happen once
      // at dev-server start instead.
      // This list is the result of grepping every 3rd-party `from "…"`
      // import across `apps/web/src`. Vite would auto-discover most
      // of them on first hit, but each lazy discovery triggers a
      // re-optimize pass that 504s any chunk URL currently in flight.
      // Pre-bundling everything once at dev-server start eliminates
      // the cascade entirely. Keep this list in sync with the grep:
      //
      //   grep -rhE 'from "(@radix-ui|@codemirror|@lezer)/' \
      //     apps/web/src --include="*.ts*" --include="*.astro" -R \
      //     | grep -oE 'from "[^"]+"' | sort -u
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        // Radix UI primitives the lazily-mounted dialogs use.
        "@radix-ui/react-alert-dialog",
        "@radix-ui/react-dialog",
        "@radix-ui/react-dropdown-menu",
        "@radix-ui/react-popover",
        "@radix-ui/react-select",
        "@radix-ui/react-slot",
        "@radix-ui/react-tabs",
        "@radix-ui/react-tooltip",
        // Date picker (calendar in ShareDialog) + supporting libs.
        "react-day-picker",
        // Toast UX (Sonner replaces every former window.alert/confirm).
        "sonner",
        // Command-palette primitive.
        "cmdk",
        // Icon family.
        "lucide-react",
        // className helpers used throughout shadcn-ui components.
        "class-variance-authority",
        "clsx",
        "tailwind-merge",
        // CodeMirror — the page editor dynamic-imports the
        // page-editor-codemirror module, which pulls these.
        "@codemirror/commands",
        "@codemirror/lang-html",
        "@codemirror/lang-markdown",
        "@codemirror/language",
        "@codemirror/state",
        "@codemirror/view",
        "@lezer/common",
        "@lezer/highlight",
      ],
    },
    build: {
      chunkSizeWarningLimit: 900,
    },
    server: {
      // Operators with a tunneled dev host (cloudflared/ngrok) set
      // VPG_TUNNEL_URL — its hostname is forwarded through Vite's
      // allowed-hosts. No hardcoded developer-specific hosts here.
      allowedHosts: [
        process.env.VPG_TUNNEL_URL
          ? new URL(process.env.VPG_TUNNEL_URL).hostname
          : "",
      ].filter(Boolean),
    },
  },
});
