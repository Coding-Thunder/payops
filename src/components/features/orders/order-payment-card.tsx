"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ExternalLinkIcon,
  RefreshCwIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CopyButton } from "@/components/common/copy-button";
import { OrderStatusBadge } from "@/components/common/status-badges";
import { toast } from "@/components/ui/sonner";
import { api, ApiClientError } from "@/lib/api-client";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/format";
import { OrderStatus } from "@/lib/constants/enums";
import type { OrderDTO } from "@/types";

interface OrderPaymentCardProps {
  order: OrderDTO;
  canRegenerate: boolean;
}

interface RegenerateApiResponse {
  order: OrderDTO;
  checkoutUrl: string;
}

export function OrderPaymentCard({
  order,
  canRegenerate,
}: OrderPaymentCardProps) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const isPaid = order.status === OrderStatus.PAID;
  const isPending = order.status === OrderStatus.PAYMENT_PENDING;
  const isFailedOrExpired =
    order.status === OrderStatus.FAILED ||
    order.status === OrderStatus.EXPIRED;

  const amountReceived =
    order.payment.amountReceived ?? order.pricing.amount;

  async function regenerate() {
    setSubmitting(true);
    try {
      await api.post<RegenerateApiResponse>(
        `/api/orders/${order.id}/regenerate-link`,
      );
      toast.success("New payment link generated");
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not regenerate the link";
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle>Payment</CardTitle>
          <CardDescription>
            {isPaid
              ? `Settled ${formatRelative(order.payment.paidAt)}`
              : isPending
                ? `Awaiting customer payment`
                : isFailedOrExpired
                  ? `Payment ${order.status.toLowerCase()}`
                  : null}
          </CardDescription>
        </div>
        <OrderStatusBadge status={order.status} />
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <Field label="Amount due" value={formatCurrency(order.pricing.amount, order.pricing.currency)} />
          <Field
            label={isPaid ? "Amount received" : "Currency"}
            value={
              isPaid
                ? formatCurrency(amountReceived, order.pricing.currency)
                : order.pricing.currency
            }
          />
          <Field
            label="Expires"
            value={
              order.payment.expiresAt
                ? formatDateTime(order.payment.expiresAt)
                : "—"
            }
          />
          <Field
            label="Stripe session"
            value={order.payment.stripeSessionId ?? "—"}
            mono
          />
        </div>

        {order.payment.failureReason ? (
          <Alert variant="destructive">
            <AlertTitle>Payment problem reported by Stripe</AlertTitle>
            <AlertDescription>{order.payment.failureReason}</AlertDescription>
          </Alert>
        ) : null}

        {isPending && order.payment.checkoutUrl ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Payment link to share with the customer
              </p>
              <p className="mt-1 font-mono text-xs break-all">
                {order.payment.checkoutUrl}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton value={order.payment.checkoutUrl} label="Copy link" />
              <Button asChild variant="outline" size="sm">
                <a
                  href={order.payment.checkoutUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLinkIcon className="size-3.5" />
                  Open in new tab
                </a>
              </Button>
              {canRegenerate ? (
                <LoadingButton
                  variant="ghost"
                  size="sm"
                  onClick={regenerate}
                  loading={submitting}
                  loadingText="Regenerating"
                  icon={<RefreshCwIcon className="size-3.5" />}
                >
                  Regenerate link
                </LoadingButton>
              ) : null}
            </div>
          </div>
        ) : null}

        {isFailedOrExpired && canRegenerate ? (
          <LoadingButton
            variant="outline"
            size="sm"
            onClick={regenerate}
            loading={submitting}
            loadingText="Generating"
            icon={<RefreshCwIcon className="size-3.5" />}
          >
            Generate a new payment link
          </LoadingButton>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={
          mono
            ? "mt-1 font-mono text-xs text-foreground break-all"
            : "mt-1 text-sm text-foreground font-medium"
        }
      >
        {value}
      </p>
    </div>
  );
}
