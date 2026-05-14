// Cached GitHub stargazer count. SSR each request can't call api.github.com
// directly: the unauthenticated rate limit is 60/hour per IP, and Cloudflare
// Workers egress shares IPs across many tenants. We cache the result in
// module-level memory with a TTL, and on Cloudflare we also use the per-POP
// `caches.default` so isolates in the same POP share a single fetch. If the
// API is unreachable or rate-limited, we return `null` and the call site
// renders without a count rather than failing the page.

const FETCH_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

type Entry = { value: number | null; fetchedAt: number };

const memCache = new Map<string, Entry>();

function buildCacheUrl(repo: string) {
  // Synthetic URL — never fetched, just keyed into caches.default.
  return `https://internal.vegastack.pages/_cache/github-stars/${repo}`;
}

async function readEdgeCache(repo: string): Promise<Entry | null> {
  const edgeCaches = (globalThis as { caches?: { default?: Cache } }).caches;
  if (!edgeCaches?.default) return null;
  try {
    const hit = await edgeCaches.default.match(buildCacheUrl(repo));
    if (!hit) return null;
    const body = (await hit.json()) as Entry;
    if (typeof body?.fetchedAt !== "number") return null;
    return body;
  } catch {
    return null;
  }
}

async function writeEdgeCache(repo: string, entry: Entry) {
  const edgeCaches = (globalThis as { caches?: { default?: Cache } }).caches;
  if (!edgeCaches?.default) return;
  try {
    const seconds = Math.floor(CACHE_TTL_MS / 1000);
    await edgeCaches.default.put(
      buildCacheUrl(repo),
      new Response(JSON.stringify(entry), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${seconds}`,
        },
      }),
    );
  } catch {
    // Best-effort cache write.
  }
}

async function fetchStars(repo: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "vegastack-pages-web",
      },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { stargazers_count?: unknown };
    return typeof body.stargazers_count === "number"
      ? body.stargazers_count
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getGithubStars(repo: string): Promise<number | null> {
  const now = Date.now();
  const cached = memCache.get(repo);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.value;

  const edge = await readEdgeCache(repo);
  if (edge && now - edge.fetchedAt < CACHE_TTL_MS) {
    memCache.set(repo, edge);
    return edge.value;
  }

  const value = await fetchStars(repo);
  const entry: Entry = { value, fetchedAt: now };
  memCache.set(repo, entry);
  // Only persist successful results to the edge cache so we retry promptly
  // after a failure instead of caching a `null` for 10 minutes.
  if (value !== null) void writeEdgeCache(repo, entry);
  return value;
}

export function formatStarCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) {
    const rounded = Math.floor((count / 1000) * 10) / 10;
    return `${rounded.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${Math.floor(count / 1000)}k`;
}
