import { listUsers } from "@/server/services/users";
import { parsePagination } from "@/server/pagination";
import { Badge, Pagination, Td, Th, fmtDate } from "@/components/ui";
import { UserStatusButton } from "@/components/user-status-button";

export const dynamic = "force-dynamic";

function statusTone(s: string): "good" | "bad" | "default" {
  if (s === "ACTIVE") return "good";
  if (s === "DISABLED") return "bad";
  return "default";
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const p = parsePagination(sp);
  const search = typeof sp.q === "string" ? sp.q : undefined;
  const result = await listUsers(p, search);

  const hrefForPage = (pg: number) => {
    const params = new URLSearchParams();
    params.set("page", String(pg));
    params.set("pageSize", String(result.pageSize));
    if (search) params.set("q", search);
    return `/users?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Users</h1>
        <form method="get" className="flex gap-2">
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
              <Th>Role</Th>
              <Th>Org</Th>
              <Th>Status</Th>
              <Th>Last login</Th>
              <Th>Joined</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <Td>
                  <span className="text-[var(--muted)]">No users found.</span>
                </Td>
              </tr>
            ) : (
              result.items.map((u) => (
                <tr key={u.id}>
                  <Td>{u.name}</Td>
                  <Td>{u.email}</Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">{u.role}</span>
                  </Td>
                  <Td>{u.orgName ?? "—"}</Td>
                  <Td>
                    <Badge tone={statusTone(u.status)}>{u.status}</Badge>
                  </Td>
                  <Td>{fmtDate(u.lastLoginAt)}</Td>
                  <Td>{fmtDate(u.createdAt)}</Td>
                  <Td>
                    <UserStatusButton userId={u.id} status={u.status} />
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
