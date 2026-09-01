import { describe, expect, it } from "vitest";

import {
  createOrderRequestSchema,
  createOrderSchema,
  cruiseOrderSchema,
  flightOrderSchema,
} from "@/lib/validation";
import { ServiceType, TripType } from "@/lib/constants/enums";
import {
  validCreateOrderInput,
  validCruiseOrderInput,
  validFlightOrderInput,
  validOneWayFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * The create-order union is the ONE boundary between an operator's form and
 * a persisted booking, so its rules are pinned here rather than inferred
 * from whichever form happens to call it.
 *
 * Two properties matter most, and both are about NOT breaking things:
 *
 *   1. The car-rental member is derived from `createOrderSchema` with
 *      `.extend()`, so an inherited rental payload must validate through the
 *      union exactly as it validates through the original schema.
 *   2. Each member is validated by ITS OWN rules. A flight payload must not
 *      be able to satisfy the cruise member, and neither may be waved
 *      through by a shared "everything optional" object.
 */

const iso = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString();

describe("the discriminated union routes by serviceType", () => {
  it("validates a car-rental payload under the rental rules", () => {
    const parsed = createOrderRequestSchema.parse(validCreateOrderInput());
    expect(parsed.serviceType).toBe(ServiceType.CAR_RENTAL);
    expect("vehicle" in parsed && parsed.vehicle.company).toBe("Toyota");
  });

  it("accepts a rental payload the ORIGINAL schema accepts", () => {
    // The union member is `createOrderSchema.extend({ serviceType })`, so
    // anything the original accepts must survive the union. If this ever
    // fails, the two have drifted and every inherited caller is at risk.
    const input = validCreateOrderInput();
    expect(() => createOrderSchema.parse(input)).not.toThrow();
    expect(() => createOrderRequestSchema.parse(input)).not.toThrow();
  });

  it("validates a flight payload under the flight rules", () => {
    const parsed = createOrderRequestSchema.parse(validFlightOrderInput());
    expect(parsed.serviceType).toBe(ServiceType.FLIGHT);
    expect("flight" in parsed && parsed.flight.origin).toContain("LHR");
  });

  it("validates a cruise payload under the cruise rules", () => {
    const parsed = createOrderRequestSchema.parse(validCruiseOrderInput());
    expect(parsed.serviceType).toBe(ServiceType.CRUISE);
    expect("cruise" in parsed && parsed.cruise.departurePort).toBe("Miami, FL");
  });

  it("refuses a flight payload wearing the cruise discriminator", () => {
    const smuggled = {
      ...validFlightOrderInput(),
      serviceType: ServiceType.CRUISE,
    };
    expect(() => createOrderRequestSchema.parse(smuggled)).toThrow();
  });

  it("refuses an unknown service type outright", () => {
    const bogus = { ...validCruiseOrderInput(), serviceType: "SAFARI" };
    expect(() => createOrderRequestSchema.parse(bogus)).toThrow();
  });
});

describe("flight rules", () => {
  it("accepts a one-way with no return leg", () => {
    const parsed = flightOrderSchema.parse(validOneWayFlightOrderInput());
    expect(parsed.flight.tripType).toBe(TripType.ONE_WAY);
    expect(parsed.flight.returnDate).toBeFalsy();
  });

  it("requires a return date on a round trip", () => {
    const input = validFlightOrderInput();
    const result = flightOrderSchema.safeParse({
      ...input,
      flight: { ...input.flight, returnDate: null },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "Return date is required for a round trip",
    );
  });

  it("refuses a return before the departure", () => {
    const input = validFlightOrderInput();
    const result = flightOrderSchema.safeParse({
      ...input,
      flight: {
        ...input.flight,
        departureDate: iso(20),
        returnDate: iso(10),
      },
    });
    expect(result.success).toBe(false);
  });

  it("allows a same-day return — a day trip is a real fare", () => {
    const input = validFlightOrderInput();
    const day = iso(12);
    const result = flightOrderSchema.safeParse({
      ...input,
      flight: { ...input.flight, departureDate: day, returnDate: day },
    });
    expect(result.success).toBe(true);
  });

  it("refuses a destination equal to the origin", () => {
    const input = validFlightOrderInput();
    const result = flightOrderSchema.safeParse({
      ...input,
      flight: { ...input.flight, destination: input.flight.origin },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "Destination must differ from origin",
    );
  });

  it("refuses an arrival before the departure", () => {
    const input = validFlightOrderInput();
    const result = flightOrderSchema.safeParse({
      ...input,
      flight: {
        ...input.flight,
        departureDate: iso(20),
        arrivalDate: iso(19),
      },
    });
    expect(result.success).toBe(false);
  });

  it("requires every infant to have an accompanying adult", () => {
    const input = validFlightOrderInput();
    const result = flightOrderSchema.safeParse({
      ...input,
      flight: {
        ...input.flight,
        passengers: { adults: 1, children: 0, infants: 2 },
      },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "Each infant must travel with an adult",
    );
  });

  it("requires at least one prepaid charge — a link that charges nothing is not a payment request", () => {
    const input = validFlightOrderInput();
    const result = flightOrderSchema.safeParse({
      ...input,
      charges: [
        { name: "Taxes", amount: 90, timing: "DUE_AT_COUNTER" as const },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("cruise rules", () => {
  it("accepts a round trip with no disembarkation port", () => {
    const parsed = cruiseOrderSchema.parse(validCruiseOrderInput());
    expect(parsed.cruise.arrivalPort).toBeFalsy();
    expect(parsed.cruise.departurePort).toBe("Miami, FL");
  });

  it("accepts a one-way repositioning sailing", () => {
    const input = validCruiseOrderInput();
    const parsed = cruiseOrderSchema.parse({
      ...input,
      cruise: { ...input.cruise, arrivalPort: "Barcelona, Spain" },
    });
    expect(parsed.cruise.arrivalPort).toBe("Barcelona, Spain");
  });

  it("requires a return date — a sailing always comes back", () => {
    const input = validCruiseOrderInput();
    const result = cruiseOrderSchema.safeParse({
      ...input,
      cruise: { ...input.cruise, returnDate: "" },
    });
    expect(result.success).toBe(false);
  });

  it("refuses a same-day return, unlike a flight", () => {
    // The distinction is deliberate: a day flight is a product, a zero-night
    // cruise is a typo.
    const input = validCruiseOrderInput();
    const day = iso(30);
    const result = cruiseOrderSchema.safeParse({
      ...input,
      cruise: { ...input.cruise, departureDate: day, returnDate: day },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "Return must be after the sailing date",
    );
  });

  it("refuses a return before the sailing date", () => {
    const input = validCruiseOrderInput();
    const result = cruiseOrderSchema.safeParse({
      ...input,
      cruise: {
        ...input.cruise,
        departureDate: iso(40),
        returnDate: iso(30),
      },
    });
    expect(result.success).toBe(false);
  });

  it("requires a departure port", () => {
    const input = validCruiseOrderInput();
    const result = cruiseOrderSchema.safeParse({
      ...input,
      cruise: { ...input.cruise, departurePort: "" },
    });
    expect(result.success).toBe(false);
  });

  it("refuses an unknown cabin category", () => {
    const input = validCruiseOrderInput();
    const result = cruiseOrderSchema.safeParse({
      ...input,
      cruise: { ...input.cruise, cabinCategory: "PENTHOUSE" },
    });
    expect(result.success).toBe(false);
  });

  it("keeps a due-later line as long as something is prepaid", () => {
    // The fixture carries gratuities as DUE_AT_COUNTER alongside a prepaid
    // fare, which is the shape a real cruise deposit takes.
    const parsed = cruiseOrderSchema.parse(validCruiseOrderInput());
    expect(parsed.charges).toHaveLength(2);
    expect(parsed.charges.some((c) => c.timing === "DUE_AT_COUNTER")).toBe(
      true,
    );
  });
});
