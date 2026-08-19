import { requireAdminPage } from "@/console/server/auth/session";
import { countPendingApplications } from "@/console/server/services/beta-applications";
import { TopNav } from "@/console/components/top-nav";

export const dynamic = "force-dynamic";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Redirects to the login page when there is no valid, allow-listed session.
  const email = await requireAdminPage();
  let pendingBeta = 0;
  try {
    pendingBeta = await countPendingApplications();
  } catch {
    pendingBeta = 0;
  }
  return (
    <div className="min-h-screen">
      <TopNav email={email} pendingBeta={pendingBeta} />
      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
    </div>
  );
}
