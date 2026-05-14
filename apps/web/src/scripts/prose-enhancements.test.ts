import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({ default: mermaidMock }));

type ObserverCallback = (mutations: Array<{ attributeName: string }>) => void;

let observerCallback: ObserverCallback | null = null;

class FakeMutationObserver {
  constructor(callback: ObserverCallback) {
    observerCallback = callback;
  }

  observe() {
    return undefined;
  }
}

class FakeElement {
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  className = "";
  dataset: Record<string, string | undefined> = {};
  private html = "";
  private text = "";

  constructor(
    readonly tagName: string,
    options: { className?: string; textContent?: string } = {},
  ) {
    this.className = options.className ?? "";
    this.textContent = options.textContent ?? "";
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.text = "";
  }

  get innerText() {
    return this.textContent;
  }

  get textContent() {
    if (this.text) return this.text;
    return this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.text = value;
    this.html = "";
  }

  append(child: FakeElement) {
    this.children.push(child);
  }

  addEventListener() {
    return undefined;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string) {
    return this.descendants().filter((element) => element.matches(selector));
  }

  private descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  private matches(selector: string) {
    if (selector === "pre") return this.tagName.toLowerCase() === "pre";
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return this.className.split(/\s+/).includes(className);
    }
    return false;
  }
}

class FakeDocument {
  documentElement = new FakeElement("html");

  constructor(private readonly roots: FakeElement[]) {}

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  querySelectorAll(selector: string) {
    if (selector === "[data-vpg-prose]") return this.roots;
    return [];
  }
}

function proseRoot(
  context: "app" | "docs",
  children: FakeElement[],
): FakeElement {
  const root = new FakeElement("div", { className: "prose" });
  root.dataset.vpgProse = "";
  root.dataset.context = context;
  root.children = children;
  return root;
}

function mermaidBlock(source: string) {
  return new FakeElement("div", {
    className: "mermaid-block",
    textContent: source,
  });
}

async function loadEnhancer(roots: FakeElement[]) {
  const fakeDocument = new FakeDocument(roots);
  vi.stubGlobal("document", fakeDocument);
  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  vi.stubGlobal("window", {
    matchMedia: vi.fn(() => ({ matches: false })),
    setTimeout,
  });
  vi.stubGlobal("navigator", {
    clipboard: { writeText: vi.fn() },
  });
  vi.resetModules();
  return import("./prose-enhancements");
}

beforeEach(() => {
  observerCallback = null;
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("enhanceProse", () => {
  it("renders Mermaid blocks and preserves the original source", async () => {
    const block = mermaidBlock("flowchart LR\n  A --> B");
    const { enhanceProse } = await loadEnhancer([proseRoot("app", [block])]);
    mermaidMock.render.mockResolvedValue({ svg: "<svg>ok</svg>" });

    enhanceProse();

    await vi.waitFor(() => {
      expect(block.dataset.mermaidState).toBe("rendered");
    });
    expect(block.dataset.mermaidOriginal).toBe("flowchart LR\n  A --> B");
    expect(block.dataset.mermaidRendered).toBe("true");
    expect(block.attributes.has("aria-busy")).toBe(false);
    expect(block.innerHTML).toBe("<svg>ok</svg>");
  });

  it("does not double-render a block when enhancement runs repeatedly", async () => {
    const block = mermaidBlock("sequenceDiagram\n  A->>B: ok");
    const { enhanceProse } = await loadEnhancer([proseRoot("app", [block])]);
    let resolveRender: (value: { svg: string }) => void = () => undefined;
    mermaidMock.render.mockReturnValue(
      new Promise((resolve) => {
        resolveRender = resolve;
      }),
    );

    enhanceProse();
    enhanceProse();

    await vi.waitFor(() => {
      expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    });
    resolveRender({ svg: "<svg>once</svg>" });
    await vi.waitFor(() => {
      expect(block.dataset.mermaidState).toBe("rendered");
    });
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });

  it("restores source on render failure and retries on the next enhancement", async () => {
    const source = "flowchart LR\n  A --> B";
    const block = mermaidBlock(source);
    const { enhanceProse } = await loadEnhancer([proseRoot("app", [block])]);
    mermaidMock.render
      .mockRejectedValueOnce(new Error("bad diagram"))
      .mockResolvedValueOnce({ svg: "<svg>retry</svg>" });

    enhanceProse();

    await vi.waitFor(() => {
      expect(block.dataset.mermaidState).toBe("error");
    });
    expect(block.textContent).toBe(source);
    expect(block.dataset.mermaidError).toBe("true");
    expect(block.attributes.has("aria-busy")).toBe(false);

    enhanceProse();

    await vi.waitFor(() => {
      expect(block.dataset.mermaidState).toBe("rendered");
    });
    expect(block.innerHTML).toBe("<svg>retry</svg>");
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);
  });

  it("rerenders existing diagrams when the active theme changes", async () => {
    const block = mermaidBlock("flowchart LR\n  A --> B");
    const { enhanceProse } = await loadEnhancer([proseRoot("docs", [block])]);
    mermaidMock.render
      .mockResolvedValueOnce({ svg: "<svg>light</svg>" })
      .mockResolvedValueOnce({ svg: "<svg>dark</svg>" });

    enhanceProse();
    await vi.waitFor(() => {
      expect(block.innerHTML).toBe("<svg>light</svg>");
    });

    document.documentElement.dataset.theme = "dark";
    observerCallback?.([{ attributeName: "data-theme" }]);

    await vi.waitFor(() => {
      expect(block.innerHTML).toBe("<svg>dark</svg>");
    });
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
  });

  it("renders Mermaid in both app and docs prose roots", async () => {
    const appBlock = mermaidBlock("flowchart LR\n  A --> B");
    const docsBlock = mermaidBlock("sequenceDiagram\n  A->>B: ok");
    const outsideBlock = mermaidBlock("flowchart LR\n  X --> Y");
    const { enhanceProse } = await loadEnhancer([
      proseRoot("app", [appBlock]),
      proseRoot("docs", [docsBlock]),
    ]);
    mermaidMock.render.mockResolvedValue({ svg: "<svg>ok</svg>" });

    enhanceProse();

    await vi.waitFor(() => {
      expect(mermaidMock.render).toHaveBeenCalledTimes(2);
    });
    expect(appBlock.dataset.mermaidState).toBe("rendered");
    expect(docsBlock.dataset.mermaidState).toBe("rendered");
    expect(outsideBlock.dataset.mermaidState).toBeUndefined();
  });
});
