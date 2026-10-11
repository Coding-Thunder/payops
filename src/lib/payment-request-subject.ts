import { flightMoneyWording } from "@/lib/charges";
import { type BookingType, ServiceType } from "@/lib/constants/enums";
import {
  type FlightItineraryInputLike,
  hasFlightItinerary,
} from "@/lib/flight-itinerary";
import { serviceNoun, serviceTypeOf } from "@/lib/service-summary";

/** What the default subject is built from — an order DTO satisfies it. */
export interface PaymentRequestSubjectSource {
  orderNumber: string;
  serviceType?: ServiceType | null;
  bookingType?: BookingType | null;
  provider?: { name: string } | null;
  flight?: FlightItineraryInputLike | null;
  charges?: ReadonlyArray<{ name?: string | null }> | null;
}

/**
 * The payment-request email's default subject — ONE builder for the
 * composer, which pre-fills its subject field with it, and the server,
 * which falls back to it when the subject is left blank. Two copies of
 * this string had already drifted apart on their fallback; one copy cannot.
 *
 * An itinerary flight's payment link collects ONE charge, the one its
 * operator named, and the subject names that charge: "Complete your Rental
 * Cost payment • ORD-…". Never the airline's name — the flight's provider,
 * which the subject used to lead with although the airline is paid none of
 * this money. A flight whose charge carries no name (one never named)
 * reads "Complete your flight payment • ORD-…".
 *
 * Everything else — every car rental, every hotel, every flight created
 * before itineraries — keeps exactly the subject it has always had: the
 * provider's name, else `fallbackName` (the brand on the server, the
 * service noun in the composer — each caller's historic fallback).
 *
 * Pure and dependency-light: imported by a client component and the email
 * service alike.
 */
export function defaultPaymentRequestSubject(
  order: PaymentRequestSubjectSource,
  fallbackName: string,
): string {
  const service = { serviceType: order.serviceType };
  if (
    serviceTypeOf(service) === ServiceType.FLIGHT &&
    hasFlightItinerary(order.flight)
  ) {
    const { chargeName } = flightMoneyWording(
      order.flight,
      order.bookingType,
      order.charges,
    );
    return `Complete your ${chargeName || serviceNoun(service)} payment • ${order.orderNumber}`;
  }
  const providerName = order.provider?.name ?? fallbackName;
  return `Complete your ${providerName} payment • ${order.orderNumber}`;
}
