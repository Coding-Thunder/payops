"use client";

import {
  CheckCircle2Icon,
  CircleIcon,
  ClockIcon,
  XCircleIcon,
} from "lucide-react";

import { ConsentStatus, OrderStatus } from "@/lib/constants/enums";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OrderDTO } from "@/types";

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
 * payment lifecycle. Reads exclusively from the order DTO, no extra
 * fetches, so it renders instantly and stays in lockstep with the
 * polled / SSE-invalidated cache.
 *
 * Step rules:
 *   Created:           always done at order.createdAt
 *   Email sent:        consent.requestedAt (consent record is created
 *                      atomically with the payment-request email send)
 *   Consent received:  consent.receivedAt (skipped when status is
 *                      NOT_REQUESTED, applies to admin-skipped flows)
 *   Paid:              payment.paidAt (failed / expired surfaces a
 *                      destructive marker instead of a pending one)
 *   Confirmation sent: payment.confirmationEmailSentAt
 */
export function OrderStatusTimeline({ order }: OrderStatusTimelineProps) {
  const steps = buildSteps(order);
  return (
    <ol className="grid gap-3 md:grid-cols-5 md:gap-1.5">
      {steps.map((step, i) => (
        <li
          key={step.key}
          className="relative flex items-start gap-3 md:flex-col md:items-stretch md:gap-2"
        >
          {/* Connector, between steps */}
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
      helperText: "Awaiting Stripe",
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

  return [created, emailSent, consentReceived, paid, confirmation];
}
