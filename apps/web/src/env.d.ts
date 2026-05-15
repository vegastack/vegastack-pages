/// <reference types="astro/client" />

declare module "cloudflare:workers" {
  export function waitUntil(promise: Promise<unknown>): void;
}

interface Window {
  __vpgPageHeaderInitialized?: boolean;
  __vpgSidebarCreateInitialized?: boolean;
  __vpgSidebarInitialized?: boolean;
  __vpgSidebarPrefetchInitialized?: boolean;
}
