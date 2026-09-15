import Link from "next/link";

import { Badge, DataTable, Pagination, Td, Th, fmtDate } from "@/console/components/ui";
import { ADMIN_BASE } from "@/console/lib/paths";
import { parsePagination } from "@/console/server/pagination";
import { listBlogPosts } from "@/console/server/services/blog";
import { blogPostPath } from "@/lib/blog/slug";
import { requireAdminPage } from "@/console/server/auth/session";

export const dynamic = "force-dynamic";

const FILTERS = ["ALL", "DRAFT", "PUBLISHED"] as const;

export default async function BlogListPage({
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
      : "ALL";
  const search = typeof sp.q === "string" ? sp.q : undefined;

  const result = await listBlogPosts({
    status,
    search,
    page: p.page,
    pageSize: p.pageSize,
  });

  const withParams = (extra: Record<string, string>) => {
    const params = new URLSearchParams(extra);
    if (search) params.set("q", search);
    return `${ADMIN_BASE}/blog?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Blog</h1>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-[var(--muted)]">
            {result.total} total
          </span>
          <Link
            href={`${ADMIN_BASE}/blog/new`}
            className="rounded-lg border border-[var(--border)] bg-white/5 px-3 py-1.5 text-sm text-slate-100 hover:bg-white/10"
          >
            New post
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <a
              key={f}
              href={withParams(f === "ALL" ? {} : { status: f })}
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
          {status !== "ALL" ? (
            <input type="hidden" name="status" value={status} />
          ) : null}
          <input
            name="q"
            defaultValue={search ?? ""}
            placeholder="Search title or slug"
            className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-[var(--accent)]"
          />
          <button className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-slate-200 hover:bg-white/5">
            Search
          </button>
        </form>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <DataTable caption="Blog posts">
          <thead>
            <tr>
              <Th>Title</Th>
              <Th>Slug</Th>
              <Th>Status</Th>
              <Th>Published</Th>
              <Th>Updated</Th>
              <Th>By</Th>
              <Th>View</Th>
            </tr>
          </thead>
          <tbody>
            {result.items.length === 0 ? (
              <tr>
                <Td>
                  <span className="text-[var(--muted)]">No posts yet.</span>
                </Td>
              </tr>
            ) : (
              result.items.map((post) => (
                <tr key={post.id}>
                  <Td>
                    <Link
                      href={`${ADMIN_BASE}/blog/${post.id}`}
                      prefetch={false}
                      className="text-slate-100 hover:text-[var(--accent)]"
                    >
                      {post.title}
                    </Link>
                  </Td>
                  <Td>
                    <span className="font-mono text-[12px] text-[var(--muted)]">
                      {post.slug}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={post.status === "PUBLISHED" ? "good" : "warn"}>
                      {post.status}
                    </Badge>
                  </Td>
                  <Td>{fmtDate(post.publishedAt)}</Td>
                  <Td>{fmtDate(post.updatedAt)}</Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">
                      {post.updatedByEmail ?? "—"}
                    </span>
                  </Td>
                  <Td>
                    {post.status === "PUBLISHED" ? (
                      /* Only a PUBLISHED post gets a live link. Offering one
                         for a draft would send the operator to a 404 and read
                         as a broken site rather than as an unpublished post. */
                      <a
                        href={blogPostPath(post.slug)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[12px] text-[var(--accent)] hover:underline"
                      >
                        Live ↗
                      </a>
                    ) : (
                      <span className="text-[12px] text-[var(--muted)]">—</span>
                    )}
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
            ...(status !== "ALL" ? { status } : {}),
          })
        }
      />
    </div>
  );
}
