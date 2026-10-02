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
import { Order, Setting, SETTINGS_KEY } from "@/server/db/models";
import {
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
  DEFAULT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { createOrder } from "@/server/services/order.service";
import {
  getSettings,
  termsForService,
  updateSettings,
} from "@/server/services/settings.service";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { createSettings } from "@/tests/factories/settings.factory";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";

/**
 * WHICH TERMS & CONDITIONS A CUSTOMER IS ASKED TO ACCEPT.
 *
 * The rental terms name a counter, a driver's licence and a vehicle to
 * return. A flight customer has none of those, so sending them that text is
 * a customer-facing defect, not a wording preference.
 *
 * Selection happens once, at order creation, into `order.terms` — every
 * downstream surface (both emails, the hosted acknowledgement page, the
 * evidence chain) reads that snapshot. So these assert the snapshot, and the
 * car assertions matter as much as the flight ones.
 */

/** Phrases that are only true of a car rental. None may reach a flight. */
const RENTAL_ONLY = [
  "due at counter",
  "driver's licence",
  "rental location at pick-up",
  "vehicle",
  "counter",
];

function flightInput(overrides: Record<string, unknown> = {}) {
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
      departureDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
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

describe("termsForService", () => {
  it("hands a car order the rental terms and the RENTAL version", async () => {
    const settings = await getSettings();
    expect(termsForService(settings, ServiceType.CAR_RENTAL)).toEqual({
      text: settings.termsAndConditions,
      version: settings.termsVersion,
    });
  });

  it("hands a flight order the flight terms and the FLIGHT version", async () => {
    const settings = await getSettings();
    expect(termsForService(settings, ServiceType.FLIGHT)).toEqual({
      text: settings.flightTermsAndConditions,
      version: settings.flightTermsVersion,
    });
  });

  it("keeps the two texts distinct by default", async () => {
    const settings = await getSettings();
    expect(settings.flightTermsAndConditions).not.toBe(
      settings.termsAndConditions,
    );
  });
});

describe("the default flight terms", () => {
  it("carry no rental-only wording", () => {
    const text = DEFAULT_FLIGHT_TERMS_AND_CONDITIONS.toLowerCase();
    for (const phrase of RENTAL_ONLY) {
      expect(text).not.toContain(phrase);
    }
  });

  it("leave the rental defaults exactly as they were", () => {
    // The requirement is that existing car copy is untouched. These two
    // phrases are load-bearing in the rental terms; their absence would mean
    // someone edited the car text while adding flights.
    expect(DEFAULT_TERMS_AND_CONDITIONS).toContain("due at counter");
    expect(DEFAULT_TERMS_AND_CONDITIONS).toContain("driver's licence");
  });
});

describe("createOrder snapshots the right terms", () => {
  it("gives a FLIGHT order the flight terms, free of rental wording", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const created = await createOrder(flightInput() as never, { actor });

    const doc = await Order.findById(created.order.id).lean();
    const snapshot = (doc?.terms?.text ?? "").toLowerCase();
    expect(snapshot.length).toBeGreaterThan(0);
    for (const phrase of RENTAL_ONLY) {
      expect(snapshot).not.toContain(phrase);
    }
  });

  it("gives a CAR order exactly the rental terms it always got", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const settings = await getSettings();
    const created = await createOrder(validCreateOrderInput(), { actor });

    const doc = await Order.findById(created.order.id).lean();
    expect(doc?.terms?.text).toBe(settings.termsAndConditions);
    expect(doc?.terms?.version).toBe(settings.termsVersion);
  });

  it("carries the operator's edited flight text onto a new flight order", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const edited =
      "Tickets are issued on payment and the passenger name cannot be changed afterwards.";
    await createSettings({ flightTermsAndConditions: edited });

    const created = await createOrder(flightInput() as never, { actor });
    const doc = await Order.findById(created.order.id).lean();
    expect(doc?.terms?.text).toBe(edited);
  });

  it("does not let edited flight text leak onto a car order", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const edited = "Flight-only clause that must never appear on a rental.";
    await createSettings({ flightTermsAndConditions: edited });

    const created = await createOrder(validCreateOrderInput(), { actor });
    const doc = await Order.findById(created.order.id).lean();
    expect(doc?.terms?.text).not.toBe(edited);
    expect(doc?.terms?.text).toBe(DEFAULT_TERMS_AND_CONDITIONS);
  });
});

describe("terms versioning stays per-service", () => {
  it("bumps only the flight version when flight text changes", async () => {
    const before = await getSettings();
    await updateSettings(
      {
        flightTermsAndConditions:
          "Revised flight terms, long enough to satisfy the schema minimum.",
      } as never,
      { actorId: actorFor().id, actorName: "QA", actorRole: "ADMIN" },
    );

    const after = await getSettings();
    expect(after.flightTermsVersion).not.toBe(before.flightTermsVersion);
    // The rental order snapshot must not start claiming a new revision.
    expect(after.termsVersion).toBe(before.termsVersion);
    expect(after.termsAndConditions).toBe(before.termsAndConditions);
  });

  it("bumps only the rental version when rental text changes", async () => {
    const before = await getSettings();
    await updateSettings(
      {
        termsAndConditions:
          "Revised rental terms, long enough to satisfy the schema minimum.",
      } as never,
      { actorId: actorFor().id, actorName: "QA", actorRole: "ADMIN" },
    );

    const after = await getSettings();
    expect(after.termsVersion).not.toBe(before.termsVersion);
    expect(after.flightTermsVersion).toBe(before.flightTermsVersion);
    expect(after.flightTermsAndConditions).toBe(
      before.flightTermsAndConditions,
    );
  });
});

describe("a settings document written before flights existed", () => {
  it("still serves flight terms, with no migration", async () => {
    // Exactly what an old production document looks like: the flight fields
    // were never written. Reading must substitute the default rather than
    // fall back to the rental text.
    await Setting.updateOne(
      { key: SETTINGS_KEY },
      { $unset: { flightTermsAndConditions: "", flightTermsVersion: "" } },
    );

    const settings = await getSettings();
    expect(settings.flightTermsAndConditions).toBe(
      DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
    );
    expect(settings.flightTermsVersion).toBe("v1");

    const actor = actorFor(UserRole.ADMIN);
    const created = await createOrder(flightInput() as never, { actor });
    const doc = await Order.findById(created.order.id).lean();
    const snapshot = (doc?.terms?.text ?? "").toLowerCase();
    for (const phrase of RENTAL_ONLY) {
      expect(snapshot).not.toContain(phrase);
    }
  });
});
