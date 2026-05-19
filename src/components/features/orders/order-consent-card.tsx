"use client";

import {
  CheckCircle2Icon,
  ClipboardCheckIcon,
  HistoryIcon,
  MailQuestionIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConsentStatusBadge } from "@/components/common/status-badges";
import { api } from "@/lib/api-client";
import {
  ConsentMethod,
  ConsentStatus,
} from "@/lib/constants/enums";
import { ConsentMethodLabel } from "@/lib/constants/labels";
import { formatDateTime } from "@/lib/format";
import type { UserRole } from "@/lib/constants/enums";
import type { OrderDTO, PaymentConsentDTO } from "@/types";

interface OrderConsentCardProps {
  order: OrderDTO;
  role: UserRole;
}

interface ConsentListResponse {
  items: PaymentConsentDTO[];
}

/**
 * Single card surfacing the consent layer on the order-detail page.
 *
 * What it shows:
 *   - current status badge + headline timeline (requested → received →
 *     verified) using the lightweight pointer on the Order doc
 *   - admin "Verify" action when there's a received-but-unverified record
 *   - manual entry dialog ("customer replied by email") for the mailto
 *     fallback case
 *   - history list of past consent records (re-sends, prior attempts)
 *     fetched lazily from /api/orders/:id/consent
 *
 * Deliberately quiet by default — we render even when status is
 * NOT_REQUESTED so the agent knows the feature exists, but the visual
 * weight stays muted until something has actually happened.
 */
export function OrderConsentCard({ order, role: _role }: OrderConsentCardProps) {
  const { consent } = order;

  const history = useQuery<ConsentListResponse>({
    queryKey: ["consent", "order", order.id],
    queryFn: () =>
      api.get<ConsentListResponse>(`/api/orders/${order.id}/consent`),
    // Don't auto-poll — the SSE invalidation in RealtimeProvider drops
    // this cache when consent moves, and the agent will refetch on
    // action otherwise.
    staleTime: 30_000,
  });

  const current =
    history.data?.items.find((c) => c.id === consent.currentConsentId) ??
    history.data?.items[0] ??
    null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-muted-foreground" aria-hidden />
            Customer consent
          </CardTitle>
          <CardDescription>
            Lightweight pre-payment acknowledgement trail.
          </CardDescription>
        </div>
        <ConsentStatusBadge status={consent.status} />
      </CardHeader>
      <CardContent className="space-y-4">
        <Timeline consent={consent} />

        {current ? <ConsentDetail consent={current} /> : null}

        <HistoryList
          items={history.data?.items ?? []}
          loading={history.isLoading}
          currentId={consent.currentConsentId}
        />
      </CardContent>
    </Card>
  );
}

function Timeline({
  consent,
}: {
  consent: OrderDTO["consent"];
}) {
  // Customer submission auto-verifies, so there is no separate
  // "Received" step any more — the hosted page click moves the record
  // straight to VERIFIED with the same captured signature + IP that
  // would have been graded later. Two steps only.
  const steps: Array<{
    label: string;
    when: string | null;
    Icon: typeof CheckCircle2Icon;
    on: boolean;
  }> = [
    {
      label: "Requested",
      when: consent.requestedAt,
      Icon: MailQuestionIcon,
      on:
        consent.status === ConsentStatus.REQUESTED ||
        consent.status === ConsentStatus.RECEIVED ||
        consent.status === ConsentStatus.VERIFIED,
    },
    {
      label: "Confirmed by customer",
      when: consent.verifiedAt ?? consent.receivedAt,
      Icon: ClipboardCheckIcon,
      on:
        consent.status === ConsentStatus.RECEIVED ||
        consent.status === ConsentStatus.VERIFIED,
    },
  ];
  return (
    <ol className="space-y-2.5">
      {steps.map((step) => (
        <li
          key={step.label}
          className="flex items-center gap-3 text-sm"
        >
          <span
            className={
              step.on
                ? "inline-flex size-7 items-center justify-center rounded-full bg-foreground text-background"
                : "inline-flex size-7 items-center justify-center rounded-full border border-border text-muted-foreground"
            }
          >
            <step.Icon className="size-3.5" aria-hidden />
          </span>
          <div className="flex-1">
            <p
              className={
                step.on
                  ? "text-sm font-medium text-foreground"
                  : "text-sm text-muted-foreground"
              }
            >
              {step.label}
            </p>
            {step.on && step.when ? (
              <p className="text-[11px] text-muted-foreground">
                {formatDateTime(step.when)}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ConsentDetail({ consent }: { consent: PaymentConsentDTO }) {
  const hostedPage = consent.method === ConsentMethod.HOSTED_PAGE;
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Acknowledgement
      </p>
      <p className="mt-1.5 text-sm leading-relaxed text-foreground">
        “{consent.consentMessage}”
      </p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11.5px]">
        {consent.signedName ? (
          <DetailLine label="Signed name" value={consent.signedName} />
        ) : null}
        {consent.receivedAt ? (
          <DetailLine
            label="Timestamp"
            value={formatDateTime(consent.receivedAt)}
            mono
          />
        ) : null}
        {consent.method ? (
          <DetailLine
            label="Method"
            value={
              <>
                {ConsentMethodLabel[consent.method as ConsentMethod]}
                {hostedPage ? (
                  <span className="text-muted-foreground">
                    {" · secure hosted page"}
                  </span>
                ) : null}
              </>
            }
          />
        ) : null}
        {consent.receiptIp ? (
          <DetailLine label="IP" value={consent.receiptIp} mono />
        ) : null}
        {consent.receiptUserAgent ? (
          <DetailLine
            label="User agent"
            value={
              <span className="line-clamp-2 break-all">
                {consent.receiptUserAgent}
              </span>
            }
            mono
          />
        ) : null}
      </dl>
    </div>
  );
}

function DetailLine({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={
          mono
            ? "font-mono text-foreground break-all"
            : "text-foreground"
        }
      >
        {value}
      </dd>
    </>
  );
}

function HistoryList({
  items,
  loading,
  currentId,
}: {
  items: PaymentConsentDTO[];
  loading: boolean;
  currentId: string | null;
}) {
  if (loading) {
    return (
      <p className="text-[11px] text-muted-foreground">Loading history…</p>
    );
  }
  if (items.length <= 1) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
        <HistoryIcon className="mr-1 inline size-3" /> Earlier attempts (
        {items.length})
      </summary>
      <ul className="mt-2 space-y-1.5">
        {items.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between rounded border border-border/60 px-2.5 py-1.5 text-[12px]"
          >
            <span>
              {c.status} ·{" "}
              <span className="text-muted-foreground">
                {formatDateTime(c.createdAt)}
              </span>
              {c.id === currentId ? (
                <span className="ml-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  (current)
                </span>
              ) : null}
            </span>
            {c.method ? (
              <span className="text-[10px] text-muted-foreground">
                {ConsentMethodLabel[c.method as ConsentMethod]}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

