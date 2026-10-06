import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import {
  ConsentStatus,
  FlightTripType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import {
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
  PaymentConsent,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import {
  getPublicConsentView,
  listConsentsForOrder,
  recordConsentFromToken,
} from "@/server/services/consent.service";
import {
  createOrder,
  getOrderById,
  initiatePayment,
} from "@/server/services/order.service";
import { createOrder as factoryCreateOrder } from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import {
  flightJourneyInput,
  flightSegmentInput,
  oneWayConnectingFlightInput,
  roundTripFlightInput,
  validCreateOrderInput,
  validFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import type { OrderDTO } from "@/types";

/**
 * The consent record a payment request freezes, for a FLIGHT.
 *
 * The hosted consent page renders from this record, not from the live
 * order, so it must carry the whole itinerary — every flight and layover —
 * and the money split (`amount` is the service charge; `airlineFare` and
 * `bookingTotal` sit beside it). The record's rental-shaped slots (`vehicle`,
 * pick-up / drop-off) have schema limits a long multi-city route could
 * overrun; consent creation must never fail on them, because the email send
 * swallows that failure and the customer would silently get no consent link.
 *
 * Car records keep their exact historic shape, and the page now names the
 * gateway the link really opens — PayPal included.
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<dep>", response: "250" };
    },
  }),
  getMailerFor: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<org>", response: "250" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const { sendPaymentRequestEmail } = await import("@/server/services/email.service");

const actor = actorFor(UserRole.ADMIN);
const BRANDING = { brandName: "Deployment Brand" };

const ORG_ENV = {
  ORG_SKYWAYS_STRIPE_SECRET_KEY: "sk_test_skyways_only",
  ORG_SKYWAYS_STRIPE_WEBHOOK_SECRET: "whsec_skyways_only",
};

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let skyways: Types.ObjectId;
let paypalair: Types.ObjectId;

async function makeOrg(slug: string, provider: PaymentGatewayKey): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault: false,
    payments: { provider },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    email: { fromName: slug, fromEmail: `no-reply@${slug}.test` },
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

function actingAs(orgId: Types.ObjectId) {
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgId) } });
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  Object.assign(process.env, ORG_ENV);
  sentMail.length = 0;
  skyways = await makeOrg("skyways", PaymentGatewayKey.STRIPE);
  paypalair = await makeOrg("paypalair", PaymentGatewayKey.PAYPAL);
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  for (const k of Object.keys(ORG_ENV)) delete process.env[k];
  setNextHeaders({});
});

/** Create in Skyways, generate the Stripe link, send the payment request. */
async function requestedConsent(input: Parameters<typeof createOrder>[0]) {
  actingAs(skyways);
  const { order } = await createOrder(input, { actor });
  const { order: linked } = await initiatePayment(order.id, { actor });
  const { consentToken } = await sendPaymentRequestEmail(linked, {}, { actor });
  expect(consentToken, "consent creation failed during the send").toBeTruthy();
  const record = await PaymentConsent.findOne({
    orderId: new Types.ObjectId(order.id),
  }).lean<{ _id: Types.ObjectId; snapshot: Record<string, unknown> } | null>();
  expect(record, "no consent record was persisted").toBeTruthy();
  return { order: linked, token: consentToken!, record: record! };
}

describe("a flight's payment request freezes its itinerary into the consent record", () => {
  it("persists snapshot.flight with both journeys, plus the airline fare and booking value", async () => {
    const { order, record } = await requestedConsent(roundTripFlightInput());
    const snapshot = record.snapshot as {
      serviceType: string;
      amount: number;
      airlineFare: number;
      bookingTotal: number;
      flight: {
        tripType: string;
        cabinClass: string;
        passengers: { adults: number; children: number; infants: number };
        pnr: string | null;
        outbound: unknown;
        return: unknown;
      };
    };

    expect(snapshot.serviceType).toBe(ServiceType.FLIGHT);
    expect(snapshot.amount).toBe(95);
    expect(snapshot.airlineFare).toBe(1240);
    expect(snapshot.bookingTotal).toBe(1335);
    expect(snapshot.flight).toMatchObject({
      tripType: FlightTripType.ROUND_TRIP,
      cabinClass: "BUSINESS",
      passengers: { adults: 2, children: 1, infants: 0 },
      pnr: "ABC123",
      outbound: order.flight!.outbound,
      return: order.flight!.return,
    });
  });

  it("folds the route and the journey's ends into the rental-shaped slots", async () => {
    const { record } = await requestedConsent(roundTripFlightInput());
    const snapshot = record.snapshot as {
      vehicle: string;
      pickupDate: Date;
      dropoffDate: Date;
      pickupLocation: string;
      dropoffLocation: string;
    };
    expect(snapshot.vehicle).toBe("Delhi → Varanasi → Mumbai (round trip)");
    // Airport-local wall clock written as UTC: reading it back in UTC gives
    // the time printed on the ticket.
    expect(new Date(snapshot.pickupDate).toISOString()).toBe("2026-10-10T10:30:00.000Z");
    // A round trip ends where the return departs.
    expect(new Date(snapshot.dropoffDate).toISOString()).toBe("2026-10-15T09:00:00.000Z");
    expect(snapshot.pickupLocation).toBe("Delhi");
    expect(snapshot.dropoffLocation).toBe("Mumbai");
  });

  it("ends a one-way trip at its final arrival", async () => {
    const { record } = await requestedConsent(oneWayConnectingFlightInput());
    const snapshot = record.snapshot as {
      dropoffDate: Date;
      dropoffLocation: string;
      flight: { return: unknown };
    };
    expect(new Date(snapshot.dropoffDate).toISOString()).toBe("2026-10-10T16:30:00.000Z");
    expect(snapshot.dropoffLocation).toBe("Mumbai");
    expect(snapshot.flight.return).toBeNull();
  });

  it("returns the same plain itinerary on the hosted page and in the admin history", async () => {
    const { order, token } = await requestedConsent(roundTripFlightInput());

    const view = await getPublicConsentView(token, BRANDING);
    expect(view.snapshot.flight?.outbound).toEqual(order.flight!.outbound);
    expect(view.snapshot.flight?.return).toEqual(order.flight!.return);
    expect(view.snapshot.airlineFare).toBe(1240);
    expect(view.snapshot.bookingTotal).toBe(1335);
    // Exactly one connection per gap, in both directions.
    expect(view.snapshot.flight!.outbound!.connections).toHaveLength(1);
    expect(view.snapshot.flight!.return!.connections).toHaveLength(1);
    expect(view.gatewayLabel).toBe("Stripe");

    actingAs(skyways);
    const [history] = await listConsentsForOrder(order.id, { actor });
    expect(history!.snapshot.flight).toEqual(view.snapshot.flight);
  });

  it("puts the money split and a readable itinerary in the consent evidence", async () => {
    const { order, token } = await requestedConsent(roundTripFlightInput());
    const requested = await OrderEvidence.findOne({
      orderId: new Types.ObjectId(order.id),
      eventType: OrderEvidenceEventType.CONSENT_REQUESTED,
    }).lean<{ payload: { snapshot: Record<string, unknown> } } | null>();
    expect(requested!.payload.snapshot).toMatchObject({
      airlineFare: 1240,
      bookingTotal: 1335,
      itinerary: {
        tripType: FlightTripType.ROUND_TRIP,
        pnr: "ABC123",
        journeys: [
          {
            label: "Outbound",
            route: "Delhi → Varanasi → Mumbai",
            layovers: ["Layover after flight 1: 2h 30m — Varanasi · Change terminals"],
          },
          {
            label: "Return",
            route: "Mumbai → Varanasi → Delhi",
            layovers: ["Layover after flight 1: 2h — Varanasi · Lounge access included"],
          },
        ],
      },
    });

    // The customer's acknowledgement freezes the same money and itinerary.
    await recordConsentFromToken(
      {
        token,
        acknowledgement: (await getPublicConsentView(token, BRANDING)).consentMessage,
        signedName: "Grace Hopper",
      },
      { branding: BRANDING },
    );
    const received = await OrderEvidence.findOne({
      orderId: new Types.ObjectId(order.id),
      eventType: OrderEvidenceEventType.CONSENT_RECEIVED,
    }).lean<{ payload: { snapshot: Record<string, unknown> } } | null>();
    expect(received!.payload.snapshot.airlineFare).toBe(1240);
    expect(received!.payload.snapshot.itinerary).toEqual(
      requested!.payload.snapshot.itinerary,
    );
  });

  it("never fails consent creation on a very long multi-city route", async () => {
    // 16 flights between airports with long names: the route runs to
    // hundreds of characters — far past the record's 160-character `vehicle`.
    const name = (i: number) =>
      `International Airport Number ${String(i).padStart(2, "0")} of an exceedingly long itinerary`;
    const segments = Array.from({ length: 16 }, (_, i) =>
      flightSegmentInput(
        name(i),
        name(i + 1),
        [`2026-11-${String(i + 1).padStart(2, "0")}`, "08:00"],
        [`2026-11-${String(i + 1).padStart(2, "0")}`, "10:00"],
      ),
    );
    const input = validFlightOrderInput(
      {},
      { tripType: FlightTripType.MULTI_CITY, outbound: flightJourneyInput(segments) },
    );

    const { record, token } = await requestedConsent(input);
    const snapshot = record.snapshot as {
      vehicle: string;
      flight: { outbound: { segments: unknown[] } };
    };
    expect(snapshot.vehicle.length).toBeLessThanOrEqual(160);
    expect(snapshot.flight.outbound.segments).toHaveLength(16);

    const view = await getPublicConsentView(token, BRANDING);
    expect(view.snapshot.flight!.outbound!.segments).toHaveLength(16);
  });

  it("keeps a LEGACY flight's flat fields exactly", async () => {
    const legacy = await factoryCreateOrder({
      serviceType: ServiceType.FLIGHT,
      organizationId: skyways,
      status: OrderStatus.LINK_GENERATED,
      pricing: { amount: 420.5, currency: "USD" as never },
      flight: {
        tripType: "ROUND_TRIP",
        airline: "Test Airways",
        flightNumber: "TA123",
        origin: "LHR",
        destination: "JFK",
        departureDate: new Date("2026-11-01T09:15:00.000Z"),
        returnDate: new Date("2026-11-08T20:00:00.000Z"),
        cabinClass: "ECONOMY",
        passengers: { adults: 1, children: 0, infants: 0 },
      },
    });
    await Order.updateOne(
      { _id: legacy._id },
      {
        $set: {
          "payment.gateway": PaymentGatewayKey.STRIPE,
          "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_legacy",
        },
      },
    );
    actingAs(skyways);
    const dto: OrderDTO = await getOrderById(String(legacy._id), { actor });
    const { consentToken } = await sendPaymentRequestEmail(dto, {}, { actor });

    const view = await getPublicConsentView(consentToken!, BRANDING);
    expect(view.snapshot).toMatchObject({
      vehicle: "Test Airways TA123 • LHR → JFK",
      pickupDate: "2026-11-01T09:15:00.000Z",
      dropoffDate: "2026-11-08T20:00:00.000Z",
      pickupLocation: "LHR",
      dropoffLocation: "JFK",
      amount: 420.5,
      airlineFare: 0,
      bookingTotal: 420.5,
    });
    expect(view.snapshot.flight).toMatchObject({
      tripType: FlightTripType.ROUND_TRIP,
      outbound: null,
      return: null,
      origin: "LHR",
      destination: "JFK",
      departureDate: "2026-11-01T09:15:00.000Z",
      returnDate: "2026-11-08T20:00:00.000Z",
    });
  });
});

describe("a car rental's consent record keeps its historic shape", () => {
  it("adds no flight keys to the hosted-page snapshot, the admin DTO or the evidence", async () => {
    const { order, token } = await requestedConsent(validCreateOrderInput());

    const view = await getPublicConsentView(token, BRANDING);
    expect(view.snapshot.vehicle).toBe("Toyota • Camry");
    for (const key of ["flight", "airlineFare", "bookingTotal"]) {
      expect(key in view.snapshot, `public view has ${key}`).toBe(false);
    }

    actingAs(skyways);
    const [history] = await listConsentsForOrder(order.id, { actor });
    for (const key of ["flight", "airlineFare", "bookingTotal"]) {
      expect(key in history!.snapshot, `admin DTO has ${key}`).toBe(false);
    }

    const requested = await OrderEvidence.findOne({
      orderId: new Types.ObjectId(order.id),
      eventType: OrderEvidenceEventType.CONSENT_REQUESTED,
    }).lean<{ payload: { snapshot: Record<string, unknown> } } | null>();
    expect(Object.keys(requested!.payload.snapshot)).toEqual([
      "bookingType",
      "provider",
      "serviceType",
      "vehicle",
      "pickupDate",
      "dropoffDate",
      "amount",
      "currency",
      "paymentLinkRef",
    ]);
  });
});

describe("the consent page names the gateway the link really opens", () => {
  /** A car order in `orgId` with a consent request on record. */
  async function carConsentIn(orgId: Types.ObjectId, gateway: PaymentGatewayKey | null) {
    actingAs(orgId);
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          status: OrderStatus.LINK_GENERATED,
          "payment.gateway": gateway,
          "payment.checkoutUrl": "https://checkout.example.test/pay/1",
        },
      },
    );
    const dto = await getOrderById(order.id, { actor });
    const { consentToken } = await sendPaymentRequestEmail(dto, {}, { actor });
    return consentToken!;
  }

  it("says Stripe for a Stripe order, exactly as before", async () => {
    const token = await carConsentIn(skyways, PaymentGatewayKey.STRIPE);
    expect((await getPublicConsentView(token, BRANDING)).gatewayLabel).toBe("Stripe");
  });

  it("says PayPal for a PayPal order — the page used to say Stripe", async () => {
    const token = await carConsentIn(paypalair, PaymentGatewayKey.PAYPAL);
    expect((await getPublicConsentView(token, BRANDING)).gatewayLabel).toBe("PayPal");
  });

  it("falls back to the organization's configured gateway when the order has none yet", async () => {
    const token = await carConsentIn(paypalair, null);
    expect((await getPublicConsentView(token, BRANDING)).gatewayLabel).toBe("PayPal");
  });

  it("names no gateway when neither the order nor an organization has one", async () => {
    // An unattributed (pre-migration style) car order with no gateway
    // pinned. Unattributed rows belong to the DEFAULT organization's scope,
    // which is where an operator would request consent for one.
    const anchor = await Organization.create({
      slug: "rentalconfirmation",
      name: "rentalconfirmation",
      brandName: "Rental Confirmation",
      isDefault: true,
      payments: { provider: PaymentGatewayKey.STRIPE },
    });
    await OrganizationMember.create({
      organizationId: anchor._id,
      userId: new Types.ObjectId(actor.id),
      role: UserRole.ADMIN,
      status: RecordState.ACTIVE,
    });
    actingAs(anchor._id as Types.ObjectId);
    const order = await factoryCreateOrder({
      payment: {
        status: "PAYMENT_PENDING",
        checkoutUrl: "https://checkout.example.test/pay/2",
        processedWebhookEventIds: [],
      } as never,
    });
    expect(order.organizationId ?? null).toBeNull();
    const { requestConsent } = await import("@/server/services/consent.service");
    const { token } = await requestConsent(
      {
        orderId: String(order._id),
        customerEmail: order.customer.email,
        customerName: order.customer.name,
        consentMessage: "I agree to proceed with this payment and booking.",
        consentEmailSubject: "Subject",
        snapshot: {
          bookingType: order.bookingType,
          provider: order.provider.name,
          vehicle: `${order.vehicle!.company} • ${order.vehicle!.type}`,
          pickupDate: order.trip!.pickupDate.toISOString(),
          dropoffDate: order.trip!.dropoffDate.toISOString(),
          amount: order.pricing.amount,
          currency: order.pricing.currency,
          paymentLinkRef: null,
        },
      },
      { actor, appUrl: "http://127.0.0.1:3100" },
    );
    expect((await getPublicConsentView(token, BRANDING)).gatewayLabel).toBeNull();
  });

  it("still names PayPal in the view returned after the customer signs (the redirect screen)", async () => {
    const token = await carConsentIn(paypalair, PaymentGatewayKey.PAYPAL);
    const before = await getPublicConsentView(token, BRANDING);
    expect(before.status).toBe(ConsentStatus.REQUESTED);

    const after = await recordConsentFromToken(
      { token, acknowledgement: before.consentMessage, signedName: "Ada Lovelace" },
      { branding: BRANDING },
    );
    expect(after.alreadyConfirmedAt).toBeTruthy();
    expect(after.gatewayLabel).toBe("PayPal");
  });
});
