"use client";

import * as React from "react";
import {
  ClockIcon,
  CheckCircle2Icon,
  XCircleIcon,
  AlertTriangleIcon,
} from "lucide-react";

import { useActivityFeed } from "@/hooks/use-activity-feed";
import { DomainEventType } from "@/lib/constants/events";
import { ConsentStatus, OrderStatus } from "@/lib/constants/enums";
import { hasCustomerConsent } from "@/lib/consent";
import { isOperatorSupersede, outstandingHeldPayments } from "@/lib/payment-state";
import { PAID_FEATURES_ENABLED } from "@/lib/paid-features";
import { cn } from "@/lib/utils";
import type { OrderDTO } from "@/types";

interface PaymentStatusFloaterProps {
  order: OrderDTO;
  /** Recording a manual payment is an admin action. */
  canRecordPayment?: boolean;
}

interface FloaterDescriptor {
  tone: "pending" | "paid" | "failed" | "expired";
  label: string;
  detail: string;
}

const TONE_STYLES: Record<FloaterDescriptor["tone"], string> = {
  pending: "bg-amber-50 text-amber-900 border-amber-200",
  paid: "bg-emerald-50 text-emerald-900 border-emerald-200",
  failed: "bg-rose-50 text-rose-900 border-rose-200",
  expired: "bg-slate-50 text-slate-700 border-slate-200",
};

const TONE_ICONS: Record<FloaterDescriptor["tone"], React.ElementType> = {
  pending: ClockIcon,
  paid: CheckCircle2Icon,
  failed: XCircleIcon,
  expired: AlertTriangleIcon,
};

function describeOrder(order: OrderDTO, canRecordPayment: boolean): FloaterDescriptor {
  if (
    PAID_FEATURES_ENABLED &&
    order.status !== OrderStatus.PAID &&
    outstandingHeldPayments(order).length > 0
  ) {
    return {
      tone: "failed",
      label: "Payment already received on an earlier link",
      detail: "Do not charge the customer again until it is reconciled.",
    };
  }
  const manual =
    PAID_FEATURES_ENABLED && order.consent?.collectionMethod === "MANUAL";
  if (manual && order.status !== OrderStatus.PAID) {
    return {
      tone: "pending",
      label: "Manual payment requested",
      detail: hasCustomerConsent(order.consent.status)
        ? canRecordPayment
          ? `${order.customer.name} confirmed. Record the payment once you have collected it.`
          : `${order.customer.name} confirmed. An admin records the payment once it is collected.`
        : order.consent.status === ConsentStatus.NOT_REQUESTED
          ? // An amount change retired the request that was out.
            "The amount changed. Send the confirmation request again."
          : `Waiting for ${order.customer.name} to confirm the booking.`,
    };
  }
  switch (order.status) {
    case OrderStatus.PAID:
      return {
        tone: "paid",
        label: "Payment received",
        detail: order.payment.paidAt
          ? `Payment confirmed at ${new Date(order.payment.paidAt).toLocaleString()}.`
          : "Payment has been confirmed.",
      };
    case OrderStatus.FAILED:
      return isOperatorSupersede(order.payment.failureReason)
        ? {
            tone: "expired",
            label: "New payment link needed",
            detail: `${order.payment.failureReason}. Choose how to collect on the payment-request page.`,
          }
        : {
            tone: "failed",
            label: "Payment failed",
            detail:
              order.payment.failureReason ??
              "The payment was declined. Choose how to collect next on the payment-request page.",
          };
    case OrderStatus.NOT_INITIATED:
      return {
        tone: "pending",
        label: "Payment not requested yet",
        detail: "Send a payment request from the payment-request page.",
      };
    case OrderStatus.LINK_GENERATED:
      return {
        tone: "pending",
        label: "Payment link ready — not sent yet",
        detail: `Send it so ${order.customer.name} can confirm and pay.`,
      };
    case OrderStatus.EXPIRED:
      return {
        tone: "expired",
        label: "Payment link expired",
        detail:
          "The customer didn't complete checkout in time. Regenerate the link to try again.",
      };
    default:
      return {
        tone: "pending",
        label: "Awaiting payment",
        detail: `Watching for ${order.customer.name}'s payment in real time.`,
      };
  }
}

/**
 * Sticky live-status floater pinned to the top of the order detail
 * page. Reads the order's current status as the source of truth and
 * additionally listens to the SSE activity feed for ORDER_PAID /
 * ORDER_FAILED / ORDER_EXPIRED matching this order so the banner
 * flips the moment Stripe fires without waiting for a route refresh.
 */
export function PaymentStatusFloater({
  order,
  canRecordPayment = true,
}: PaymentStatusFloaterProps) {
  const { events } = useActivityFeed();
  const [override, setOverride] = React.useState<FloaterDescriptor | null>(
    null,
  );

  // Standard "react to event-bus state" pattern — the setState calls
  // inside this effect run on every match. The lint rule's "don't
  // setState in effects" is a false-positive for event-driven flows.
  React.useEffect(() => {
    for (const event of events) {
      const payload = event.payload as Record<string, unknown>;
      const matchesOrder =
        payload.orderId === order.id ||
        payload.orderNumber === order.orderNumber;
      if (!matchesOrder) continue;
      // Only news the loaded order does not already reflect. An older
      // "failed" event kept overriding the banner after the order had moved
      // on (a new link, a switch, a manual request).
      if (Date.parse(event.at) <= Date.parse(order.updatedAt)) continue;
      if (event.type === DomainEventType.ORDER_PAID) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setOverride({
          tone: "paid",
          label: "Payment received",
          detail: `Payment confirmed at ${new Date(event.at).toLocaleString()}.`,
        });
        return;
      }
      if (event.type === DomainEventType.ORDER_FAILED) {
        setOverride({
          tone: "failed",
          label: "Payment failed",
          detail:
            (typeof payload.reason === "string" ? payload.reason : null) ??
            "The payment was declined.",
        });
        return;
      }
      if (event.type === DomainEventType.ORDER_EXPIRED) {
        setOverride({
          tone: "expired",
          label: "Payment link expired",
          detail: "Regenerate the link to try again.",
        });
        return;
      }
    }
  }, [events, order.id, order.orderNumber, order.updatedAt]);

  const descriptor = override ?? describeOrder(order, canRecordPayment);
  const Icon = TONE_ICONS[descriptor.tone];

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "sticky top-16 z-30 flex items-center gap-3 rounded-lg border px-4 py-3 shadow-sm transition-colors duration-200",
        TONE_STYLES[descriptor.tone],
      )}
    >
      <Icon
        className={cn(
          "size-4 shrink-0",
          descriptor.tone === "pending" && "animate-pulse",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold leading-tight">
          {descriptor.label}
        </p>
        <p className="mt-0.5 truncate text-[12px] opacity-80">
          {descriptor.detail}
        </p>
      </div>
    </div>
  );
}
