import type { Instrumentation } from "next";

import { logger } from "@/lib/logger";

/**
 * Server-side error capture.
 *
 * Why this file exists: `withApi` only wraps `/api` route handlers. Every
 * throw inside a page, a layout or a Server Component produced NO log line
 * at all — and since every route in this app is `force-dynamic` and reads
 * Mongo directly, that is the majority of the application. A large share of
 * the "there's an error every day" reports were, by construction, invisible
 * to anyone looking at the logs.
 *
 * `onRequestError` is Next's hook for exactly that gap. It fires when the
 * server captures an error, including ones React re-wraps during Server
 * Component rendering — which is why `digest` is logged: it is the only
 * value that ties the customer's error screen to this line.
 *
 * DESTINATION LIMITATION, stated plainly: this writes through the existing
 * `logger`, which emits to stdout. On DigitalOcean App Platform that means
 * the runtime log stream — no aggregation, no search, no retention, no
 * alerting. This makes failures *visible*; it does not make them *searchable*.
 * Wiring a log drain or an error tracker is a separate, deliberate decision
 * and is not smuggled in here.
 */
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  const error = err as Error & { digest?: string };

  // Deliberately narrow. `request.headers` carries cookies and the
  // Authorization header, and `request.body` can carry customer PII or a
  // webhook payload — none of that is logged. Path, method and the routing
  // context are enough to find the failure, and carry nothing secret.
  logger.error("next.request_error", {
    name: error?.name ?? "Error",
    message: error?.message ?? String(err),
    digest: error?.digest ?? null,
    stack: error?.stack ?? null,
    path: request?.path ?? null,
    method: request?.method ?? null,
    routerKind: context?.routerKind ?? null,
    routePath: context?.routePath ?? null,
    routeType: context?.routeType ?? null,
    renderSource: context?.renderSource ?? null,
    revalidateReason: context?.revalidateReason ?? null,
  });
};
