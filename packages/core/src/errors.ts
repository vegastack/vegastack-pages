export const errorCodes = [
  "AUTH_REQUIRED",
  "SETUP_REQUIRED",
  "SETUP_ALREADY_COMPLETE",
  "WORKSPACE_REQUIRED",
  "WORKSPACE_NOT_FOUND",
  "PERMISSION_DENIED",
  "PAGE_NOT_FOUND",
  "FOLDER_NOT_FOUND",
  "THREAD_NOT_FOUND",
  "COMMENT_NOT_FOUND",
  "USER_NOT_FOUND",
  "MCP_SESSION_NOT_FOUND",
  "SHARE_LINK_NOT_FOUND",
  "SHARE_PASSWORD_REQUIRED",
  "PUBLICATION_NOT_FOUND",
  "PUBLICATION_PASSWORD_REQUIRED",
  "PUBLICATION_PASSWORD_INVALID",
  "PUBLICATION_REVOKED",
  "ARTIFACT_NOT_FOUND",
  "TEMPLATE_NOT_FOUND",
  "CONFLICT",
  "VALIDATION_ERROR",
  "RATE_LIMITED",
  "LOCK_TIMEOUT",
  "PAYLOAD_TOO_LARGE",
  "EMAIL_NOT_CONFIGURED",
  "EMAIL_DELIVERY_FAILED",
  "UNSUPPORTED_SOURCE_TYPE",
  "RENDER_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    status = 400,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON(requestId?: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        request_id: requestId,
        details: this.details,
      },
    };
  }
}
