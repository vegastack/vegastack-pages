import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { html as htmlLanguage } from "@codemirror/lang-html";
import {
  markdown,
  markdownKeymap,
  markdownLanguage,
} from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import {
  Compartment,
  EditorSelection,
  EditorState,
  type ChangeSpec,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { tags as t } from "@lezer/highlight";

export type PageEditorInit = {
  pageId: string;
  source: string;
  sourceType: "markdown" | "mdx" | "html";
  title: string;
  versionId: string;
  guestNameRequired: boolean;
  mount: HTMLElement;
  onReady?: () => void;
};

export type PageEditorApi = {
  flushSave: (checkpoint: boolean) => Promise<void>;
  focus: () => void;
  getSource: () => string;
  setEditable: (editable: boolean) => void;
};

type SaveStatus = "idle" | "saved" | "saving" | "error";

type EditableSource = {
  body: string;
  frontmatterRaw: string;
  hiddenLeadingHeading: string;
};

const HEADING_ID_PREFIX = "user-content-";
const AUTO_SAVE_DELAY_MS = 650;

const proseHighlightStyle = HighlightStyle.define([
  { tag: t.strong, fontWeight: "var(--weight-bold)" },
  { tag: t.emphasis, fontStyle: "italic" },
  {
    tag: t.strikethrough,
    color: "var(--vsk-muted)",
    textDecoration: "line-through",
  },
  {
    tag: t.link,
    color: "var(--vsk-text)",
    textDecoration: "underline",
    textDecorationColor: "var(--vsk-tint-28)",
  },
  { tag: t.url, color: "var(--vsk-muted)" },
  {
    tag: t.monospace,
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-relative-lg)",
  },
  {
    tag: t.processingInstruction,
    color: "var(--vsk-muted-70)",
  },
  { tag: t.contentSeparator, color: "var(--vsk-muted)" },
  { tag: t.meta, color: "var(--vsk-muted)" },
  { tag: t.quote, color: "var(--vsk-muted)", fontStyle: "italic" },
]);

const editorTheme = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  ".cm-content": { caretColor: "var(--vsk-text)" },
});

export function createPageEditor(init: PageEditorInit): PageEditorApi {
  return new PageEditor(init).api();
}

class PageEditor {
  private readonly bodyHost: HTMLElement;
  private readonly editableCompartment = new Compartment();
  private frontmatterList: HTMLElement | null = null;
  private readonly readOnlyCompartment = new Compartment();
  private readonly allInputs: HTMLInputElement[] = [];
  private readonly message: HTMLElement;
  private readonly root: HTMLElement;
  private readonly view: EditorView;
  private autoSaveTimer: number | null = null;
  private baseVersionId: string;
  private conflict = false;
  private editable = true;
  private frontmatterRaw: string;
  private guestName = "";
  private hiddenLeadingHeading: string;
  private savedSource: string;

  constructor(private readonly init: PageEditorInit) {
    const parsed = splitEditableSource(
      init.source,
      init.title,
      init.sourceType,
    );
    this.frontmatterRaw = parsed.frontmatterRaw;
    this.hiddenLeadingHeading = parsed.hiddenLeadingHeading;
    this.savedSource = init.source;
    this.baseVersionId = init.versionId;
    this.root = document.createElement("section");
    this.root.className = "source-editor-shell vpg-page-editor-shell";
    this.root.dataset.editable = "true";
    this.root.setAttribute("aria-label", "Source editor");

    this.message = document.createElement("div");
    this.message.className = "source-editor-message";
    this.message.dataset.vpgEditorMessage = "true";

    this.renderFrontmatter();
    this.root.append(this.message);
    this.bodyHost = document.createElement("div");
    this.bodyHost.className = "source-editor-codemirror";
    this.bodyHost.dataset.editable = "true";
    this.bodyHost.setAttribute("aria-label", `${init.sourceType} body`);
    this.root.append(this.bodyHost);
    init.mount.replaceChildren(this.root);
    init.mount.hidden = false;

    this.view = new EditorView({
      doc: parsed.body,
      parent: this.bodyHost,
      extensions: this.extensions(),
    });
    this.emitSourceChange();
    this.init.onReady?.();
  }

