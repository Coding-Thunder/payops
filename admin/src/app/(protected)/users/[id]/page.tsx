import Link from "next/link";
import { notFound } from "next/navigation";

import { getUserDetail } from "@/server/services/users";
import { listNotes } from "@/server/services/notes";
import { Badge, Card, Field, fmtDateTime } from "@/components/ui";
import { UserStatusButton } from "@/components/user-status-button";
import { UserSupportActions } from "@/components/user-support-actions";
import { NotesPanel } from "@/components/notes-panel";

export const dynamic = "force-dynamic";

function statusTone(s: string): "good" | "bad" | "default" {
  if (s === "ACTIVE") return "good";
  if (s === "DISABLED") return "bad";
  return "default";
}

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const u = await getUserDetail(id);
  if (!u) notFound();
  const notes = await listNotes("user", u.id);

  const authMethod = [
    u.hasPassword ? "Password" : null,
    u.firebaseLinked ? "Google" : null,
  ]
    .filter(Boolean)
    .join(" + ") || "—";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/users" className="text-[12px] text-[var(--muted)] hover:text-slate-200">
            ← Users
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold text-slate-100">
            {u.name}
            <Badge tone={statusTone(u.status)}>{u.status}</Badge>
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-slate-400">
              {u.role}
            </span>
            {u.isOrgOwner ? (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300">
                Org owner
              </span>
            ) : null}
          </h1>
          <div className="mt-0.5 text-[12px] text-[var(--muted)]">{u.email}</div>
        </div>
      </div>

      <Card title="Identity">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Email" value={u.email} />
          <Field label="Role" value={u.role} />
          <Field label="Status" value={u.status} />
          <Field label="Org" value={u.orgName ?? "—"} />
          <Field label="Auth method" value={authMethod} />
          <Field label="Last login" value={fmtDateTime(u.lastLoginAt)} />
          <Field label="Joined" value={fmtDateTime(u.createdAt)} />
          <Field
            label="User id"
            value={<span className="font-mono text-[12px]">{u.id}</span>}
          />
        </div>
      </Card>

      <Card title="Support actions">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-[var(--muted)]">Account:</span>
            <UserStatusButton userId={u.id} status={u.status} />
          </div>
          <div className="h-5 w-px bg-[var(--border)]" />
          <UserSupportActions userId={u.id} />
        </div>
        {u.isOrgOwner ? (
          <p className="mt-3 text-[11px] text-amber-300/80">
            This user owns an organization — disabling them is blocked to avoid
            locking out that tenant.
          </p>
        ) : null}
      </Card>

      <NotesPanel subjectType="user" subjectId={u.id} initialNotes={notes} />
    </div>
  );
}
