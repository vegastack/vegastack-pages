type CloudflareWorkersModule = {
  waitUntil?: (promise: Promise<unknown>) => void;
};

let waitUntilImport: Promise<
  ((promise: Promise<unknown>) => void) | null
> | null = null;

export function scheduleBackgroundTask(
  name: string,
  task: () => Promise<unknown> | unknown,
) {
  const promise = Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error(`[background:${name}] failed`, error);
    });

  void cloudflareWaitUntil().then((waitUntil) => {
    if (waitUntil) {
      waitUntil(promise);
    }
  });
}

async function cloudflareWaitUntil() {
  if (!waitUntilImport) {
    waitUntilImport = (async () => {
      const isCloudflareRuntime =
        process.env.VPG_ADAPTER === "cloudflare" ||
        process.env.VPG_RUNTIME === "cloudflare" ||
        process.env.CF_PAGES === "1";
      if (!isCloudflareRuntime) return null;
      try {
        const specifier = "cloudflare:workers";
        const module = (await import(
          /* @vite-ignore */ specifier
        )) as CloudflareWorkersModule;
        return typeof module.waitUntil === "function" ? module.waitUntil : null;
      } catch {
        return null;
      }
    })();
  }
  return waitUntilImport;
}
