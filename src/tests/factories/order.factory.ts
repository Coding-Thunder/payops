import { Types } from "mongoose";

import {
  BookingType,
  ConsentStatus,
  Currency,
  OrderStatus,
  PaymentTiming,
  RecordState,
  FlightTripType,
  ServiceType,
} from "@/lib/constants/enums";
import {
  buildProviderSnapshot,
  ProviderId,
} from "@/lib/constants/providers";
import { Order, type OrderDoc, type OrderDocument } from "@/server/db/models";

/**
 * Order factory. `buildOrder()` returns a pure object suitable for unit
 * tests; `createOrder()` persists it. The shape mirrors `OrderDoc` so
 * callers can override any nested field with a partial.
 *
 * Trip dates are anchored to "tomorrow" / "two days from now" so they
 * pass the model's pre-validate hook (`dropoff > pickup`) without being
 * fragile to time-of-day.
 */

interface CreatorSeed {
  userId?: Types.ObjectId | string;
  name?: string;
  email?: string;
}

export interface OrderSeed
  extends Partial<Omit<OrderDoc, "createdBy" | "payment">> {
  createdBy?: CreatorSeed;
  /**
   * Shallow-partial on purpose. `Partial<OrderDoc>` only makes `payment`
   * itself optional, so supplying it demanded all twelve sub-fields — while
   * the builder below already defaults every one it is not given. A test
   * that cares about the session id had to restate the whole payment block
   * to say so.
   */
  payment?: Partial<OrderDoc["payment"]>;
}

let counter = 0;
function nextSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function buildOrder(seed: OrderSeed = {}): OrderDoc & { _id: Types.ObjectId } {
  const suffix = nextSuffix();
  const now = new Date();
  const pickup = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dropoff = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  return {
    _id: new Types.ObjectId(),
    orderNumber: seed.orderNumber ?? `TST-${suffix.toUpperCase()}`.slice(0, 32),
    bookingType: seed.bookingType ?? BookingType.NEW_BOOKING,
    status: seed.status ?? OrderStatus.PAYMENT_PENDING,
    state: seed.state ?? RecordState.ACTIVE,
    provider: seed.provider ?? buildProviderSnapshot(ProviderId.BUDGET),
    customer: {
      name: seed.customer?.name ?? "Test Customer",
      email: (seed.customer?.email ?? "customer@payops.test").toLowerCase(),
      phone: seed.customer?.phone ?? "+15555550100",
    },
    // Default is a CAR_RENTAL, exactly as every existing test expects.
    // Pass `serviceType: FLIGHT` (and optionally `flight`) to build a flight
    // order instead; the car payload is then omitted, which is what the
    // model requires.
    serviceType: seed.serviceType ?? ServiceType.CAR_RENTAL,
    vehicle:
      seed.serviceType === ServiceType.FLIGHT
        ? null
        : {
            company: seed.vehicle?.company ?? "Toyota",
            type: seed.vehicle?.type ?? "Corolla",
          },
    trip:
      seed.serviceType === ServiceType.FLIGHT
        ? null
        : {
            pickupDate: seed.trip?.pickupDate ?? pickup,
            dropoffDate: seed.trip?.dropoffDate ?? dropoff,
            pickupLocation:
              seed.trip?.pickupLocation ?? "LAX Airport — Terminal 1",
            dropoffLocation:
              seed.trip?.dropoffLocation ?? "San Diego Downtown",
          },
    flight:
      seed.serviceType === ServiceType.FLIGHT
        ? {
            tripType: seed.flight?.tripType ?? FlightTripType.ONE_WAY,
            airline: seed.flight?.airline ?? "British Airways",
            flightNumber: seed.flight?.flightNumber ?? "BA117",
            origin: seed.flight?.origin ?? "London Heathrow",
            destination: seed.flight?.destination ?? "New York JFK",
            departureDate: seed.flight?.departureDate ?? pickup,
            departureTimePreference:
              seed.flight?.departureTimePreference ?? null,
            arrivalDate: seed.flight?.arrivalDate ?? null,
            returnDate: seed.flight?.returnDate ?? null,
            returnTimePreference: seed.flight?.returnTimePreference ?? null,
            cabinClass: seed.flight?.cabinClass ?? "ECONOMY",
            passengers: seed.flight?.passengers ?? {
              adults: 1,
              children: 0,
              infants: 0,
            },
            passengerNotes: seed.flight?.passengerNotes ?? null,
            pnr: seed.flight?.pnr ?? null,
          }
        : null,
    pricing: {
      amount: seed.pricing?.amount ?? 199.5,
      currency: (seed.pricing?.currency ?? Currency.USD) as Currency,
    },
    charges: seed.charges ?? [
      {
        name: "Rental cost",
        amount: seed.pricing?.amount ?? 199.5,
        timing: PaymentTiming.PREPAID,
      },
    ],
    confirmationNumber: seed.confirmationNumber ?? null,
    terms: seed.terms ?? { text: "Standard test terms.", version: "v1" },
    termsAcknowledgement: seed.termsAcknowledgement ?? null,
    payment: {
      // Stamped at LINK_GENERATED in production, never by the webhook — and
      // `applyCheckoutPaid` reads it to label the dedupe row, so a fixture
      // that leaves it null makes a PayPal settlement record itself as
      // Stripe. Seedable so a non-Stripe order can be built truthfully.
      gateway: seed.payment?.gateway ?? null,
      stripeSessionId: seed.payment?.stripeSessionId ?? null,
      paymentIntentId: seed.payment?.paymentIntentId ?? null,
      checkoutUrl: seed.payment?.checkoutUrl ?? null,
      status: seed.payment?.status ?? (seed.status ?? OrderStatus.PAYMENT_PENDING),
      paidAt: seed.payment?.paidAt ?? null,
      expiresAt:
        seed.payment?.expiresAt ?? new Date(now.getTime() + 24 * 60 * 60 * 1000),
      amountReceived: seed.payment?.amountReceived ?? null,
      receiptUrl: seed.payment?.receiptUrl ?? null,
      failureReason: seed.payment?.failureReason ?? null,
      confirmationEmailSentAt: seed.payment?.confirmationEmailSentAt ?? null,
      processedWebhookEventIds: seed.payment?.processedWebhookEventIds ?? [],
    },
    createdBy: {
      userId:
        toObjectId(seed.createdBy?.userId) ?? new Types.ObjectId(),
      name: seed.createdBy?.name ?? "Test Creator",
      email: (seed.createdBy?.email ?? "creator@payops.test").toLowerCase(),
    },
    policy: {
      acceptedAt: seed.policy?.acceptedAt ?? now,
      version: seed.policy?.version ?? "v1",
      text: seed.policy?.text ?? "Standard test policy snapshot.",
    },
    risk: {
      flagged: seed.risk?.flagged ?? false,
      flaggedNote: seed.risk?.flaggedNote ?? null,
      flaggedAt: seed.risk?.flaggedAt ?? null,
      flaggedBy: seed.risk?.flaggedBy ?? null,
    },
    consent: {
      status: seed.consent?.status ?? ConsentStatus.NOT_REQUESTED,
      currentConsentId: seed.consent?.currentConsentId ?? null,
      requestedAt: seed.consent?.requestedAt ?? null,
      receivedAt: seed.consent?.receivedAt ?? null,
      verifiedAt: seed.consent?.verifiedAt ?? null,
      method: seed.consent?.method ?? null,
    },
    notes: seed.notes ?? null,
    createdAt: seed.createdAt ?? now,
    updatedAt: seed.updatedAt ?? now,
  };
}

