import { redirect } from "next/navigation";

import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { getCurrentUser } from "@/server/auth/session";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const brand = env.server.APP_NAME;

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar role={user.role} brand={brand} />
      <div className="flex flex-1 flex-col min-w-0">
        <Topbar user={user} brand={brand} />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
