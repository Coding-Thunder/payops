"use client";

import {
  CheckCircle2Icon,
  CircleIcon,
  ClockIcon,
  XCircleIcon,
} from "lucide-react";

import {
  ConsentStatus,
  OrderStatus,
  PaymentCaptureStatus,
} from "@/lib/constants/enums";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OrderDTO, OrderPaymentCapture } from "@/types";

interface OrderStatusTimelineProps {
  order: OrderDTO;
}

interface Step {
  key: string;
  label: string;
  /** Pulled from order fields; null when the step hasn't fired yet. */
  when: string | null;
  state: "done" | "active" | "pending" | "skipped" | "failed";
  helperText?: string;
}

/**
 * Five-step horizontal-on-desktop / vertical-on-mobile timeline of the
 * payment lifecycle — six on a manual-capture order, which inserts
 * "Authorized" between consent and payment. Reads exclusively from the
 * order DTO — no extra fetches — so it renders instantly and stays in
 * lockstep with the polled / SSE-invalidated cache.
 *
 * Step rules:
 *   Created:           always done at order.createdAt
 *   Email sent:        consent.requestedAt (consent record is created
 *                      atomically with the payment-request email send)
 *   Consent received:  consent.receivedAt (skipped when status is
 *                      NOT_REQUESTED — applies to admin-skipped flows)
 *   Authorized:        payment.capture.authorizedAt — ONLY present when
 *                      payment.capture is non-null, i.e. never for the
 *                      automatic-capture orders both incumbent brands run
 *   Paid:              payment.paidAt (failed / expired surfaces a
 *                      destructive marker instead of a pending one)
 *   Confirmation sent: payment.confirmationEmailSentAt
 */
