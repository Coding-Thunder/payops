import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  BookingType,
  OrderEvidenceEventType,
  OrderStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import {
  buildFlightItinerary,
  CONNECTION_CHRONOLOGY_MESSAGE,
} from "@/lib/flight-itinerary";
import {
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { orgCookieName } from "@/server/auth/org-cookie";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import {
  createOrder,
  getOrderById,
  initiatePayment,
} from "@/server/services/order.service";
import { getEvidenceChain } from "@/server/services/evidence.service";
import {
  buildProviderSnapshotFromKey,
  createProvider,
} from "@/server/services/provider.service";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import {
  createOrder as factoryCreateOrder,
  itineraryFlight,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import {
  flightJourneyInput,
  flightSegmentInput,
  flightServiceCharge,
  FLIGHT_SEGMENTS,
  oneWayConnectingFlightInput,
  validCreateOrderInput,
  validFlightOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * FLIGHT orders end to end at the service layer: what `createOrder` stores
 * and freezes, what the order model refuses even when zod is bypassed, and —
 * the money rule the whole flight change exists for — what the payment
 * gateway is asked to charge.
 *
 * THE RULE: airline fare + service charge = booking value, and the gateway
 * (Stripe or PayPal) receives ONLY the service charge. The fare is a figure
 * shown to the customer, never a charge line, so it can never reach
 * `pricing.amount`. Car rentals keep collecting their PREPAID total exactly
 * as before, due-at-counter lines excluded.
 */

const actor = actorFor(UserRole.ADMIN);

/** A Stripe brand that sells cars and flights (automatic capture). */
const SKYWAYS_STRIPE_ENV = {
  ORG_SKYWAYS_STRIPE_SECRET_KEY: "sk_test_skyways_only",
  ORG_SKYWAYS_STRIPE_WEBHOOK_SECRET: "whsec_skyways_only",
};
/** A PayPal brand that sells flights. */
const PAYPALAIR_ENV = {
  ORG_PAYPALAIR_PAYPAL_CLIENT_ID: "test-client-id",
  ORG_PAYPALAIR_PAYPAL_CLIENT_SECRET: "test-client-secret",
  ORG_PAYPALAIR_PAYPAL_WEBHOOK_ID: "TESTWEBHOOK",
  ORG_PAYPALAIR_PAYPAL_SANDBOX: "true",
};

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let rentalconfirmation: Types.ObjectId;
let skyways: Types.ObjectId;
let paypalair: Types.ObjectId;
/** Every request body the PayPal API was sent, in order. */
let paypalBodies: Record<string, unknown>[] = [];

async function makeOrg(opts: {
  slug: string;
  isDefault: boolean;
  provider: PaymentGatewayKey;
  serviceTypes: ServiceType[];
}): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName: `${opts.slug} brand`,
    isDefault: opts.isDefault,
    payments: { provider: opts.provider },
    serviceTypes: opts.serviceTypes,
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

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {});
}

/** Minimal PayPal API: OAuth, then order creation — recording each body. */
function stubPayPal() {
  paypalBodies = [];
  _setPayPalFetchForTesting((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (init?.body) paypalBodies.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        id: "PP-FLIGHT-1",
        status: "PAYER_ACTION_REQUIRED",
        links: [
          {
            rel: "payer-action",
            href: "https://www.sandbox.paypal.com/checkoutnow?token=PP-FLIGHT-1",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch);
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  Object.assign(process.env, SKYWAYS_STRIPE_ENV, PAYPALAIR_ENV);
  stubPayPal();
  rentalconfirmation = await makeOrg({
    slug: "rentalconfirmation",
    isDefault: true,
    provider: PaymentGatewayKey.STRIPE,
    serviceTypes: [ServiceType.CAR_RENTAL],
  });
  skyways = await makeOrg({
    slug: "skyways",
    isDefault: false,
    provider: PaymentGatewayKey.STRIPE,
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
  });
  paypalair = await makeOrg({
    slug: "paypalair",
    isDefault: false,
    provider: PaymentGatewayKey.PAYPAL,
    serviceTypes: [ServiceType.FLIGHT],
  });
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  _setPayPalFetchForTesting(null);
  for (const k of [...Object.keys(SKYWAYS_STRIPE_ENV), ...Object.keys(PAYPALAIR_ENV)]) {
    delete process.env[k];
  }
  setNextHeaders({});
});

/** A flight with an explicit fare and service charge, created in `orgId`. */
async function flightIn(orgId: Types.ObjectId, airlineFare: number, serviceCharge: number) {
  actingAs(orgId);
  const { order } = await createOrder(
    oneWayConnectingFlightInput({ charges: flightServiceCharge(serviceCharge) }, { airlineFare }),
    { actor },
  );
  return order;
}

async function genesisPayload(orderId: string): Promise<Record<string, unknown>> {
  const row = await OrderEvidence.findOne({
    orderId: new Types.ObjectId(orderId),
    eventType: OrderEvidenceEventType.ORDER_CREATED,
  }).lean<{ payload: Record<string, unknown> } | null>();
  expect(row, "no genesis evidence row").toBeTruthy();
  return row!.payload;
}

/* ------------------------------------------------------------------ *
 * What createOrder stores
 * ------------------------------------------------------------------ */

describe("createOrder FLIGHT stores the itinerary it was given", () => {
  it("persists a connecting one-way's segments, connections and layover verbatim", async () => {
    const order = await flightIn(skyways, 400, 100);

    const doc = await Order.findById(order.id).lean<{
      flight: {
        tripType: string;
        outbound: {
          segments: Record<string, unknown>[];
          connections: Record<string, unknown>[];
        };
        return: unknown;
        airlineFare: number | null;
      };
    } | null>();
    const flight = doc!.flight;
    expect(flight.tripType).toBe("ONE_WAY");
    expect(flight.outbound.segments).toEqual([
      {
        origin: "Delhi",
        destination: "Varanasi",
        departure: { date: "2026-10-10", time: "10:30" },
        arrival: { date: "2026-10-10", time: "12:00" },
        airline: "Air India",
        flightNumber: "AI123",
        details: null,
      },
      {
        origin: "Varanasi",
        destination: "Mumbai",
        departure: { date: "2026-10-10", time: "14:30" },
        arrival: { date: "2026-10-10", time: "16:30" },
        airline: "IndiGo",
        flightNumber: "6E456",
        details: null,
      },
    ]);
    // ONE connection for the one gap. The layover stores only what the two
    // flights cannot: the calculated 2h 30m is derived, never stored.
    expect(flight.outbound.connections).toEqual([
      { layover: { location: null, durationMinutesOverride: null, notes: "Change terminals" } },
    ]);
    expect(flight.return ?? null).toBeNull();
    expect(flight.airlineFare).toBe(400);
  });

  it("sets pricing.amount to the service charge only — the fare never reaches it", async () => {
    const order = await flightIn(skyways, 400, 100);
    const doc = await Order.findById(order.id).lean<{
      pricing: { amount: number; currency: string };
      charges: { name: string; amount: number; timing: string }[];
    } | null>();

    expect(doc!.pricing.amount).toBe(100);
    expect(doc!.pricing.amount).not.toBe(500);
    expect(doc!.charges).toEqual([
      { name: "Service charge", amount: 100, timing: PaymentTiming.PREPAID },
    ]);
  });

  it("sums several service-charge lines, all PREPAID", async () => {
    actingAs(skyways);
    const { order } = await createOrder(
      oneWayConnectingFlightInput(
        {
          charges: [
            { name: "Service charge", amount: 60, timing: PaymentTiming.PREPAID },
            { name: "Seat selection", amount: 15.5, timing: PaymentTiming.PREPAID },
          ],
        },
        { airlineFare: 300 },
      ),
      { actor },
    );
    const dto = await getOrderById(order.id, { actor });
    expect(dto.pricing.amount).toBe(75.5);
    expect(dto.charges.every((c) => c.timing === PaymentTiming.PREPAID)).toBe(true);
    expect(dto.flight!.airlineFare).toBe(300);
  });

  it("stores a blank airline fare as null", async () => {
    actingAs(skyways);
    const { order } = await createOrder(
      oneWayConnectingFlightInput({}, { airlineFare: null }),
      { actor },
    );
    const dto = await getOrderById(order.id, { actor });
    expect(dto.flight!.airlineFare).toBeNull();
    expect(dto.pricing.amount).toBe(100);
  });

  it("round-trips the itinerary through the DTO", async () => {
    const input = oneWayConnectingFlightInput({}, { pnr: "  XYZ789 ", passengerNotes: "" });
    actingAs(skyways);
    const { order } = await createOrder(input, { actor });

    const dto = await getOrderById(order.id, { actor });
    expect(dto.flight!.outbound).toEqual(input.flight.outbound);
    expect(dto.flight!.return).toBeNull();
    expect(dto.flight!.pnr).toBe("XYZ789");
    expect(dto.flight!.passengerNotes).toBeNull();

    // …and renders through the one display view every surface uses.
    const view = buildFlightItinerary(dto.flight)!;
    expect(view.legacy).toBe(false);
    expect(view.journeys[0]!.route).toBe("Delhi → Varanasi → Mumbai");
    expect(view.journeys[0]!.connections[0]!.layover).toMatchObject({
      location: "Varanasi",
      calculatedMinutes: 150,
      minutes: 150,
      notes: "Change terminals",
    });
  });

  it("freezes the full flight and the money split into the genesis evidence row", async () => {
    const order = await flightIn(skyways, 400, 100);
    const dto = await getOrderById(order.id, { actor });
    const payload = await genesisPayload(order.id);

    expect(payload.serviceType).toBe(ServiceType.FLIGHT);
    expect(payload.flight).toMatchObject({
      tripType: "ONE_WAY",
      outbound: dto.flight!.outbound,
      return: null,
      airlineFare: 400,
    });
    expect(payload.pricing).toEqual({ amount: 100, currency: "USD" });
    expect(payload.chargeBreakdown).toEqual({
      prepaid: 100,
      dueAtCounter: 0,
      total: 100,
      currency: "USD",
      airlineFare: 400,
      serviceCharge: 100,
      bookingTotal: 500,
    });
  });

  it("keeps a car order's genesis row in its exact historic shape", async () => {
    actingAs(skyways);
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    const payload = await genesisPayload(order.id);

    expect(payload.flight).toBeNull();
    expect(payload.chargeBreakdown).toEqual({
      prepaid: 249.99,
      dueAtCounter: 0,
      total: 249.99,
      currency: "USD",
    });
  });
});

describe("POST /api/orders normalises a flight before it is stored", () => {
  it("drops a one-way's stray return, fills the missing connection, and charges the service charge", async () => {
    actingAs(skyways);
    const payload = validFlightOrderInput(
      {},
      {
        outbound: {
          // No `connections` sent at all: the schema adds one per gap.
          segments: [FLIGHT_SEGMENTS.delhiVaranasi(), FLIGHT_SEGMENTS.varanasiMumbai()],
        } as never,
        // A ONE_WAY carrying a return journey: dropped, never stored.
        return: flightJourneyInput([FLIGHT_SEGMENTS.mumbaiVaranasi()]),
        airlineFare: 825,
      },
    );
    const res = await createOrderRoute(
      buildRequest("/api/orders", {
        method: "POST",
        body: { ...payload, charges: flightServiceCharge(75) },
      }),
    );
    const { status, body } = await jsonBody<{ ok: boolean; data: { order: { id: string } } }>(res);
    expect(status, JSON.stringify(body)).toBe(201);

    const dto = await getOrderById(body.data.order.id, { actor });
    expect(dto.serviceType).toBe(ServiceType.FLIGHT);
    expect(dto.flight!.return).toBeNull();
    expect(dto.flight!.outbound!.connections).toEqual([{ layover: null }]);
    expect(dto.flight!.airlineFare).toBe(825);
    expect(dto.pricing.amount).toBe(75);
  });

  it("answers 422 — and stores nothing — for an impossible connection", async () => {
    actingAs(skyways);
    const payload = validFlightOrderInput(
      {},
      {
        outbound: flightJourneyInput([
          FLIGHT_SEGMENTS.delhiVaranasi(),
          flightSegmentInput("Varanasi", "Mumbai", ["2026-10-10", "11:00"], ["2026-10-10", "13:00"]),
        ]),
      },
    );
    const res = await createOrderRoute(
      buildRequest("/api/orders", { method: "POST", body: payload }),
    );
    const { status, body } = await jsonBody<{
      ok: false;
      error: { details?: { issues?: { path: (string | number)[]; message: string }[] } };
    }>(res);
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain(CONNECTION_CHRONOLOGY_MESSAGE);
    expect(await Order.countDocuments({ serviceType: ServiceType.FLIGHT })).toBe(0);
  });

  it("answers 422 for a DUE_AT_COUNTER flight charge", async () => {
    actingAs(skyways);
    const res = await createOrderRoute(
      buildRequest("/api/orders", {
        method: "POST",
        body: validFlightOrderInput({
          charges: [
            {
              name: "Balance at the airport",
              amount: 300,
              timing: PaymentTiming.DUE_AT_COUNTER as never,
            },
          ],
        }),
      }),
    );
    const { status, body } = await jsonBody<unknown>(res);
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain("Flight charges are always prepaid");
  });
});

/* ------------------------------------------------------------------ *
 * The order model, bypassing zod
 * ------------------------------------------------------------------ */

describe("the order model guards a NEW flight even when zod is bypassed", () => {
  it("refuses a new flight order carrying a DUE_AT_COUNTER charge", async () => {
    actingAs(skyways);
    // `createOrder` takes already-parsed input; this is the shape zod would
    // have refused. The model is the last line.
    const input = validFlightOrderInput({
      charges: [
        { name: "Service charge", amount: 100, timing: PaymentTiming.PREPAID },
        {
          name: "Balance at the airport",
          amount: 300,
          timing: PaymentTiming.DUE_AT_COUNTER as never,
        },
      ],
    });

    await expect(createOrder(input, { actor })).rejects.toThrow(
      /Flight charges must be prepaid/,
    );
    expect(await Order.countDocuments({ serviceType: ServiceType.FLIGHT })).toBe(0);
  });

  it("refuses an impossible connection written straight to the model", async () => {
    await expect(
      factoryCreateOrder({
        serviceType: ServiceType.FLIGHT,
        organizationId: skyways,
        flight: itineraryFlight({
          outbound: flightJourneyInput([
            FLIGHT_SEGMENTS.delhiVaranasi(),
            flightSegmentInput("Varanasi", "Mumbai", ["2026-10-10", "11:00"], ["2026-10-10", "13:00"]),
          ]),
        }),
      }),
    ).rejects.toThrow(CONNECTION_CHRONOLOGY_MESSAGE);
  });

  it("refuses a round trip with no return, and a one-way that carries one", async () => {
    await expect(
      factoryCreateOrder({
        serviceType: ServiceType.FLIGHT,
        organizationId: skyways,
        flight: itineraryFlight({ tripType: "ROUND_TRIP", return: null }),
      }),
    ).rejects.toThrow(/A round trip needs a return flight/);

    await expect(
      factoryCreateOrder({
        serviceType: ServiceType.FLIGHT,
        organizationId: skyways,
        flight: itineraryFlight({
          tripType: "ONE_WAY",
          return: flightJourneyInput([FLIGHT_SEGMENTS.mumbaiVaranasi()]),
        }),
      }),
    ).rejects.toThrow(/Only a round trip has a return flight/);
  });

  it("does not re-validate a stored itinerary on an unrelated later save", async () => {
    // A webhook flipping the payment status must never fail because an
    // itinerary rule was tightened after the order was placed. Simulate a
    // stored itinerary that today's rules would refuse.
    const order = await factoryCreateOrder({
      serviceType: ServiceType.FLIGHT,
      organizationId: skyways,
      flight: itineraryFlight(),
    });
    await Order.collection.updateOne(
      { _id: order._id },
      { $set: { "flight.outbound.segments.1.departure.time": "11:00" } },
    );

    const doc = await Order.findById(order._id);
    doc!.status = OrderStatus.PAID;
    await expect(doc!.save()).resolves.toBeTruthy();
  });
});

describe("a LEGACY flight order (created before itineraries) still works", () => {
  async function legacyFlight(seed: Parameters<typeof factoryCreateOrder>[0] = {}) {
    return factoryCreateOrder({
      serviceType: ServiceType.FLIGHT,
      organizationId: skyways,
      ...seed,
    });
  }

  it("saves, validates and re-saves with its flat fields and prepaid 'Airfare' line", async () => {
    const order = await legacyFlight();
    const doc = await Order.findById(order._id);

    expect(doc!.flight!.origin).toBe("LHR");
    expect(doc!.flight!.destination).toBe("JFK");
    expect(doc!.flight!.outbound ?? null).toBeNull();
    expect(doc!.charges.map((c) => [c.name, c.timing])).toEqual([
      ["Airfare", PaymentTiming.PREPAID],
    ]);
    await expect(doc!.validate()).resolves.toBeUndefined();

    doc!.notes = "Touched by an operator after the itinerary release.";
    await expect(doc!.save()).resolves.toBeTruthy();
  });

  it("keeps its original rules — a due-later line is still accepted", async () => {
    const order = await legacyFlight({
      charges: [
        { name: "Airfare", amount: 200, timing: PaymentTiming.PREPAID },
        { name: "Balance", amount: 300, timing: PaymentTiming.DUE_AT_COUNTER },
      ],
    });
    expect(order._id).toBeTruthy();
  });

  it("still refuses an arrival before departure, as it always did", async () => {
    await expect(
      legacyFlight({
        flight: {
          tripType: "ONE_WAY",
          origin: "LHR",
          destination: "JFK",
          departureDate: new Date("2026-11-01T09:15:00.000Z"),
          arrivalDate: new Date("2026-11-01T08:00:00.000Z"),
          cabinClass: "ECONOMY",
          passengers: { adults: 1, children: 0, infants: 0 },
        },
      }),
    ).rejects.toThrow(/Arrival must not be before departure/);
  });

  it("reads back and renders through buildFlightItinerary, its times labelled UTC", async () => {
    const order = await legacyFlight({
      flight: {
        tripType: "ONE_WAY",
        airline: "Test Airways",
        flightNumber: "TA123",
        origin: "LHR",
        destination: "JFK",
        departureDate: new Date("2026-11-01T09:15:00.000Z"),
        arrivalDate: new Date("2026-11-01T17:40:00.000Z"),
        cabinClass: "ECONOMY",
        passengers: { adults: 1, children: 0, infants: 0 },
      },
    });
    actingAs(skyways);
    const dto = await getOrderById(String(order._id), { actor });

    expect(dto.flight).toMatchObject({
      outbound: null,
      return: null,
      origin: "LHR",
      destination: "JFK",
      departureDate: "2026-11-01T09:15:00.000Z",
      arrivalDate: "2026-11-01T17:40:00.000Z",
    });
    const view = buildFlightItinerary(dto.flight)!;
    expect(view.legacy).toBe(true);
    expect(view.journeys).toHaveLength(1);
    expect(view.journeys[0]!.timeZoneLabel).toBe("UTC");
    expect(view.journeys[0]!.segments[0]).toMatchObject({
      origin: "LHR",
      destination: "JFK",
      airline: "Test Airways",
      flightNumber: "TA123",
      departure: { date: "2026-11-01", time: "09:15" },
      arrival: { date: "2026-11-01", time: "17:40" },
    });
  });
});

/* ------------------------------------------------------------------ *
 * The gateway amount — Stripe
 * ------------------------------------------------------------------ */

describe("Stripe is asked for the SERVICE CHARGE only", () => {
  it.each([
    { fare: 400, service: 100, minor: 10000 },
    { fare: 825, service: 75, minor: 7500 },
  ])(
    "airline fare $fare + service charge $service → unit_amount $minor",
    async ({ fare, service, minor }) => {
      const order = await flightIn(skyways, fare, service);
      await initiatePayment(order.id, { actor });

      const stripe = getCurrentTestStripe();
      expect(stripe.sessionsCreated).toHaveLength(1);
      const lineItems = stripe.sessionsCreated[0]!.params.line_items!;
      expect(lineItems).toHaveLength(1);
      const price = lineItems[0]!.price_data!;
      expect(price.unit_amount).toBe(minor);
      expect(price.currency).toBe("usd");
      // Neither the fare nor the booking value.
      expect(price.unit_amount).not.toBe(fare * 100);
      expect(price.unit_amount).not.toBe((fare + service) * 100);
      expect(price.product_data!.name).toContain("service charge");
    },
  );

  it("names the line item a service charge and lists every airport of the route", async () => {
    const order = await flightIn(skyways, 400, 100);
    await initiatePayment(order.id, { actor });

    const product = getCurrentTestStripe().sessionsCreated[0]!.params.line_items![0]!
      .price_data!.product_data!;
    expect(product.name.startsWith("Budget • ")).toBe(true);
    expect(product.name).toContain("Flight booking service charge");
    expect(product.name).toContain("Delhi → Varanasi → Mumbai");
    // The description says what is being paid for, then when the trip is.
    expect(product.description!.startsWith("Flight booking service charge • ")).toBe(true);
    expect(product.description).toContain("Departs: Sat, Oct 10, 2026 10:30 AM • One way, 1 stop");
    expect(product.description!.length).toBeLessThanOrEqual(127);
  });

  it("names the provider by its own name, not its catalog key", async () => {
    await createProvider(
      {
        key: "AIRINDIA",
        name: "Air India",
        logo: "/providers/air-india.png",
        primaryColor: "#C8102E",
        onPrimaryColor: "#FFFFFF",
        tagline: "",
        sortOrder: 0,
        serviceTypes: [ServiceType.FLIGHT],
      } as Parameters<typeof createProvider>[0],
      { actor },
    );
    actingAs(skyways);
    const { order } = await createOrder(
      oneWayConnectingFlightInput({ provider: "AIRINDIA" }),
      { actor },
    );
    await initiatePayment(order.id, { actor });

    const name = getCurrentTestStripe().sessionsCreated[0]!.params.line_items![0]!
      .price_data!.product_data!.name;
    expect(name.startsWith("Air India • ")).toBe(true);
    expect(name).toContain("Flight booking service charge");
    expect(name).not.toContain("AIRINDIA");
  });

  it.each([
    { bookingType: BookingType.MODIFICATION, qualifier: "Booking modification", noun: "booking modification" },
    { bookingType: BookingType.CANCELLATION_CHARGE, qualifier: "Cancellation charge", noun: "cancellation charge" },
  ])(
    "qualifies a $bookingType line item for what it is — not a service charge",
    async ({ bookingType, qualifier, noun }) => {
      actingAs(skyways);
      const { order } = await createOrder(oneWayConnectingFlightInput({ bookingType }), { actor });
      await initiatePayment(order.id, { actor });

      const product = getCurrentTestStripe().sessionsCreated[0]!.params.line_items![0]!
        .price_data!.product_data!;
      expect(product.name).toContain(noun);
      expect(product.name).not.toContain("service charge");
      expect(product.description!.startsWith(`${qualifier} • `)).toBe(true);
      expect(product.description).toContain("Departs: Sat, Oct 10, 2026 10:30 AM");
    },
  );

  it("keeps a car order's PREPAID-only amount: 249.99 + 100 due at counter → 24999", async () => {
    actingAs(rentalconfirmation);
    const { order } = await createOrder(
      validCreateOrderInput({
        charges: [
          { name: "Rental cost", amount: 249.99, timing: PaymentTiming.PREPAID },
          { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
        ],
      }),
      { actor },
    );
    await initiatePayment(order.id, { actor });

    const price = getCurrentTestStripe().sessionsCreated[0]!.params.line_items![0]!.price_data!;
    expect(price.unit_amount).toBe(24999);
    expect(price.currency).toBe("usd");
    expect(price.product_data!.name).toBe("Budget • Toyota Camry rental");
  });

  it("keeps a hotel's line item exactly as before", async () => {
    actingAs(skyways);
    const { order } = await createOrder(validHotelOrderInput(), { actor });
    await initiatePayment(order.id, { actor });

    const product = getCurrentTestStripe().sessionsCreated[0]!.params.line_items![0]!
      .price_data!.product_data!;
    expect(product.name).toBe("Budget • Hilton • Paris hotel");
    expect(product.description).toMatch(
      /^Check-in: \d{4}-\d{2}-\d{2} • Check-out: \d{4}-\d{2}-\d{2} • 3 nights$/,
    );
  });

  it("keeps a LEGACY flight's historic line item: '<provider> • <item> flight'", async () => {
    const legacy = await factoryCreateOrder({
      serviceType: ServiceType.FLIGHT,
      organizationId: skyways,
      status: OrderStatus.NOT_INITIATED,
      flight: {
        tripType: "ONE_WAY",
        airline: "Test Airways",
        flightNumber: "TA123",
        origin: "LHR",
        destination: "JFK",
        departureDate: new Date("2026-11-01T09:15:00.000Z"),
        cabinClass: "ECONOMY",
        passengers: { adults: 1, children: 0, infants: 0 },
      },
      pricing: { amount: 420.5, currency: "USD" as never },
    });
    actingAs(skyways);
    await initiatePayment(String(legacy._id), { actor });

    const price = getCurrentTestStripe().sessionsCreated[0]!.params.line_items![0]!.price_data!;
    expect(price.product_data!.name).toBe("Budget • Test Airways TA123 • LHR → JFK flight");
    expect(price.product_data!.name).not.toContain("service charge");
    expect(price.product_data!.description).toBe("Departs: 2026-11-01 • One way");
    // A legacy flight's prepaid line was usually its whole fare, collected as is.
    expect(price.unit_amount).toBe(42050);
  });
});

/* ------------------------------------------------------------------ *
 * The gateway amount — PayPal
 * ------------------------------------------------------------------ */

describe("PayPal is asked for the SERVICE CHARGE only", () => {
  it.each([
    { fare: 400, service: 100, value: "100.00" },
    { fare: 825, service: 75, value: "75.00" },
  ])(
    "airline fare $fare + service charge $service → purchase unit $value USD",
    async ({ fare, service, value }) => {
      const order = await flightIn(paypalair, fare, service);
      const { order: initiated } = await initiatePayment(order.id, { actor });
      expect(initiated.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);

      const created = paypalBodies.find((b) => "purchase_units" in b) as
        | { purchase_units: { amount: { currency_code: string; value: string } }[] }
        | undefined;
      expect(created, "PayPal order was never created").toBeTruthy();
      expect(created!.purchase_units).toHaveLength(1);
      expect(created!.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value });
      // Never touched Stripe.
      expect(getCurrentTestStripe().sessionsCreated).toHaveLength(0);
    },
  );

  it("describes the purchase as the flight booking service charge", async () => {
    const order = await flightIn(paypalair, 400, 100);
    await initiatePayment(order.id, { actor });
    const created = paypalBodies.find((b) => "purchase_units" in b) as {
      purchase_units: { description: string }[];
    };
    const description = created.purchase_units[0]!.description;
    expect(description.startsWith("Flight booking service charge • ")).toBe(true);
    expect(description.length).toBeLessThanOrEqual(127);
  });
});

/* ------------------------------------------------------------------ *
 * The evidence chain (dispute packet)
 * ------------------------------------------------------------------ */

describe("the evidence chain describes a flight from the order it already loaded", () => {
  it("carries the itinerary, the trip rows and the money split for a flight", async () => {
    const order = await flightIn(skyways, 400, 100);
    actingAs(skyways);
    const chain = await getEvidenceChain(order.id, { actor });

    expect(chain.flight).toBeDefined();
    expect(chain.flight!.serviceChargeModel).toBe(true);
    expect(chain.flight!.itinerary!.journeys[0]!.route).toBe("Delhi → Varanasi → Mumbai");
    expect(chain.flight!.itinerary!.journeys[0]!.connections[0]!.layover).toMatchObject({
      location: "Varanasi",
      minutes: 150,
    });
    expect(chain.flight!.details.map((r) => r.label)).toEqual([
      "Trip type",
      "Route",
      "Cabin",
      "Passengers",
    ]);
    expect(chain.flight!.amounts).toMatchObject({
      airlineFare: 400,
      serviceCharge: 100,
      dueLater: 0,
      bookingTotal: 500,
    });
  });

  it("reports money as collected only once the order is PAID", async () => {
    const unpaid = await flightIn(skyways, 400, 100);
    actingAs(skyways);
    expect((await getEvidenceChain(unpaid.id, { actor })).flight!.collection).toEqual({
      status: "NOT_COLLECTED",
      amount: null,
    });

    const paid = await factoryCreateOrder({
      serviceType: ServiceType.FLIGHT,
      organizationId: skyways,
      flight: itineraryFlight(),
      status: OrderStatus.PAID,
      pricing: { amount: 100, currency: "USD" as never },
      charges: [{ name: "Service charge", amount: 100, timing: PaymentTiming.PREPAID }],
      payment: {
        status: OrderStatus.PAID,
        paidAt: new Date(),
        amountReceived: 100,
        processedWebhookEventIds: [],
      } as never,
    });
    const chain = await getEvidenceChain(String(paid._id), { actor });
    expect(chain.flight!.collection).toEqual({ status: "COLLECTED", amount: 100 });
    // Collected is the service charge — never the fare or the booking value.
    expect(chain.flight!.amounts.bookingTotal).toBe(500);
  });

  it("folds a LEGACY flight into the same view, labelled UTC and worded neutrally", async () => {
    const legacy = await factoryCreateOrder({
      serviceType: ServiceType.FLIGHT,
      organizationId: skyways,
    });
    actingAs(skyways);
    const chain = await getEvidenceChain(String(legacy._id), { actor });
    expect(chain.flight!.serviceChargeModel).toBe(false);
    expect(chain.flight!.itinerary!.legacy).toBe(true);
    expect(chain.flight!.itinerary!.journeys[0]!.timeZoneLabel).toBe("UTC");
  });

  it("adds no flight key at all to a car rental's chain", async () => {
    actingAs(skyways);
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    const chain = await getEvidenceChain(order.id, { actor });
    expect("flight" in chain).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Provider wording
 * ------------------------------------------------------------------ */

describe("an unknown provider key is worded for the service", () => {
  it("calls a flight's missing provider an airline or supplier", async () => {
    await expect(
      buildProviderSnapshotFromKey("NOSUCHAIRLINE", ServiceType.FLIGHT),
    ).rejects.toThrow("Unknown airline or supplier");
  });

  it("keeps 'Unknown rental provider' for a car, with or without a service type", async () => {
    await expect(
      buildProviderSnapshotFromKey("NOSUCHRENTAL", ServiceType.CAR_RENTAL),
    ).rejects.toThrow("Unknown rental provider");
    await expect(buildProviderSnapshotFromKey("NOSUCHRENTAL")).rejects.toThrow(
      "Unknown rental provider",
    );
  });

  it("surfaces the airline wording when a flight order names an unknown provider", async () => {
    actingAs(skyways);
    await expect(
      createOrder(validFlightOrderInput({ provider: "NOSUCHAIRLINE" }), { actor }),
    ).rejects.toThrow("Unknown airline or supplier");
  });
});
