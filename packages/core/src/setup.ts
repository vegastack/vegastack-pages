import { AppError } from "./errors";

export type SetupState = {
  setupComplete: boolean;
  firstAdminUserId: string | null;
  firstWorkspaceId: string | null;
};

export type CompleteSetupInput = {
  setupToken: string;
  expectedSetupToken: string;
  adminEmail: string;
  adminName: string;
  workspaceName: string;
  adminUserId?: string;
  workspaceId?: string;
};

export type CompleteSetupResult = {
  adminUserId: string;
  adminEmail: string;
  adminName: string;
  workspaceId: string;
  workspaceName: string;
};

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export class SetupService {
  constructor(
    private state: SetupState = {
      setupComplete: false,
      firstAdminUserId: null,
      firstWorkspaceId: null,
    },
  ) {}

  status(): SetupState {
    return { ...this.state };
  }

  complete(input: CompleteSetupInput): CompleteSetupResult {
    if (this.state.setupComplete) {
      throw new AppError(
        "SETUP_ALREADY_COMPLETE",
        "Setup has already been completed.",
        409,
      );
    }
    if (
      !input.expectedSetupToken ||
      !constantTimeEqual(input.setupToken, input.expectedSetupToken)
    ) {
      throw new AppError("PERMISSION_DENIED", "Invalid setup token.", 403);
    }
    if (!input.adminEmail.includes("@")) {
      throw new AppError("VALIDATION_ERROR", "Admin email must be valid.", 400);
    }
    if (!input.workspaceName.trim()) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Workspace name is required.",
        400,
      );
    }

    const adminUserId = input.adminUserId ?? "usr_setup";
    const workspaceId = input.workspaceId ?? "wks_setup";
    this.state = {
      setupComplete: true,
      firstAdminUserId: adminUserId,
      firstWorkspaceId: workspaceId,
    };

    return {
      adminUserId,
      adminEmail: input.adminEmail,
      adminName: input.adminName,
      workspaceId,
      workspaceName: input.workspaceName,
    };
  }
}
