import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { TemplateProperty } from "@vegastack/pages-core";
import { Button } from "../ui/button";

export type TemplateSummary = {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  source_type: "markdown" | "mdx";
  version_id: string;
  properties: TemplateProperty[];
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
};

type Props = {
  workspaceId: string;
  initialTemplates: TemplateSummary[];
};

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function WorkspaceTemplatesManager({
  workspaceId,
  initialTemplates,
}: Props) {
  const [templates, setTemplates] =
    useState<TemplateSummary[]>(initialTemplates);
  const [busyDeleteId, setBusyDeleteId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const buckets = new Map<string, TemplateSummary[]>();
    for (const template of templates) {
      const key = template.category || "general";
      const existing = buckets.get(key) ?? [];
      existing.push(template);
      buckets.set(key, existing);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, items]) => ({
        category,
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
      }));
  }, [templates]);

  async function deleteTemplate(template: TemplateSummary) {
    const confirmed =
      (await window.settingsHelpers?.confirmAction?.({
        title: "Delete template",
        description:
          "New pages created from this template before now are unaffected. The template itself cannot be recovered.",
        confirmLabel: "Delete template",
        tone: "danger",
      })) ??
      window.confirm(
        `Delete the template "${template.name}"? This cannot be undone.`,
      );
    if (!confirmed) return;

    setBusyDeleteId(template.id);
    try {
      const response = await fetch(
        `/api/templates/${template.id}?workspace_id=${encodeURIComponent(workspaceId)}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message ?? "Delete failed.");
      }
      setTemplates((prev) => prev.filter((item) => item.id !== template.id));
      toast.success("Template deleted.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not delete template.",
      );
    } finally {
      setBusyDeleteId(null);
    }
  }

  return (
    <section className="settings-templates" aria-label="Templates">
      {templates.length === 0 ? (
        <div className="settings-empty">
          <p>
            <strong>No templates yet</strong>
            Create a template to add a reusable page scaffold.
          </p>
        </div>
      ) : (
        grouped.map((group) => (
          <div key={group.category} className="settings-template-group">
            <h3 className="settings-template-group-heading">
              {titleCase(group.category)}
            </h3>
            <ul className="settings-template-list">
              {group.items.map((template) => (
                <li key={template.id} className="settings-template-row">
                  <a
                    className="settings-template-card"
                    href={`/app/settings/templates/${template.id}`}
                  >
                    <div className="settings-template-card-head">
                      <strong>{template.name}</strong>
                      {template.is_builtin ? (
                        <span className="settings-template-tag">Builtin</span>
                      ) : null}
                    </div>
                    <p className="settings-template-card-desc">
                      {template.description || <em>No description.</em>}
                    </p>
                    <div className="settings-template-card-meta">
                      <code>{template.slug}</code>
                      <span>
                        {template.properties.length}{" "}
                        {template.properties.length === 1 ? "field" : "fields"}
                      </span>
                    </div>
                  </a>
                  <div className="settings-template-row-actions">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteTemplate(template)}
                      disabled={busyDeleteId === template.id}
                      aria-label={`Delete ${template.name}`}
                      title="Delete template"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
