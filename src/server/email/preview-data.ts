import "server-only";

import { BookingType, PaymentTiming } from "@/lib/constants/enums";
import type { ProviderSnapshot } from "@/lib/constants/providers";
import type { EmailChargeBreakdown } from "@/server/email/components";

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
  termsAndConditions?: string;
  termsVersion?: string;
  bookingType?: BookingType;
}

/** Sample split breakdown so previews exercise the prepaid / due-at-counter
 *  rows. Prepaid $150, due-at-counter $350, total $500. */
const SAMPLE_BREAKDOWN: EmailChargeBreakdown = {
  lines: [
    { name: "Rental cost", amount: "$150.00", timing: PaymentTiming.PREPAID },
    {
      name: "Counter balance",
      amount: "$350.00",
      timing: PaymentTiming.DUE_AT_COUNTER,
    },
  ],
  prepaid: "$150.00",
  dueAtCounter: "$350.00",
  total: "$500.00",
};

const SAMPLE_TRIP = {
  pickupDate: "Sun, May 17 · 10:00 AM",
  dropoffDate: "Wed, May 20 · 6:00 PM",
  pickupLocation: "LAX Airport — Terminal 1",
  dropoffLocation: "San Diego Downtown",
};

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
    amount: "$150.00",
    paidOn: "May 17, 2026 · 3:42 PM",
    provider: args.provider,
    vehicle: { company: "Toyota", type: "Camry SE", imageUrl: null },
    trip: SAMPLE_TRIP,
    confirmationNumber: "SUPP-9F3K2218",
    chargeBreakdown: SAMPLE_BREAKDOWN,
    termsText:
      args.termsAndConditions ??
      "The prepaid amount is charged today to secure your reservation. The balance shown as due at counter is collected at pick-up.\nA valid driver's licence and the payment card used must be presented at pick-up.",
    termsVersion: args.termsVersion ?? "v1",
    acknowledgeUrl: `${args.appUrl.replace(/\/$/, "")}/acknowledge/preview-token`,
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
    amount: "$150.00",
    dueBy: "May 19, 2026 · 6:00 PM",
    provider: args.provider,
    vehicle: { company: "Toyota", type: "Camry SE", imageUrl: null },
    trip: SAMPLE_TRIP,
    chargeBreakdown: SAMPLE_BREAKDOWN,
    paymentUrl:
      "https://checkout.stripe.com/c/pay/cs_test_preview_link_only",
    greeting: null,
    intro: null,
    note: null,
    cancellationPolicy: args.cancellationPolicy,
    cancellationPolicyVersion: args.cancellationPolicyVersion,
    termsText:
      args.termsAndConditions ??
      "The prepaid amount is charged today to secure your reservation. The balance shown as due at counter is collected at pick-up.\nA valid driver's licence and the payment card used must be presented at pick-up.",
    termsVersion: args.termsVersion ?? "v1",
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
