import { requireAdminPage } from "@/console/server/auth/session";
import { normalizeEmail } from "@/console/server/auth/allowlist";
import { listAdmins } from "@/console/server/services/admins";
import { Badge, Td, Th, fmtDate, DataTable } from "@/console/components/ui";
import { AddAdminForm } from "@/console/components/add-admin-form";
import { RemoveAdminButton } from "@/console/components/remove-admin-button";

export const dynamic = "force-dynamic";

/**
 * Admin allow-list management. The list IS the `admin_users` collection —
 * the only source of admin access. Adding an admin sends them a welcome
 * email; removing disables their row (yourself and the last remaining active
 * admin are protected).
 */
export default async function AdminsPage() {
  const actor = await requireAdminPage();
  const admins = await listAdmins();
  const me = normalizeEmail(actor);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Admins</h1>
        <span className="text-[12px] text-[var(--muted)]">
          {admins.filter((a) => a.status === "ACTIVE").length} active
        </span>
      </div>

      <AddAdminForm />

      <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]">
        <DataTable caption="Console administrators">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Last login</Th>
              <Th>Added</Th>
              <Th>Action</Th>
            </tr>
          </thead>
          <tbody>
            {admins.length === 0 ? (
              <tr>
                <Td>
                  <span className="text-[var(--muted)]">No admins yet.</span>
                </Td>
              </tr>
            ) : (
              admins.map((a) => (
                <tr key={a.email}>
                  <Td>
                    {a.name}
                    {a.email === me ? (
                      <span className="ml-2 text-[11px] text-[var(--muted)]">
                        (you)
                      </span>
                    ) : null}
                  </Td>
                  <Td>{a.email}</Td>
                  <Td>
                    <span className="text-[12px] text-[var(--muted)]">
                      {a.role}
                    </span>
                  </Td>
                  <Td>
                    <Badge tone={a.status === "ACTIVE" ? "good" : "bad"}>
                      {a.status}
                    </Badge>
                  </Td>
                  <Td>{fmtDate(a.lastLoginAt)}</Td>
                  <Td>{fmtDate(a.createdAt)}</Td>
                  <Td>
                    {a.email !== me ? (
                      <RemoveAdminButton id={a.id} email={a.email} />
                    ) : (
                      <span className="text-[11px] text-[var(--muted)]">—</span>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </DataTable>
      </div>

      <p className="text-[12px] text-[var(--muted)]">
        This list is the only source of console access. There is no
        environment-level override — if every admin here is disabled, access
        can only be restored directly in the database.
      </p>
    </div>
  );
}
