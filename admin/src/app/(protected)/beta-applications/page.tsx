import Link from "next/link";

import { listBetaApplications } from "@/server/services/beta-applications";
import { parsePagination } from "@/server/pagination";
import { Badge, Pagination, Td, Th, fmtDate } from "@/components/ui";

export const dynamic = "force-dynamic";

const FILTERS = [
  "ALL",
  "PENDING",
  "APPROVED",
  "INVITED",
  "ACTIVATED",
  "REJECTED",
] as const;

function statusTone(s: string): "good" | "warn" | "bad" | "default" {
  if (s === "ACTIVATED") return "good";
  if (s === "PENDING") return "warn";
  if (s === "REJECTED") return "bad";
  return "default";
}

export default async function BetaApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    pageSize?: string;
    status?: string;
    q?: string;
  }>;
}) {
  const sp = await searchParams;
  const p = parsePagination(sp);
  const status =
    typeof sp.status === "string" && FILTERS.includes(sp.status as never)
      ? sp.status
      : "ALL";
  const search = typeof sp.q === "string" ? sp.q : undefined;

  const result = await listBetaApplications({
    status,
    search,
    page: p.page,
    pageSize: p.pageSize,
  });

  const hrefForPage = (pg: number) => {
    const params = new URLSearchParams();
    params.set("page", String(pg));
    params.set("pageSize", String(result.pageSize));
    if (status !== "ALL") params.set("status", status);
    if (search) params.set("q", search);
    return `/beta-applications?${params.toString()}`;
  };

  const filterHref = (f: string) => {
    const params = new URLSearchParams();
    if (f !== "ALL") params.set("status", f);
    if (search) params.set("q", search);
    return `/beta-applications?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">
          Beta Applications
        </h1>
        <span className="text-[12px] text-[var(--muted)]">
          {result.total} total
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1">
          {FILTERS.map((f) => {
            const active = status === f;
            return (
              <a
                key={f}
                href={filterHref(f)}
                className={`rounded-md px-2.5 py-1 text-[12px] ${
                  active
                    ? "bg-white/10 text-slate-100"
                    : "text-[var(--muted)] hover:text-slate-200"
                }`}
              >
                {f === "ALL" ? "All" : f.charAt(0) + f.slice(1).toLowerCase()}
              </a>
            );
          })}
        </nav>
        <form method="get" className="flex gap-2">
          {status !== "ALL" ? (
            <input type="hidden" name="status" value={status} />
          ) : null}
          <input
            name="q"
            defaultValue={search ?? ""}
            placeholder="Search name or email"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-[var(--accent)]"
          />
          <button className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5">
            Search
          </button>
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Type</Th>
              <Th>Business</Th>
              <Th>Status</Th>
              <Th>Applied</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <Td>
                  <span className="text-[var(--muted)]">
                    No applications found.
                  </span>
                </Td>
              </tr>
            ) : (
              result.items.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <Link
                      href={`/beta-applications/${a.id}`}
                      className="text-sky-300 hover:underline"
                    >
                      {a.fullName || "—"}
                    </Link>
                  </Td>
                  <Td>{a.email}</Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">
                      {a.userType}
                    </span>
                  </Td>
                  <Td>{a.businessName ?? "—"}</Td>
                  <Td>
                    <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                    {a.lastInviteError ? (
                      <span className="ml-1 text-[11px] text-red-300">
                        · send failed
                      </span>
                    ) : null}
                  </Td>
                  <Td>{fmtDate(a.createdAt)}</Td>
                  <Td>
                    <Link
                      href={`/beta-applications/${a.id}`}
                      className="rounded-md border border-[var(--border)] px-2.5 py-1 text-[12px] text-slate-200 hover:bg-white/5"
                    >
                      Review
                    </Link>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        hrefForPage={hrefForPage}
      />
    </div>
  );
}
