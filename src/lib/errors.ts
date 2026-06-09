/**
 * Domain error hierarchy. API route handlers turn these into JSON responses;
 * service code throws them so callers don't need bespoke status codes.
 */

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "PAYMENT_ERROR"
  | "EXTERNAL_SERVICE_ERROR"
  | "BOT_CHECK_FAILED"
  | "QUOTA_EXCEEDED";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    options: { details?: unknown; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", details?: unknown) {
    super("BAD_REQUEST", message, 400, { details });
    this.name = "BadRequestError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", details?: unknown) {
    super("VALIDATION_ERROR", message, 422, { details });
    this.name = "ValidationError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super("NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: unknown) {
    super("CONFLICT", message, 409, { details });
    this.name = "ConflictError";
  }
}

export class PaymentError extends AppError {
  constructor(message = "Payment processing failed", cause?: unknown) {
    super("PAYMENT_ERROR", message, 502, { cause });
    this.name = "PaymentError";
  }
}

export class ExternalServiceError extends AppError {
  constructor(message = "Upstream service failed", cause?: unknown) {
    super("EXTERNAL_SERVICE_ERROR", message, 502, { cause });
    this.name = "ExternalServiceError";
  }
}

/**
 * Plan quota hit (e.g. concurrent-active-orders cap). Status 402 so the
 * client can distinguish billing pressure from generic 4xx (validation,
 * auth, not-found) and render an upgrade panel instead of a toast. The
 * details payload always carries `{ plan, limit, current, resource }`
 * so the UI can render an exact "12 / 30 active orders" line without
 * re-fetching usage.
 */
export class QuotaExceededError extends AppError {
  constructor(
    message: string,
    details: {
      plan: string;
      resource: string;
      limit: number;
      current: number;
    },
  ) {
    super("QUOTA_EXCEEDED", message, 402, { details });
    this.name = "QuotaExceededError";
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
