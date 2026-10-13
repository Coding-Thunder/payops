import Link from "next/link";
import { notFound } from "next/navigation";

import { getEnquiry } from "@/console/server/services/quotations";
import { Badge, Field, fmtDateTime } from "@/console/components/ui";
import { ADMIN_BASE } from "@/console/lib/paths";
import { requireAdminPage } from "@/console/server/auth/session";

export const dynamic = "force-dynamic";

function notifyTone(s: string): "good" | "warn" | "bad" | "default" {
  if (s === "SENT") return "good";
  if (s === "FAILED") return "bad";
  if (s === "SKIPPED") return "warn";
  return "default";
}

export default async function EnquiryDetailPage({
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

  // `getEnquiry` returns null for a malformed id and for a waitlist row, so
  // both land on the same 404 — guessing an id discloses nothing about
  // whether it exists on another surface.
  const enquiry = await getEnquiry(id);
  if (!enquiry) notFound();

  return (
    <div className="space-y-4">
      <Link
        href={`${ADMIN_BASE}/quotations`}
        className="text-[12px] text-[var(--muted)] hover:text-slate-200"
      >
        ← Back to enquiries
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-slate-100">
          {enquiry.name || "Enquiry"}
        </h1>
        <div className="flex items-center gap-2">
          <Badge tone={enquiry.status === "PENDING" ? "warn" : "default"}>
            {enquiry.status}
          </Badge>
          <Badge tone={notifyTone(enquiry.notificationStatus)}>
            notification: {enquiry.notificationStatus}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5 sm:grid-cols-2">
        <Field label="Business email" value={enquiry.email || "—"} />
        <Field label="Company" value={enquiry.company ?? "—"} />
        <Field label="Source" value={enquiry.source} />
        <Field label="Received" value={fmtDateTime(enquiry.createdAt)} />
        {/* Legacy gateway-era fields. A general enquiry has neither, so they
            render as em dashes rather than being hidden — an empty field is
            information too. */}
        <Field label="Country" value={enquiry.country || "—"} />
        <Field label="Expected volume" value={enquiry.expectedVolume || "—"} />
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
        <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
          Enquiry
        </div>
        {/* Rendered as text in a pre-wrap block, never as HTML: this is
            visitor-supplied content and React escapes it. `break-words` stops
            a pasted URL from blowing out the layout. */}
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-200">
          {enquiry.message?.trim() || "(no message)"}
        </p>
      </div>

      {enquiry.notificationStatus !== "SENT" ? (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="text-[11px] uppercase tracking-wider text-[var(--muted)]">
            Why no notification went out
          </div>
          <p className="mt-2 text-sm text-slate-200">
            {enquiry.notificationError === "no_recipient_configured"
              ? "No SALES_EMAIL or SUPPORT_EMAIL is configured, so there was nowhere to send it. The enquiry itself is stored and answerable from this page."
              : enquiry.notificationError === "email_not_configured"
                ? "No email transport is configured in this environment. The enquiry itself is stored and answerable from this page."
                : (enquiry.notificationError ??
                  "No reason was recorded on this enquiry.")}
          </p>
        </div>
      ) : null}

      <p className="text-[12px] leading-relaxed text-[var(--muted)]">
        Read-only. Opening this page is recorded in the audit log, because it
        shows a visitor&apos;s email alongside what they wrote.
      </p>
    </div>
  );
}
