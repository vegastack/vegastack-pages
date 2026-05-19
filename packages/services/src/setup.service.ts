// Setup service — single-row setup_state table.
//
// Plan 011 §5 phase 1. Replaces packages/core/src/setup.ts (class-based,
// in-memory state) with direct-D1 functions over ServiceContext.
//
// Authentication contract: the setup endpoint is unauthenticated by
// design (the operator supplies a setup token via env). Authorization
// is enforced inline via constant-time comparison of the supplied
// token against the expected token.

import { AppError } from "@vegastack/pages-core";
import { requireDb, type ServiceContext } from "./context.ts";

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

const SINGLETON_KEY = "default";

type SetupRow = {
  setup_complete: number;
  first_admin_user_id: string | null;
  first_workspace_id: string | null;
};

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export async function status(ctx: ServiceContext): Promise<SetupState> {
  const db = requireDb(ctx);
  const row = await db
    .prepare(
      "SELECT setup_complete, first_admin_user_id, first_workspace_id FROM setup_state WHERE key = ?1",
    )
    .bind(SINGLETON_KEY)
    .first<SetupRow>();
  if (!row) {
    return {
      setupComplete: false,
      firstAdminUserId: null,
      firstWorkspaceId: null,
    };
  }
  return {
    setupComplete: row.setup_complete === 1,
    firstAdminUserId: row.first_admin_user_id,
    firstWorkspaceId: row.first_workspace_id,
  };
}

export async function complete(
  ctx: ServiceContext,
  input: CompleteSetupInput,
): Promise<CompleteSetupResult> {
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
    throw new AppError("VALIDATION_ERROR", "Workspace name is required.", 400);
  }

  const db = requireDb(ctx);
  const adminUserId = input.adminUserId ?? "usr_setup";
  const workspaceId = input.workspaceId ?? "wks_setup";
  const now = new Date().toISOString();

  // Atomic flip: insert the singleton row; if it already exists,
  // don't touch it. The first caller wins. The route caller is
  // expected to have already inserted the admin user + workspace
  // rows referenced below; this just records the pointers.
  await db
    .prepare(
      `INSERT INTO setup_state
         (key, setup_complete, first_admin_user_id, first_workspace_id, updated_at)
       VALUES (?1, 1, ?2, ?3, ?4)
       ON CONFLICT(key) DO NOTHING`,
    )
    .bind(SINGLETON_KEY, adminUserId, workspaceId, now)
    .run();

  // Read back to detect a lost race: the row's adminUserId is the
  // winning caller's id. If it doesn't match the one we attempted to
  // write, somebody else completed setup first.
  const after = await status(ctx);
  if (after.firstAdminUserId !== adminUserId) {
    throw new AppError(
      "SETUP_ALREADY_COMPLETE",
      "Setup has already been completed.",
      409,
    );
  }

  return {
    adminUserId,
    adminEmail: input.adminEmail,
    adminName: input.adminName,
    workspaceId,
    workspaceName: input.workspaceName,
  };
}
