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
  process.env.VPG_ADAPTER ??
  (process.env.NODE_ENV === "development" ? "node" : "cloudflare");
const allowedDomainSources = [
  "http://127.0.0.1:4322",
  "http://localhost:4322",
  "https://pages-mk.vegastack.dev",
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
  fonts: [
    {
      name: "Geist",
      cssVariable: "--font-geist",
      provider: fontProviders.fontsource(),
      weights: ["100 900"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["sans-serif"],
      display: "block",
    },
    {
      name: "Geist Mono",
      cssVariable: "--font-geist-mono",
      provider: fontProviders.fontsource(),
      weights: ["100 900"],
      styles: ["normal"],
      subsets: ["latin", "latin-ext"],
      fallbacks: ["monospace"],
      display: "block",
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
      include: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
    },
    build: {
      chunkSizeWarningLimit: 900,
    },
    server: {
      allowedHosts: ["pages-mk.vegastack.dev"],
    },
  },
});
