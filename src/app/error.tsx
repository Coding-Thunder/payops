"use client";

import Link from "next/link";

import { SiteWordmark } from "@/components/brand/site-wordmark";
import { Button } from "@/components/ui/button";

/**
 * Root error boundary. Catches an uncaught throw from any page/layout below
 * the root layout — e.g. an Atlas M0 read timing out on a `force-dynamic`
 * page — and renders a branded, recoverable card instead of Next's raw
 * "Application error: a server-side exception has occurred" white screen.
 *
 * Next has already logged the underlying error server-side and passes only a
 * `digest` to the client (never the message/stack), so there is nothing to
 * log here; we surface the digest as a support reference.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-6 py-16">
      <div className="w-full max-w-md text-center">
        <div className="mb-8 flex justify-center">
          <SiteWordmark textClassName="text-foreground" />
        </div>
        <div className="rounded-xl border border-border bg-card p-8">
          <h1 className="text-lg font-semibold text-foreground">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            We hit an unexpected error loading this page. It’s been logged on
            our side. You can retry, or head back to your dashboard.
          </p>
          <div className="mt-6 flex items-center justify-center gap-2">
            <Button onClick={() => reset()}>Try again</Button>
            <Button variant="outline" asChild>
              <Link href="/app/dashboard">Go to dashboard</Link>
            </Button>
          </div>
          {error.digest ? (
            <p className="mt-5 font-mono text-[11px] text-muted-foreground">
              Reference: {error.digest}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
