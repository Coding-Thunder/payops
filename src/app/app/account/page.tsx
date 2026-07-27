import { redirect } from "next/navigation";

import { PageHeader } from "@/components/common/page-header";
import { MyAccessCard } from "@/components/features/settings/my-access-card";
import { MyAccountCard } from "@/components/features/settings/my-account-card";
import { requireUser } from "@/server/auth/session";
import { getUserById } from "@/server/services/user.service";
import type { PublicUser } from "@/types";

export const metadata = { title: "My account" };
export const dynamic = "force-dynamic";

/**
 * Self-service account page for EVERY authenticated user (owner or member).
 * Unlike the owner-only /app/admin/settings hub, this route uses requireUser
 * (no permission gate), so a member — who is 403'd out of Workspace settings
 * — still has a home for their profile + a read-only view of their access.
 */
export default async function AccountPage() {
  const user = await requireUser();
  if (!user.orgId) redirect("/login");

  // lastLoginAt / createdAt / the persisted permissionMode come from the
  // OrgMember-joined read. Resilient: a legacy session without a membership
  // row still renders (identity + effective permissions come off the
  // session), just without the timestamps.
  let me: PublicUser | null = null;
  try {
    me = await getUserById(user.id, { orgId: user.orgId });
  } catch {
    me = null;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="My account"
        description="Your profile and what you can do in this workspace."
      />
      <MyAccountCard
        name={user.name}
        email={user.email}
        workspaceRole={user.workspaceRole}
        lastLoginAt={me?.lastLoginAt ?? null}
        createdAt={me?.createdAt ?? null}
      />
      <MyAccessCard
        workspaceRole={user.workspaceRole}
        permissionMode={me?.permissionMode}
        effectivePermissions={[...user.permissions]}
      />
    </div>
  );
}
