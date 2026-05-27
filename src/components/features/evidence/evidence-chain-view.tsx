"use client";

import Link from "next/link";
import { ArrowLeftIcon, DownloadIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/common/page-header";
import { formatCurrency, formatDateTime } from "@/lib/format";
import type { OrderEvidenceChainDTO } from "@/types";

import { ConsentEvidenceCard } from "./consent-evidence-card";
import { EvidenceTimeline } from "./evidence-timeline";
import { IntegrityBadge } from "./integrity-badge";

interface EvidenceChainViewProps {
  chain: OrderEvidenceChainDTO;
  canExport: boolean;
}

/**
 * Read-only dispute-defense screen. Renders the full hash-chained
 * timeline, a consent evidence card, and the integrity status of the
 * chain.
 *
 * "Download PDF" hits the server-rendered export route
 * (`/orders/[id]/evidence/export`) which streams an
 * `application/pdf` packet. Server-side rendering is gated by an
 * in-process semaphore (one render at a time) and a hard cap on
 * chain length so a single export can't OOM the $5-tier box — the
 * UI surfaces a Retry-After on 503.
 *
 * The previous `window.print()` UX is gone; print-time CSS classes
 * are kept as belt-and-suspenders for ad-hoc browser prints but the
 * canonical PDF is now the server export.
 */
export function EvidenceChainView({
  chain,
  canExport,
}: EvidenceChainViewProps) {
  const { events, verification, order } = chain;
  // Authed app surfaces live under `/app/*` (the route folder is `app`,
  // not the `(app)` route-group that would have been URL-transparent).
  // Anchor + back-to-order link must carry the same prefix or every
  // click 404s.
  const exportHref = `/app/orders/${order.id}/evidence/export`;
  return (
    <div className="space-y-6 print:space-y-4">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="w-fit print:hidden"
      >
        <Link href={`/app/orders/${order.id}`}>
          <ArrowLeftIcon className="size-3.5" />
          Back to order
        </Link>
      </Button>
      <PageHeader
        eyebrow="Dispute evidence"
        title={`${order.orderNumber} — evidence chain`}
        description="Immutable, hash-chained record of this order's full lifecycle. Use this as the single document a dispute / chargeback can be defended with."
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <IntegrityBadge verification={verification} />
            {canExport ? (
              <Button asChild size="sm" title="Download server-rendered PDF">
                <a
                  href={exportHref}
                  download={`evidence-${order.orderNumber}.pdf`}
                >
                  <DownloadIcon className="size-3.5" />
                  Download PDF
                </a>
              </Button>
            ) : null}
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Order header</CardTitle>
          <CardDescription>
            Snapshot of the order at the moment this page was loaded.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 text-[12.5px] sm:grid-cols-2">
            <Row label="Order number" value={order.orderNumber} mono />
            <Row label="Status" value={order.status} />
            <Row label="Customer" value={order.customer.name} />
            <Row label="Customer email" value={order.customer.email} />
            <Row
              label="Amount"
              value={formatCurrency(order.pricing.amount, order.pricing.currency)}
            />
            <Row
              label="Created"
              value={formatDateTime(order.createdAt)}
            />
            <Row label="Events recorded" value={String(events.length)} />
          </div>

          <div className="space-y-1.5">
            <h4 className="text-[12.5px] font-semibold text-foreground">
              {order.lineItems.length === 1 ? "Item" : "Items"}
            </h4>
            <p className="text-[13px]">
              {order.lineItems
                .map((l) =>
                  l.quantity > 1 ? `${l.quantity}× ${l.name}` : l.name,
                )
                .join(", ") || "—"}
            </p>
          </div>

          {order.scheduling ? (
            <div className="space-y-1">
              <h4 className="text-[12.5px] font-semibold text-foreground">
                Window
              </h4>
              <p className="text-[13px]">
                {formatDateTime(order.scheduling.startsAt)}
                {order.scheduling.endsAt
                  ? ` → ${formatDateTime(order.scheduling.endsAt)}`
                  : ""}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ConsentEvidenceCard events={events} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Event chain</CardTitle>
          <CardDescription>
            Each event is hashed against the previous one. Editing a single
            payload field cascades into every downstream hash and surfaces
            here as a red &ldquo;broken&rdquo; indicator.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">
              No evidence events recorded for this order yet. Events appear
              automatically when an order is created, a payment link is
              generated, an email is sent, consent is received, or a webhook
              confirms payment.
            </p>
          ) : (
            <EvidenceTimeline
              events={events}
              brokenAtSequence={verification.brokenAtSequence}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[10rem_1fr] items-start gap-x-3">
      <div className="text-muted-foreground">{label}</div>
      <div className={mono ? "font-mono" : ""}>{value}</div>
    </div>
  );
}

