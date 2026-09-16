"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Route-level error boundary.
 *
 * Catches render failures anywhere under `app/` that are not caught closer
 * in — the marketing pages, `/consent`, `/pay` and the whole authenticated
 * console. Before this existed, any such throw showed Next's bare default
 * page with no styling, no support route and no way back.
 *
 * It does NOT swallow the error. The server has already captured it through
 * `onRequestError` in `src/instrumentation.ts`; the `digest` shown here is
 * the same value logged there, which is what lets an operator quote a code
 * that can actually be found. The message and stack are deliberately NOT
 * rendered — this boundary covers customer-facing routes too.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Client-side render failures never reach the server hook, so this is the
    // only record of them. Console is the only sink available in the browser.
    console.error("[payops] render error", {
      digest: error.digest,
      name: error.name,
    });
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-6 py-16">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-[20px] font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          This page didn&apos;t load. The problem has been recorded. You can try
          again, and if it keeps happening quote the reference below to support.
        </p>
        {error.digest ? (
          <p className="font-mono text-[11px] text-muted-foreground/80">
            Reference: {error.digest}
          </p>
        ) : null}
        <div className="flex items-center justify-center gap-2 pt-1">
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center rounded-md bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-border px-4 py-2 text-[13px] font-medium transition-colors hover:bg-muted"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
