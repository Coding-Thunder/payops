import { Types } from "mongoose";

import {
  BookingType,
  ConsentStatus,
  Currency,
  OrderStatus,
  PaymentTiming,
  RecordState,
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
 *
 * SERVICE TYPE. A seed with no `serviceType` builds exactly the car rental
 * this factory has always built — same vehicle, same trip, same strings —
 * with `flight` / `hotel` / `bookingStatus` / `payment.capture` sitting at
 * the null the schema defaults them to. FLIGHT and HOTEL seeds swap the
 * car-rental payload for their own (and drop `vehicle` / `trip` to null,
 * which is what the model requires of them) without touching the rental
 * path above.
 */

interface CreatorSeed {
  userId?: Types.ObjectId | string;
  name?: string;
  email?: string;
}

export interface OrderSeed extends Partial<Omit<OrderDoc, "createdBy">> {
  createdBy?: CreatorSeed;
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
  const serviceType = seed.serviceType ?? ServiceType.CAR_RENTAL;
  // A payload is built when its service type owns it, or when the caller
  // seeded one explicitly (`vehicle: null` stays null either way).
  const wants = (owner: ServiceType, seeded: unknown): boolean =>
    seeded === null ? false : Boolean(seeded) || serviceType === owner;
  return {
    _id: new Types.ObjectId(),
    orderNumber: seed.orderNumber ?? `TST-${suffix.toUpperCase()}`.slice(0, 32),
    bookingType: seed.bookingType ?? BookingType.NEW_BOOKING,
    serviceType,
    status: seed.status ?? OrderStatus.PAYMENT_PENDING,
    state: seed.state ?? RecordState.ACTIVE,
    /** Null on every automatic-capture order, which is every order the two
     *  incumbent brands have ever created. */
    bookingStatus: seed.bookingStatus ?? null,
    provider: seed.provider ?? buildProviderSnapshot(ProviderId.BUDGET),
    customer: {
      name: seed.customer?.name ?? "Test Customer",
      email: (seed.customer?.email ?? "customer@payops.test").toLowerCase(),
      phone: seed.customer?.phone ?? "+15555550100",
    },
    vehicle: wants(ServiceType.CAR_RENTAL, seed.vehicle)
      ? {
          company: seed.vehicle?.company ?? "Toyota",
          type: seed.vehicle?.type ?? "Corolla",
        }
      : null,
    trip: wants(ServiceType.CAR_RENTAL, seed.trip)
      ? {
          pickupDate: seed.trip?.pickupDate ?? pickup,
          dropoffDate: seed.trip?.dropoffDate ?? dropoff,
          pickupLocation: seed.trip?.pickupLocation ?? "LAX Airport — Terminal 1",
          dropoffLocation: seed.trip?.dropoffLocation ?? "San Diego Downtown",
        }
      : null,
    flight: wants(ServiceType.FLIGHT, seed.flight)
      ? {
          tripType: seed.flight?.tripType ?? "ONE_WAY",
          airline: seed.flight?.airline ?? "Test Airways",
          flightNumber: seed.flight?.flightNumber ?? "TA123",
          origin: seed.flight?.origin ?? "LHR",
          destination: seed.flight?.destination ?? "JFK",
          departureDate: seed.flight?.departureDate ?? pickup,
          departureTimePreference: seed.flight?.departureTimePreference ?? null,
          // A round trip has to carry a return leg or the model's
          // pre-validate hook rejects it, so seed one by default.
          returnDate:
            seed.flight?.returnDate ??
            (seed.flight?.tripType === "ROUND_TRIP" ? dropoff : null),
          returnTimePreference: seed.flight?.returnTimePreference ?? null,
          cabinClass: seed.flight?.cabinClass ?? "ECONOMY",
          passengers: {
            adults: seed.flight?.passengers?.adults ?? 1,
            children: seed.flight?.passengers?.children ?? 0,
            infants: seed.flight?.passengers?.infants ?? 0,
          },
          passengerNotes: seed.flight?.passengerNotes ?? null,
          pnr: seed.flight?.pnr ?? null,
        }
      : null,
    hotel: wants(ServiceType.HOTEL, seed.hotel)
      ? {
          destination: seed.hotel?.destination ?? "Paris",
          propertyName: seed.hotel?.propertyName ?? "Hilton",
          checkInDate: seed.hotel?.checkInDate ?? pickup,
          checkOutDate: seed.hotel?.checkOutDate ?? dropoff,
          rooms: seed.hotel?.rooms ?? 1,
          guests: {
            adults: seed.hotel?.guests?.adults ?? 2,
            children: seed.hotel?.guests?.children ?? 0,
          },
          roomPreference: seed.hotel?.roomPreference ?? null,
          guestNotes: seed.hotel?.guestNotes ?? null,
          confirmationCode: seed.hotel?.confirmationCode ?? null,
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
      /** Manual-capture bookkeeping. Null means "automatic capture, not
       *  applicable" — the state of every incumbent order. */
      capture: seed.payment?.capture ?? null,
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
    /**
     * TENANCY. Null by default — which is what every order written before
     * the organization migration carries, and what the pre-existing tests
     * that call this factory with no seed expect.
     *
     * It has to be built HERE rather than left to the caller: `createOrder`
     * spreads this object into `Order.create`, so a field absent from the
     * returned document is simply never written. A test that passed
     * `organizationId` and got an unowned order back would then "prove" a
     * cross-tenant guard was working when it was really just refusing an
     * orphan.
     */
    organizationId: toObjectId(
      seed.organizationId as Types.ObjectId | string | undefined,
    ),
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
  // Spread rather than re-enumerate. The previous version listed every
  // field by hand, so a field added to `buildOrder` — `serviceType`,
  // `flight`, `hotel`, `bookingStatus`, `payment.capture` — was built and
  // then silently dropped on the way to the database. `createdAt` /
  // `updatedAt` stay out, exactly as before: Mongoose's timestamps own them.
  const doc: Partial<OrderDoc> & { _id: Types.ObjectId } = { ...data };
  delete doc.createdAt;
  delete doc.updatedAt;
  return (await Order.create(doc)) as OrderDocument;
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