  api(): PageEditorApi {
    return {
      flushSave: (checkpoint) => this.flushSave(checkpoint),
      focus: () => this.view.focus(),
      getSource: () => this.getSource(),
      setEditable: (editable) => this.setEditable(editable),
    };
  }

  private extensions(): Extension[] {
    const markdownExtensions =
      this.init.sourceType === "html"
        ? []
        : [
            markdown({ base: markdownLanguage, addKeymap: false }),
            syntaxHighlighting(proseHighlightStyle),
            markdownLivePreview(),
          ];
    const htmlExtensions =
      this.init.sourceType === "html" ? [htmlLanguage()] : [];
    const markdownBindings =
      this.init.sourceType === "html"
        ? []
        : [
            {
              key: "Mod-b",
              run: (view: EditorView) =>
                wrapSelection(view, "**", "**", "bold text"),
            },
            {
              key: "Mod-i",
              run: (view: EditorView) =>
                wrapSelection(view, "_", "_", "italic text"),
            },
            { key: "Mod-k", run: insertLink },
            {
              key: "Mod-Shift-1",
              run: (view: EditorView) => setHeading(view, 1),
            },
            {
              key: "Mod-Shift-2",
              run: (view: EditorView) => setHeading(view, 2),
            },
            {
              key: "Mod-Shift-3",
              run: (view: EditorView) => setHeading(view, 3),
            },
            {
              key: "Mod-Shift-l",
              run: (view: EditorView) => prefixLines(view, "- "),
            },
            {
              key: "Mod-Shift-.",
              run: (view: EditorView) => prefixLines(view, "> "),
            },
            ...markdownKeymap,
          ];

    return [
      history(),
      EditorView.lineWrapping,
      ...markdownExtensions,
      ...htmlExtensions,
      editorTheme,
      this.readOnlyCompartment.of(EditorState.readOnly.of(false)),
      this.editableCompartment.of(EditorView.editable.of(true)),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            void this.flushSave(true);
            return true;
          },
        },
        ...markdownBindings,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        this.emitSourceChange();
        this.scheduleSave();
      }),
    ];
  }

  private renderFrontmatter() {
    if (this.init.sourceType === "html") return;
    if (this.init.guestNameRequired) {
      this.guestName = window.localStorage.getItem("vpg_guest_name") ?? "";
    }
    const frontmatter = parseFrontmatterMap(this.frontmatterRaw);
    const visibleKeys = Object.keys(frontmatter).filter(
      (key) => key !== "title",
    );
    if (!this.init.guestNameRequired && visibleKeys.length === 0) return;

    const list = document.createElement("dl");
    list.className = "frontmatter-editor";
    list.dataset.editable = "true";
    list.setAttribute("aria-label", "Page metadata");
    this.frontmatterList = list;
    this.root.dataset.hasFrontmatter = "true";

    if (this.init.guestNameRequired) {
      const input = this.createInput("Your name", this.guestName);
      this.allInputs.push(input);
      input.autocomplete = "name";
      input.placeholder = "Jane Reviewer";
      input.addEventListener("input", () => {
        this.guestName = input.value;
      });
      list.append(row("Your name", input));
    }

    for (const key of visibleKeys) {
      const input = this.createInput(key, frontmatter[key] ?? "");
      this.allInputs.push(input);
      input.addEventListener("input", () => {
        this.frontmatterRaw = replaceFrontmatterField(
          this.frontmatterRaw,
          key,
          input.value,
        );
        this.emitSourceChange();
        this.scheduleSave();
      });
      list.append(row(key, input));
    }

    this.root.append(list);
  }

  private createInput(label: string, value: string) {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.setAttribute("aria-label", label);
    return input;
  }

  private getSource() {
    if (this.init.sourceType === "html") return this.view.state.doc.toString();
    const body = `${this.hiddenLeadingHeading}${this.view.state.doc.toString()}`;
    return buildSource(this.frontmatterRaw, body);
  }

  private emitSourceChange() {
    const source = this.getSource();
    window.__vpgCurrentSource = source;
    window.dispatchEvent(
      new CustomEvent("vpg:source-change", {
        detail: { source, sourceType: this.init.sourceType },
      }),
    );
  }

  private setEditable(editable: boolean) {
    this.editable = editable;
    this.root.dataset.editable = String(editable);
    this.bodyHost.dataset.editable = String(editable);
    if (this.frontmatterList) {
      this.frontmatterList.dataset.editable = String(editable);
    }
    for (const input of this.allInputs) {
      input.disabled = !editable;
    }
    this.view.dispatch({
      effects: [
        this.readOnlyCompartment.reconfigure(
          EditorState.readOnly.of(!editable),
        ),
        this.editableCompartment.reconfigure(EditorView.editable.of(editable)),
      ],
    });
  }

  private scheduleSave() {
    if (!this.editable || this.conflict) return;
    if (this.autoSaveTimer !== null) {
      window.clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.getSource() === this.savedSource) {
      this.setStatus("idle");
      return;
    }
    this.setStatus("saving");
    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = null;
      void this.flushSave(false);
    }, AUTO_SAVE_DELAY_MS);
  }

  private async flushSave(checkpoint: boolean) {
    if (this.autoSaveTimer !== null) {
      window.clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.conflict) return;
    const source = this.getSource();
    if (source === this.savedSource) {
      this.setStatus("idle");
      return;
    }
    const guestName = this.guestName.trim();
    if (this.init.guestNameRequired && !guestName) {
      this.message.textContent = "Enter your name before editing.";
      this.setStatus("error");
      return;
    }
    if (guestName) window.localStorage.setItem("vpg_guest_name", guestName);

    this.setStatus("saving");
    this.message.textContent = "";
    try {
      const response = await fetch(
        withPageQuery(`/api/pages/${this.init.pageId}/source`),
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            source,
            base_version_id: this.baseVersionId,
            checkpoint,
            checkpoint_label: checkpoint ? "Manual save" : null,
            guest_name: guestName || null,
          }),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        if (payload?.error?.code === "CONFLICT") {
          this.conflict = true;
          this.message.textContent =
            "This page changed elsewhere. Reload before saving again.";
        } else {
          this.message.textContent = payload?.error?.message ?? "Save failed.";
        }
        this.setStatus("error");
        return;
      }
      const payload = (await response.json()) as {
        checkpoint_created?: boolean;
        updated_at?: string;
        version_id?: string;
      };
      if (payload.version_id) this.baseVersionId = payload.version_id;
      this.savedSource = source;
      if (payload.updated_at) {
        window.dispatchEvent(
          new CustomEvent("vpg:page-updated", {
            detail: {
              checkpointCreated: Boolean(payload.checkpoint_created),
              updatedAt: payload.updated_at,
              versionId: payload.version_id,
            },
          }),
        );
      }
      this.setStatus("saved");
      this.message.textContent = checkpoint ? "Checkpoint saved." : "";
    } catch {
      this.setStatus("error");
      this.message.textContent = "Save failed.";
    }
  }

  private setStatus(status: SaveStatus) {
    window.dispatchEvent(
      new CustomEvent("vpg:save-status", { detail: { status } }),
    );
  }
}

