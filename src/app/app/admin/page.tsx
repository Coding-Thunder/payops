import { redirect } from "next/navigation";

import { Permission, roleHasPermission } from "@/lib/constants/permissions";
import { requireUser } from "@/server/auth/session";

export const dynamic = "force-dynamic";

/**
 * `/app/admin` is a landing route, pick the highest-priority admin
 * subpage the user has permission for and redirect there. Staff
 * hitting this URL bounce to the dashboard.
 */
export default async function AdminIndexPage() {
  const user = await requireUser();
  if (roleHasPermission(user.role, Permission.ANALYTICS_VIEW)) {
    redirect("/app/admin/analytics");
  }
  if (roleHasPermission(user.role, Permission.USER_VIEW)) {
    redirect("/app/admin/users");
  }
  if (roleHasPermission(user.role, Permission.SETTINGS_VIEW)) {
    redirect("/app/admin/settings");
  }
  redirect("/app/dashboard");
}
