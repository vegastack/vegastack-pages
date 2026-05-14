import { AppError, slugifyTitle } from "@vegastack/pages-core";
import { workspaceService } from "./runtime";

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

export function createUniqueWorkspace(name: string) {
  const baseSlug = slugifyTitle(name);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix =
      attempt === 0
        ? ""
        : `-${crypto.randomUUID().replaceAll("-", "").slice(0, 6)}`;
    try {
      return workspaceService.createWorkspace({
        name,
        slug: `${baseSlug}${suffix}`,
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