export function OrderStatusTimeline({ order }: OrderStatusTimelineProps) {
  const steps = buildSteps(order);
  return (
    <ol
      className={
        // Written as two whole literals rather than a composed string so
        // the five-step class attribute is byte-for-byte what it is today.
        steps.length === 6
          ? "grid gap-3 md:grid-cols-6 md:gap-1.5"
          : "grid gap-3 md:grid-cols-5 md:gap-1.5"
      }
    >
      {steps.map((step, i) => (
        <li
          key={step.key}
          className="relative flex items-start gap-3 md:flex-col md:items-stretch md:gap-2"
        >
          {/* Connector — between steps */}
          {i < steps.length - 1 ? (
            <span
              aria-hidden
              className={cn(
                "absolute md:top-3 md:left-[calc(50%+18px)] md:right-[calc(-50%+18px)] md:h-px",
                "left-3 top-7 h-[calc(100%-12px)] w-px md:bottom-auto",
                step.state === "done" || step.state === "active"
                  ? "bg-foreground"
                  : "bg-border",
              )}
            />
          ) : null}

          <span
            className={cn(
              "relative z-10 inline-flex size-7 shrink-0 items-center justify-center rounded-full md:mx-auto",
              step.state === "done"
                ? "bg-foreground text-background"
                : step.state === "active"
                  ? "bg-amber-500 text-white"
                  : step.state === "failed"
                    ? "bg-destructive text-destructive-foreground"
                    : "border border-border bg-background text-muted-foreground",
            )}
          >
            <StepIcon state={step.state} />
          </span>

          <div className="min-w-0 md:text-center">
            <p
              className={cn(
                "text-[12.5px] font-medium leading-tight",
                step.state === "done"
                  ? "text-foreground"
                  : step.state === "active"
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              {step.label}
            </p>
            {step.when ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {formatDateTime(step.when)}
              </p>
            ) : step.helperText ? (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {step.helperText}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepIcon({ state }: { state: Step["state"] }) {
  switch (state) {
    case "done":
      return <CheckCircle2Icon className="size-3.5" aria-hidden />;
    case "active":
      return <ClockIcon className="size-3.5" aria-hidden />;
    case "failed":
      return <XCircleIcon className="size-3.5" aria-hidden />;
    case "skipped":
    case "pending":
    default:
      return <CircleIcon className="size-3.5" aria-hidden />;
  }
}

function buildSteps(order: OrderDTO): Step[] {
  const created: Step = {
    key: "created",
    label: "Created",
    when: order.createdAt,
    state: "done",
  };

  const consentRequestedAt = order.consent?.requestedAt ?? null;
  const emailSent: Step = consentRequestedAt
    ? {
        key: "email-sent",
        label: "Email sent",
        when: consentRequestedAt,
        state: "done",
      }
    : {
        key: "email-sent",
        label: "Email sent",
        when: null,
        state: "active",
        helperText: "Awaiting send",
      };

  const consentStatus = order.consent?.status;
  const consentReceivedAt = order.consent?.receivedAt ?? null;
  let consentReceived: Step;
  if (consentStatus === ConsentStatus.NOT_REQUESTED) {
    consentReceived = {
      key: "consent",
      label: "Consent",
      when: null,
      state: "skipped",
      helperText: "Not requested",
    };
  } else if (consentReceivedAt) {
    consentReceived = {
      key: "consent",
      label: "Consent received",
      when: consentReceivedAt,
      state: "done",
    };
  } else if (emailSent.state === "done") {
    consentReceived = {
      key: "consent",
      label: "Consent received",
      when: null,
      state: "active",
      helperText: "Awaiting customer",
    };
  } else {
    consentReceived = {
      key: "consent",
      label: "Consent received",
      when: null,
      state: "pending",
    };
  }

  // Manual capture only. Null — and therefore absent from the timeline —
  // for every automatic-capture order, which is every order both incumbent
  // brands have ever created.
  const capture = order.payment.capture;
  const authorized: Step | null = capture
    ? buildAuthorizedStep(capture, emailSent, consentReceived)
    : null;

  let paid: Step;
  if (order.status === OrderStatus.PAID && order.payment.paidAt) {
    paid = {
      key: "paid",
      label: "Paid",
      when: order.payment.paidAt,
      state: "done",
    };
  } else if (order.status === OrderStatus.FAILED) {
    paid = {
      key: "paid",
      label: "Payment failed",
      when: null,
      state: "failed",
      helperText: order.payment.failureReason ?? undefined,
    };
  } else if (order.status === OrderStatus.EXPIRED) {
    paid = {
      key: "paid",
      label: "Payment expired",
      when: null,
      state: "failed",
    };
  } else if (
    consentReceived.state === "done" ||
    emailSent.state === "done"
  ) {
    paid = {
      key: "paid",
      label: "Paid",
      when: null,
      state: "active",
      helperText: "Awaiting confirmation",
    };
  } else {
    paid = {
      key: "paid",
      label: "Paid",
      when: null,
      state: "pending",
    };
  }

  const confirmedAt = order.payment.confirmationEmailSentAt ?? null;
  let confirmation: Step;
  if (confirmedAt) {
    confirmation = {
      key: "confirmation",
      label: "Confirmation sent",
      when: confirmedAt,
      state: "done",
    };
  } else if (paid.state === "done") {
    confirmation = {
      key: "confirmation",
      label: "Confirmation sent",
      when: null,
      state: "active",
      helperText: "Sending receipt",
    };
  } else if (paid.state === "failed") {
    confirmation = {
      key: "confirmation",
      label: "Confirmation",
      when: null,
      state: "skipped",
      helperText: "Not applicable",
    };
  } else {
    confirmation = {
      key: "confirmation",
      label: "Confirmation sent",
      when: null,
      state: "pending",
    };
  }

  // The automatic-capture branch returns the identical five-element array
  // it has always returned, in the identical order.
  return authorized
    ? [created, emailSent, consentReceived, authorized, paid, confirmation]
    : [created, emailSent, consentReceived, paid, confirmation];
}

/**
 * The "money is on hold" step, shown only on manual-capture orders.
 *
 * Under manual capture the customer authorizes at checkout and the card is
 * only charged when an operator confirms the booking, so "Paid" alone hides
 * a state the operator has to act on. `AUTHORIZED` therefore reads as done
 * — the hold really is in place — while the release / expiry outcomes are
 * terminal states that never become "Paid".
 */
function buildAuthorizedStep(
  capture: OrderPaymentCapture,
  emailSent: Step,
  consentReceived: Step,
): Step {
  const key = "authorized";
  switch (capture.status) {
    case PaymentCaptureStatus.CANCELLED:
      return {
        key,
        label: "Authorization released",
        when: capture.cancelledAt,
        state: "skipped",
        helperText: capture.cancelReason ?? "Hold released",
      };
    case PaymentCaptureStatus.AUTHORIZATION_EXPIRED:
      return {
        key,
        label: "Authorization expired",
        when: null,
        state: "failed",
        helperText: "The gateway released the hold",
      };
    case PaymentCaptureStatus.CAPTURE_FAILED:
      // `when` stays null so the reason renders in place of a timestamp —
      // the operator needs the gateway's message, not the authorize time.
      return {
        key,
        label: "Capture failed",
        when: null,
        state: "failed",
        helperText: capture.lastError ?? "The hold may still stand",
      };
    case PaymentCaptureStatus.AUTHORIZED:
    case PaymentCaptureStatus.CAPTURE_PENDING:
    case PaymentCaptureStatus.CAPTURED:
      return {
        key,
        label: "Authorized",
        when: capture.authorizedAt,
        state: "done",
        helperText: capture.authorizedAt ? undefined : "Hold placed",
      };
    case PaymentCaptureStatus.PENDING_AUTHORIZATION:
    default:
      return emailSent.state === "done" || consentReceived.state === "done"
        ? {
            key,
            label: "Authorized",
            when: null,
            state: "active",
            helperText: "Awaiting authorization",
          }
        : { key, label: "Authorized", when: null, state: "pending" };
  }
}