function toObjectId(
  value: Types.ObjectId | string | undefined,
): Types.ObjectId | null {
  if (!value) return null;
  if (value instanceof Types.ObjectId) return value;
  if (typeof value === "string" && Types.ObjectId.isValid(value)) {
    return new Types.ObjectId(value);
  }
  return null;
}

export async function createOrder(seed: OrderSeed = {}): Promise<OrderDocument> {
  const data = buildOrder(seed);
  return (await Order.create({
    _id: data._id,
    orderNumber: data.orderNumber,
    bookingType: data.bookingType,
    status: data.status,
    state: data.state,
    provider: data.provider,
    customer: data.customer,
    serviceType: data.serviceType,
    vehicle: data.vehicle,
    trip: data.trip,
    flight: data.flight,
    pricing: data.pricing,
    charges: data.charges,
    confirmationNumber: data.confirmationNumber,
    terms: data.terms,
    termsAcknowledgement: data.termsAcknowledgement,
    payment: data.payment,
    createdBy: data.createdBy,
    policy: data.policy,
    risk: data.risk,
    consent: data.consent,
    notes: data.notes,
  })) as OrderDocument;
}

export async function createPaidOrder(seed: OrderSeed = {}): Promise<OrderDocument> {
  const now = new Date();
  return createOrder({
    status: OrderStatus.PAID,
    payment: {
      status: OrderStatus.PAID,
      paidAt: now,
      amountReceived: seed.pricing?.amount ?? 199.5,
      stripeSessionId: `cs_test_paid_${Date.now()}`,
      paymentIntentId: `pi_test_paid_${Date.now()}`,
      processedWebhookEventIds: [],
      ...(seed.payment ?? {}),
    },
    ...seed,
  });
}
