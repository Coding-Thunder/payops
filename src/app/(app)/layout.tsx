import { redirect } from "next/navigation";

import { Suspense } from "react";

import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { CommandPalette } from "@/components/command-palette";
import { RouteTransitionLoader } from "@/components/common/route-transition-loader";
import { RealtimeProvider } from "@/components/providers/realtime-provider";
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
    <RealtimeProvider>
      {/* useSearchParams suspends on initial page load; isolating the
          transition loader keeps the rest of the shell from blocking. */}
      <Suspense fallback={null}>
        <RouteTransitionLoader />
      </Suspense>
      <div className="flex min-h-screen bg-background">
        <Sidebar role={user.role} brand={brand} />
        <div className="flex flex-1 flex-col min-w-0">
          <Topbar user={user} brand={brand} />
          <main className="flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8 md:px-8">
              {children}
            </div>
          </main>
        </div>
        <CommandPalette role={user.role} />
      </div>
    </RealtimeProvider>
  );
}
