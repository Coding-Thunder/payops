import Link from "next/link";
import { notFound } from "next/navigation";

import { getBetaApplication } from "@/console/server/services/beta-applications";
import { Badge, Field, fmtDateTime } from "@/console/components/ui";
import { BetaActions } from "@/console/components/beta-actions";
import { ADMIN_BASE } from "@/console/lib/paths";
import { requireAdminPage } from "@/console/server/auth/session";

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
  // Defence in depth. `src/proxy.ts` already refuses this request without a
  // valid admin session, so nothing should reach here unauthenticated — but a
  // layout `redirect()` does NOT stop a page rendering (the App Router runs
  // them concurrently and attaches the rendered payload to the 307), so the
  // guard has to be awaited HERE, before any data is read, for this page to be
  // safe on its own. Awaiting it first is the whole point: it must precede
  // every query below.
  await requireAdminPage();
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

      {/* Where this lead came from. Absent for a direct visit and for every
          application submitted before attribution shipped, so the panel is
          hidden rather than rendering a grid of dashes.

          Everything here is text an anonymous visitor's browser supplied. It
          is rendered as TEXT ONLY — never as a link, never interpolated into
          a query — because a referrer is an attacker-chosen URL and a
          clickable one in an admin panel is a phishing target with an
          authenticated admin on the other end. React escapes the content;
          not linking it is the part React does not do for us. */}
      {app.attribution ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
          <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
            Attribution
          </div>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Source" value={app.attribution.utmSource ?? "—"} />
            <Field label="Medium" value={app.attribution.utmMedium ?? "—"} />
            <Field
              label="Campaign"
              value={app.attribution.utmCampaign ?? "—"}
            />
            <Field label="Term" value={app.attribution.utmTerm ?? "—"} />
            <Field label="Content" value={app.attribution.utmContent ?? "—"} />
            <Field
              label="Landing page"
              value={app.attribution.landingPage ?? "—"}
            />
          </div>
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
              Referrer
            </div>
            {/* break-all: an untrusted URL must not blow out the layout. */}
            <p className="mt-1 break-all text-[13px] text-slate-200">
              {app.attribution.referrer ?? "Direct / none"}
            </p>
          </div>
        </div>
      ) : null}

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
