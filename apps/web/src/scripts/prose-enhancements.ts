const COPY_ICON = `<svg class="prose-copy-icon-copy" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg class="prose-copy-icon-check" aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
let mermaidSeq = 0;
let themeObserverInstalled = false;
let mermaidRenderSeq = 0;

export function enhanceProse() {
  attachCopyButtons();
  void renderMermaidBlocks();
  if (!themeObserverInstalled) {
    themeObserverInstalled = true;
    const observer = new MutationObserver((mutations) => {
      if (
        mutations.some((mutation) => mutation.attributeName === "data-theme")
      ) {
        void rerenderMermaidBlocks();
      }
    });
    observer.observe(document.documentElement, { attributes: true });
  }
}

function attachCopyButtons() {
  const blocks = proseRoots().flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLPreElement>("pre")),
  );
  blocks.forEach((pre) => {
    if (pre.querySelector(".prose-copy-btn")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "prose-copy-btn";
    button.setAttribute("aria-label", "Copy code to clipboard");
    button.innerHTML = `${COPY_ICON}${CHECK_ICON}`;
    button.addEventListener("click", async () => {
      const code = pre.querySelector("code");
      const text = code?.innerText ?? pre.innerText;
      try {
        await navigator.clipboard.writeText(text.trimEnd());
        button.classList.add("is-copied");
        button.setAttribute("aria-label", "Copied");
        window.setTimeout(() => {
          button.classList.remove("is-copied");
          button.setAttribute("aria-label", "Copy code to clipboard");
        }, 1400);
      } catch {
        /* clipboard blocked */
      }
    });
    pre.append(button);
  });
}

function proseRoots() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-vpg-prose]"));
}

function mermaidBlocks() {
  return proseRoots().flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>(".mermaid-block")),
  );
}

async function loadMermaid() {
  mermaidPromise ??= import("mermaid").then((mod) => mod.default);
  return mermaidPromise;
}

function isDarkTheme() {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

async function renderMermaidBlocks() {
  const blocks = mermaidBlocks().filter(
    (block) => block.dataset.mermaidState !== "rendered",
  );
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  mermaid.initialize({
    startOnLoad: false,
    theme: isDarkTheme() ? "dark" : "neutral",
    securityLevel: "strict",
    fontFamily: "var(--font-sans)",
  });
  for (const block of Array.from(blocks)) {
    if (
      block.dataset.mermaidState === "pending" ||
      block.dataset.mermaidState === "rendered"
    ) {
      continue;
    }
    const src = (
      block.dataset.mermaidOriginal ??
      block.textContent ??
      ""
    ).trim();
    if (!src) continue;
    block.dataset.mermaidOriginal = src;
    block.dataset.mermaidState = "pending";
    block.setAttribute("aria-busy", "true");
    const renderId = String(++mermaidRenderSeq);
    block.dataset.mermaidRenderId = renderId;
    try {
      const id = `vpg-mermaid-${Date.now()}-${mermaidSeq++}`;
      const { svg } = await mermaid.render(id, src);
      if (block.dataset.mermaidRenderId !== renderId) continue;
      block.innerHTML = svg;
      block.dataset.mermaidState = "rendered";
      block.dataset.mermaidRendered = "true";
      delete block.dataset.mermaidError;
    } catch (error) {
      if (block.dataset.mermaidRenderId !== renderId) continue;
      block.textContent = src;
      block.dataset.mermaidState = "error";
      block.dataset.mermaidError = "true";
      console.warn("Mermaid render failed", error);
    } finally {
      if (block.dataset.mermaidRenderId === renderId) {
        block.removeAttribute("aria-busy");
        delete block.dataset.mermaidRenderId;
      }
    }
  }
}

async function rerenderMermaidBlocks() {
  const blocks = mermaidBlocks().filter(
    (block) =>
      block.dataset.mermaidState === "rendered" ||
      block.dataset.mermaidRendered === "true",
  );
  blocks.forEach((block) => {
    const original = block.dataset.mermaidOriginal;
    if (!original) return;
    block.textContent = original;
    delete block.dataset.mermaidState;
    delete block.dataset.mermaidRendered;
    delete block.dataset.mermaidError;
  });
  await renderMermaidBlocks();
}