function row(label: string, input: HTMLInputElement) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const desc = document.createElement("dd");
  desc.append(input);
  wrapper.append(term, desc);
  return wrapper;
}

function wrapSelection(
  view: EditorView,
  before: string,
  after: string,
  placeholder: string,
): boolean {
  if (view.state.readOnly) return false;
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      const text = selected || placeholder;
      const insert = `${before}${text}${after}`;
      const start = range.from + before.length;
      const end = start + text.length;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(start, end),
      };
    }),
  );
  view.focus();
  return true;
}

function prefixLines(view: EditorView, prefix: string): boolean {
  if (view.state.readOnly) return false;
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    for (let n = startLine.number; n <= endLine.number; n += 1) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      if (line.text.startsWith(prefix)) {
        changes.push({
          from: line.from,
          to: line.from + prefix.length,
          insert: "",
        });
      } else {
        changes.push({ from: line.from, insert: prefix });
      }
    }
  }
  if (changes.length > 0) view.dispatch({ changes });
  view.focus();
  return true;
}

function setHeading(view: EditorView, level: number): boolean {
  if (view.state.readOnly) return false;
  const target = `${"#".repeat(level)} `;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from);
    const endLine = view.state.doc.lineAt(range.to);
    for (let n = startLine.number; n <= endLine.number; n += 1) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = view.state.doc.line(n);
      const match = /^(#{1,6}\s)/.exec(line.text);
      if (!match) {
        changes.push({ from: line.from, insert: target });
      } else if (match[0] === target) {
        changes.push({
          from: line.from,
          to: line.from + match[0].length,
          insert: "",
        });
      } else {
        changes.push({
          from: line.from,
          to: line.from + match[0].length,
          insert: target,
        });
      }
    }
  }
  if (changes.length > 0) view.dispatch({ changes });
  view.focus();
  return true;
}

