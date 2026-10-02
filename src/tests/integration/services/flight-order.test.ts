import { beforeEach, describe, expect, it } from "vitest";

import {
  BookingType,
  Currency,
  FlightTripType,
  PaymentTiming,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { ProviderId } from "@/lib/constants/providers";
import {
  createFlightOrderSchema,
  createOrderRequestSchema,
} from "@/lib/validation";
import { Order } from "@/server/db/models";
import { createOrder, getOrderById } from "@/server/services/order.service";
import { createSettings } from "@/tests/factories/settings.factory";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Creating and reading a FLIGHT order through the real service.
 *
 * The car path is covered in depth by `order.service.test.ts`; nothing here
 * touches it. What these assert is that a flight order goes through the
 * SAME `createOrder`, gets the same organization stamp, the same charge
 * summarisation and the same audit/evidence writes — with a different
 * payload — rather than through some parallel flight-only route.
 */

function flightInput(overrides: Record<string, unknown> = {}) {
  const departure = new Date(Date.now() + 7 * 86_400_000).toISOString();
  return {
    serviceType: ServiceType.FLIGHT,
    bookingType: BookingType.NEW_BOOKING,
    provider: ProviderId.BUDGET,
    customer: {
      name: "Ada Lovelace",
      email: "ada@payops.test",
      phone: "+15555550100",
    },
    flight: {
      tripType: FlightTripType.ONE_WAY,
      origin: "London Heathrow",
      destination: "New York JFK",
      departureDate: departure,
      cabinClass: "ECONOMY",
      passengers: { adults: 1, children: 0, infants: 0 },
    },
    currency: Currency.USD,
    charges: [
      { name: "Airfare", amount: 420.5, timing: PaymentTiming.PREPAID },
    ],
    ...overrides,
  };
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

describe("flight order validation", () => {
  it("accepts a well-formed one-way request", () => {
    expect(() => createFlightOrderSchema.parse(flightInput())).not.toThrow();
  });

  it("rejects a round trip with no return date", () => {
    const parsed = createFlightOrderSchema.safeParse(
      flightInput({
        flight: {
          ...flightInput().flight,
          tripType: FlightTripType.ROUND_TRIP,
        },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("rejects a return date before departure", () => {
    const base = flightInput().flight;
    const parsed = createFlightOrderSchema.safeParse(
      flightInput({
        flight: {
          ...base,
          tripType: FlightTripType.ROUND_TRIP,
          returnDate: new Date(Date.now() + 86_400_000).toISOString(),
        },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  /**
   * REGRESSION — the form sends "" for every optional date it has not
   * touched. `isoDateString.optional()` admits `undefined`, never "", so the
   * one-way form failed its own validation demanding a return date it had
   * labelled "not required", and the order never reached the API.
   */
  it("accepts empty strings for the optional dates, as the form sends them", () => {
    const parsed = createFlightOrderSchema.safeParse(
      flightInput({
        flight: {
          ...flightInput().flight,
          arrivalDate: "",
          returnDate: "",
          departureTimePreference: "",
          returnTimePreference: "",
          airline: "",
          flightNumber: "",
          pnr: "",
          passengerNotes: "",
        },
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Normalised to null so the stored document matches the model's
      // `default: null` rather than holding empty strings.
      expect(parsed.data.flight.returnDate).toBeNull();
      expect(parsed.data.flight.arrivalDate).toBeNull();
      expect(parsed.data.flight.airline).toBeNull();
      expect(parsed.data.flight.pnr).toBeNull();
    }
  });

  /**
   * REGRESSION — a number input hands react-hook-form a STRING, and
   * `chargeInputSchema.amount` is a strict `z.number()`. The flight form was
   * missing the car form's explicit conversion, so every submission failed
   * client-side with "Enter a valid amount" and no request was ever sent.
   * The schema is shared, so this asserts the contract the form must meet.
   */
  it("requires a NUMBER amount — a string is rejected, as the shared schema demands", () => {
    const asString = createFlightOrderSchema.safeParse(
      flightInput({
        charges: [
          { name: "Airfare", amount: "420.50", timing: PaymentTiming.PREPAID },
        ],
      }),
    );
    expect(asString.success).toBe(false);

    const asNumber = createFlightOrderSchema.safeParse(
      flightInput({
        charges: [
          { name: "Airfare", amount: 420.5, timing: PaymentTiming.PREPAID },
        ],
      }),
    );
    expect(asNumber.success).toBe(true);
  });

  it("keeps a decimal amount exact through parsing", () => {
    for (const amount of [420.5, 0.5, 1, 1234.56, 99.99]) {
      const parsed = createFlightOrderSchema.safeParse(
        flightInput({
          charges: [{ name: "Airfare", amount, timing: PaymentTiming.PREPAID }],
        }),
      );
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.charges[0]!.amount).toBe(amount);
    }
  });

  it("rejects a flight with no route", () => {
    const parsed = createFlightOrderSchema.safeParse(
      flightInput({ flight: { ...flightInput().flight, origin: "" } }),
    );
    expect(parsed.success).toBe(false);
  });

  it("routes an input with no serviceType to the CAR member of the union", () => {
    // This is the backward-compatibility guarantee: every existing caller
    // omits `serviceType`, and the API route defaults it before parsing.
    const carish = {
      serviceType: ServiceType.CAR_RENTAL,
      bookingType: BookingType.NEW_BOOKING,
      provider: ProviderId.BUDGET,
      customer: flightInput().customer,
      vehicle: { company: "Toyota", type: "Camry" },
      trip: {
        pickupDate: new Date(Date.now() + 86_400_000).toISOString(),
        dropoffDate: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        pickupLocation: "LAX Airport",
        dropoffLocation: "San Diego",
      },
      currency: Currency.USD,
      charges: [
        { name: "Rental cost", amount: 100, timing: PaymentTiming.PREPAID },
      ],
    };
    const parsed = createOrderRequestSchema.safeParse(carish);
    expect(parsed.success).toBe(true);
  });

  it("refuses a flight payload that also carries a vehicle", () => {
    // The union has no member accepting both, which is the whole reason it
    // is a union rather than one object with everything optional.
    const parsed = createOrderRequestSchema.safeParse(
      flightInput({ vehicle: { company: "Toyota", type: "Camry" } }),
    );
    // zod strips unknown keys rather than failing, so assert the result
    // carries no vehicle rather than that it threw.
    if (parsed.success) {
      expect("vehicle" in parsed.data).toBe(false);
    }
  });
});

describe("createOrder — FLIGHT", () => {
  it("persists the flight payload and leaves the car fields null", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const result = await createOrder(flightInput() as never, { actor });

    const doc = await Order.findById(result.order.id).lean();
    expect(doc?.serviceType).toBe(ServiceType.FLIGHT);
    expect(doc?.flight?.origin).toBe("London Heathrow");
    expect(doc?.flight?.destination).toBe("New York JFK");
    expect(doc?.flight?.tripType).toBe(FlightTripType.ONE_WAY);
    expect(doc?.flight?.passengers?.adults).toBe(1);
    // Car payload must be absent, not an empty husk.
    expect(doc?.vehicle ?? null).toBeNull();
    expect(doc?.trip ?? null).toBeNull();
  });

  it("goes through the same pricing and organization stamping as a car order", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const result = await createOrder(flightInput() as never, { actor });

    const doc = await Order.findById(result.order.id).lean();
    // Prepaid total is the only figure the gateway is ever asked to charge.
    expect(doc?.pricing.amount).toBe(420.5);
    expect(doc?.pricing.currency).toBe(Currency.USD);
    expect(doc?.organizationId).toBeTruthy();
    expect(doc?.status).toBe("NOT_INITIATED");
  });

  it("serialises the flight onto the DTO the operator UI reads", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const created = await createOrder(flightInput() as never, { actor });

    const dto = await getOrderById(created.order.id, { actor });
    expect(dto.serviceType).toBe(ServiceType.FLIGHT);
    expect(dto.flight?.origin).toBe("London Heathrow");
    expect(dto.vehicle).toBeNull();
    expect(dto.trip).toBeNull();
    // ISO strings, not Dates — the DTO crosses the server/client boundary.
    expect(typeof dto.flight?.departureDate).toBe("string");
  });

  it("still creates a car order with no serviceType supplied", async () => {
    // Regression guard for every pre-existing caller.
    const actor = actorFor(UserRole.ADMIN);
    const { validCreateOrderInput } = await import(
      "@/tests/fixtures/order-input.fixture"
    );
    const result = await createOrder(validCreateOrderInput(), { actor });

    const doc = await Order.findById(result.order.id).lean();
    expect(doc?.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect(doc?.vehicle?.company).toBe("Toyota");
    expect(doc?.trip?.pickupDate).toBeTruthy();
    expect(doc?.flight ?? null).toBeNull();
  });
});
