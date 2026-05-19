import "server-only";

import { BookingType } from "@/lib/constants/enums";
import type { ProviderSnapshot } from "@/lib/constants/providers";

import type { PaymentConfirmationEmailProps } from "@/server/email/templates/payment-confirmation";
import type { PaymentRequestEmailProps } from "@/server/email/templates/payment-request";

interface BuildPaymentPreviewArgs {
  brandName: string;
  appUrl: string;
  supportEmail: string;
  supportPhone: string;
  provider: ProviderSnapshot;
  cancellationPolicy?: string;
  cancellationPolicyVersion?: string;
  bookingType?: BookingType;
}

/**
 * Deterministic sample data for the payment-confirmation template. Used
 * by the admin email preview page so non-prod env can render the
 * receipt without hitting Stripe / Mongo.
 */
export function buildPaymentPreviewProps(
  args: BuildPaymentPreviewArgs,
): PaymentConfirmationEmailProps {
  const bookingType = args.bookingType ?? BookingType.NEW_BOOKING;
  return {
    brandName: args.brandName,
    appUrl: args.appUrl,
    supportEmail: args.supportEmail,
    supportPhone: args.supportPhone,
    customerName: "Jane Smith",
    orderNumber: "ORD-260517-PREVW1",
    bookingType,
    amount: "$245.00",
    paidOn: "May 17, 2026 · 3:42 PM",
    provider: args.provider,
    vehicle: { company: "Toyota", type: "Camry SE", imageUrl: null },
    trip: {
      pickupDate: "Sun, May 17 · 10:00 AM",
      dropoffDate: "Wed, May 20 · 6:00 PM",
    },
    receiptUrl: "https://pay.stripe.com/receipts/preview",
    cancellationPolicy: args.cancellationPolicy,
    cancellationPolicyVersion: args.cancellationPolicyVersion,
  };
}

/**
 * Deterministic sample data for the payment-request template. Lets the
 * admin preview the "please pay" email shown by the composer without
 * having to create a real order.
 */
export function buildPaymentRequestPreviewProps(
  args: BuildPaymentPreviewArgs,
): PaymentRequestEmailProps {
  const bookingType = args.bookingType ?? BookingType.NEW_BOOKING;
  return {
    brandName: args.brandName,
    appUrl: args.appUrl,
    supportEmail: args.supportEmail,
    supportPhone: args.supportPhone,
    customerName: "Jane Smith",
    orderNumber: "ORD-260517-PREVW1",
    bookingType,
    amount: "$245.00",
    dueBy: "May 19, 2026 · 6:00 PM",
    provider: args.provider,
    vehicle: { company: "Toyota", type: "Camry SE", imageUrl: null },
    trip: {
      pickupDate: "Sun, May 17 · 10:00 AM",
      dropoffDate: "Wed, May 20 · 6:00 PM",
    },
    paymentUrl:
      "https://checkout.stripe.com/c/pay/cs_test_preview_link_only",
    greeting: null,
    intro: null,
    note: null,
    cancellationPolicy: args.cancellationPolicy,
    cancellationPolicyVersion: args.cancellationPolicyVersion,
    primaryCta: {
      url: `${args.appUrl.replace(/\/$/, "")}/consent/preview-token`,
      label: "Review & Confirm Booking",
      helperText:
        "You'll see a one-screen summary, confirm, then continue to secure payment.",
    },
    gatewayLabel: "Stripe",
    consentMailto: "mailto:support@example.com?subject=Order%20acknowledgement",
    consentRequired: false,
  };
}
