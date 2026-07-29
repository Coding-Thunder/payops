/**
 * Client-side helpers for turning a 422 VALIDATION_ERROR envelope into
 * human-readable, per-field messages.
 *
 * The server (`handleError` in `respond.ts`) serialises a ZodError as
 * `{ error: { code: "VALIDATION_ERROR", details: { issues: [...] } } }`,
 * and `api-client` surfaces that `details` on `ApiClientError.details`.
 * Forms otherwise show only the generic top-level message ("Invalid
 * request data"), which hides *which* field is wrong — these helpers
 * recover the field paths so the operator sees exactly what to fix.
 */

import { ApiClientError } from "@/lib/api-client";

export interface FieldIssue {
  /** Dot path into the request body, e.g. `customer.email`, `lineItems.0.name`. */
  path: string;
  /** The zod message, e.g. "Invalid email". */
  message: string;
  /** The zod issue code, e.g. "too_small" (best-effort). */
  code?: string;
  /** Path rendered as a human label, e.g. "Customer Email", "Line Items #1 Name". */
  label: string;
}

/**
 * Turn a dot/array path into a readable label:
 *   customer.email    → "Customer Email"
 *   lineItems.0.name  → "Line Items #1 Name"
 *   pricing.amount    → "Pricing Amount"
 *   ""  (root issue)  → "This form"
 */
export function humanizePath(path: string): string {
  if (!path) return "This form";
  return path
    .split(".")
    .map((seg) => {
      if (/^\d+$/.test(seg)) return `#${Number(seg) + 1}`;
      const spaced = seg
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim();
      return spaced
        .split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    })
    .join(" ");
}

/**
 * Extract per-field issues from a thrown error. Returns [] for anything
 * that isn't a 422 carrying a well-formed `issues[]` array, so callers can
 * fall back to the generic message.
 */
export function fieldIssuesFrom(err: unknown): FieldIssue[] {
  if (!(err instanceof ApiClientError)) return [];
  if (err.code !== "VALIDATION_ERROR") return [];
  const details = err.details as { issues?: unknown } | undefined;
  const issues = details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues
    .map((raw): FieldIssue | null => {
      if (!raw || typeof raw !== "object") return null;
      const i = raw as { path?: unknown; message?: unknown; code?: unknown };
      const path = typeof i.path === "string" ? i.path : "";
      return {
        path,
        message:
          typeof i.message === "string" && i.message
            ? i.message
            : "Invalid value",
        code: typeof i.code === "string" ? i.code : undefined,
        label: humanizePath(path),
      };
    })
    .filter((x): x is FieldIssue => x !== null);
}

/**
 * One-call helper for a form's catch block. Returns the banner message + the
 * per-field issues to render beneath it:
 *   - a 422 with field issues -> a "Please fix the following:" heading + issues
 *   - any other ApiClientError -> its human message, no issues
 *   - a non-API error (network, etc.) -> the caller's `fallback`, no issues
 */
export function describeApiError(
  err: unknown,
  fallback: string,
): { message: string; issues: FieldIssue[] } {
  const issues = fieldIssuesFrom(err);
  if (issues.length > 0) {
    return { message: "Please fix the following:", issues };
  }
  return {
    message: err instanceof ApiClientError ? err.message : fallback,
    issues: [],
  };
}
