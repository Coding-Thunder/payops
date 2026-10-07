import "server-only";

import {
  BookingType,
  CabinClass,
  FlightTripType,
  PaymentTiming,
  ServiceType,
} from "@/lib/constants/enums";
import { flightMoneyWording } from "@/lib/charges";
import type { ProviderSnapshot } from "@/lib/constants/providers";
import { buildFlightItinerary } from "@/lib/flight-itinerary";
import { serviceDetailRows } from "@/lib/service-summary";
import {
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import type {
  EmailChargeBreakdown,
  EmailFlightAmounts,
} from "@/server/email/components";

import type { PaymentAuthorizedEmailProps } from "@/server/email/templates/payment-authorized";
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
  /** FLIGHT swaps in the sample flight; anything else renders the sample
   *  car rental the previews have always shown. */
  serviceType?: ServiceType;
  /** The flight terms and policy the flight sample shows — the selected
   *  organization's own, or its default. Absent: the built-in flight text.
   *  Never the car rental text above. */
  flightLegal?: {
    termsAndConditions: string;
    termsVersion: string;
    cancellationPolicy: string;
    cancellationPolicyVersion: string;
  };
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
 * Sample FLIGHT itinerary: a round trip whose outbound connects through
 * Varanasi (with a layover note) and whose return lands after midnight, so
 * every branch of the itinerary block renders.
 */
const SAMPLE_FLIGHT = {
  tripType: FlightTripType.ROUND_TRIP,
  outbound: {
    segments: [
      {
        origin: "Delhi (DEL)",
        destination: "Varanasi (VNS)",
        departure: { date: "2026-10-10", time: "10:30" },
        arrival: { date: "2026-10-10", time: "12:00" },
        airline: "Air India",
        flightNumber: "AI 405",
        details: "Terminal 3 · 15 kg checked baggage",
      },
      {
        origin: "Varanasi (VNS)",
        destination: "Mumbai (BOM)",
        departure: { date: "2026-10-10", time: "14:30" },
        arrival: { date: "2026-10-10", time: "16:45" },
        airline: "IndiGo",
        flightNumber: "6E 2141",
        details: null,
      },
    ],
    connections: [
      {
        layover: {
          location: null,
          durationMinutesOverride: null,
          notes: "Collect your bags and check in again with IndiGo.",
        },
      },
    ],
  },
  return: {
    segments: [
      {
        origin: "Mumbai (BOM)",
        destination: "Delhi (DEL)",
        departure: { date: "2026-10-17", time: "22:15" },
        arrival: { date: "2026-10-18", time: "00:30" },
        airline: "Air India",
        flightNumber: "AI 806",
        details: null,
      },
    ],
    connections: [],
  },
  cabinClass: CabinClass.ECONOMY,
  passengers: { adults: 2, children: 1, infants: 0 },
  pnr: "QX7T2L",
};

/** Airline charge $1,240 (shown, never charged) + service charge $95. */
const SAMPLE_FLIGHT_AMOUNTS: EmailFlightAmounts = {
  lines: [
    { name: "Service charge", amount: "$95.00", timing: PaymentTiming.PREPAID },
  ],
  airlineFare: "$1,240.00",
  serviceCharge: "$95.00",
  dueLater: null,
  bookingTotal: "$1,335.00",
  hasItinerary: true,
  // An itinerary flight, so the service-charge copy (true).
  serviceChargeModel: flightMoneyWording(SAMPLE_FLIGHT, BookingType.NEW_BOOKING).serviceChargeModel,
};

/**
 * What the sample flight puts in place of the sample car. Its legal text is
 * the built-in flight terms and policy: the args carry the deployment's
 * rental text, which a flight order never receives.
 */
function flightPreviewFields(args: BuildPaymentPreviewArgs) {
  return {
    amount: SAMPLE_FLIGHT_AMOUNTS.serviceCharge,
    serviceType: ServiceType.FLIGHT,
    vehicle: null,
    trip: null,
    serviceRows: serviceDetailRows({
      serviceType: ServiceType.FLIGHT,
      flight: SAMPLE_FLIGHT,
    }),
    flightItinerary: buildFlightItinerary(SAMPLE_FLIGHT),
    flightAmounts: SAMPLE_FLIGHT_AMOUNTS,
    termsText:
      args.flightLegal?.termsAndConditions ?? DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
    termsVersion: args.flightLegal?.termsVersion ?? DEFAULT_FLIGHT_LEGAL_VERSION,
    cancellationPolicy:
      args.flightLegal?.cancellationPolicy ?? DEFAULT_FLIGHT_CANCELLATION_POLICY,
    cancellationPolicyVersion:
      args.flightLegal?.cancellationPolicyVersion ?? DEFAULT_FLIGHT_LEGAL_VERSION,
  };
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
  const props: PaymentConfirmationEmailProps = {
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
  return args.serviceType === ServiceType.FLIGHT
    ? { ...props, ...flightPreviewFields(args) }
    : props;
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
  const props: PaymentRequestEmailProps = {
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
  return args.serviceType === ServiceType.FLIGHT
    ? { ...props, ...flightPreviewFields(args) }
    : props;
}

/**
 * Deterministic sample data for the payment-authorized (manual-capture
 * hold) template, which had no preview of its own — the template a flight
 * organization on manual capture sends first.
 */
export function buildPaymentAuthorizedPreviewProps(
  args: BuildPaymentPreviewArgs,
): PaymentAuthorizedEmailProps {
  const bookingType = args.bookingType ?? BookingType.NEW_BOOKING;
  const props: PaymentAuthorizedEmailProps = {
    brandName: args.brandName,
    appUrl: args.appUrl,
    supportEmail: args.supportEmail,
    supportPhone: args.supportPhone,
    customerName: "Jane Smith",
    orderNumber: "ORD-260517-PREVW1",
    bookingType,
    amount: "$150.00",
    authorizedOn: "17 May 2026 • 15:42 UTC",
    holdExpiresOn: "24 May 2026 • 15:42 UTC",
    provider: args.provider,
    vehicle: { company: "Toyota", type: "Camry SE", imageUrl: null },
    trip: SAMPLE_TRIP,
    chargeBreakdown: SAMPLE_BREAKDOWN,
    termsText:
      args.termsAndConditions ??
      "The prepaid amount is charged today to secure your reservation. The balance shown as due at counter is collected at pick-up.\nA valid driver's licence and the payment card used must be presented at pick-up.",
    termsVersion: args.termsVersion ?? "v1",
    acknowledgeUrl: `${args.appUrl.replace(/\/$/, "")}/acknowledge/preview-token`,
    cancellationPolicy: args.cancellationPolicy,
    cancellationPolicyVersion: args.cancellationPolicyVersion,
    gatewayLabel: "Stripe",
  };
  return args.serviceType === ServiceType.FLIGHT
    ? { ...props, ...flightPreviewFields(args) }
    : props;
}
