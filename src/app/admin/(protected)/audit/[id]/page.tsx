import Link from "next/link";
import { notFound } from "next/navigation";

import { getAuditById, normalizeSource } from "@/console/server/services/audit-center";
import { Badge, Card, Field, fmtDateTime } from "@/console/components/ui";
import { ADMIN_BASE } from "@/console/lib/paths";

export const dynamic = "force-dynamic";

export default async function AuditDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const { id } = await params;
  const { source: rawSource } = await searchParams;
  const source = normalizeSource(rawSource);
  const event = await getAuditById(source, id);
  if (!event) notFound();

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`${ADMIN_BASE}/audit?source=${source}`}
          className="text-[12px] text-[var(--muted)] hover:text-slate-200"
        >
          ← Audit Center
        </Link>
        <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-slate-100">
          <span className="font-mono text-[16px]">{event.action}</span>
          <Badge tone={source === "console" ? "warn" : "default"}>
            {source === "console" ? "Console action" : "Product event"}
          </Badge>
        </h1>
        <div className="mt-0.5 font-mono text-[12px] text-[var(--muted)]">
          {event.id}
        </div>
      </div>

      <Card title="Event">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Action" value={event.action} />
          <Field label="Actor" value={event.actor} />
          {event.actorName ? (
            <Field label="Actor name" value={event.actorName} />
          ) : null}
          {event.actorRole ? (
            <Field label="Actor role" value={event.actorRole} />
          ) : null}
          <Field label="Entity" value={event.entity} />
          {event.org ? (
            <Field
              label="Org"
              value={<span className="font-mono text-[12px]">{event.org}</span>}
            />
          ) : null}
          <Field label="When" value={fmtDateTime(event.createdAt)} />
          <Field label="IP" value={event.ip ?? "—"} />
          {event.requestId ? (
            <Field
              label="Request id"
              value={
                <span className="font-mono text-[12px]">{event.requestId}</span>
              }
            />
          ) : null}
        </div>
        {event.userAgent ? (
          <div className="mt-4">
            <Field
              label="User agent"
              value={
                <span className="break-all text-[12px] text-[var(--muted)]">
                  {event.userAgent}
                </span>
              }
            />
          </div>
        ) : null}
      </Card>

      <Card title="Metadata">
        {event.metadata && Object.keys(event.metadata).length > 0 ? (
          <pre className="max-h-[420px] overflow-auto rounded-lg bg-[var(--panel-2)] p-3 text-[12px] leading-relaxed text-slate-300">
            {JSON.stringify(event.metadata, null, 2)}
          </pre>
        ) : (
          <span className="text-[13px] text-[var(--muted)]">
            No metadata on this event.
          </span>
        )}
      </Card>
    </div>
  );
}
