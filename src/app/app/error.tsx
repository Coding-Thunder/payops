"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";

/**
 * Error boundary for the authenticated app. Because it lives under
 * `app/app/layout.tsx`, a caught error renders INSIDE the sidebar shell — the
 * operator keeps their nav and session; only the failed content area shows the
 * recovery card. Catches data-fetch failures on `force-dynamic` pages (the
 * likeliest mid-session event on Atlas M0). Errors in the shell layout itself
 * fall through to the root boundary.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid min-h-[60vh] place-items-center px-4 py-12">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8 text-center">
        <h1 className="text-lg font-semibold text-foreground">
          This page didn’t load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong fetching this data. Your session is fine — retry,
          or head back to the dashboard.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Button onClick={() => reset()}>Try again</Button>
          <Button variant="outline" asChild>
            <Link href="/app/dashboard">Dashboard</Link>
          </Button>
        </div>
        {error.digest ? (
          <p className="mt-5 font-mono text-[11px] text-muted-foreground">
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
    </div>
  );
}
