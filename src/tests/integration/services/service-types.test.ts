import { beforeEach, describe, expect, it } from "vitest";

import {
  OrderStatus,
  RecordState,
  ServiceType,
  TripType,
  UserRole,
} from "@/lib/constants/enums";
import { isAppError, type AppError } from "@/lib/errors";
import { Order, Provider } from "@/server/db/models";
import { actorFor } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { setOrganizationServiceTypes } from "@/tests/utils/organization";
import {
  validCreateOrderInput,
  validCruiseOrderInput,
  validFlightOrderInput,
  validOneWayFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

const { createOrder, initiatePayment, getOrderById, listOrders } = await import(
  "@/server/services/order.service"
);

const actor = actorFor(UserRole.ADMIN);

/** The single line item on the most recent Checkout session the gateway was
 *  asked to create — i.e. what the customer reads while entering their
 *  card, and what their bank statement will echo. */
function lastLineItem() {
  const recorded = getCurrentTestStripe().sessionsCreated.at(-1);
  expect(recorded, "expected a Checkout session to have been created").toBeDefined();
  return recorded!.params.line_items![0]!;
}

/**
 * RCR Cruise sells flights and cruises. These tests exercise both through the
 * real service layer — persistence, the tenant allow-list, the supplier
 * guard, the gateway description, and the list/search paths — plus the
 * regression that matters most: a car-rental order created the way it always
 * was must still work, unchanged.
 */

/** Suppliers the fixtures reference. Seeded per test because the automatic
 *  starter catalog is CAR_RENTAL-only and is skipped entirely once the
 *  organization stops selling car rental. */
async function seedServiceProviders() {
  await Provider.create([
    {
      key: "TESTAIR",
      name: "Test Airways",
      logo: "/providers/_placeholder.svg",
      primaryColor: "#0078D2",
      onPrimaryColor: "#FFFFFF",
      tagline: "Test airline",
      serviceTypes: [ServiceType.FLIGHT],
      status: RecordState.ACTIVE,
      sortOrder: 100,
    },
    {
      key: "TESTCRUISE",
      name: "Test Cruise Line",
      logo: "/providers/_placeholder.svg",
      primaryColor: "#003DA5",
      onPrimaryColor: "#FFFFFF",
      tagline: "Test cruise line",
      serviceTypes: [ServiceType.CRUISE],
      status: RecordState.ACTIVE,
      sortOrder: 200,
    },
  ]);
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedServiceProviders();
  // The seeded organization defaults to CAR_RENTAL. Widening it here is what
  // the RCR Cruise seed does via SEED_ORGS_SERVICE_TYPES, and doing it
  // explicitly is what proves the allow-list is load-bearing rather than
  // decorative — the "refuses" tests below narrow it again.
  await setOrganizationServiceTypes([
    ServiceType.CAR_RENTAL,
    ServiceType.FLIGHT,
    ServiceType.CRUISE,
  ]);
});

/* ─────────────────────────── Flights ─────────────────────────── */

