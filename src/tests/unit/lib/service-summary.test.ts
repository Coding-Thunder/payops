import { describe, expect, it } from "vitest";

import { ServiceType, TripType } from "@/lib/constants/enums";
import {
  describeServiceDates,
  describeServiceItem,
  serviceConsentSlots,
  serviceDetailRows,
  serviceItemLabel,
  serviceNoun,
  serviceTypeOf,
  type ServiceSummarySource,
} from "@/lib/service-summary";

/**
 * `service-summary` is the single source of truth behind seven rendering
 * surfaces — the gateway checkout line, both customer emails, the consent
 * mailto body, the order table, the detail card, the evidence PDF and
 * /pay/success. If it drifts, those seven drift with it.
 *
 * THE CAR_RENTAL EXPECTATIONS BELOW ARE CHARACTERIZATION TESTS. Every string
 * is what the pre-existing call sites produced inline before this module
 * existed, so a change that reworded an inherited receipt fails here rather
 * than in a customer's inbox.
 */

const RENTAL: ServiceSummarySource = {
  serviceType: ServiceType.CAR_RENTAL,
  vehicle: { company: "Toyota", type: "Corolla" },
  trip: {
    pickupDate: "2026-03-04T10:00:00.000Z",
    dropoffDate: "2026-03-08T16:00:00.000Z",
    pickupLocation: "LAX Airport — Terminal 1",
    dropoffLocation: "San Diego Downtown",
  },
};

const FLIGHT: ServiceSummarySource = {
  serviceType: ServiceType.FLIGHT,
  flight: {
    tripType: TripType.ROUND_TRIP,
    airline: "British Airways",
    flightNumber: "BA117",
    origin: "LHR",
    destination: "JFK",
    departureDate: "2026-05-10T09:00:00.000Z",
    arrivalDate: "2026-05-10T17:00:00.000Z",
    returnDate: "2026-05-17T18:00:00.000Z",
    cabinClass: "PREMIUM_ECONOMY",
    pnr: "X4T9KP",
    passengers: { adults: 2, children: 1, infants: 1 },
  },
};

const CRUISE: ServiceSummarySource = {
  serviceType: ServiceType.CRUISE,
  cruise: {
    cruiseLine: "Royal Caribbean",
    shipName: "Wonder of the Seas",
    itinerary: "Western Caribbean",
    departurePort: "Miami, FL",
    arrivalPort: null,
    departureDate: "2026-06-01T16:00:00.000Z",
    returnDate: "2026-06-08T07:00:00.000Z",
    cabinCategory: "BALCONY",
    cabinNumber: "9204",
    guests: { adults: 2, children: 2 },
    bookingReference: "8842317",
  },
};

describe("serviceTypeOf defaults to CAR_RENTAL", () => {
  it("reads an order stored before the field existed as a car rental", () => {
    // `.lean()` does not apply Mongoose defaults, so a document written
    // before `serviceType` arrives here with the key entirely absent. If
    // this ever returned undefined, every switch below would fall through
    // to a branch chosen by accident.
    expect(serviceTypeOf({ vehicle: { company: "A", type: "B" } })).toBe(
      ServiceType.CAR_RENTAL,
    );
    expect(serviceTypeOf({ serviceType: null })).toBe(ServiceType.CAR_RENTAL);
  });
});

describe("car rental output is unchanged", () => {
  it("describes the item exactly as before", () => {
    expect(describeServiceItem(RENTAL)).toBe("Toyota Corolla");
  });

  it("builds the checkout description exactly as before", () => {
    expect(describeServiceDates(RENTAL)).toBe(
      "Pick-up: 2026-03-04 (LAX Airport — Terminal 1) • Drop-off: 2026-03-08 (San Diego Downtown)",
    );
  });

  it("omits the parenthesised location when none was captured", () => {
    expect(
      describeServiceDates({
        ...RENTAL,
        trip: {
          pickupDate: RENTAL.trip!.pickupDate,
          dropoffDate: RENTAL.trip!.dropoffDate,
        },
      }),
    ).toBe("Pick-up: 2026-03-04 • Drop-off: 2026-03-08");
  });

  it("yields the Vehicle / Pick-up / Drop-off triple, in that order", () => {
    expect(serviceDetailRows(RENTAL)).toEqual([
      { label: "Vehicle", value: "Toyota Corolla" },
      { label: "Pick-up", value: "2026-03-04" },
      { label: "Drop-off", value: "2026-03-08" },
    ]);
  });

  it('keeps the "rental" noun that the total line reads', () => {
    expect(serviceNoun(RENTAL)).toBe("rental");
    expect(serviceItemLabel(RENTAL)).toBe("Vehicle");
  });
});

