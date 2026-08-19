import Link from "next/link";

import { ADMIN_BASE } from "@/console/lib/paths";

/**
 * Console 404 boundary.
 *
 * Six console detail pages call `notFound()` (`orders/[id]`, `users/[id]`,
 * `customers/[id]`, `emails/[id]`, `audit/[id]`, `beta-applications/[id]`).
 * Without this file the nearest boundary is the main app's
 * `src/app/not-found.tsx`, which renders tenant-branded chrome and a "Back
 * home" link to `/` — dumping an operator out of the console and onto the
 * marketing site. Standalone, those pages rendered Next's default 404.
 */
export default function AdminNotFound() {
  return (
    <div className="grid min-h-[60vh] place-items-center px-6">
      <div className="space-y-3 text-center">
        <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
          404
        </p>
        <h1 className="text-xl font-semibold text-slate-100">Not found</h1>
        <p className="text-[13px] text-[var(--muted)]">
          That record doesn&apos;t exist, or it has been removed.
        </p>
        <div className="pt-2">
          <Link
            href={`${ADMIN_BASE}/dashboard`}
            className="inline-flex rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-slate-200 hover:bg-white/5"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
