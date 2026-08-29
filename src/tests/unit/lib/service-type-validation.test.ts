import { describe, expect, it } from "vitest";

import { ServiceType } from "@/lib/constants/enums";
import {
  createOrderRequestSchema,
  createOrderSchema,
  flightOrderSchema,
  hotelOrderSchema,
} from "@/lib/validation/order";
import {
  invalidTripDatesInput,
  validCreateOrderInput,
  validFlightOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * Pure-zod validation of the three service types. No database, no session,
 * no service layer — just "does the schema accept the payloads an operator
 * can legitimately submit, and refuse the ones that would produce a booking
 * nobody can fulfil".
 *
 * Requirement 10 is the non-regression half: the car-rental schema two
 * production brands submit against every day is `createOrderSchema`, and it
 * must be untouched — same acceptance, same rejection, same MESSAGE. The
 * car-rental union member is derived from it with `.extend()`, so both are
 * exercised here to prove they cannot drift.
 */

/** Days from now, as an ISO string — keeps every fixture date in the future. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** All zod issue messages for a failed parse. */
function messagesOf(result: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }): string[] {
  return result.success ? [] : result.error!.issues.map((i) => i.message);
}

function pathsOf(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] {
  return result.success ? [] : result.error!.issues.map((i) => i.path.join("."));
}

/* ------------------------------------------------------------------ *
 * Requirement 8 — flight validation
 * ------------------------------------------------------------------ */

