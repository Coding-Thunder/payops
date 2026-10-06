import { describe, expect, it } from "vitest";

import { FlightTripType, ServiceType } from "@/lib/constants/enums";
import {
  describeServiceDates,
  describeServiceItem,
  serviceDetailRows,
  serviceItemLabel,
  serviceNoun,
  type ServiceSummarySource,
} from "@/lib/service-summary";
import {
  flightJourneyInput,
  flightSegmentInput,
  multiCityFlightInput,
  oneWayConnectingFlightInput,
  roundTripFlightInput,
  validFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * `@/lib/service-summary` for FLIGHT — the gateway line item, the email and
 * consent rows, the order table — and the proof that CAR_RENTAL did not
 * move a byte.
 *
 * An itinerary flight is described from `buildFlightItinerary`: every
 * airport on the route (a connecting itinerary never collapses into one
 * origin → destination pair) and airport-local times exactly as entered. A
 * flight created before itineraries keeps its historic strings. The car
 * strings below are pinned verbatim — they are what two production brands'
 * checkout pages and receipts print.
 */

function flightOrder(flight: ServiceSummarySource["flight"]): ServiceSummarySource {
  return { serviceType: ServiceType.FLIGHT, flight };
}

const directOneWay = () => flightOrder(validFlightOrderInput().flight);
const connectingOneWay = () => flightOrder(oneWayConnectingFlightInput().flight);
const roundTrip = () => flightOrder(roundTripFlightInput().flight);
const multiCity = () => flightOrder(multiCityFlightInput().flight);

/** A flight stored before itineraries existed: flat fields, UTC instants. */
function legacyFlight(
  over: Partial<NonNullable<ServiceSummarySource["flight"]>> = {},
): ServiceSummarySource {
  return flightOrder({
    tripType: "ONE_WAY",
    airline: "Test Airways",
    flightNumber: "TA123",
    origin: "LHR",
    destination: "JFK",
    departureDate: "2026-11-01T09:15:00.000Z",
    arrivalDate: "2026-11-01T17:40:00.000Z",
    returnDate: null,
    cabinClass: "ECONOMY",
    passengers: { adults: 1, children: 0, infants: 0 },
    pnr: null,
    ...over,
  });
}

const CAR: ServiceSummarySource = {
  serviceType: ServiceType.CAR_RENTAL,
  vehicle: { company: "Toyota", type: "Corolla" },
  trip: {
    pickupDate: "2026-10-10T15:00:00.000Z",
    dropoffDate: "2026-10-12T09:30:00.000Z",
    pickupLocation: "LAX Airport — Terminal 1",
    dropoffLocation: "San Diego Downtown",
  },
};

describe("describeServiceItem — FLIGHT", () => {
  it("keeps the 'carrier • route' shape for a direct one-way flight", () => {
    expect(describeServiceItem(directOneWay())).toBe("Test Airways TA123 • LHR → JFK");
  });

  it("is just the route when a direct flight has no carrier", () => {
    const order = flightOrder(
      validFlightOrderInput(
        {},
        {
          outbound: flightJourneyInput([
            flightSegmentInput("LHR", "JFK", ["2026-11-01", "09:15"], ["2026-11-01", "12:20"]),
          ]),
        },
      ).flight,
    );
    expect(describeServiceItem(order)).toBe("LHR → JFK");
  });

  it("lists EVERY airport of a connecting itinerary", () => {
    expect(describeServiceItem(connectingOneWay())).toBe("Delhi → Varanasi → Mumbai");
  });

  it("describes a round trip by its outbound route, marked as a round trip", () => {
    expect(describeServiceItem(roundTrip())).toBe(
      "Delhi → Varanasi → Mumbai (round trip)",
    );
  });

  it("lists every stop of a multi-city trip", () => {
    expect(describeServiceItem(multiCity())).toBe(
      "Delhi → Varanasi → Mumbai → Goa",
    );
  });

  it("shows an airport change on the route instead of hiding it", () => {
    // Lands at LHR, the next flight leaves from CDG: the route names both.
    const order = flightOrder(
      validFlightOrderInput(
        {},
        {
          tripType: FlightTripType.MULTI_CITY,
          outbound: flightJourneyInput([
            flightSegmentInput("JFK", "LHR", ["2026-10-10", "18:00"], ["2026-10-11", "06:30"]),
            flightSegmentInput("CDG", "FCO", ["2026-10-12", "09:00"], ["2026-10-12", "11:00"]),
            flightSegmentInput("FCO", "JFK", ["2026-10-14", "10:00"], ["2026-10-14", "14:00"]),
          ]),
        },
      ).flight,
    );
    const item = describeServiceItem(order);
    expect(item).toContain("LHR / CDG");
    expect(item).toBe("JFK → LHR / CDG → FCO → JFK");
    // The same airport in another case is not a change.
    const sameAirport = flightOrder(
      validFlightOrderInput(
        {},
        {
          outbound: flightJourneyInput([
            flightSegmentInput("Delhi", "Varanasi", ["2026-10-10", "10:30"], ["2026-10-10", "12:00"]),
            flightSegmentInput("varanasi", "Mumbai", ["2026-10-10", "14:30"], ["2026-10-10", "16:30"]),
          ]),
        },
      ).flight,
    );
    expect(describeServiceItem(sameAirport)).not.toContain(" / ");
  });

  it("caps a very long route at 120 characters with an ellipsis", () => {
    const segments = Array.from({ length: 12 }, (_, i) =>
      flightSegmentInput(
        `Airport number ${i} international`,
        `Airport number ${i + 1} international`,
        [`2026-10-${String(10 + i).padStart(2, "0")}`, "08:00"],
        [`2026-10-${String(10 + i).padStart(2, "0")}`, "09:00"],
      ),
    );
    const item = describeServiceItem(
      flightOrder(
        validFlightOrderInput(
          {},
          { tripType: FlightTripType.MULTI_CITY, outbound: flightJourneyInput(segments) },
        ).flight,
      ),
    );
    expect(item).toHaveLength(120);
    expect(item.endsWith("…")).toBe(true);
    expect(item.startsWith("Airport number 0 international → Airport number 1")).toBe(true);
  });

  it("keeps the historic string for a LEGACY flat-field flight", () => {
    expect(describeServiceItem(legacyFlight())).toBe("Test Airways TA123 • LHR → JFK");
    expect(
      describeServiceItem(legacyFlight({ airline: null, flightNumber: null })),
    ).toBe("LHR → JFK");
  });

  it("degrades to the service noun when there is no flight at all", () => {
    expect(describeServiceItem(flightOrder(null))).toBe("Flight");
    expect(describeServiceItem(flightOrder({ tripType: "ONE_WAY" }))).toBe("Flight");
  });
});

describe("describeServiceDates — FLIGHT (the gateway line-item description)", () => {
  it("prints the first departure as entered, airport-local, for a direct one-way", () => {
    expect(describeServiceDates(directOneWay())).toBe(
      "Departs: Sun, Nov 1, 2026 9:15 AM • One way",
    );
  });

  it("counts the stops of a connecting one-way", () => {
    expect(describeServiceDates(connectingOneWay())).toBe(
      "Departs: Sat, Oct 10, 2026 10:30 AM • One way, 1 stop",
    );
    const twoStops = flightOrder(
      validFlightOrderInput(
        {},
        {
          outbound: flightJourneyInput([
            flightSegmentInput("Delhi", "Varanasi", ["2026-10-10", "10:30"], ["2026-10-10", "12:00"]),
            flightSegmentInput("Varanasi", "Mumbai", ["2026-10-10", "14:30"], ["2026-10-10", "16:30"]),
            flightSegmentInput("Mumbai", "Goa", ["2026-10-10", "19:45"], ["2026-10-10", "21:00"]),
          ]),
        },
      ).flight,
    );
    expect(describeServiceDates(twoStops)).toBe(
      "Departs: Sat, Oct 10, 2026 10:30 AM • One way, 2 stops",
    );
  });

  it("names the return departure on a round trip", () => {
    expect(describeServiceDates(roundTrip())).toBe(
      "Departs: Sat, Oct 10, 2026 10:30 AM • Returns: Thu, Oct 15, 2026 9:00 AM",
    );
  });

  it("counts flights, not stops, on a multi-city trip", () => {
    expect(describeServiceDates(multiCity())).toBe(
      "Departs: Sat, Oct 10, 2026 10:30 AM • Multi-city, 3 flights",
    );
  });

  it("keeps the historic ISO-day strings for a LEGACY flight", () => {
    expect(describeServiceDates(legacyFlight())).toBe("Departs: 2026-11-01 • One way");
    expect(
      describeServiceDates(
        legacyFlight({ tripType: "ROUND_TRIP", returnDate: "2026-11-08T20:00:00.000Z" }),
      ),
    ).toBe("Departs: 2026-11-01 • Returns: 2026-11-08");
  });

  it("is empty when there is no flight to describe", () => {
    expect(describeServiceDates(flightOrder(null))).toBe("");
  });
});

describe("serviceDetailRows — FLIGHT carries trip-level rows only", () => {
  it("summarises a one-way trip: type, route, cabin, passengers", () => {
    expect(serviceDetailRows(connectingOneWay())).toEqual([
      { label: "Trip type", value: "One way" },
      { label: "Route", value: "Delhi → Varanasi → Mumbai" },
      { label: "Cabin", value: "Economy" },
      { label: "Passengers", value: "1 adult" },
    ]);
  });

  it("names each direction of a round trip, and adds the PNR once ticketed", () => {
    expect(serviceDetailRows(roundTrip())).toEqual([
      { label: "Trip type", value: "Round trip" },
      { label: "Outbound", value: "Delhi → Varanasi → Mumbai" },
      { label: "Return", value: "Mumbai → Varanasi → Delhi" },
      { label: "Cabin", value: "Business" },
      { label: "Passengers", value: "2 adults, 1 child" },
      { label: "PNR", value: "ABC123" },
    ]);
  });

  it("summarises a multi-city trip by its whole route", () => {
    expect(serviceDetailRows(multiCity()).slice(0, 2)).toEqual([
      { label: "Trip type", value: "Multi-city" },
      { label: "Route", value: "Delhi → Varanasi → Mumbai → Goa" },
    ]);
  });

  it("folds a LEGACY flight into the same trip-level rows", () => {
    expect(serviceDetailRows(legacyFlight())).toEqual([
      { label: "Trip type", value: "One way" },
      { label: "Route", value: "LHR → JFK" },
      { label: "Cabin", value: "Economy" },
      { label: "Passengers", value: "1 adult" },
    ]);
  });

  it("never renders a flight as rows of times, nor with rental vocabulary", () => {
    for (const order of [directOneWay(), connectingOneWay(), roundTrip(), multiCity(), legacyFlight()]) {
      const labels = serviceDetailRows(order).map((r) => r.label);
      for (const banned of ["Departure", "Arrival", "Airline", "Vehicle", "Pick-up", "Drop-off"]) {
        expect(labels).not.toContain(banned);
      }
    }
  });

  it("labels and nouns a flight as a flight", () => {
    expect(serviceItemLabel(directOneWay())).toBe("Route");
    expect(serviceNoun(directOneWay())).toBe("flight");
  });
});

describe("CAR_RENTAL output is byte-identical", () => {
  it("describes the vehicle as 'Company Type'", () => {
    expect(describeServiceItem(CAR)).toBe("Toyota Corolla");
    expect(describeServiceItem({ ...CAR, serviceType: undefined })).toBe("Toyota Corolla");
    expect(describeServiceItem({ serviceType: ServiceType.CAR_RENTAL })).toBe("Vehicle");
  });

  it("describes the dates exactly as the checkout line item always has", () => {
    expect(describeServiceDates(CAR)).toBe(
      "Pick-up: 2026-10-10 (LAX Airport — Terminal 1) • Drop-off: 2026-10-12 (San Diego Downtown)",
    );
    expect(
      describeServiceDates({
        ...CAR,
        trip: { ...CAR.trip!, pickupLocation: null, dropoffLocation: "  " },
      }),
    ).toBe("Pick-up: 2026-10-10 • Drop-off: 2026-10-12");
  });

  it("keeps the Vehicle / Pick-up / Drop-off triple, in order", () => {
    expect(serviceDetailRows(CAR)).toEqual([
      { label: "Vehicle", value: "Toyota Corolla" },
      { label: "Pick-up", value: "2026-10-10" },
      { label: "Drop-off", value: "2026-10-12" },
    ]);
    expect(serviceDetailRows(CAR, (d) => `<${String(d)}>`)).toEqual([
      { label: "Vehicle", value: "Toyota Corolla" },
      { label: "Pick-up", value: "<2026-10-10T15:00:00.000Z>" },
      { label: "Drop-off", value: "<2026-10-12T09:30:00.000Z>" },
    ]);
  });

  it("keeps its label and noun", () => {
    expect(serviceItemLabel(CAR)).toBe("Vehicle");
    expect(serviceNoun(CAR)).toBe("rental");
  });

  it("treats a row stored before serviceType existed as a car rental", () => {
    const preMigration: ServiceSummarySource = { ...CAR };
    delete preMigration.serviceType;
    expect(describeServiceItem(preMigration)).toBe("Toyota Corolla");
    expect(serviceDetailRows(preMigration).map((r) => r.label)).toEqual([
      "Vehicle",
      "Pick-up",
      "Drop-off",
    ]);
  });
});
