import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { users, workspaces } from "@vegastack/pages-services";
import { buildServiceContext } from "../../../../lib/service-context";
import { POST as verifyMagicLink } from "../magic-link/verify";
import { POST as signup } from "../signup";

async function getCtx() {
  const { ctx } = await buildServiceContext({
    cookies: { get: () => undefined } as never,
  });
  return ctx;
}

const tempDirs: string[] = [];

function uniqueEmail() {
  return `signup-${crypto.randomUUID()}@example.com`;
}

afterEach(() => {
  delete process.env.VPG_PUBLIC_SIGNUP;
  delete process.env.VPG_EMAIL_PROVIDER;
  delete process.env.VPG_RUNTIME;
  delete process.env.VPG_STATE_DIR;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("public signup", () => {
  it("does not create user or workspace records before email verification", async () => {
    process.env.VPG_PUBLIC_SIGNUP = "true";
    process.env.VPG_EMAIL_PROVIDER = "console";
    process.env.VPG_RUNTIME = "node";
    process.env.VPG_STATE_DIR = mkdtempSync(join(tmpdir(), "vpg-signup-"));
    tempDirs.push(process.env.VPG_STATE_DIR);
    const email = uniqueEmail();
    const workspaceName = `Deferred Signup ${crypto.randomUUID()}`;

    const response = await signup({
      request: new Request("https://pages.example.test/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          display_name: "Deferred User",
          workspace_name: workspaceName,
        }),
      }),
      url: new URL("https://pages.example.test/api/auth/signup"),
    } as never);
    const body = (await response.json()) as {
      ok?: boolean;
      debug_verify_url?: string;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.debug_verify_url).toContain("/auth/magic-link#token=");
    const preCtx = await getCtx();
    expect(await users.getByEmail(preCtx, email)).toBeNull();
    // No user exists yet, so no workspace can be associated. Verify directly
    // against D1 to be sure the workspace wasn't created either.
    const preWorkspaceRows = await preCtx.db
      ?.prepare("SELECT name FROM workspaces WHERE name = ?1")
      .bind(workspaceName)
      .all<{ name: string }>();
    const preRows = Array.isArray(preWorkspaceRows)
      ? preWorkspaceRows
      : (preWorkspaceRows?.results ?? []);
    expect(preRows).toEqual([]);

    const setCookie = vi.fn();
    const verifyUrl = new URL(
      body.debug_verify_url ?? "https://pages.example.test/",
    );
    const token = new URLSearchParams(verifyUrl.hash.slice(1)).get("token");
    const verifyResponse = await verifyMagicLink({
      cookies: { set: setCookie },
      request: new Request(
        "https://pages.example.test/api/auth/magic-link/verify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        },
      ),
      url: new URL("https://pages.example.test/api/auth/magic-link/verify"),
    } as never);
    const verifyBody = (await verifyResponse.json()) as {
      redirect_to?: string;
    };
    const postCtx = await getCtx();
    const user = await users.getByEmail(postCtx, email);

    expect(verifyResponse.status).toBe(200);
    expect(verifyBody.redirect_to).toMatch(/^\/p\//);
    expect(setCookie).toHaveBeenCalledWith(
      "vpg_session",
      expect.any(String),
      expect.objectContaining({ httpOnly: true, path: "/" }),
    );
    expect(user?.email).toBe(email);
    const userWorkspaces = user
      ? await workspaces.listForUser(postCtx, { userId: user.id })
      : [];
    expect(
      userWorkspaces.some((workspace) => workspace.name === workspaceName),
    ).toBe(true);
  });
});
