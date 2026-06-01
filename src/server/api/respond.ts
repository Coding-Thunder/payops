import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { AppError, isAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

import {
  applySecurityHeaders,
  DEFAULT_BODY_LIMIT_BYTES,
  enforceBodyLimit,
  enforceRateLimit,
  enforceSameOrigin,
} from "./security";

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

export interface RateLimitConfig {
  /** Logical route name for bucket namespacing. */
  route: string;
  /** Max requests within the window. */
  max: number;
  /** Window length in ms. */
  windowMs: number;
}

export interface WithApiOptions {
  /** Skip the same-origin (CSRF) guard for non-GET requests. Default
   *  false. Use only for gateway-signature-authed routes that legitimately
   *  originate from a non-browser caller (e.g. the Stripe webhook -
   *  which doesn't go through `withApi` anyway). */
  allowCrossOrigin?: boolean;
  /** Override default JSON body cap (bytes). null disables the check
   *  entirely, use only for multipart uploads that enforce their own
   *  cap inside the handler. */
  bodyLimitBytes?: number | null;
  /** Optional rate-limit guard applied before the handler runs. Keyed
   *  by IP for unauth routes, IP+session for authed routes. */
  rateLimit?: RateLimitConfig;
}

/**
 * Wrap a route handler so thrown errors become consistent JSON
 * responses and never leak stack traces or internal messages.
 *
 * Adds cross-cutting protections automatically:
 *   1. Same-origin enforcement on state-changing methods
 *      (POST/PUT/PATCH/DELETE), paired with `sameSite=strict` cookies
 *      and JSON content-type, this is the CSRF defense.
 *   2. Body-size pre-flight using Content-Length (default 32 KB; can be
 *      overridden via `bodyLimitBytes` or disabled with `null`).
 *   3. Optional rate-limit guard keyed by the caller's IP (and session
 *      cookie if present) before the handler runs.
 *   4. HSTS + private-cache response headers on every reply.
 *   5. Catch-all error handler that returns the right HTTP code for
 *      AppError / ZodError, and 500 for anything else.
 */
export function withApi<TArgs extends unknown[]>(
  handler: (...args: TArgs) => Promise<NextResponse> | NextResponse,
  options: WithApiOptions = {},
) {
  return async (...args: TArgs): Promise<NextResponse> => {
    try {
      const req = args[0] as Request | undefined;
      if (req) {
        if (shouldEnforceOrigin(req, options)) {
          await enforceSameOrigin();
        }
        if (options.bodyLimitBytes !== null && shouldCheckBody(req)) {
          await enforceBodyLimit(
            req.headers.get("content-length"),
            options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES,
          );
        }
        if (options.rateLimit) {
          enforceRateLimit({
            route: options.rateLimit.route,
            key: rateLimitKey(req),
            max: options.rateLimit.max,
            windowMs: options.rateLimit.windowMs,
          });
        }
      }
      const res = await handler(...args);
      applySecurityHeaders(res);
      return res;
    } catch (err) {
      const res = handleError(err);
      applySecurityHeaders(res);
      return res;
    }
  };
}

function shouldCheckBody(req: Request): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  return (
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE"
  );
}

/** Compose a rate-limit key from forwarded IP + the auth cookie value.
 *  Cookie content is hashed-by-prefix so it stays inside the in-process
 *  map without leaking session material on a Set-Cookie dump. */
function rateLimitKey(req: Request): string {
  const headers = req.headers;
  const fwd =
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "unknown";
  const cookie = headers.get("cookie") ?? "";
  const sessionMarker = cookie.length > 0 ? cookie.slice(0, 16) : "anon";
  return `${fwd}|${sessionMarker}`;
}

function shouldEnforceOrigin(
  req: Request,
  options: WithApiOptions,
): boolean {
  if (options.allowCrossOrigin) return false;
  const method = (req.method ?? "GET").toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
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