describe("creating a flight order", () => {
  it("persists the flight payload and no rental payload", async () => {
    const { order } = await createOrder(validFlightOrderInput(), { actor });

    expect(order.serviceType).toBe(ServiceType.FLIGHT);
    expect(order.flight?.origin).toContain("LHR");
    expect(order.flight?.destination).toContain("JFK");
    expect(order.flight?.cabinClass).toBe("ECONOMY");
    expect(order.flight?.passengers).toEqual({
      adults: 2,
      children: 1,
      infants: 0,
    });
    // A flight is not a half-filled car rental. Both rental blocks must be
    // explicitly absent, or the detail card and the receipt would render a
    // "Pick-up" row for a flight.
    expect(order.vehicle).toBeNull();
    expect(order.trip).toBeNull();
    expect(order.cruise).toBeNull();
  });

  it("starts NOT_INITIATED with no gateway session, like every order", async () => {
    const { order, checkoutUrl } = await createOrder(validFlightOrderInput(), {
      actor,
    });
    expect(order.status).toBe(OrderStatus.NOT_INITIATED);
    expect(order.payment.paymentUrl).toBeNull();
    expect(checkoutUrl).toBeNull();
  });

  it("charges only the PREPAID total, exactly as a rental does", async () => {
    const { order } = await createOrder(
      validFlightOrderInput({
        charges: [
          { name: "Airfare", amount: 900, timing: "PREPAID" },
          { name: "Baggage", amount: 120, timing: "DUE_AT_COUNTER" },
        ],
      }),
      { actor },
    );
    expect(order.pricing.amount).toBe(900);

    const { order: live } = await initiatePayment(order.id, { actor });
    expect(live.payment.paymentUrl).toBeTruthy();
    // Minor units of the PREPAID figure only — never the booking total.
    expect(lastLineItem().price_data?.unit_amount).toBe(90_000);
  });

  it("describes the route on the gateway checkout page, not a vehicle", async () => {
    const { order } = await createOrder(validFlightOrderInput(), { actor });
    await initiatePayment(order.id, { actor });

    const product = lastLineItem().price_data?.product_data;
    // This is the string the customer reads while entering their card.
    expect(product?.name).toContain("LHR");
    expect(product?.name).toContain("JFK");
    expect(product?.name).toContain("flight");
    expect(product?.description).toContain("Departs:");
    expect(product?.description).toContain("Returns:");
    expect(product?.description).not.toContain("Pick-up");
  });

  it("stores a one-way with no return leg", async () => {
    const { order } = await createOrder(validOneWayFlightOrderInput(), {
      actor,
    });
    expect(order.flight?.tripType).toBe(TripType.ONE_WAY);
    expect(order.flight?.returnDate).toBeNull();
  });

  it("drops a stale return date when the operator switches to one-way", async () => {
    // The form clears the field, but a client that does not is not allowed
    // to persist a return leg on a trip that has none.
    const input = validFlightOrderInput();
    const { order } = await createOrder(
      {
        ...input,
        flight: { ...input.flight, tripType: TripType.ONE_WAY },
      },
      { actor },
    );
    expect(order.flight?.returnDate).toBeNull();
  });
});

/* ─────────────────────────── Cruises ─────────────────────────── */

describe("creating a cruise order", () => {
  it("persists the cruise payload and no rental payload", async () => {
    const { order } = await createOrder(validCruiseOrderInput(), { actor });

    expect(order.serviceType).toBe(ServiceType.CRUISE);
    expect(order.cruise?.cruiseLine).toBe("Royal Caribbean");
    expect(order.cruise?.shipName).toBe("Wonder of the Seas");
    expect(order.cruise?.departurePort).toBe("Miami, FL");
    expect(order.cruise?.cabinCategory).toBe("BALCONY");
    expect(order.cruise?.guests).toEqual({ adults: 2, children: 2 });
    expect(order.vehicle).toBeNull();
    expect(order.trip).toBeNull();
    expect(order.flight).toBeNull();
  });

  it("charges the deposit, not the total, when gratuities are due later", async () => {
    // The fixture is the real shape: fare prepaid, gratuities at the pier.
    const { order } = await createOrder(validCruiseOrderInput(), { actor });
    expect(order.pricing.amount).toBe(2480);

    await initiatePayment(order.id, { actor });
    expect(lastLineItem().price_data?.unit_amount).toBe(248_000);
  });

  it("describes the sailing on the gateway checkout page", async () => {
    const { order } = await createOrder(validCruiseOrderInput(), { actor });
    await initiatePayment(order.id, { actor });

    const product = lastLineItem().price_data?.product_data;
    expect(product?.name).toContain("Wonder of the Seas");
    expect(product?.name).toContain("cruise");
    expect(product?.description).toContain("Sails:");
    expect(product?.description).toContain("7 nights");
    expect(product?.description).not.toContain("Pick-up");
  });

  it("refuses a zero-night sailing at the model layer too", async () => {
    // Belt and braces: the schema rejects it, and so does the pre-validate
    // hook, so a write that bypasses the route cannot store one either.
    const input = validCruiseOrderInput();
    const sameDay = input.cruise.departureDate;
    await expect(
      Order.create({
        orderNumber: "TST-ZERO-NIGHT",
        bookingType: "NEW_BOOKING",
        serviceType: ServiceType.CRUISE,
        status: OrderStatus.NOT_INITIATED,
        state: RecordState.ACTIVE,
        customer: input.customer,
        provider: {
          id: "TESTCRUISE",
          name: "Test Cruise Line",
          logo: "/providers/_placeholder.svg",
        },
        cruise: {
          departurePort: "Miami, FL",
          departureDate: new Date(sameDay),
          returnDate: new Date(sameDay),
          cabinCategory: "INTERIOR",
          guests: { adults: 1, children: 0 },
        },
        pricing: { amount: 100, currency: "USD" },
        payment: {
          status: OrderStatus.NOT_INITIATED,
          processedWebhookEventIds: [],
        },
        createdBy: { userId: actor.id, name: actor.name, email: actor.email },
      }),
    ).rejects.toThrow(/Return date must be after the sailing date/);
  });
});

