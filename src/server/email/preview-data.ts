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
import { formatEmailDay } from "@/server/email/format";
import type {
  EmailChargeBreakdown,
  EmailFlightAmounts,
} from "@/server/email/components";

import type { PaymentAuthorizedEmailProps } from "@/server/email/templates/payment-authorized";
import type { PaymentConfirmationEmailProps } from "@/server/email/templates/payment-confirmation";
import type { PaymentRequestEmailProps } from "@/server/email/templates/payment-request";

/**
 * The Terms & cancellation policy a preview shows. Always the output of
 * `resolveServiceTerms` for the previewed organization and the previewed
 * service — there is no sample or fallback T&C here, so a preview can only
 * ever show the terms a real order of that service would freeze.
 */
export interface PreviewTerms {
  termsAndConditions: string;
  termsVersion: string;
  cancellationPolicy: string;
  cancellationPolicyVersion: string;
}

interface BuildPaymentPreviewArgs {
  brandName: string;
  appUrl: string;
  supportEmail: string;
  supportPhone: string;
  provider: ProviderSnapshot;
  bookingType?: BookingType;
  /** Which service's sample booking to show. Required: a preview never
   *  guesses its service. */
  serviceType: ServiceType;
  /** That service's terms, from the canonical resolver. */
  terms: PreviewTerms;
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

/** The hotel sample's split: a prepaid room charge, the balance settled at
 *  the property — no rental vocabulary. */
const SAMPLE_HOTEL_BREAKDOWN: EmailChargeBreakdown = {
  lines: [
    { name: "Room charge", amount: "$150.00", timing: PaymentTiming.PREPAID },
    {
      name: "Balance at the property",
      amount: "$350.00",
      timing: PaymentTiming.DUE_AT_COUNTER,
    },
  ],
  prepaid: "$150.00",
  dueAtCounter: "$350.00",
  total: "$500.00",
};

/** Sample HOTEL stay: three nights, one room, two adults. */
const SAMPLE_HOTEL = {
  hotelId: null,
  destination: "Lisbon, Portugal",
  propertyName: "Harbour View Hotel",
  checkInDate: "2026-10-16T00:00:00.000Z",
  checkOutDate: "2026-10-19T00:00:00.000Z",
  rooms: 1,
  guests: { adults: 2, children: 0 },
  roomPreference: null,
  guestNotes: null,
  confirmationCode: null,
};

/**
 * The sample booking for the previewed service, in the shape real emails
 * use for that service (see email.service.tsx): the car rental the previews
 * have always shown, the sample flight with its itinerary and money split,
 * or the sample hotel stay.
 */
function serviceSampleFields(serviceType: ServiceType) {
  switch (serviceType) {
    case ServiceType.FLIGHT:
      return {
        amount: SAMPLE_FLIGHT_AMOUNTS.serviceCharge,
        serviceType: ServiceType.FLIGHT,
        vehicle: null,
        trip: null,
        serviceRows: serviceDetailRows(
          { serviceType: ServiceType.FLIGHT, flight: SAMPLE_FLIGHT },
          formatEmailDay,
        ),
        flightItinerary: buildFlightItinerary(SAMPLE_FLIGHT),
        flightAmounts: SAMPLE_FLIGHT_AMOUNTS,
      };
    case ServiceType.HOTEL:
      return {
        serviceType: ServiceType.HOTEL,
        vehicle: null,
        trip: null,
        chargeBreakdown: SAMPLE_HOTEL_BREAKDOWN,
        serviceRows: serviceDetailRows(
          { serviceType: ServiceType.HOTEL, hotel: SAMPLE_HOTEL },
          formatEmailDay,
        ),
      };
    case ServiceType.CAR_RENTAL:
    default:
      return { serviceType: ServiceType.CAR_RENTAL };
  }
}

/** The previewed service's own terms and policy — never a sample text. */
function termsFields(terms: PreviewTerms) {
  return {
    termsText: terms.termsAndConditions,
    termsVersion: terms.termsVersion,
    cancellationPolicy: terms.cancellationPolicy,
    cancellationPolicyVersion: terms.cancellationPolicyVersion,
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
    ...termsFields(args.terms),
    acknowledgeUrl: `${args.appUrl.replace(/\/$/, "")}/acknowledge/preview-token`,
    receiptUrl: "https://pay.stripe.com/receipts/preview",
  };
  return { ...props, ...serviceSampleFields(args.serviceType) };
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
    ...termsFields(args.terms),
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
  return { ...props, ...serviceSampleFields(args.serviceType) };
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
    ...termsFields(args.terms),
    acknowledgeUrl: `${args.appUrl.replace(/\/$/, "")}/acknowledge/preview-token`,
    gatewayLabel: "Stripe",
  };
  return { ...props, ...serviceSampleFields(args.serviceType) };
}
