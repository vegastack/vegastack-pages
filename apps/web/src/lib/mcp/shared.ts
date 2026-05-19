import {
  AppError,
  type TemplateBuilderDocument,
  type TemplateBuilderHeadingLevel,
  type TemplateProperty,
  type TemplateRecord,
} from "@vegastack/pages-core";
import {
  comments,
  pages,
  reviewEvents,
  search,
  templates,
} from "@vegastack/pages-services";
import { absoluteUrl, asString, optionalString } from "./util";
import { getExistingPage } from "./permissions";
import type { McpActor, McpToolContext } from "./types";

export async function updatePageSource(
  context: McpToolContext,
  input: {
    pageId: string;
    source: string;
    baseVersionId: string;
    checkpoint: boolean;
    checkpointLabel: string | null;
  },
) {
  const ctx = context.ctx;
  const updated = await pages.updateSource(ctx, {
    pageId: input.pageId,
    source: input.source,
    baseVersionId: input.baseVersionId,
    checkpoint: input.checkpoint,
    checkpointLabel: input.checkpointLabel,
  });
  ctx.waitUntil(search.scheduleIndexPage(ctx, updated.data.page.id));
  await reviewEvents.emit(ctx, {
    workspaceId: updated.data.page.workspaceId,
    pageId: updated.data.page.id,
    type: updated.data.checkpointCreated
      ? "page.version_created"
      : "page.updated",
    actorUserId: null,
    payload: {
      version_id: updated.data.page.versionId,
      content_hash: updated.data.page.contentHash,
      checkpoint_created: updated.data.checkpointCreated,
      changed: updated.data.changed,
      source: "mcp",
    },
  });
  return {
    page_id: updated.data.page.id,
    slug_id: updated.data.page.slugId,
    url: absoluteUrl(context, `/p/${updated.data.page.slugId}`),
    version_id: updated.data.page.versionId,
    content_hash: updated.data.page.contentHash,
    checkpoint_created: updated.data.checkpointCreated,
    changed: updated.data.changed,
  };
}

export function patchSource(source: string, args: Record<string, unknown>) {
  const find = asString(args.find);
  if (!find) throw new AppError("VALIDATION_ERROR", "find is required.", 400);

  const replace = asString(args.replace, "");
  const replaceAll = Boolean(args.replace_all);
  const parts = source.split(find);
  const replacementCount = parts.length - 1;
  if (replacementCount === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Text to replace was not found in the live page source.",
      400,
    );
  }

  const expected =
    args.expected_replacements === undefined
      ? replaceAll
        ? replacementCount
        : 1
      : Number(args.expected_replacements);
  if (!Number.isFinite(expected) || expected < 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "expected_replacements must be a positive number.",
      400,
    );
  }
  if (replacementCount !== expected) {
    throw new AppError(
      "CONFLICT",
      "Replacement count did not match expected_replacements.",
      409,
      {
        replacement_count: replacementCount,
        expected_replacements: expected,
      },
    );
  }

  return {
    replacementCount,
    source: replaceAll ? parts.join(replace) : source.replace(find, replace),
  };
}

export function assertEditBase(
  page: { versionId: string; contentHash: string; updatedAt: string },
  args: Record<string, unknown>,
) {
  const baseVersionId = asString(args.base_version_id);
  if (page.versionId !== baseVersionId) {
    throw new AppError(
      "CONFLICT",
      "Page source has changed since it was loaded.",
      409,
      {
        current_version_id: page.versionId,
        current_content_hash: page.contentHash,
        updated_at: page.updatedAt,
      },
    );
  }
  if (
    args.base_content_hash &&
    page.contentHash !== String(args.base_content_hash)
  ) {
    throw new AppError(
      "CONFLICT",
      "Page content hash has changed since it was loaded.",
      409,
      {
        current_version_id: page.versionId,
        current_content_hash: page.contentHash,
        updated_at: page.updatedAt,
      },
    );
  }
}

export function agentReplyInput(
  args: Record<string, unknown>,
  actor: McpActor,
): Parameters<typeof comments.reply>[1] {
  const isAgent = Boolean(args.agent_name);
  return {
    threadId: asString(args.thread_id),
    pageId: "",
    workspaceId: "",
    body: asString(args.body),
    authorType: isAgent ? ("agent" as const) : ("user" as const),
    authorUserId: isAgent ? null : (actor.user?.id ?? null),
    guestName: null,
    guestSessionId: null,
    publicationId: null,
    agent: isAgent
      ? {
          name: String(args.agent_name),
          model: asString(args.agent_model, "unknown"),
          sessionId: asString(args.agent_session_id, "agt_mcp"),
        }
      : null,
  };
}

