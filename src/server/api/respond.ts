import { createHash } from "node:crypto";

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
  /**
   * "ip" ignores cookies. Use it for routes called before signing in (login,
   * public forms): there the cookies are whatever the caller chooses, and
   * keying on them let a script reset its own limit on every attempt.
   * Default "session": the caller's IP plus their session.
   */
  keyBy?: "ip" | "session";
}

export interface WithApiOptions {
  /** Skip the same-origin (CSRF) guard for non-GET requests. Default
   *  false. Use only for gateway-signature-authed routes that legitimately
   *  originate from a non-browser caller (e.g. the Stripe webhook —
   *  which doesn't go through `withApi` anyway). */
  allowCrossOrigin?: boolean;
  /** Override default JSON body cap (bytes). null disables the check
   *  entirely — use only for multipart uploads that enforce their own
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
 *      (POST/PUT/PATCH/DELETE) — paired with `sameSite=strict` cookies
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
            key: rateLimitKey(req, options.rateLimit.keyBy ?? "session"),
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

/**
 * Compose a rate-limit key from the caller's IP and, for signed-in routes,
 * a hash of their session token.
 *
 * It used to take the first 16 characters of the whole Cookie header —
 * which is the cookie NAME, the same for everyone — so every operator
 * behind one office IP shared each route's limit, while anyone could change
 * their bucket by sending a different cookie. The token is hashed so no
 * session material sits in the in-process map.
 */
function rateLimitKey(req: Request, keyBy: "ip" | "session"): string {
  const headers = req.headers;
  // Cloudflare overwrites this header; the left end of X-Forwarded-For is
  // whatever the client sent.
  const ip =
    headers.get("cf-connecting-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "unknown";
  if (keyBy === "ip") return ip;
  const token = sessionToken(headers.get("cookie") ?? "");
  const session = token
    ? createHash("sha256").update(token).digest("hex").slice(0, 24)
    : "anon";
  return `${ip}|${session}`;
}

function sessionToken(cookieHeader: string): string | null {
  const name = process.env.COOKIE_NAME || "payops_session";
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
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
    // Lead with the first specific reason — "Enter a valid email" — rather
    // than a generic line the operator cannot act on. Every issue is still
    // in `details.issues` for callers that want them all.
    const first = err.issues[0];
    const more = err.issues.length - 1;
    const message = first
      ? `${first.message}${more > 0 ? ` (and ${more} more problem${more === 1 ? "" : "s"})` : ""}`
      : "Invalid request data";
    return jsonError(422, "VALIDATION_ERROR", message, {
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

  // A body that is not JSON at all. `req.json()` throws a SyntaxError, which
  // used to fall through to the 500 below and tell the caller the SERVER had
  // failed.
  if (err instanceof SyntaxError) {
    return jsonError(400, "BAD_REQUEST", "The request body is not valid JSON.");
  }

  // A database-level validation failure (for example a limit the request
  // schema does not repeat). The operator gets the field and the reason
  // instead of "Something went wrong".
  if (
    err instanceof Error &&
    err.name === "ValidationError" &&
    "errors" in err &&
    err.errors &&
    typeof err.errors === "object"
  ) {
    const issues = Object.entries(
      err.errors as Record<string, { message?: string }>,
    ).map(([path, e]) => ({
      path,
      message: e?.message ?? "Invalid value",
      code: "invalid",
    }));
    logger.warn("api.model_validation_error", { issues });
    return jsonError(
      422,
      "VALIDATION_ERROR",
      issues[0]?.message ?? "Invalid request data",
      { issues },
    );
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
