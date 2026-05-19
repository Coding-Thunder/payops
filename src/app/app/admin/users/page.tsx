import { PageHeader } from "@/components/common/page-header";
import { CreateUserDialog } from "@/components/features/users/create-user-dialog";
import { UserTable } from "@/components/features/users/user-table";
import { Permission } from "@/lib/constants/permissions";
import { listUsersQuerySchema } from "@/lib/validation";
import { requirePermission } from "@/server/auth/session";
import { listUsers } from "@/server/services/user.service";

export const metadata = { title: "Team" };
export const dynamic = "force-dynamic";

interface UsersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminUsersPage({ searchParams }: UsersPageProps) {
  const actor = await requirePermission(Permission.USER_VIEW);
  const sp = await searchParams;
  const query = listUsersQuerySchema.parse(flatten(sp));
  const data = await listUsers(query);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Team"
        description="Manage who has access to the operations console."
        actions={<CreateUserDialog actorRole={actor.role} />}
      />
      <UserTable
        items={data.items}
        currentUserId={actor.id}
        currentUserRole={actor.role}
      />
    </div>
  );
}

function flatten(
  sp: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.length > 0) out[k] = v[0];
  }
  return out;
}
