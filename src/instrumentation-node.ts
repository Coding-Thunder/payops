import "server-only";

import { logger } from "@/lib/logger";

/**
 * Process-level crash backstop for the single $5 DigitalOcean instance.
 *
 * A stray unhandled promise rejection (e.g. a best-effort fire-and-forget that
 * rejects) would, under Node's default, terminate the WHOLE process and drop
 * every in-flight request. We log and keep serving instead.
 *
 * Tradeoff: we deliberately do NOT exit on uncaughtException. Exiting is the
 * textbook move (process state is undefined after an uncaught throw), but on a
 * single instance it means immediate full downtime and a possible crash-loop.
 * For a beta that skews toward availability we log loudly and stay up; flip to
 * `process.exit(1)` here once running multi-instance behind a load balancer.
 *
 * Imported only from instrumentation.ts under the Node runtime; the top-level
 * body registers the handlers once (guarded against dev-HMR double-register).
 */
const g = globalThis as typeof globalThis & {
  __tracetxnProcessHandlers?: boolean;
};

if (!g.__tracetxnProcessHandlers) {
  g.__tracetxnProcessHandlers = true;

  process.on("unhandledRejection", (reason) => {
    logger.error("process.unhandledRejection", {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on("uncaughtException", (err) => {
    logger.error("process.uncaughtException", {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  });
}