describe("requirement 8: FLIGHT validation", () => {
  it("REJECTS a round trip whose return date is before departure", () => {
    const input = validFlightOrderInput({
      flight: {
        ...validFlightOrderInput().flight,
        tripType: "ROUND_TRIP",
        departureDate: inDays(10),
        returnDate: inDays(3),
      },
    });

    const result = flightOrderSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("Return must be on or after departure");
    expect(pathsOf(result)).toContain("flight.returnDate");
  });

  it("REJECTS a round trip with no return date at all", () => {
    // The neighbouring rule: a round trip that never comes back is not a
    // round trip, and the operator cannot source the fare.
    const input = validFlightOrderInput({
      flight: {
        ...validFlightOrderInput().flight,
        tripType: "ROUND_TRIP",
        returnDate: null,
      },
    });

    const result = flightOrderSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain(
      "Return date is required for a round trip",
    );
  });

  it("ACCEPTS a round trip returning on the same day as departure", () => {
    // "on or after" — a same-day return is a legitimate business day trip
    // and must not be caught by the before-departure rule.
    const sameDay = inDays(10);
    const input = validFlightOrderInput({
      flight: {
        ...validFlightOrderInput().flight,
        tripType: "ROUND_TRIP",
        departureDate: sameDay,
        returnDate: sameDay,
      },
    });

    expect(flightOrderSchema.safeParse(input).success).toBe(true);
  });

  it("ACCEPTS a one-way flight with NO return date", () => {
    const input = validFlightOrderInput({
      flight: {
        ...validFlightOrderInput().flight,
        tripType: "ONE_WAY",
        returnDate: null,
      },
    });

    const result = flightOrderSchema.safeParse(input);
    expect(result.success, messagesOf(result).join("; ")).toBe(true);
  });

  it("ACCEPTS a one-way flight with the return key omitted entirely", () => {
    // A client that simply never sends the key is not the same payload as
    // one sending null; both are legitimate one-way requests.
    const flight = { ...validFlightOrderInput().flight, tripType: "ONE_WAY" as const };
    delete (flight as Record<string, unknown>).returnDate;
    const input = { ...validFlightOrderInput(), flight } as never;

    const result = flightOrderSchema.safeParse(input);
    expect(result.success, messagesOf(result).join("; ")).toBe(true);
  });

  it("REJECTS an origin equal to the destination", () => {
    const input = validFlightOrderInput({
      flight: {
        ...validFlightOrderInput().flight,
        origin: "LHR",
        destination: "LHR",
      },
    });

    const result = flightOrderSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("Destination must differ from origin");
    expect(pathsOf(result)).toContain("flight.destination");
  });

  it("REJECTS an origin equal to the destination ignoring case and padding", () => {
    const input = validFlightOrderInput({
      flight: {
        ...validFlightOrderInput().flight,
        origin: "lhr",
        destination: "  LHR  ",
      },
    });

    expect(flightOrderSchema.safeParse(input).success).toBe(false);
  });

  it("REJECTS zero adults", () => {
    const input = validFlightOrderInput({
      flight: {
        ...validFlightOrderInput().flight,
        passengers: { adults: 0, children: 2, infants: 0 },
      },
    });

    const result = flightOrderSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("At least one adult is required");
  });

  it("ACCEPTS the canonical valid flight request", () => {
    const result = flightOrderSchema.safeParse(validFlightOrderInput());
    expect(result.success, messagesOf(result).join("; ")).toBe(true);
  });

  it("routes a FLIGHT payload to the flight rules through the request union", () => {
    // The union is what the API route actually parses; a discriminator that
    // fell through to the rental member would accept a flight with no
    // vehicle and reject a legitimate one.
    const bad = validFlightOrderInput({
      flight: {
        ...validFlightOrderInput().flight,
        origin: "JFK",
        destination: "JFK",
      },
    });
    const result = createOrderRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("Destination must differ from origin");

    const good = createOrderRequestSchema.safeParse(validFlightOrderInput());
    expect(good.success, messagesOf(good).join("; ")).toBe(true);
    if (good.success) {
      expect(good.data.serviceType).toBe(ServiceType.FLIGHT);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 9 — hotel validation
 * ------------------------------------------------------------------ */

describe("requirement 9: HOTEL validation", () => {
  it("REJECTS a check-out BEFORE check-in", () => {
    const input = validHotelOrderInput({
      hotel: {
        ...validHotelOrderInput().hotel,
        checkInDate: inDays(10),
        checkOutDate: inDays(8),
      },
    });

    const result = hotelOrderSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("Check-out must be after check-in");
    expect(pathsOf(result)).toContain("hotel.checkOutDate");
  });

  it("REJECTS a check-out EQUAL to check-in (a zero-night stay)", () => {
    const sameInstant = inDays(10);
    const input = validHotelOrderInput({
      hotel: {
        ...validHotelOrderInput().hotel,
        checkInDate: sameInstant,
        checkOutDate: sameInstant,
      },
    });

    const result = hotelOrderSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("Check-out must be after check-in");
  });

  it("ACCEPTS a check-out AFTER check-in", () => {
    const input = validHotelOrderInput({
      hotel: {
        ...validHotelOrderInput().hotel,
        checkInDate: inDays(10),
        checkOutDate: inDays(11),
      },
    });

    const result = hotelOrderSchema.safeParse(input);
    expect(result.success, messagesOf(result).join("; ")).toBe(true);
  });

  it("REJECTS zero rooms", () => {
    const input = validHotelOrderInput({
      hotel: { ...validHotelOrderInput().hotel, rooms: 0 },
    });

    const result = hotelOrderSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain("At least one room is required");
  });

  it("ACCEPTS the canonical valid hotel request", () => {
    const result = hotelOrderSchema.safeParse(validHotelOrderInput());
    expect(result.success, messagesOf(result).join("; ")).toBe(true);
  });

  it("routes a HOTEL payload to the hotel rules through the request union", () => {
    const bad = validHotelOrderInput({
      hotel: { ...validHotelOrderInput().hotel, rooms: 0 },
    });
    expect(createOrderRequestSchema.safeParse(bad).success).toBe(false);

    const good = createOrderRequestSchema.safeParse(validHotelOrderInput());
    expect(good.success, messagesOf(good).join("; ")).toBe(true);
    if (good.success) {
      expect(good.data.serviceType).toBe(ServiceType.HOTEL);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Requirement 10 — car rental is UNCHANGED
 * ------------------------------------------------------------------ */

describe("requirement 10: CAR_RENTAL validation still behaves exactly as before", () => {
  it("still REJECTS a drop-off before pick-up, with the same message and path", () => {
    const result = createOrderSchema.safeParse(invalidTripDatesInput());
    expect(result.success).toBe(false);
    // Pinned verbatim: this string is rendered under the drop-off field in
    // both production brands' create-order form.
    expect(messagesOf(result)).toContain("Drop-off must be after pick-up");
    expect(pathsOf(result)).toContain("trip.dropoffDate");
  });

  it("still ACCEPTS a valid rental input", () => {
    const result = createOrderSchema.safeParse(validCreateOrderInput());
    expect(result.success, messagesOf(result).join("; ")).toBe(true);
  });

  it("gives the derived CAR_RENTAL union member the identical rejection", () => {
    // `carRentalOrderSchema` is `createOrderSchema.extend({ serviceType })`.
    // If the rental rules were ever re-implemented instead of extended, the
    // two message lists would diverge here.
    const base = createOrderSchema.safeParse(invalidTripDatesInput());
    const viaUnion = createOrderRequestSchema.safeParse({
      ...invalidTripDatesInput(),
      serviceType: ServiceType.CAR_RENTAL,
    });

    expect(viaUnion.success).toBe(false);
    expect(messagesOf(viaUnion)).toEqual(messagesOf(base));
    expect(pathsOf(viaUnion)).toEqual(pathsOf(base));
  });

  it("gives the derived CAR_RENTAL union member the identical acceptance", () => {
    // ONE fixture, parsed twice. `validCreateOrderInput()` derives its trip
    // dates from `Date.now()`, so calling it a second time yields timestamps
    // a millisecond apart and the deep-equal below fails intermittently —
    // which is a flaw in the test, not in the schema. Sharing the input is
    // also what makes this assertion mean what it claims: that the SCHEMAS
    // agree, not that two fixtures happen to match.
    const input = validCreateOrderInput();
    const base = createOrderSchema.safeParse(input);
    const viaUnion = createOrderRequestSchema.safeParse({
      ...input,
      serviceType: ServiceType.CAR_RENTAL,
    });

    expect(base.success).toBe(true);
    expect(viaUnion.success, messagesOf(viaUnion).join("; ")).toBe(true);
    if (base.success && viaUnion.success) {
      const { serviceType, ...rest } = viaUnion.data as Record<string, unknown> & {
        serviceType: string;
      };
      expect(serviceType).toBe(ServiceType.CAR_RENTAL);
      // Everything else parses to precisely what the rental schema produced.
      expect(rest).toEqual(base.data);
    }
  });

  it("still rejects a rental with no prepaid charge line", () => {
    const result = createOrderSchema.safeParse(
      validCreateOrderInput({
        charges: [
          { name: "Deposit", amount: 100, timing: "DUE_AT_COUNTER" as never },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(messagesOf(result)).toContain(
      "At least one prepaid charge is required to collect payment",
    );
  });
});
