import { AppError } from "@vegastack/pages-core";
import { strToU8, Zip, ZipPassThrough } from "fflate";
import type { APIRoute } from "astro";
import { getApiRequestActor, jsonAppError } from "../../../../lib/access";
import {
  attachmentService,
  auditService,
  checkRateLimit,
  ensureSeedData,
  pageService,
  permissionService,
  workspaceService,
} from "../../../../lib/runtime";

export const prerender = false;

function extension(sourceType: string) {
  return sourceType === "mdx" ? "mdx" : sourceType === "html" ? "html" : "md";
}

function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

const DEFAULT_EXPORT_MAX_BYTES = 50 * 1024 * 1024;

function exportMaxBytes() {
  const configured = Number(process.env.VPG_WORKSPACE_EXPORT_MAX_BYTES ?? "");
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_EXPORT_MAX_BYTES;
}

function assertExportSize(input: { byteSize: number; maxBytes: number }) {
  if (input.byteSize <= input.maxBytes) return;
  throw new AppError(
    "PAYLOAD_TOO_LARGE",
    "Workspace export exceeds the configured size limit.",
    413,
    {
      export_bytes: input.byteSize,
      max_export_bytes: input.maxBytes,
    },
  );
}

async function estimateExportSize(workspaceId: string, manifestBytes: number) {
  let byteSize = manifestBytes;
  let pageCount = 0;
  let attachmentCount = 0;
  const maxBytes = exportMaxBytes();
  assertExportSize({ byteSize, maxBytes });
  for (const page of pageService.listPages(workspaceId)) {
    const withSource = await pageService.getPage(page.id);
    if (!withSource) continue;
    pageCount += 1;
    byteSize += strToU8(withSource.source).byteLength;
    assertExportSize({ byteSize, maxBytes });
    for (const attachment of attachmentService.listForPage(page.id)) {
      attachmentCount += 1;
      byteSize += attachment.byteSize;
      assertExportSize({ byteSize, maxBytes });
    }
  }
  return { byteSize, pageCount, attachmentCount, maxBytes };
}

function workspaceExportStream(input: {
  workspaceId: string;
  workspaceSlug: string;
  manifest: Uint8Array;
}) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const zip = new Zip((error, chunk, final) => {
        if (error) {
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      try {
        for (const page of pageService.listPages(input.workspaceId)) {
          const withSource = await pageService.getPage(page.id);
          if (!withSource) continue;
          const basePath = `workspaces/${input.workspaceSlug}/pages/${page.folderPath ? `${page.folderPath}/` : ""}${page.slugId}`;
          const source = new ZipPassThrough(
            `${basePath}/source/current.${extension(page.sourceType)}`,
          );
          zip.add(source);
          source.push(strToU8(withSource.source), true);

          for (const attachment of attachmentService.listForPage(page.id)) {
            const stored = await attachmentService.get(attachment.id);
            if (!stored) continue;
            const file = new ZipPassThrough(
              `${basePath}/attachments/${attachment.id}/${attachment.filename}`,
            );
            zip.add(file);
            file.push(decodeBase64(stored.base64Body), true);
          }
        }
        const manifest = new ZipPassThrough(
          `workspaces/${input.workspaceSlug}/manifest.json`,
        );
        zip.add(manifest);
        manifest.push(input.manifest, true);
        zip.end();
      } catch (error) {
        zip.terminate();
        controller.error(error);
      }
    },
  });
}

export const GET: APIRoute = async ({ cookies, params, request }) => {
  try {
    await ensureSeedData();
    const workspaceId = params.workspaceId ?? "";
    const workspace = workspaceService.getWorkspace(workspaceId);
    if (!workspace)
      throw new AppError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
        404,
        {
          parameter: "workspaceId",
          location: "path",
        },
      );
    const actor = await getApiRequestActor(cookies, request);
    const member = actor.user
      ? workspaceService.getMember(workspaceId, actor.user.id)
      : null;
    const permission =
      actor.workspaceId && actor.workspaceId !== workspaceId
        ? "none"
        : permissionService.resolve({
            user: actor.user,
            member,
            workspaceId,
          });
    permissionService.assert({ actual: permission, required: "admin" });

    await checkRateLimit({
      key: `workspace-export:${workspaceId}`,
      limit: 3,
      windowMs: 60 * 60_000,
    });

    const pages = pageService.listPages(workspaceId);
    const manifest = strToU8(
      JSON.stringify(
        {
          workspace,
          exported_at: new Date().toISOString(),
          page_count: pages.length,
        },
        null,
        2,
      ),
    );
    const estimated = await estimateExportSize(
      workspaceId,
      manifest.byteLength,
    );
    auditService.record({
      workspaceId,
      actorUserId: actor.user?.id ?? null,
      action: "workspace.exported",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: {
        estimated_bytes: estimated.byteSize,
        max_export_bytes: estimated.maxBytes,
        page_count: estimated.pageCount,
        attachment_count: estimated.attachmentCount,
      },
    });

    return new Response(
      workspaceExportStream({
        workspaceId,
        workspaceSlug: workspace.slug,
        manifest,
      }),
      {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${workspace.slug}-vegastack-pages.zip"`,
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (error) {
    return jsonAppError(error, "Workspace export failed.");
  }
};
