import { requireAdminPage } from "@/console/server/auth/session";
import { countPendingApplications } from "@/console/server/services/beta-applications";
import { countPendingReviews } from "@/console/server/services/reviews";
import { TopNav } from "@/console/components/top-nav";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Redirects to the login page when there is no valid, allow-listed session.
  const email = await requireAdminPage();
  // Queue counts are decoration on the nav: a database blip must never stop
  // an operator reaching the console, so each falls back to zero.
  let pendingBeta = 0;
  let pendingReviews = 0;
  try {
    [pendingBeta, pendingReviews] = await Promise.all([
      countPendingApplications(),
      countPendingReviews(),
    ]);
  } catch {
    pendingBeta = 0;
    pendingReviews = 0;
  }
  return (
    <div className="min-h-screen">
      <TopNav
        email={email}
        pendingBeta={pendingBeta}
        pendingReviews={pendingReviews}
      />
      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
    </div>
  );
}
