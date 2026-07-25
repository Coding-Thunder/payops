import { listWaitlist } from "@/server/services/waitlist";
import { parsePagination } from "@/server/pagination";
import { Badge, Pagination, Td, Th, fmtDate } from "@/components/ui";
import { GrantButton } from "@/components/grant-button";

export const dynamic = "force-dynamic";

export default async function WaitlistPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string }>;
}) {
  const sp = await searchParams;
  const p = parsePagination(sp);
  const result = await listWaitlist(p);

  const hrefForPage = (pg: number) => {
    const params = new URLSearchParams();
    params.set("page", String(pg));
    params.set("pageSize", String(result.pageSize));
    return `/waitlist?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Waitlist</h1>
        <span className="text-[12px] text-[var(--muted)]">
          {result.total} entries
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Company</Th>
              <Th>Use case</Th>
              <Th>Status</Th>
              <Th>Requested</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <Td>
                  <span className="text-[var(--muted)]">No waitlist entries.</span>
                </Td>
              </tr>
            ) : (
              result.items.map((w) => (
                <tr key={w.id}>
                  <Td>{w.name || "—"}</Td>
                  <Td>{w.email || "—"}</Td>
                  <Td>{w.company ?? "—"}</Td>
                  <Td>
                    <span className="line-clamp-2 max-w-[22ch] text-[13px] text-slate-300">
                      {w.useCase ?? "—"}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={w.granted ? "good" : "default"}>{w.status}</Badge>
                  </Td>
                  <Td>{fmtDate(w.createdAt)}</Td>
                  <Td>
                    {w.email ? (
                      <GrantButton
                        quotationId={w.id}
                        granted={w.granted}
                        email={w.email}
                      />
                    ) : (
                      <span className="text-[12px] text-[var(--muted)]">no email</span>
                    )}
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
