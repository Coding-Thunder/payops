import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { AppError, isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export function jsonOk<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(details ? { details } : {}) } },
    { status },
  );
}

/**
 * Wrap a route handler so thrown errors become consistent JSON responses
 * and never leak stack traces / internal messages.
 */
export function withApi<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<NextResponse> | NextResponse,
) {
  return async (...args: TArgs): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (err) {
      return handleError(err);
    }
  };
}

function handleError(err: unknown): NextResponse {
  if (err instanceof ZodError) {
    return jsonError(422, "VALIDATION_ERROR", "Invalid request data", {
      issues: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
        code: i.code,
      })),
    });
  }

  if (isAppError(err)) {
    if (err.statusCode >= 500) {
      logger.error("api.app_error", {
        code: err.code,
        message: err.message,
        cause: stringifyCause(err),
      });
    } else {
      logger.warn("api.app_error", { code: err.code, message: err.message });
    }
    return jsonError(err.statusCode, err.code, err.message, err.details);
  }

  if (err instanceof Error) {
    logger.error("api.unhandled_error", { message: err.message });
    return jsonError(500, "INTERNAL_ERROR", "Something went wrong");
  }

  logger.error("api.unknown_error", { value: String(err) });
  return jsonError(500, "INTERNAL_ERROR", "Something went wrong");
}

function stringifyCause(err: AppError): string | undefined {
  if (!err.cause) return undefined;
  if (err.cause instanceof Error) return err.cause.message;
  try {
    return JSON.stringify(err.cause);
  } catch {
    return String(err.cause);
  }
}