function insertLink(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const selected = state.sliceDoc(range.from, range.to);
      const text = selected || "text";
      const insert = `[${text}](url)`;
      const urlStart = range.from + 1 + text.length + 2;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(urlStart, urlStart + 3),
      };
    }),
  );
  view.focus();
  return true;
}

export function splitEditableSource(
  source: string,
  title: string,
  sourceType: "markdown" | "mdx" | "html",
): EditableSource {
  if (sourceType === "html") {
    return { body: source, frontmatterRaw: "", hiddenLeadingHeading: "" };
  }
  const parsed = parseSourceFrontmatter(source);
  const stripped = stripLeadingTitleHeading(parsed.body, title);
  return {
    body: stripped.body,
    frontmatterRaw: parsed.frontmatterRaw,
    hiddenLeadingHeading: stripped.hidden,
  };
}

export function buildSource(frontmatterRaw: string, body: string) {
  if (!frontmatterRaw.trim()) return body;
  return `${frontmatterRaw.trimEnd()}\n\n${body}`;
}

function parseSourceFrontmatter(source: string) {
  if (!source.startsWith("---\n")) {
    return { frontmatterRaw: "", body: source };
  }
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/.exec(source);
  if (!match) return { frontmatterRaw: "", body: source };
  const frontmatterRaw = match[0].trimEnd();
  const body = source.slice(match[0].length).replace(/^\r?\n/, "");
  return { frontmatterRaw, body };
}

