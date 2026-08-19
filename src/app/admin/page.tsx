import { redirect } from "next/navigation";

import { getAdminEmail, isSafeConsolePath } from "@/console/server/auth/session";
import { LoginForm } from "@/console/components/login-form";
import { ADMIN_BASE } from "@/console/lib/paths";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  // Validated server-side so a crafted `?next=` can never bounce an operator
  // off-origin after they authenticate.
  const next = isSafeConsolePath(raw) ? raw! : null;

  // Already signed in → honour the intended destination, else the dashboard.
  if (await getAdminEmail()) redirect(next ?? `${ADMIN_BASE}/dashboard`);
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <LoginForm next={next} />
    </main>
  );
}
