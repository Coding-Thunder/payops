import Link from "next/link";

import { Badge, DataTable, Pagination, Td, Th, fmtDate } from "@/console/components/ui";
import { ADMIN_BASE } from "@/console/lib/paths";
import { parsePagination } from "@/console/server/pagination";
import { listReviews } from "@/console/server/services/reviews";
import { requireAdminPage } from "@/console/server/auth/session";

export const dynamic = "force-dynamic";

const FILTERS = ["PENDING", "APPROVED", "REJECTED", "ALL"] as const;

function tone(status: string): "good" | "warn" | "bad" | "default" {
  if (status === "APPROVED") return "good";
  if (status === "PENDING") return "warn";
  if (status === "REJECTED") return "bad";
  return "default";
}

/**
 * The moderation queue. Defaults to PENDING rather than ALL — the reason to
 * open this page is almost always "what is waiting on me", and a list that
 * opens on everything buries that.
 */
export default async function ReviewsListPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    pageSize?: string;
    status?: string;
    q?: string;
  }>;
}) {
  // Defence in depth. `src/proxy.ts` already refuses this request without a
  // valid admin session, so nothing should reach here unauthenticated — but a
  // layout `redirect()` does NOT stop a page rendering (the App Router runs
  // them concurrently and attaches the rendered payload to the 307), so the
  // guard has to be awaited HERE, before any data is read, for this page to be
  // safe on its own. Awaiting it first is the whole point: it must precede
  // every query below.
  await requireAdminPage();
  const sp = await searchParams;
  const p = parsePagination(sp);
  const status =
    typeof sp.status === "string" && FILTERS.includes(sp.status as never)
      ? sp.status
      : "PENDING";
  const search = typeof sp.q === "string" ? sp.q : undefined;

  const result = await listReviews({
    status,
    search,
    page: p.page,
    pageSize: p.pageSize,
  });

  const withParams = (extra: Record<string, string>) => {
    const params = new URLSearchParams(extra);
    if (search) params.set("q", search);
    return `${ADMIN_BASE}/reviews?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Reviews</h1>
        <span className="text-[12px] text-[var(--muted)]">
          {result.total} in this view
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <a
              key={f}
              href={withParams({ status: f })}
              className={`rounded-md px-2.5 py-1 text-[12px] ${
                status === f
                  ? "bg-white/10 text-slate-100"
                  : "text-[var(--muted)] hover:text-slate-200"
              }`}
            >
              {f === "ALL" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
            </a>
          ))}
        </nav>
        <form method="get" className="flex gap-2">
          <input type="hidden" name="status" value={status} />
          <input
            name="q"
            defaultValue={search ?? ""}
            placeholder="Search name, email or headline"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-[var(--accent)]"
          />
          <button className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5">
            Search
          </button>
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <DataTable caption="Customer reviews">
          <thead>
            <tr>
              <Th>Rating</Th>
              <Th>Headline</Th>
              <Th>Reviewer</Th>
              <Th>Status</Th>
              <Th>Submitted</Th>
              <Th>Moderated by</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <Td>
                  <span className="text-[var(--muted)]">
                    Nothing in this view.
                  </span>
                </Td>
              </tr>
            ) : (
              result.items.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <span className="text-amber-300">
                      {"★".repeat(r.rating)}
                      <span className="text-[var(--muted)]">
                        {"★".repeat(5 - r.rating)}
                      </span>
                    </span>
                  </Td>
                  <Td>
                    <Link
                      href={`${ADMIN_BASE}/reviews/${r.id}`}
                      prefetch={false}
                      className="text-slate-100 hover:text-[var(--accent)]"
                    >
                      {r.title}
                    </Link>
                  </Td>
                  <Td>
                    <span className="text-slate-200">{r.authorName}</span>
                    <span className="block text-[11px] text-[var(--muted)]">
                      {r.authorEmail}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={tone(r.status)}>{r.status}</Badge>
                  </Td>
                  <Td>{fmtDate(r.createdAt)}</Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">
                      {r.moderatedByEmail ?? "—"}
                    </span>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </DataTable>
      </div>

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        hrefForPage={(pg) =>
          withParams({
            page: String(pg),
            pageSize: String(result.pageSize),
            status,
          })
        }
      />
    </div>
  );
}