function stripLeadingTitleHeading(body: string, title: string) {
  const match = /^(#[ \t]+([^\r\n]+?)[ \t#]*)(\r?\n(?:\r?\n)?|$)/.exec(body);
  if (!match) return { body, hidden: "" };
  if (normalizeHeading(match[2]) !== normalizeHeading(title)) {
    return { body, hidden: "" };
  }
  return { body: body.slice(match[0].length), hidden: match[0] };
}

function normalizeHeading(value: string) {
  return value
    .trim()
    .replace(/\s+#*$/, "")
    .trim()
    .toLowerCase();
}

function parseFrontmatterMap(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const body = raw.replace(/^---\r?\n/, "").replace(/\r?\n---$/, "");
  for (const line of body.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    result[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return result;
}

function replaceFrontmatterField(raw: string, key: string, value: string) {
  const line = `${key}: ${value}`;
  if (!raw.trim()) return `---\n${line}\n---`;
  const lines = raw.split(/\r?\n/);
  const index = lines.findIndex((entry) =>
    new RegExp(`^${escapeRegExp(key)}\\s*:`).test(entry),
  );
  if (index >= 0) {
    lines[index] = line;
  } else {
    lines.splice(Math.max(1, lines.length - 1), 0, line);
  }
  return lines.join("\n");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withPageQuery(path: string) {
  const url = new URL(path, window.location.origin);
  const current = new URLSearchParams(window.location.search);
  const workspaceId =
    current.get("workspace_id") ??
    document.querySelector<HTMLElement>("[data-vpg-page-editor]")?.dataset
      .workspaceId ??
    document.querySelector<HTMLElement>("[data-vpg-workspace-id]")?.dataset
      .vpgWorkspaceId;
  if (workspaceId) url.searchParams.set("workspace_id", workspaceId);
  return `${url.pathname}${url.search}`;
}

const QUOTE_LINE = Decoration.line({ attributes: { class: "cm-md-quote" } });
const BULLET_LINE = Decoration.line({
  attributes: { class: "cm-md-bullet-list" },
});
const ORDERED_LINE = Decoration.line({
  attributes: { class: "cm-md-ordered-list" },
});
const HR_LINE = Decoration.line({ attributes: { class: "cm-md-hr" } });
const CODE_BLOCK_LINE = Decoration.line({
  attributes: { class: "cm-md-code-block" },
});
const HIDE_MARK = Decoration.replace({});
const LINK_TEXT_MARK = Decoration.mark({ class: "cm-md-link-text" });
const ORDERED_MARK = Decoration.mark({ class: "cm-md-ordered-mark" });
const ATX_HEADING = /^ATXHeading([1-6])$/;
const SETEXT_HEADING = /^SetextHeading([12])$/;

class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }

  eq(other: TaskCheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-task";
    wrap.dataset.pos = String(this.pos);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-md-task-checkbox";
    input.setAttribute("aria-label", this.checked ? "Done" : "Todo");
    wrap.append(input);
    return wrap;
  }

  ignoreEvent(event: Event) {
    return event.type !== "click" && event.type !== "mousedown";
  }
}

function markdownLivePreview() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(readonly view: EditorView) {
        this.decorations = buildDecorations(view);
      }

      update(update: ViewUpdate) {
        const editableChanged =
          update.startState.facet(EditorView.editable) !==
          update.state.facet(EditorView.editable);
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          editableChanged
        ) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.decorations ?? Decoration.none,
        ),
      eventHandlers: {
        click(event) {
          const target = event.target;
          if (!(target instanceof HTMLInputElement)) return;
          if (!target.classList.contains("cm-md-task-checkbox")) return;
          const wrap = target.closest<HTMLElement>("[data-pos]");
          const pos = Number.parseInt(wrap?.dataset.pos ?? "-1", 10);
          if (pos < 0 || this.view.state.readOnly) {
            event.preventDefault();
            return;
          }
          const current = this.view.state.sliceDoc(pos, pos + 3);
          this.view.dispatch({
            changes: {
              from: pos,
              to: pos + 3,
              insert: /\[[xX]\]/.test(current) ? "[ ]" : "[x]",
            },
          });
          event.preventDefault();
        },
      },
    },
  );
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);
  const doc = view.state.doc;
  const isEditable = view.state.facet(EditorView.editable);
  const slugFor = makeSlugger();
  const cursorTouchesRange = (from: number, to: number) =>
    isEditable &&
    view.state.selection.ranges.some((range) =>
      range.empty
        ? range.from >= from && range.from <= to
        : range.from < to && range.to > from,
    );
  const cursorTouchesLine = (lineNumber: number) => {
    const line = doc.line(lineNumber);
    return cursorTouchesRange(line.from, line.to);
  };
  const hideRange = (from: number, to: number) => {
    if (to > from) ranges.push(HIDE_MARK.range(from, to));
  };

  for (const { from: visFrom, to: visTo } of view.visibleRanges) {
    tree.iterate({
      from: visFrom,
      to: visTo,
      enter(node) {
        const name = node.type.name;
        const headingMatch = ATX_HEADING.exec(name);
        if (headingMatch) {
          const level = Number.parseInt(headingMatch[1], 10);
          const line = doc.lineAt(node.from);
          const id = `${HEADING_ID_PREFIX}${slugFor(headingText(doc, node.node))}`;
          ranges.push(
            Decoration.line({
              attributes: { class: `cm-md-h${level}`, id },
            }).range(line.from),
          );
          if (!cursorTouchesLine(line.number)) {
            const mark = findChild(node.node, "HeaderMark");
            if (mark)
              hideRange(line.from, clamp(mark.to + 1, line.from, line.to));
          }
          return;
        }

        const setextMatch = SETEXT_HEADING.exec(name);
        if (setextMatch) {
          const level = Number.parseInt(setextMatch[1], 10);
          const headingLine = doc.lineAt(node.from);
          const id = `${HEADING_ID_PREFIX}${slugFor(
            doc.sliceString(headingLine.from, headingLine.to).trim(),
          )}`;
          ranges.push(
            Decoration.line({
              attributes: { class: `cm-md-h${level}`, id },
            }).range(headingLine.from),
          );
          const underline = findChild(node.node, "HeaderMark");
          if (underline) {
            const underlineLine = doc.lineAt(underline.from);
            if (!cursorTouchesLine(underlineLine.number)) {
              hideRange(underlineLine.from, underlineLine.to);
            }
          }
          return;
        }

        if (name === "Blockquote") {
          forEachLine(doc, node.from, node.to, (line) => {
            ranges.push(QUOTE_LINE.range(line.from));
          });
          return;
        }

        if (name === "QuoteMark") {
          const line = doc.lineAt(node.from);
          if (!cursorTouchesLine(line.number)) {
            const after = doc.sliceString(node.to, node.to + 1);
            hideRange(
              node.from,
              clamp(node.to + (after === " " ? 1 : 0), line.from, line.to),
            );
          }
          return;
        }

        if (name === "ListItem") {
          const parent = node.node.parent;
          const isOrdered = parent?.type.name === "OrderedList";
          const line = doc.lineAt(node.from);
          ranges.push(
            (isOrdered ? ORDERED_LINE : BULLET_LINE).range(line.from),
          );
          return;
        }

        if (name === "ListMark") {
          const list = node.node.parent?.parent;
          const line = doc.lineAt(node.from);
          if (list?.type.name === "BulletList") {
            if (!cursorTouchesRange(node.from, node.to)) {
              const after = doc.sliceString(node.to, node.to + 1);
              hideRange(
                node.from,
                clamp(node.to + (after === " " ? 1 : 0), line.from, line.to),
              );
            }
          } else if (list?.type.name === "OrderedList") {
            ranges.push(ORDERED_MARK.range(node.from, node.to));
          }
          return;
        }

        if (name === "TaskMarker") {
          const line = doc.lineAt(node.from);
          if (!cursorTouchesLine(line.number)) {
            const text = doc.sliceString(node.from, node.to);
            ranges.push(
              Decoration.replace({
                widget: new TaskCheckboxWidget(
                  /\[[xX]\]/.test(text),
                  node.from,
                ),
              }).range(node.from, node.to),
            );
          }
          return;
        }

        if (name === "FencedCode") {
          forEachLine(doc, node.from, node.to, (line) => {
            ranges.push(CODE_BLOCK_LINE.range(line.from));
          });
          return false;
        }

        if (name === "HorizontalRule") {
          const line = doc.lineAt(node.from);
          ranges.push(HR_LINE.range(line.from));
          if (!cursorTouchesLine(line.number)) hideRange(line.from, line.to);
          return;
        }

        if (
          name === "StrongEmphasis" ||
          name === "Emphasis" ||
          name === "Strikethrough"
        ) {
          if (cursorTouchesRange(node.from, node.to)) return;
          const markLength = name === "Emphasis" ? 1 : 2;
          hideRange(node.from, node.from + markLength);
          hideRange(node.to - markLength, node.to);
          return;
        }

        if (name === "InlineCode") {
          if (cursorTouchesRange(node.from, node.to)) return;
          hideRange(node.from, node.from + 1);
          hideRange(node.to - 1, node.to);
          return;
        }

        if (name === "Link" || name === "Image") {
          if (cursorTouchesRange(node.from, node.to)) return;
          const marks: SyntaxNode[] = [];
          for (
            let child = node.node.firstChild;
            child;
            child = child.nextSibling
          ) {
            if (child.type.name === "LinkMark") marks.push(child);
          }
          if (marks.length < 2) return;
          hideRange(node.from, marks[0].to);
          hideRange(marks[1].from, node.to);
          if (name === "Link" && marks[1].from > marks[0].to) {
            ranges.push(LINK_TEXT_MARK.range(marks[0].to, marks[1].from));
          }
        }
      },
    });
  }

  return Decoration.set(ranges, true);
}

function makeSlugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base =
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

function headingText(doc: Text, node: SyntaxNode) {
  return doc
    .sliceString(node.from, node.to)
    .replace(/^#+\s*/, "")
    .replace(/\s+#*\s*$/, "")
    .trim();
}

function findChild(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.type.name === name) return child;
  }
  return null;
}

function forEachLine(
  doc: Text,
  from: number,
  to: number,
  callback: (line: ReturnType<Text["lineAt"]>) => void,
) {
  let cursor = from;
  while (cursor <= to) {
    const line = doc.lineAt(cursor);
    callback(line);
    if (line.to >= to) break;
    cursor = line.to + 1;
  }
}

function clamp(pos: number, from: number, to: number) {
  if (pos < from) return from;
  if (pos > to) return to;
  return pos;
}

declare global {
  interface Window {
    __vpgCurrentSource?: string;
  }
}
