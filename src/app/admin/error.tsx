"use client";

import { ADMIN_BASE } from "@/console/lib/paths";

/**
 * Console error boundary.
 *
 * Without it the nearest boundary is the main app's `src/app/error.tsx`,
 * whose recovery CTA is `<Link href="/app/dashboard">` — an uncaught throw on
 * a console page would offer the operator a way into the TENANT app. That
 * boundary also sits above `layout.tsx`, so the console's theme wrapper is
 * replaced too and the card renders in the main app's light palette.
 *
 * Next has already logged the underlying error server-side and passes only a
 * `digest` to the client, so there is nothing to log here.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid min-h-[60vh] place-items-center px-6">
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6 text-center">
        <h1 className="text-lg font-semibold text-slate-100">
          Something went wrong
        </h1>
        <p className="mt-2 text-[13px] text-[var(--muted)]">
          This console page failed to load. The error has been logged.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            onClick={() => reset()}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--accent-2)]"
          >
            Try again
          </button>
          <a
            href={`${ADMIN_BASE}/dashboard`}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-slate-200 hover:bg-white/5"
          >
            Back to dashboard
          </a>
        </div>
        {error.digest ? (
          <p className="mt-5 font-mono text-[11px] text-[var(--muted)]">
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}
