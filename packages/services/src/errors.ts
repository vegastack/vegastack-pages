// Service-layer errors. Each carries a stable code so HTTP adapters
// (apps/web routes) and MCP adapters can translate to status codes and
// MCP error shapes without re-classifying messages.

export type ServiceErrorCode =
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "CONFLICT"
  | "VALIDATION"
  | "RATE_LIMITED"
  | "INTERNAL";

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ServiceErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = httpStatusFor(code);
    this.details = details;
  }
}

export function httpStatusFor(code: ServiceErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "FORBIDDEN":
      return 403;
    case "UNAUTHORIZED":
      return 401;
    case "CONFLICT":
      return 409;
    case "VALIDATION":
      return 400;
    case "RATE_LIMITED":
      return 429;
    case "INTERNAL":
      return 500;
  }
}

export function isServiceError(value: unknown): value is ServiceError {
  return value instanceof ServiceError;
}
