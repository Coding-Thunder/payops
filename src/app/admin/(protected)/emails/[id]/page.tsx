import Link from "next/link";
import { notFound } from "next/navigation";

import { getEmailById } from "@/console/server/services/email-ops";
import { Badge, Card, Field, fmtDateTime } from "@/console/components/ui";
import { EmailActions } from "@/console/components/email-actions";
import { ADMIN_BASE } from "@/console/lib/paths";

export const dynamic = "force-dynamic";

function statusTone(s: string): "good" | "warn" | "bad" | "default" {
  if (s === "SENT") return "good";
  if (s === "FAILED") return "bad";
  if (s === "PENDING") return "warn";
  return "default";
}

interface TimelineItem {
  label: string;
  at: string | null;
  tone?: "good" | "warn" | "bad" | "default";
}

export default async function EmailDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const email = await getEmailById(id);
  if (!email) notFound();

  // Lifecycle assembled from the row's own timestamps.
  const timeline: TimelineItem[] = [
    { label: "Queued", at: email.createdAt, tone: "default" },
  ];
  if (email.status === "PENDING" || email.status === "PROCESSING") {
    timeline.push({
      label: "Next attempt due",
      at: email.nextAttemptAt,
      tone: "warn",
    });
  }
  if (email.status === "FAILED") {
    timeline.push({
      label: `Failed after ${email.attempts} attempt(s)`,
      at: email.updatedAt,
      tone: "bad",
    });
  }
  if (email.status === "SENT") {
    timeline.push({
      label: "Delivered to provider",
      at: email.sentAt,
      tone: "good",
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={`${ADMIN_BASE}/emails`}
            className="text-[12px] text-[var(--muted)] hover:text-slate-200"
          >
            ← Email Operations
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-slate-100">
            {email.recipient}
            <Badge tone={statusTone(email.status)}>{email.status}</Badge>
          </h1>
          <div className="mt-0.5 font-mono text-[12px] text-[var(--muted)]">
            {email.kind} · {email.id}
          </div>
        </div>
        <EmailActions id={email.id} status={email.status} />
      </div>

      <Card title="Details">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Status" value={email.status} />
          <Field label="Kind" value={email.kind} />
          <Field label="Attempts" value={email.attempts} />
          <Field
            label="Order"
            value={
              email.orderId ? (
                <span className="font-mono text-[12px]">{email.orderId}</span>
              ) : (
                "—"
              )
            }
          />
          <Field
            label="Org"
            value={
              email.orgId ? (
                <span className="font-mono text-[12px]">{email.orgId}</span>
              ) : (
                "—"
              )
            }
          />
          <Field label="Queued" value={fmtDateTime(email.createdAt)} />
          <Field label="Next attempt" value={fmtDateTime(email.nextAttemptAt)} />
          <Field label="Sent" value={fmtDateTime(email.sentAt)} />
          <Field label="Updated" value={fmtDateTime(email.updatedAt)} />
        </div>
      </Card>

      {email.lastError ? (
        <Card title="Last error">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-red-500/10 p-3 text-[12px] leading-relaxed text-red-200">
            {email.lastError}
          </pre>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Timeline">
          <ol className="space-y-3">
            {timeline.map((t, i) => (
              <li key={i} className="flex items-start gap-3">
                <span
                  className={`mt-1 size-2 shrink-0 rounded-full ${
                    t.tone === "good"
                      ? "bg-emerald-400"
                      : t.tone === "bad"
                        ? "bg-red-400"
                        : t.tone === "warn"
                          ? "bg-amber-400"
                          : "bg-slate-500"
                  }`}
                />
                <div>
                  <div className="text-sm text-slate-200">{t.label}</div>
                  <div className="text-[12px] text-[var(--muted)]">
                    {fmtDateTime(t.at)}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Payload (metadata)">
          {email.metadata && Object.keys(email.metadata).length > 0 ? (
            <pre className="max-h-[360px] overflow-auto rounded-lg bg-[var(--panel-2)] p-3 text-[12px] leading-relaxed text-slate-300">
              {JSON.stringify(email.metadata, null, 2)}
            </pre>
          ) : (
            <span className="text-[13px] text-[var(--muted)]">
              No metadata on this email.
            </span>
          )}
        </Card>
      </div>
    </div>
  );
}
