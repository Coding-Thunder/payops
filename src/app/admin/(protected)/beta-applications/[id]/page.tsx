import Link from "next/link";
import { notFound } from "next/navigation";

import { getBetaApplication } from "@/console/server/services/beta-applications";
import { Badge, Field, fmtDateTime } from "@/console/components/ui";
import { BetaActions } from "@/console/components/beta-actions";
import { ADMIN_BASE } from "@/console/lib/paths";

export const dynamic = "force-dynamic";

function statusTone(s: string): "good" | "warn" | "bad" | "default" {
  if (s === "ACTIVATED") return "good";
  if (s === "PENDING") return "warn";
  if (s === "REJECTED") return "bad";
  return "default";
}

export default async function BetaApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const app = await getBetaApplication(id);
  if (!app) notFound();

  return (
    <div className="space-y-4">
      <Link
        href={`${ADMIN_BASE}/beta-applications`}
        className="text-[12px] text-[var(--muted)] hover:text-slate-200"
      >
        ← Back to applications
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">
          {app.fullName}
        </h1>
        <Badge tone={statusTone(app.status)}>{app.status}</Badge>
      </div>

      {app.lastInviteError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-[13px] text-red-200">
          The invitation email failed to send:{" "}
          <span className="font-medium">{app.lastInviteError}</span>. Use{" "}
          <span className="font-medium">Retry invitation</span> below to try
          again.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 sm:grid-cols-3">
        <Field label="Email" value={app.email} />
        <Field label="User type" value={app.userType} />
        <Field label="Business / agency" value={app.businessName ?? "—"} />
        <Field label="Clients managed" value={app.clientsManaged ?? "—"} />
        <Field label="Applied" value={fmtDateTime(app.createdAt)} />
        <Field
          label="Reviewed by"
          value={app.reviewedByEmail ?? "—"}
        />
        <Field label="Invited" value={fmtDateTime(app.invitedAt)} />
        <Field
          label="Invite expires"
          value={fmtDateTime(app.inviteExpiresAt)}
        />
        <Field label="Activated" value={fmtDateTime(app.activatedAt)} />
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
          Client-management challenge
        </div>
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-200">
          {app.challengeAnswer?.trim() || "—"}
        </p>
      </div>

      <BetaActions
        id={app.id}
        status={app.status}
        note={app.adminNote ?? ""}
      />
    </div>
  );
}
