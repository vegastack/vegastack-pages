import { AppError, slugifyTitle } from "@vegastack/pages-core";
import { workspaces, type ServiceContext } from "@vegastack/pages-services";

export type SignupIntent = {
  displayName: string;
  workspaceName: string;
};

const signupIntentPath = "/app/signup/complete";

export function createSignupIntentRedirect(input: SignupIntent): string {
  const params = new URLSearchParams({
    signup_intent: "1",
    display_name: input.displayName,
    workspace_name: input.workspaceName,
  });
  return `${signupIntentPath}?${params.toString()}`;
}

export function parseSignupIntentRedirect(value: string): SignupIntent | null {
  try {
    const url = new URL(value, "https://pages.local");
    if (
      url.origin !== "https://pages.local" ||
      url.pathname !== signupIntentPath ||
      url.searchParams.get("signup_intent") !== "1"
    ) {
      return null;
    }
    const workspaceName = (url.searchParams.get("workspace_name") ?? "").trim();
    if (!workspaceName) return null;
    return {
      displayName: (url.searchParams.get("display_name") ?? "").trim(),
      workspaceName,
    };
  } catch {
    return null;
  }
}

// Create a workspace with a slug derived from the title; retry up to 8
// times with a random suffix if there's a collision. Workspaces.create
// in @vegastack/pages-services now auto-picks a free slug when none is
// supplied — but we keep an explicit retry loop here for callers that
// need to surface meaningful errors per attempt.
export async function createUniqueWorkspace(
  ctx: ServiceContext,
  name: string,
  firstAdminUserId?: string,
) {
  const baseSlug = slugifyTitle(name) || "workspace";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix =
      attempt === 0
        ? ""
        : `-${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
    try {
      return await workspaces.create(ctx, {
        name,
        slug: `${baseSlug}${suffix}`,
        firstAdminUserId,
      });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "VALIDATION_ERROR") {
        throw error;
      }
    }
  }
  throw new AppError(
    "VALIDATION_ERROR",
    "Could not create a unique workspace slug.",
    400,
  );
}