/* ─────────────────── The tenant allow-list ─────────────────── */

describe("an organization can only create what it sells", () => {
  it("refuses a cruise order on a flights-only brand", async () => {
    await setOrganizationServiceTypes([ServiceType.FLIGHT]);
    const err = await createOrder(validCruiseOrderInput(), { actor }).then(
      () => null,
      (e: unknown) => e as AppError,
    );
    expect(err && isAppError(err)).toBe(true);
    expect(err!.message).toMatch(/does not sell this service type/i);
  });

  it("refuses a flight order on a car-rental-only brand", async () => {
    await setOrganizationServiceTypes([ServiceType.CAR_RENTAL]);
    const err = await createOrder(validFlightOrderInput(), { actor }).then(
      () => null,
      (e: unknown) => e as AppError,
    );
    expect(err && isAppError(err)).toBe(true);
    expect(err!.message).toMatch(/does not sell this service type/i);
  });

  it("writes nothing when the service type is refused", async () => {
    await setOrganizationServiceTypes([ServiceType.FLIGHT]);
    await createOrder(validCruiseOrderInput(), { actor }).catch(() => {});
    expect(await Order.countDocuments({})).toBe(0);
  });

  it("still allows what the brand does sell", async () => {
    await setOrganizationServiceTypes([ServiceType.FLIGHT, ServiceType.CRUISE]);
    const { order } = await createOrder(validFlightOrderInput(), { actor });
    expect(order.serviceType).toBe(ServiceType.FLIGHT);
  });
});

/* ─────────────── The supplier / service-type guard ─────────────── */

describe("a supplier cannot be attached to the wrong service", () => {
  it("refuses a cruise line on a flight order", async () => {
    const err = await createOrder(
      validFlightOrderInput({ provider: "TESTCRUISE" }),
      { actor },
    ).then(
      () => null,
      (e: unknown) => e as AppError,
    );
    expect(err && isAppError(err)).toBe(true);
    expect(err!.message).toMatch(/not available for this service type/i);
  });

  it("refuses an airline on a cruise order", async () => {
    const err = await createOrder(
      validCruiseOrderInput({ provider: "TESTAIR" }),
      { actor },
    ).then(
      () => null,
      (e: unknown) => e as AppError,
    );
    expect(err && isAppError(err)).toBe(true);
    expect(err!.message).toMatch(/not available for this service type/i);
  });

  it("accepts a supplier that serves both", async () => {
    await Provider.create({
      key: "BOTH",
      name: "Multi Travel",
      logo: "/providers/_placeholder.svg",
      primaryColor: "#0B4F6C",
      onPrimaryColor: "#FFFFFF",
      tagline: "Flights and cruises",
      serviceTypes: [ServiceType.FLIGHT, ServiceType.CRUISE],
      status: RecordState.ACTIVE,
      sortOrder: 90,
    });
    const flight = await createOrder(
      validFlightOrderInput({ provider: "BOTH" }),
      { actor },
    );
    const cruise = await createOrder(
      validCruiseOrderInput({ provider: "BOTH" }),
      { actor },
    );
    expect(flight.order.provider.name).toBe("Multi Travel");
    expect(cruise.order.provider.name).toBe("Multi Travel");
  });
});

