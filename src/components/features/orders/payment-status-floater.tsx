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
import { OrderStatus, PaymentCaptureStatus } from "@/lib/constants/enums";
import { PaymentCaptureStatusLabel } from "@/lib/constants/labels";
import { cn } from "@/lib/utils";
import type { OrderDTO, OrderPaymentCapture } from "@/types";

interface PaymentStatusFloaterProps {
  order: OrderDTO;
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

function describeOrder(order: OrderDTO): FloaterDescriptor {
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
      return {
        tone: "failed",
        label: "Payment failed",
        detail:
          order.payment.failureReason ??
          "The payment was declined. Generate a new link or contact the customer.",
      };
    case OrderStatus.EXPIRED:
      return {
        tone: "expired",
        label: "Payment link expired",
        detail:
          "The customer didn't complete checkout in time. Regenerate the link to try again.",
      };
    default:
      // A manual-capture order sitting on an AUTHORIZED hold is NOT
      // "awaiting payment" — the money is committed but not taken, and the
      // operator has to capture it. `capture` is null on every
      // automatic-capture order, so this returns null for both incumbent
      // brands and the original banner below is reached unchanged.
      return (
        describeCapture(order.payment.capture) ?? {
          tone: "pending",
          label: "Awaiting payment",
          detail: `Watching for ${order.customer.name}'s payment in real time.`,
        }
      );
  }
}

/**
 * Banner copy for the authorization lifecycle of a manual-capture order.
 * Returns null when there is nothing capture-specific to say, which
 * includes every automatic-capture order (`capture === null`).
 */
function describeCapture(
  capture: OrderPaymentCapture | null,
): FloaterDescriptor | null {
  if (!capture) return null;
  switch (capture.status) {
    case PaymentCaptureStatus.AUTHORIZED:
      return {
        tone: "pending",
        label: PaymentCaptureStatusLabel[PaymentCaptureStatus.AUTHORIZED],
        detail: capture.captureExpiresAt
          ? `The card is on hold and has not been charged. Capture by ${new Date(capture.captureExpiresAt).toLocaleString()} or the hold is released.`
          : "The card is on hold and has not been charged. Capture it when you confirm the booking.",
      };
    case PaymentCaptureStatus.CAPTURE_PENDING:
      return {
        tone: "pending",
        label: PaymentCaptureStatusLabel[PaymentCaptureStatus.CAPTURE_PENDING],
        detail: "Charging the authorized amount now.",
      };
    case PaymentCaptureStatus.CAPTURE_FAILED:
      return {
        tone: "failed",
        label: PaymentCaptureStatusLabel[PaymentCaptureStatus.CAPTURE_FAILED],
        detail:
          capture.lastError ??
          "The capture was rejected. The hold may still stand — retry or release it.",
      };
    case PaymentCaptureStatus.AUTHORIZATION_EXPIRED:
      return {
        tone: "expired",
        label:
          PaymentCaptureStatusLabel[
            PaymentCaptureStatus.AUTHORIZATION_EXPIRED
          ],
        detail:
          "The gateway released the hold. Generate a new link to charge the customer.",
      };
    case PaymentCaptureStatus.CANCELLED:
      return {
        tone: "expired",
        label: PaymentCaptureStatusLabel[PaymentCaptureStatus.CANCELLED],
        detail:
          capture.cancelReason ??
          "The hold was released. The customer was not charged.",
      };
    case PaymentCaptureStatus.PENDING_AUTHORIZATION:
      return {
        tone: "pending",
        label:
          PaymentCaptureStatusLabel[
            PaymentCaptureStatus.PENDING_AUTHORIZATION
          ],
        detail: "Watching for the customer's card authorization in real time.",
      };
    case PaymentCaptureStatus.CAPTURED:
    default:
      // CAPTURED lands the order on OrderStatus.PAID, which the caller's
      // switch has already answered before reaching here.
      return null;
  }
}

/**
 * Sticky live-status floater pinned to the top of the order detail
 * page. Reads the order's current status as the source of truth and
 * additionally listens to the SSE activity feed for ORDER_PAID /
 * ORDER_FAILED / ORDER_EXPIRED matching this order so the banner
 * flips the moment Stripe fires without waiting for a route refresh.
 */
export function PaymentStatusFloater({ order }: PaymentStatusFloaterProps) {
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
  }, [events, order.id, order.orderNumber]);

  const descriptor = override ?? describeOrder(order);
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
