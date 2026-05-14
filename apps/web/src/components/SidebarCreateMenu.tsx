import { FilePlus2, FilePlus, FolderPlus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TemplateProperty } from "@vegastack/pages-core";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";

type CreateKind = "page" | "folder" | "subfolder" | "template";
type SourceType = "markdown" | "mdx" | "html";

type TemplateSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  properties: TemplateProperty[];
};

type SidebarCreateMenuProps = {
  workspaceId: string;
  currentFolderId?: string | null;
  currentFolderPath?: string;
  triggerClassName?: string;
  triggerLabel?: string;
};

export function SidebarCreateMenu({
  workspaceId,
  currentFolderId,
  currentFolderPath = "",
  triggerClassName,
  triggerLabel,
}: SidebarCreateMenuProps) {
  const [open, setOpen] = useState(false);
  const [dialogKind, setDialogKind] = useState<CreateKind | null>(null);
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<SourceType>("markdown");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [propertyValues, setPropertyValues] = useState<Record<string, unknown>>(
    {},
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!dialogKind) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [dialogKind]);

  function openDialog(kind: CreateKind) {
    setDialogKind(kind);
    setName("");
    setSourceType("markdown");
    setError("");
    setOpen(false);
    setSelectedTemplateId(null);
    setPropertyValues({});
    if (kind === "template" && !templatesLoaded) {
      void loadTemplates();
    }
  }

  async function loadTemplates() {
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/templates`);
      const payload = (await response.json()) as {
        templates?: TemplateSummary[];
      };
      if (response.ok && Array.isArray(payload.templates)) {
        setTemplates(payload.templates);
        setTemplatesLoaded(true);
      } else {
        setTemplatesLoaded(true);
      }
    } catch {
      setTemplatesLoaded(true);
    }
  }

  function closeDialog() {
    if (submitting) return;
    setDialogKind(null);
    setName("");
    setError("");
  }

  async function submitCreate() {
    const trimmedName = name.trim();
    if (!dialogKind || !trimmedName) {
      setError(
        dialogKind === "page" || dialogKind === "template"
          ? "Page title is required."
          : "Folder name is required.",
      );
      return;
    }
    if (dialogKind === "template" && !selectedTemplateId) {
      setError("Pick a template.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      if (dialogKind === "page") {
        await createPage(trimmedName);
      } else if (dialogKind === "template") {
        await createFromTemplate(trimmedName);
      } else {
        await createFolder(
          trimmedName,
          dialogKind === "subfolder" ? currentFolderId : null,
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function createFromTemplate(title: string) {
    if (!selectedTemplateId) return;
    const response = await fetch(
      `/api/templates/${selectedTemplateId}/pages?workspace_id=${encodeURIComponent(workspaceId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          folder_path: currentFolderPath,
          properties: propertyValues,
        }),
      },
    );
    const payload = (await response.json()) as {
      url?: string;
      error?: { message?: string };
    };
    if (!response.ok || !payload.url) {
      setError(payload.error?.message ?? "Page creation from template failed.");
      return;
    }
    window.location.href = payload.url;
  }

  async function createPage(title: string) {
    const response = await fetch(`/api/workspaces/${workspaceId}/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        folder_path: currentFolderPath,
        source_type: sourceType,
        source: initialSource(title, sourceType),
      }),
    });
    const payload = (await response.json()) as {
      url?: string;
      error?: { message?: string };
    };
    if (!response.ok || !payload.url) {
      setError(payload.error?.message ?? "Page creation failed.");
      return;
    }
    window.location.href = payload.url;
  }

  async function createFolder(
    folderName: string,
    parentFolderId?: string | null,
  ) {
    const response = await fetch(`/api/workspaces/${workspaceId}/folders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: folderName,
        parent_folder_id: parentFolderId ?? null,
      }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(payload?.error?.message ?? "Folder creation failed.");
      return;
    }
    window.location.reload();
  }

  const dialogTitle =
    dialogKind === "page"
      ? "New page"
      : dialogKind === "template"
        ? "New page from template"
        : dialogKind === "subfolder"
          ? "New subfolder"
          : "New folder";
  const submitLabel = submitting
    ? "Creating..."
    : dialogKind === "page" || dialogKind === "template"
      ? "Create page"
      : "Create folder";

  const selectedTemplate = templates.find(
    (template) => template.id === selectedTemplateId,
  );
  const templatesByCategory = templates.reduce<
    Record<string, TemplateSummary[]>
  >((acc, template) => {
    const key = template.category || "general";
    (acc[key] = acc[key] ?? []).push(template);
    return acc;
  }, {});

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label={
              triggerLabel
                ? currentFolderPath
                  ? `Create in ${currentFolderPath}`
                  : "Create at workspace root"
                : "Create page or folder"
            }
            className={triggerClassName}
            size={triggerLabel ? "sm" : "icon"}
            type="button"
            variant="ghost"
          >
            <Plus size={15} aria-hidden="true" />
            {triggerLabel ? <span>{triggerLabel}</span> : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={() => openDialog("page")}>
            <FilePlus2 size={14} aria-hidden="true" />
            <span>New page</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog("template")}>
            <FilePlus size={14} aria-hidden="true" />
            <span>New from template…</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openDialog("folder")}>
            <FolderPlus size={14} aria-hidden="true" />
            <span>New folder</span>
          </DropdownMenuItem>
          {currentFolderId ? (
            <DropdownMenuItem onSelect={() => openDialog("subfolder")}>
              <FolderPlus size={14} aria-hidden="true" />
              <span>New subfolder</span>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={Boolean(dialogKind)}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
      >
        <DialogContent className="create-dialog">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>
              {dialogKind === "page"
                ? currentFolderPath
                  ? `Create in ${currentFolderPath}`
                  : "Create at workspace root"
                : dialogKind === "template"
                  ? currentFolderPath
                    ? `Create in ${currentFolderPath} from a template`
                    : "Pick a template; the page is created at workspace root"
                  : dialogKind === "subfolder"
                    ? "Create under the current folder"
                    : "Create a top-level folder"}
            </DialogDescription>
          </DialogHeader>
          {dialogKind ? (
            <form
              className="create-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submitCreate();
              }}
            >
              {dialogKind === "template" ? (
                <label className="vpg-field">
                  <span>Template</span>
                  {!templatesLoaded ? (
                    <p className="create-dialog-hint">Loading templates…</p>
                  ) : templates.length === 0 ? (
                    <p className="create-dialog-hint">
                      No templates in this workspace yet. Create one in Settings
                      → Templates.
                    </p>
                  ) : (
                    <Select
                      value={selectedTemplateId ?? ""}
                      onValueChange={(value) => {
                        setSelectedTemplateId(value);
                        setPropertyValues({});
                      }}
                    >
                      <SelectTrigger aria-label="Template">
                        <SelectValue placeholder="Choose a template" />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(templatesByCategory)
                          .sort(([a], [b]) => a.localeCompare(b))
                          .flatMap(([category, items]) => [
                            <SelectItem
                              key={`${category}-header`}
                              value={`__header_${category}`}
                              disabled
                            >
                              {category.replace(/\b\w/g, (c) =>
                                c.toUpperCase(),
                              )}
                            </SelectItem>,
                            ...items.map((template) => (
                              <SelectItem key={template.id} value={template.id}>
                                {template.name}
                              </SelectItem>
                            )),
                          ])}
                      </SelectContent>
                    </Select>
                  )}
                </label>
              ) : null}

              <label className="vpg-field">
                <span>
                  {dialogKind === "page" || dialogKind === "template"
                    ? "Title"
                    : "Name"}
                </span>
                <Input
                  ref={inputRef}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={
                    dialogKind === "page" || dialogKind === "template"
                      ? "API Review"
                      : "Product"
                  }
                />
              </label>

              {dialogKind === "page" ? (
                <label className="vpg-field">
                  <span>Type</span>
                  <Select
                    value={sourceType}
                    onValueChange={(value) =>
                      setSourceType(value as SourceType)
                    }
                  >
                    <SelectTrigger aria-label="Source type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="markdown">Markdown</SelectItem>
                      <SelectItem value="mdx">MDX</SelectItem>
                      <SelectItem value="html">HTML</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
              ) : null}

              {dialogKind === "template" && selectedTemplate ? (
                <div className="create-dialog-template-props">
                  {selectedTemplate.description ? (
                    <p className="create-dialog-template-desc">
                      {selectedTemplate.description}
                    </p>
                  ) : null}
                  {selectedTemplate.properties.length === 0 ? null : (
                    <fieldset className="create-dialog-fieldset">
                      <legend>Properties</legend>
                      {selectedTemplate.properties.map((property) => (
                        <PropertyField
                          key={property.key}
                          property={property}
                          value={propertyValues[property.key]}
                          onChange={(value) =>
                            setPropertyValues((prev) => ({
                              ...prev,
                              [property.key]: value,
                            }))
                          }
                        />
                      ))}
                    </fieldset>
                  )}
                </div>
              ) : null}

              {error ? <p className="create-dialog-error">{error}</p> : null}

              <DialogFooter>
                <Button
                  disabled={submitting}
                  type="button"
                  variant="ghost"
                  onClick={closeDialog}
                >
                  Cancel
                </Button>
                <Button disabled={submitting} type="submit" variant="primary">
                  {submitLabel}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function PropertyField({
  property,
  value,
  onChange,
}: {
  property: TemplateProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = property.label || property.key;
  const requiredMark = property.required ? " *" : "";
  switch (property.type) {
    case "longtext":
      return (
        <label className="vpg-field">
          <span>
            {label}
            {requiredMark}
          </span>
          <Textarea
            rows={3}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
          />
          {property.help ? (
            <small className="create-dialog-help">{property.help}</small>
          ) : null}
        </label>
      );
    case "number":
      return (
        <label className="vpg-field">
          <span>
            {label}
            {requiredMark}
          </span>
          <Input
            type="number"
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(event) =>
              onChange(
                event.target.value === ""
                  ? undefined
                  : Number(event.target.value),
              )
            }
          />
          {property.help ? (
            <small className="create-dialog-help">{property.help}</small>
          ) : null}
        </label>
      );
    case "boolean":
      return (
        <label className="vpg-field create-dialog-checkbox">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>
            {label}
            {requiredMark}
          </span>
          {property.help ? (
            <small className="create-dialog-help">{property.help}</small>
          ) : null}
        </label>
      );
    case "date":
      return (
        <label className="vpg-field">
          <span>
            {label}
            {requiredMark}
          </span>
          <Input
            type="date"
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
          />
          {property.help ? (
            <small className="create-dialog-help">{property.help}</small>
          ) : null}
        </label>
      );
    case "datetime":
      return (
        <label className="vpg-field">
          <span>
            {label}
            {requiredMark}
          </span>
          <Input
            type="datetime-local"
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
          />
          {property.help ? (
            <small className="create-dialog-help">{property.help}</small>
          ) : null}
        </label>
      );
    case "select":
      return (
        <label className="vpg-field">
          <span>
            {label}
            {requiredMark}
          </span>
          <Select
            value={typeof value === "string" ? value : ""}
            onValueChange={(next) => onChange(next)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Choose…" />
            </SelectTrigger>
            <SelectContent>
              {(property.options ?? []).map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {property.help ? (
            <small className="create-dialog-help">{property.help}</small>
          ) : null}
        </label>
      );
    case "tags":
      return (
        <label className="vpg-field">
          <span>
            {label}
            {requiredMark}
          </span>
          <Input
            value={Array.isArray(value) ? (value as string[]).join(", ") : ""}
            onChange={(event) =>
              onChange(
                event.target.value
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean),
              )
            }
            placeholder="comma, separated, tags"
          />
          {property.help ? (
            <small className="create-dialog-help">{property.help}</small>
          ) : null}
        </label>
      );
    default:
      return (
        <label className="vpg-field">
          <span>
            {label}
            {requiredMark}
          </span>
          <Input
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
          />
          {property.help ? (
            <small className="create-dialog-help">{property.help}</small>
          ) : null}
        </label>
      );
  }
}

function initialSource(title: string, sourceType: SourceType) {
  const safeTitle = title.trim();
  if (sourceType === "html") {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(safeTitle)}</title>
  </head>
  <body>
    <h1>${escapeHtml(safeTitle)}</h1>
  </body>
</html>
`;
  }
  return `---
title: ${safeTitle}
type: note
updated: ${new Date().toISOString().slice(0, 10)}
---

# ${safeTitle}
`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}