/* ─────────────────────── Listing and search ─────────────────────── */

describe("listing and search across services", () => {
  it("filters by service type", async () => {
    await createOrder(validFlightOrderInput(), { actor });
    await createOrder(validCruiseOrderInput(), { actor });
    await createOrder(validCreateOrderInput(), { actor });

    const flights = await listOrders(
      { serviceType: ServiceType.FLIGHT, state: "ACTIVE", page: 1, pageSize: 20 },
      { actor },
    );
    expect(flights.total).toBe(1);
    expect(flights.items[0]!.serviceType).toBe(ServiceType.FLIGHT);

    const cruises = await listOrders(
      { serviceType: ServiceType.CRUISE, state: "ACTIVE", page: 1, pageSize: 20 },
      { actor },
    );
    expect(cruises.total).toBe(1);

    const all = await listOrders(
      { state: "ACTIVE", page: 1, pageSize: 20 },
      { actor },
    );
    expect(all.total).toBe(3);
  });

  it("finds a flight by its route, which carries no vehicle to search", async () => {
    await createOrder(validFlightOrderInput(), { actor });
    const found = await listOrders(
      { q: "JFK", state: "ACTIVE", page: 1, pageSize: 20 },
      { actor },
    );
    expect(found.total).toBe(1);
  });

  it("finds a cruise by its ship name", async () => {
    await createOrder(validCruiseOrderInput(), { actor });
    const found = await listOrders(
      { q: "Wonder of the Seas", state: "ACTIVE", page: 1, pageSize: 20 },
      { actor },
    );
    expect(found.total).toBe(1);
  });

  it("still finds a car rental by its vehicle", async () => {
    await createOrder(validCreateOrderInput(), { actor });
    const found = await listOrders(
      { q: "Camry", state: "ACTIVE", page: 1, pageSize: 20 },
      { actor },
    );
    expect(found.total).toBe(1);
  });
});

/* ───────────────────── Car-rental regression ───────────────────── */

describe("car rental is unaffected", () => {
  it("creates exactly the order it always did", async () => {
    const { order } = await createOrder(validCreateOrderInput(), { actor });

    expect(order.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(order.vehicle?.company).toBe("Toyota");
    expect(order.trip?.pickupLocation).toBe("LAX Airport — Terminal 1");
    expect(order.flight).toBeNull();
    expect(order.cruise).toBeNull();
  });

  it("still describes a vehicle on the gateway checkout page", async () => {
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    await initiatePayment(order.id, { actor });

    const product = lastLineItem().price_data?.product_data;
    expect(product?.name).toContain("Toyota Camry");
    expect(product?.name).toContain("rental");
    expect(product?.description).toContain("Pick-up:");
    expect(product?.description).toContain("Drop-off:");
  });

  it("reads back an order stored with NO serviceType as a car rental", async () => {
    // The compatibility case that matters: every order inherited from the
    // car-rental baseline predates this field. Written straight through the
    // driver so Mongoose cannot apply its default on the way in.
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    await Order.collection.updateOne(
      { _id: Order.base.Types.ObjectId.createFromHexString(order.id) },
      { $unset: { serviceType: "" } },
    );

    const reread = await getOrderById(order.id, { actor });
    expect(reread.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(reread.vehicle?.company).toBe("Toyota");
  });

  it("includes an un-stamped order in a CAR_RENTAL filter", async () => {
    // The list filter is `$in: [CAR_RENTAL, null]` precisely so the service
    // filter is complete BEFORE the backfill script has run.
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    await Order.collection.updateOne(
      { _id: Order.base.Types.ObjectId.createFromHexString(order.id) },
      { $unset: { serviceType: "" } },
    );

    const rentals = await listOrders(
      {
        serviceType: ServiceType.CAR_RENTAL,
        state: "ACTIVE",
        page: 1,
        pageSize: 20,
      },
      { actor },
    );
    expect(rentals.total).toBe(1);
  });
});