export async function listPageComments(
  context: McpToolContext,
  pageId: string,
  status: "open" | "resolved" | "all",
  workspaceValue: unknown,
) {
  const ctx = context.ctx;
  const page = await getExistingPage(context, pageId, "read", workspaceValue);
  const threads = await comments.listForPage(ctx, {
    pageId,
    status,
  });
  return threads.map((entry) => ({
    ...entry,
    page: {
      id: page.page.id,
      title: page.page.title,
      slugId: page.page.slugId,
      sourceType: page.page.sourceType,
      contentHash: page.page.contentHash,
      url: absoluteUrl(context, `/p/${page.page.slugId}`),
    },
    anchor_context: {
      kind: entry.anchor.kind,
      surface: entry.anchor.surface,
      confidence: entry.anchor.confidence,
      selectedText: entry.anchor.selectedText,
      prefixText: entry.anchor.prefixText,
      suffixText: entry.anchor.suffixText,
      sourceStart: entry.anchor.sourceStart,
      sourceEnd: entry.anchor.sourceEnd,
      renderedDomPath: entry.anchor.renderedDomPath ?? null,
      selector: entry.anchor.selector ?? null,
      needsPlacement:
        entry.anchor.confidence === "fuzzy" ||
        entry.anchor.confidence === "stale",
    },
  }));
}

export function findAnchoredIndex(
  text: string,
  selectedText: string,
  prefixText: string,
  suffixText: string,
) {
  if (!text || !selectedText) return -1;
  let bestIndex = text.indexOf(selectedText);
  let bestScore = bestIndex >= 0 ? 0 : -1;
  let index = bestIndex;
  while (index >= 0) {
    const prefix = text.slice(Math.max(0, index - prefixText.length), index);
    const suffix = text.slice(
      index + selectedText.length,
      index + selectedText.length + suffixText.length,
    );
    const score =
      commonSuffixLength(prefix, prefixText) +
      commonPrefixLength(suffix, suffixText);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
    index = text.indexOf(selectedText, index + selectedText.length);
  }
  return bestIndex;
}

function commonPrefixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (count < limit && left[count] === right[count]) count += 1;
  return count;
}

function commonSuffixLength(left: string, right: string) {
  const limit = Math.min(left.length, right.length);
  let count = 0;
  while (
    count < limit &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

export function slugifyName(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "template"
  );
}

export function serializeMcpTemplate(template: TemplateRecord) {
  return {
    id: template.id,
    slug: template.slug,
    name: template.name,
    description: template.description,
    category: template.category,
    source_type: template.sourceType,
    version_id: template.versionId,
    properties: template.properties,
    is_builtin: template.isBuiltin,
    created_at: template.createdAt,
    updated_at: template.updatedAt,
  };
}

export function asTemplateProperties(
  input: unknown,
): TemplateProperty[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Template properties must be an array.",
      400,
    );
  }
  return input as TemplateProperty[];
}

export function asTemplateBuilder(input: unknown): TemplateBuilderDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Template builder must be an object with title, intro, and sections.",
      400,
    );
  }
  const record = input as Record<string, unknown>;
  const sections = Array.isArray(record.sections) ? record.sections : [];
  return {
    title: optionalString(record.title),
    intro: optionalString(record.intro),
    sections: sections.map((entry) => {
      const section =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : {};
      return {
        level:
          section.level === 3 || section.level === 4
            ? (section.level as TemplateBuilderHeadingLevel)
            : 2,
        heading: optionalString(section.heading) ?? "",
        helpText:
          optionalString(section.help_text) ??
          optionalString(section.helpText) ??
          "",
        guidance: optionalString(section.guidance) ?? "",
        body: optionalString(section.body) ?? "",
      };
    }),
  };
}

export async function resolveTemplate(
  context: McpToolContext,
  workspaceId: string,
  identifier: string,
): Promise<TemplateRecord> {
  if (!identifier) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Template identifier is required.",
      400,
    );
  }
  const ctx = context.ctx;
  const direct = identifier.startsWith("tpl_")
    ? await templates.get(ctx, identifier)
    : null;
  const bySlug = direct
    ? null
    : await templates.getBySlug(ctx, { workspaceId, slug: identifier });
  const template = direct ?? bySlug;
  if (!template || template.workspaceId !== workspaceId) {
    throw new AppError("PAGE_NOT_FOUND", "Template was not found.", 404);
  }
  return template;
}
