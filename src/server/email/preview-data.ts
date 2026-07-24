import "server-only";

import { Currency, OrderStatus, RecordState } from "@/lib/constants/enums";
import { EmailBlockKey, SchedulingType } from "@/lib/constants/items";
import type { OrderDTO } from "@/types";

import { sortBlocks, type EmailBlockContext } from "@/server/email/blocks";
import type { UniversalOrderEmailProps } from "@/server/email/templates/universal-order-email";

interface BuildPaymentPreviewArgs {
  brandName: string;
  appUrl: string;
  supportEmail: string;
  supportPhone: string;
  cancellationPolicy?: string;
  cancellationPolicyVersion?: string;
}

/**
 * Pass 5h, preview seed for the admin template preview.
 *
 * Builds a synthetic universal-shape OrderDTO so the admin can preview
 * the template against a representative line item without needing real
 * order data. The sample uses a generic `service_visit` item type plus
 * a scheduling window so the SCHEDULING_WINDOW block lights up; tenants
 * who declare more attribute blocks on their own ItemTypes get a richer
 * preview when they hit the per-order email composer.
 */
function buildPreviewOrder(args: BuildPaymentPreviewArgs): OrderDTO {
  const start = new Date("2026-05-17T10:00:00Z");
  const end = new Date("2026-05-20T18:00:00Z");
  return {
    id: "preview-id",
    orgId: null,
    orderNumber: "ORD-260517-PREVW1",
    status: OrderStatus.PAID,
    state: RecordState.ACTIVE,
    customerId: null,
    customer: {
      name: "Jane Smith",
      email: "jane@example.com",
      phone: "+1 555 0100",
    },
    pricing: { amount: 245, currency: Currency.USD },
    payment: {
      status: OrderStatus.PAID,
      amountReceived: 245,
      paidAt: new Date("2026-05-17T15:42:00Z").toISOString(),
      receiptUrl: "https://pay.stripe.com/receipts/preview",
      paymentIntentId: null,
      paymentUrl: null,
      paymentSessionId: null,
      expiresAt: null,
      failureReason: null,
      confirmationEmailSentAt: null,
      initiatedAt: null,
      gateway: "STRIPE",
    },
    createdBy: {
      userId: "preview-creator",
      name: "Admin",
      email: "admin@example.com",
    },
    policy: {
      acceptedAt: new Date("2026-05-17T15:00:00Z").toISOString(),
      version: args.cancellationPolicyVersion ?? "v1",
      text: args.cancellationPolicy ?? "Standard cancellation policy.",
    },
    risk: { flagged: false },
    consent: { status: "NOT_REQUESTED" } as OrderDTO["consent"],
    dispute: null,
    refundedAmount: 0,
    notes: null,
    lineItems: [
      {
        itemId: null,
        itemTypeKey: "service_visit",
        name: "Premium service visit",
        description: null,
        quantity: 1,
        unitPrice: 245,
        total: 245,
        attributes: {},
        scheduling: null,
      },
    ],
    scheduling: {
      type: SchedulingType.FIXED_WINDOW,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
    },
    createdAt: new Date("2026-05-17T15:00:00Z").toISOString(),
    updatedAt: new Date("2026-05-17T15:42:00Z").toISOString(),
  };
}

function buildPreviewBlocks(): EmailBlockKey[] {
  return sortBlocks([
    EmailBlockKey.PAYMENT_SUMMARY,
    EmailBlockKey.LINE_ITEMS_TABLE,
    EmailBlockKey.SCHEDULING_WINDOW,
    EmailBlockKey.TOTALS,
    EmailBlockKey.PURCHASE_TERMS,
    EmailBlockKey.SUPPORT_SECTION,
  ]);
}

function buildPreviewContext(
  args: BuildPaymentPreviewArgs,
  variant: "confirmation" | "request",
): EmailBlockContext {
  return {
    order: buildPreviewOrder(args),
    branding: {
      brandName: args.brandName,
      supportEmail: args.supportEmail,
      supportPhone: args.supportPhone,
    },
    payment:
      variant === "confirmation"
        ? {
            amount: "$245.00",
            paidOn: "May 17, 2026 · 3:42 PM",
            receiptUrl: "https://pay.stripe.com/receipts/preview",
          }
        : null,
  };
}

export function buildPaymentPreviewProps(
  args: BuildPaymentPreviewArgs,
): UniversalOrderEmailProps {
  return {
    variant: "confirmation",
    blocks: buildPreviewBlocks(),
    ctx: buildPreviewContext(args, "confirmation"),
  };
}

export function buildPaymentRequestPreviewProps(
  args: BuildPaymentPreviewArgs,
): UniversalOrderEmailProps {
  return {
    variant: "request",
    blocks: buildPreviewBlocks(),
    ctx: buildPreviewContext(args, "request"),
    cta: {
      url: `${args.appUrl.replace(/\/$/, "")}/consent/preview-token`,
      label: "Review & Confirm Order",
      helperText:
        "You'll see a one-screen summary, confirm, then continue to secure payment.",
    },
    greeting: null,
    intro: null,
    note: null,
  };
}