describe("flights", () => {
  it("names the carrier and the route", () => {
    expect(describeServiceItem(FLIGHT)).toBe("British Airways BA117 • LHR → JFK");
  });

  it("falls back to the bare route before a carrier is sourced", () => {
    expect(
      describeServiceItem({
        ...FLIGHT,
        flight: { ...FLIGHT.flight!, airline: null, flightNumber: null },
      }),
    ).toBe("LHR → JFK");
  });

  it("states the return leg on a round trip", () => {
    expect(describeServiceDates(FLIGHT)).toBe(
      "Departs: 2026-05-10 • Returns: 2026-05-17",
    );
  });

  it('says "One way" rather than inventing a return', () => {
    expect(
      describeServiceDates({
        ...FLIGHT,
        flight: {
          ...FLIGHT.flight!,
          tripType: TripType.ONE_WAY,
          returnDate: null,
        },
      }),
    ).toBe("Departs: 2026-05-10 • One way");
  });

  it("renders cabin class as a label, never as the raw enum", () => {
    const rows = serviceDetailRows(FLIGHT);
    expect(rows).toContainEqual({ label: "Cabin", value: "Premium economy" });
  });

  it("surfaces the PNR once ticketed", () => {
    expect(serviceDetailRows(FLIGHT)).toContainEqual({
      label: "PNR",
      value: "X4T9KP",
    });
  });

  it("pluralises the passenger mix correctly", () => {
    expect(serviceDetailRows(FLIGHT)).toContainEqual({
      label: "Passengers",
      value: "2 adults, 1 child, 1 infant",
    });
  });

  it("degrades to a readable noun when the payload is missing", () => {
    expect(describeServiceItem({ serviceType: ServiceType.FLIGHT })).toBe(
      "Flight",
    );
  });
});

describe("cruises", () => {
  it("names the ship and the route", () => {
    expect(describeServiceItem(CRUISE)).toBe(
      "Royal Caribbean Wonder of the Seas • Round trip from Miami, FL",
    );
  });

  it("names both ports on a repositioning sailing", () => {
    expect(
      describeServiceItem({
        ...CRUISE,
        cruise: { ...CRUISE.cruise!, arrivalPort: "Barcelona, Spain" },
      }),
    ).toBe(
      "Royal Caribbean Wonder of the Seas • Miami, FL → Barcelona, Spain",
    );
  });

  it("counts the nights in the checkout description", () => {
    expect(describeServiceDates(CRUISE)).toBe(
      "Sails: 2026-06-01 • Returns: 2026-06-08 • 7 nights",
    );
  });

  it("does not repeat the home port as a disembarkation row", () => {
    const labels = serviceDetailRows(CRUISE).map((r) => r.label);
    expect(labels).toContain("Departs from");
    expect(labels).not.toContain("Disembarks at");
  });

  it("adds the disembarkation row when the ports differ", () => {
    const rows = serviceDetailRows({
      ...CRUISE,
      cruise: { ...CRUISE.cruise!, arrivalPort: "Barcelona, Spain" },
    });
    expect(rows).toContainEqual({
      label: "Disembarks at",
      value: "Barcelona, Spain",
    });
  });

  it("renders the cabin category as a label and the duration in nights", () => {
    const rows = serviceDetailRows(CRUISE);
    expect(rows).toContainEqual({ label: "Cabin", value: "Balcony" });
    expect(rows).toContainEqual({ label: "Duration", value: "7 nights" });
    expect(rows).toContainEqual({ label: "Stateroom", value: "9204" });
    expect(rows).toContainEqual({ label: "Guests", value: "2 adults, 2 children" });
  });

  it('uses the "cruise" noun', () => {
    expect(serviceNoun(CRUISE)).toBe("cruise");
    expect(serviceItemLabel(CRUISE)).toBe("Sailing");
  });
});

describe("consent slots keep ONE shape across every service", () => {
  it("reproduces the rental slots verbatim", () => {
    const slots = serviceConsentSlots(RENTAL);
    expect(slots.item).toBe("Toyota • Corolla");
    expect(slots.startDate).toBe("2026-03-04T10:00:00.000Z");
    expect(slots.endDate).toBe("2026-03-08T16:00:00.000Z");
    expect(slots.startLocation).toBe("LAX Airport — Terminal 1");
  });

  it("maps a flight's route and legs into the same three slots", () => {
    const slots = serviceConsentSlots(FLIGHT);
    expect(slots.item).toBe("British Airways BA117 • LHR → JFK");
    expect(slots.startDate).toBe("2026-05-10T09:00:00.000Z");
    expect(slots.endDate).toBe("2026-05-17T18:00:00.000Z");
    expect(slots.startLocation).toBe("LHR");
    expect(slots.endLocation).toBe("JFK");
  });

  it("repeats the departure for a one-way, so the page can detect and omit it", () => {
    // The required `endDate` slot has to hold something. Repeating the
    // departure is what lets the consent page recognise "there is no return"
    // and drop the row instead of printing a return that does not exist.
    const slots = serviceConsentSlots({
      ...FLIGHT,
      flight: {
        ...FLIGHT.flight!,
        tripType: TripType.ONE_WAY,
        returnDate: null,
      },
    });
    expect(slots.endDate).toBe(slots.startDate);
  });

  it("maps a cruise's ports and dates into the same three slots", () => {
    const slots = serviceConsentSlots(CRUISE);
    expect(slots.startDate).toBe("2026-06-01T16:00:00.000Z");
    expect(slots.endDate).toBe("2026-06-08T07:00:00.000Z");
    expect(slots.startLocation).toBe("Miami, FL");
    // A round trip disembarks where it boarded.
    expect(slots.endLocation).toBe("Miami, FL");
  });

  it("never throws on a malformed row — the customer send path depends on it", () => {
    const slots = serviceConsentSlots({ serviceType: ServiceType.CRUISE });
    expect(slots.item).toBe("Cruise");
    expect(() => new Date(slots.startDate).toISOString()).not.toThrow();
  });
});
