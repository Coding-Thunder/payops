import { requireAdminPage } from "@/server/auth/session";
import { normalizeEmail } from "@/server/auth/allowlist";
import { listAdmins } from "@/server/services/admins";
import { Badge, Td, Th, fmtDate } from "@/components/ui";
import { AddAdminForm } from "@/components/add-admin-form";
import { RemoveAdminButton } from "@/components/remove-admin-button";

export const dynamic = "force-dynamic";

/**
 * Admin allow-list management. The list is the `admin_users` collection plus
 * any break-glass bootstrap admin from the env. Adding an admin sends them a
 * welcome email; removing disables their DB row (bootstrap admins, yourself,
 * and the last admin are protected).
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
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Source</Th>
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
                  <Td>
                    {a.source === "bootstrap" ? (
                      <Badge tone="warn">Bootstrap</Badge>
                    ) : (
                      <span className="text-[12px] text-[var(--muted)]">
                        Managed
                      </span>
                    )}
                  </Td>
                  <Td>{fmtDate(a.lastLoginAt)}</Td>
                  <Td>{fmtDate(a.createdAt)}</Td>
                  <Td>
                    {a.id && a.source === "db" && a.email !== me ? (
                      <RemoveAdminButton id={a.id} email={a.email} />
                    ) : (
                      <span className="text-[11px] text-[var(--muted)]">—</span>
                    )}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[12px] text-[var(--muted)]">
        Break-glass admins are configured in the <code>ADMIN_ALLOWLIST</code>{" "}
        environment variable and always retain access — edit the env to change
        them.
      </p>
    </div>
  );
}
