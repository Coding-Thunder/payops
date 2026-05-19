import { redirect } from "next/navigation";

import { Suspense } from "react";

import { Sidebar } from "@/components/app-shell/sidebar";
import { TelemetryStrip } from "@/components/app-shell/telemetry-strip";
import { Topbar } from "@/components/app-shell/topbar";
import { CommandPalette } from "@/components/command-palette";
import { RouteTransitionLoader } from "@/components/common/route-transition-loader";
import { RealtimeProvider } from "@/components/providers/realtime-provider";
import { UserRoleLabel } from "@/lib/constants/labels";
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
      <Suspense fallback={null}>
        <RouteTransitionLoader />
      </Suspense>
      <div className="relative flex min-h-screen bg-background print:block print:min-h-0 print:bg-white">
        <div className="print:hidden md:flex md:bg-sidebar">
          <Sidebar role={user.role} brand={brand} />
        </div>
        <div className="flex flex-1 flex-col min-w-0 print:block">
          {/* Control-tower chrome: thin telemetry strip (28px) over
              a slim topbar (48px). Telemetry owns infrastructure
              health; topbar owns page context + ⌘K + user. The
              previous gradient hairline is folded into the strip's
              top-edge accent stroke. */}
          <div className="print:hidden">
            <TelemetryStrip
              workspace={brand}
              operatorLabel={`${user.name} · ${UserRoleLabel[user.role]}`}
            />
          </div>
          <div className="print:hidden">
            <Topbar user={user} brand={brand} />
          </div>
          {/* Shell padding lives inside main so every page gets a
              consistent inset on all four sides without a coloured
              gutter strip — same bg both sides of the seam, the gap
              is purely spacing. Scales 16 → 20 → 24 px on md / lg /
              xl, same rhythm horizontally and vertically. The `print:`
              overrides drop overflow and padding so the printed
              evidence page flows naturally onto paper using the
              browser's page margins instead of the app's chrome. */}
          <main className="flex-1 overflow-y-auto md:px-4 md:py-4 lg:px-5 lg:py-5 xl:px-6 xl:py-6 print:overflow-visible print:p-0">
            {children}
          </main>
        </div>
        <CommandPalette role={user.role} />
      </div>
    </RealtimeProvider>
  );
}
