import { describe, expect, it } from "vitest";

import { ServiceType } from "@/lib/constants/enums";
import {
  describeServiceDates,
  describeServiceItem,
  isFlightOrder,
  serviceDetailRows,
  serviceItemLabel,
  serviceNoun,
  serviceTypeOf,
} from "@/lib/service-summary";

/**
 * The CAR_RENTAL half of these assertions is a CHARACTERIZATION test: every
 * expected string is what the call sites produced before service types
 * existed — the gateway line item, the email metadata rows, the consent
 * mailto body and the /pay/success detail table all fed off these exact
 * shapes. If one of them changes, a live car-rental customer sees different
 * copy on the page where they pay, so these are pinned deliberately and a
 * diff here should be treated as a regression until proven otherwise.
 */

const CAR = {
  serviceType: ServiceType.CAR_RENTAL,
  vehicle: { company: "Toyota", type: "Corolla" },
  trip: {
    pickupDate: "2026-03-01T10:00:00.000Z",
    dropoffDate: "2026-03-04T10:00:00.000Z",
    pickupLocation: "LAX Airport — Terminal 1",
    dropoffLocation: "San Diego Downtown",
  },
};

/** A row written before `serviceType` existed: no such key at all. This is
 *  what `.lean()` hands back for every pre-existing order. */
const LEGACY_CAR = { vehicle: CAR.vehicle, trip: CAR.trip };

const FLIGHT_ONE_WAY = {
  serviceType: ServiceType.FLIGHT,
  flight: {
    tripType: "ONE_WAY" as const,
    airline: "British Airways",
    flightNumber: "BA117",
    origin: "London Heathrow",
    destination: "New York JFK",
    departureDate: "2026-03-01T10:00:00.000Z",
    cabinClass: "ECONOMY",
    passengers: { adults: 2, children: 1, infants: 0 },
  },
};

describe("serviceTypeOf — the defaulting rule everything depends on", () => {
  it("defaults a row with no serviceType to CAR_RENTAL", () => {
    // `.lean()` does not apply Mongoose defaults, so every legacy order
    // arrives here with the key absent. Reading it as anything but a car
    // rental would mis-render every historical order at once.
    expect(serviceTypeOf(LEGACY_CAR)).toBe(ServiceType.CAR_RENTAL);
    expect(serviceTypeOf({ serviceType: null })).toBe(ServiceType.CAR_RENTAL);
    expect(isFlightOrder(LEGACY_CAR)).toBe(false);
  });

  it("reads an explicit FLIGHT", () => {
    expect(serviceTypeOf(FLIGHT_ONE_WAY)).toBe(ServiceType.FLIGHT);
    expect(isFlightOrder(FLIGHT_ONE_WAY)).toBe(true);
  });
});

describe("CAR_RENTAL output is unchanged (characterization)", () => {
  it("describes the vehicle exactly as before", () => {
    expect(describeServiceItem(CAR)).toBe("Toyota Corolla");
    expect(describeServiceItem(LEGACY_CAR)).toBe("Toyota Corolla");
    expect(serviceItemLabel(CAR)).toBe("Vehicle");
    expect(serviceNoun(CAR)).toBe("rental");
  });

  it("emits the gateway description byte-for-byte", () => {
    // This string is the Stripe/PayPal checkout line-item sub-description.
    expect(describeServiceDates(CAR)).toBe(
      "Pick-up: 2026-03-01 (LAX Airport — Terminal 1) • Drop-off: 2026-03-04 (San Diego Downtown)",
    );
  });

  it("omits the parenthesised locations when absent, as before", () => {
    expect(
      describeServiceDates({
        ...CAR,
        trip: { ...CAR.trip, pickupLocation: null, dropoffLocation: null },
      }),
    ).toBe("Pick-up: 2026-03-01 • Drop-off: 2026-03-04");
  });

  it("yields the Vehicle / Pick-up / Drop-off triple in that order", () => {
    expect(serviceDetailRows(CAR)).toEqual([
      { label: "Vehicle", value: "Toyota Corolla" },
      { label: "Pick-up", value: "2026-03-01" },
      { label: "Drop-off", value: "2026-03-04" },
    ]);
  });

  it("produces identical rows for a legacy row with no serviceType", () => {
    expect(serviceDetailRows(LEGACY_CAR)).toEqual(serviceDetailRows(CAR));
  });
});

describe("FLIGHT output", () => {
  it("describes the carrier and route", () => {
    expect(describeServiceItem(FLIGHT_ONE_WAY)).toBe(
      "British Airways BA117 • London Heathrow → New York JFK",
    );
    expect(serviceItemLabel(FLIGHT_ONE_WAY)).toBe("Route");
    expect(serviceNoun(FLIGHT_ONE_WAY)).toBe("flight");
  });

  it("falls back to the bare route when no carrier is known yet", () => {
    const f = {
      ...FLIGHT_ONE_WAY,
      flight: { ...FLIGHT_ONE_WAY.flight, airline: null, flightNumber: null },
    };
    expect(describeServiceItem(f)).toBe("London Heathrow → New York JFK");
  });

  it("says One way rather than inventing a return leg", () => {
    expect(describeServiceDates(FLIGHT_ONE_WAY)).toBe(
      "Departs: 2026-03-01 • One way",
    );
    expect(serviceDetailRows(FLIGHT_ONE_WAY)).toContainEqual({
      label: "Trip type",
      value: "One way",
    });
  });

  it("shows the return leg on a round trip", () => {
    const rt = {
      ...FLIGHT_ONE_WAY,
      flight: {
        ...FLIGHT_ONE_WAY.flight,
        tripType: "ROUND_TRIP" as const,
        returnDate: "2026-03-09T10:00:00.000Z",
      },
    };
    expect(describeServiceDates(rt)).toBe(
      "Departs: 2026-03-01 • Returns: 2026-03-09",
    );
    expect(serviceDetailRows(rt)).toContainEqual({
      label: "Return",
      value: "2026-03-09",
    });
  });

  it("pluralises passengers and omits empty categories", () => {
    expect(serviceDetailRows(FLIGHT_ONE_WAY)).toContainEqual({
      label: "Passengers",
      value: "2 adults, 1 child",
    });
    const solo = {
      ...FLIGHT_ONE_WAY,
      flight: {
        ...FLIGHT_ONE_WAY.flight,
        passengers: { adults: 1, children: 0, infants: 0 },
      },
    };
    expect(serviceDetailRows(solo)).toContainEqual({
      label: "Passengers",
      value: "1 adult",
    });
  });

  it("never renders car wording for a flight", () => {
    const rows = serviceDetailRows(FLIGHT_ONE_WAY);
    const labels = rows.map((r) => r.label);
    expect(labels).not.toContain("Vehicle");
    expect(labels).not.toContain("Pick-up");
    expect(labels).not.toContain("Drop-off");
    expect(describeServiceDates(FLIGHT_ONE_WAY)).not.toContain("Pick-up");
  });

  it("degrades to a readable noun when the payload is missing", () => {
    // A malformed row must not render "undefined undefined" to a customer.
    expect(describeServiceItem({ serviceType: ServiceType.FLIGHT })).toBe(
      "Flight",
    );
    expect(describeServiceDates({ serviceType: ServiceType.FLIGHT })).toBe("");
    expect(serviceDetailRows({ serviceType: ServiceType.FLIGHT })).toEqual([]);
  });
});
