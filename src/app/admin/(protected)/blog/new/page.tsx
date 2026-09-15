import Link from "next/link";

import { BlogEditor } from "@/console/components/blog-editor";
import { ADMIN_BASE } from "@/console/lib/paths";
import { requireAdminPage } from "@/console/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * New post. Always creates a DRAFT — the create endpoint has no publish path,
 * so there is no way to write straight to the public site.
 */
export default async function NewBlogPostPage() {
  // Defence in depth. `src/proxy.ts` already refuses this request without a
  // valid admin session, so nothing should reach here unauthenticated — but a
  // layout `redirect()` does NOT stop a page rendering (the App Router runs
  // them concurrently and attaches the rendered payload to the 307), so the
  // guard has to be awaited HERE, before any data is read, for this page to be
  // safe on its own. Awaiting it first is the whole point: it must precede
  // every query below.
  await requireAdminPage();
  return (
    <div className="space-y-4">
      <Link
        href={`${ADMIN_BASE}/blog`}
        className="text-[12px] text-[var(--muted)] hover:text-slate-200"
      >
        ← Back to blog
      </Link>
      <h1 className="text-xl font-semibold text-slate-100">New post</h1>
      <BlogEditor />
    </div>
  );
}
