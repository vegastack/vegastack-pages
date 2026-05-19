import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { auth, users, workspaces } from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { POST as createTemplate } from "../[workspaceId]/templates";
import {
  GET as getTemplate,
  PATCH as updateTemplate,
} from "../../templates/[templateId]";

beforeAll(() => {
  process.env.VPG_RUNTIME = "node";
  process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-template-rest-"));
});

function uniqueId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function sessionCookies(sessionId: string) {
  return {
    get(name: string) {
      return name === "vpg_session" ? { value: sessionId } : undefined;
    },
  } as never;
}

function resourceUrl(path: string, workspaceId: string) {
  return `https://pages.example.test${path}?workspace_id=${encodeURIComponent(workspaceId)}`;
}

describe("template REST API", () => {
  it("creates, reads, and updates structured template builders", async () => {
    const { ctx: seedCtx } = await buildServiceContext({
      cookies: { get: () => undefined } as never,
    });
    const admin = await users.upsert(seedCtx, {
      id: uniqueId("usr"),
      email: `template-rest-${crypto.randomUUID()}@example.test`,
      displayName: "Template REST Admin",
      role: "user",
    });
    const workspace = await workspaces.create(seedCtx, {
      id: uniqueId("wks"),
      name: "Template REST",
      slug: uniqueId("slug"),
      firstAdminUserId: admin.id,
    });
    const session = await auth.createSession(seedCtx, { userId: admin.id });
    const cookies = sessionCookies(session.id);

    const createdResponse = await createTemplate({
      cookies,
      params: { workspaceId: workspace.id },
      request: new Request(
        `https://pages.example.test/api/workspaces/${workspace.id}/templates`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Executive Review",
            slug: "executive-review",
            description: "Structured executive template",
            category: "agent",
            builder: {
              title: "{{ title }}",
              intro: "Brief the reader.",
              sections: [
                {
                  level: 2,
                  heading: "Context",
                  help_text: "Why now?",
                  guidance: "Keep this business-readable.",
                },
              ],
            },
            properties: [
              {
                key: "owner",
                label: "Owner",
                type: "text",
                required: true,
              },
            ],
          }),
        },
      ),
    } as never);
    const created = (await createdResponse.json()) as {
      template?: { id: string; slug: string };
      source?: string;
      builder?: { sections?: Array<{ level: number; heading: string }> };
    };

    expect(createdResponse.status).toBe(200);
    expect(created.template?.slug).toBe("executive-review");
    expect(created.source).toContain("## Context");
    expect(created.builder?.sections?.[0]).toMatchObject({
      level: 2,
      heading: "Context",
    });

    const getResponse = await getTemplate({
      cookies,
      params: { templateId: created.template?.id },
      request: new Request(
        resourceUrl(`/api/templates/${created.template?.id}`, workspace.id),
      ),
      url: new URL(
        resourceUrl(`/api/templates/${created.template?.id}`, workspace.id),
      ),
    } as never);
    const loaded = (await getResponse.json()) as {
      builder?: { title: string };
      source?: string;
    };
    expect(getResponse.status).toBe(200);
    expect(loaded.builder?.title).toBe("{{ title }}");
    expect(loaded.source).toContain("Brief the reader.");

    const updateResponse = await updateTemplate({
      cookies,
      params: { templateId: created.template?.id },
      request: new Request(
        resourceUrl(`/api/templates/${created.template?.id}`, workspace.id),
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            builder: {
              title: "{{ title }}",
              sections: [
                {
                  level: 4,
                  heading: "Decision Detail",
                  guidance: "Make the final ask concrete.",
                },
              ],
            },
          }),
        },
      ),
      url: new URL(
        resourceUrl(`/api/templates/${created.template?.id}`, workspace.id),
      ),
    } as never);
    const updated = (await updateResponse.json()) as {
      source?: string;
      builder?: { sections?: Array<{ level: number; heading: string }> };
    };

    expect(updateResponse.status).toBe(200);
    expect(updated.source).toContain("#### Decision Detail");
    expect(updated.builder?.sections?.[0]).toMatchObject({
      level: 4,
      heading: "Decision Detail",
    });
  });
});
