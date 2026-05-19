import { AppError } from "@vegastack/pages-core";
import type { APIRoute } from "astro";
import { pages as pagesService, reviewEvents } from "@vegastack/pages-services";
import { resolvePageAccess } from "../../../../lib/access";
import {
  assertUtf8ByteLimit,
  numericEnv,
  readJsonBody,
} from "../../../../lib/request-body";
import { scheduleIndexPage } from "../../../../lib/runtime";
import {
  buildServiceContext,
  serviceErrorToResponse,
} from "../../../../lib/service-context";

export const prerender = false;
const defaultMaxPageSourceBytes = 1_048_576;
const jsonOverheadBytes = 64 * 1024;

function maxPageSourceBytes() {
  return numericEnv("VPG_MAX_PAGE_SOURCE_BYTES", defaultMaxPageSourceBytes);
}

function patchSource(source: string, body: Record<string, unknown>) {
  const find = String(body.find ?? "");
  if (!find) throw new AppError("VALIDATION_ERROR", "find is required.", 400);
  const replace = String(body.replace ?? "");
  const replaceAll = Boolean(body.replace_all);
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
    body.expected_replacements === undefined
      ? replaceAll
        ? replacementCount
        : 1
      : Number(body.expected_replacements);
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
      { replacement_count: replacementCount, expected_replacements: expected },
    );
  }
  return {
    replacementCount,
    source: replaceAll ? parts.join(replace) : source.replace(find, replace),
  };
}

export const POST: APIRoute = async ({ cookies, params, request, url }) => {
  try {
    const maxSourceBytes = maxPageSourceBytes();
    const body = await readJsonBody<Record<string, unknown>>(request, {
      maxBytes: maxSourceBytes + jsonOverheadBytes,
      label: "Page source patch",
    });
    const { ctx } = await buildServiceContext({ cookies, request });
    const page = params.pageId
      ? await pagesService.get(ctx, params.pageId)
      : null;
    if (!page) {
      throw new AppError("PAGE_NOT_FOUND", "Page was not found.", 404);
    }
    const access = await resolvePageAccess({
      cookies,
      request,
      url,
      page: page.page,
      required: "write",
    });
    if (page.page.versionId !== String(body.base_version_id ?? "")) {
      throw new AppError(
        "CONFLICT",
        "Page source has changed since it was loaded.",
        409,
        {
          current_version_id: page.page.versionId,
          current_content_hash: page.page.contentHash,
          updated_at: page.page.updatedAt,
        },
      );
    }
    if (
      body.base_content_hash &&
      page.page.contentHash !== String(body.base_content_hash)
    ) {
      throw new AppError(
        "CONFLICT",
        "Page content hash has changed since it was loaded.",
        409,
        {
          current_version_id: page.page.versionId,
          current_content_hash: page.page.contentHash,
          updated_at: page.page.updatedAt,
        },
      );
    }
    const patched = patchSource(page.source, body);
    assertUtf8ByteLimit({
      value: patched.source,
      maxBytes: maxSourceBytes,
      label: "Page source",
      detailKey: "max_page_source_bytes",
    });
    const result = await pagesService.updateSource(ctx, {
      pageId: page.page.id,
      source: patched.source,
      baseVersionId: page.page.versionId,
      checkpoint: Boolean(body.checkpoint),
      checkpointLabel: body.checkpoint_label
        ? String(body.checkpoint_label)
        : null,
    });
    const updated = result.data;
    scheduleIndexPage(updated.page.id);
    await reviewEvents.emit(ctx, {
      workspaceId: updated.page.workspaceId,
      pageId: updated.page.id,
      type: updated.checkpointCreated ? "page.version_created" : "page.updated",
      actorUserId: access.actor.user?.id ?? null,
      payload: {
        version_id: updated.page.versionId,
        content_hash: updated.page.contentHash,
        checkpoint_created: updated.checkpointCreated,
        changed: updated.changed,
      },
    });
    return Response.json({
      page_id: updated.page.id,
      slug_id: updated.page.slugId,
      url: `/p/${updated.page.slugId}`,
      version_id: updated.page.versionId,
      content_hash: updated.page.contentHash,
      checkpoint_created: updated.checkpointCreated,
      changed: updated.changed,
      replacement_count: patched.replacementCount,
      envelope: result.envelope,
    });
  } catch (error) {
    return serviceErrorToResponse(error, "Page patch failed.");
  }
};
