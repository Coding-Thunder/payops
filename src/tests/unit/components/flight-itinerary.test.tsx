import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { FlightItinerary } from "@/components/common/flight-itinerary";
import { FlightTripType } from "@/lib/constants/enums";
import { buildFlightItinerary } from "@/lib/flight-itinerary";
import {
  flightJourneyInput,
  flightSegmentInput,
  multiCityFlightInput,
  roundTripFlightInput,
  validFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * `<FlightItinerary>` — the one web component every surface renders a
 * flight with (the order page, the evidence page, /pay/success, the hosted
 * consent page, the capture dialog).
 *
 * Stacked, numbered flights; a layover row only where the operator recorded
 * one, between the two flights it joins; times exactly as entered, with the
 * arrival's day named whenever the clock alone would mislead.
 */

type FlightSource = Parameters<typeof buildFlightItinerary>[0];

function textOf(flight: FlightSource, showOverrideHint = false) {
  const { container } = render(
    <FlightItinerary itinerary={buildFlightItinerary(flight)!} showOverrideHint={showOverrideHint} />,
  );
  return {
    container,
    text: (container.textContent ?? "").replace(/\s+/g, " "),
  };
}

describe("FlightItinerary", () => {
  it("shows both journeys of a round trip, numbered, with every recorded layover", () => {
    const { text, container } = textOf(roundTripFlightInput().flight);

    for (const heading of ["Outbound", "Return"]) {
      expect(container.querySelector(`section[aria-label="${heading}"]`)).not.toBeNull();
    }
    expect(text).toContain("Delhi → Varanasi → Mumbai · 1 stop");
    expect(text).toContain("Mumbai → Varanasi → Delhi · 1 stop");
    expect(text).toContain("Delhi → Varanasi");
    expect(text).toContain("Air India • AI123");
    expect(text).toContain("Sat, Oct 10, 2026");
    expect(text).toContain("10:30 AM → 12:00 PM");
    expect(text).toContain("Layover: 2h 30m — Varanasi");
    expect(text).toContain("Change terminals");
    // The overridden return layover shows the override.
    expect(text).toContain("Layover: 2h — Varanasi");
    expect(container.querySelectorAll('[aria-label^="Layover after flight"]')).toHaveLength(2);
  });

  it("shows no layover row for a direct flight", () => {
    const { text, container } = textOf(validFlightOrderInput().flight);
    expect(container.querySelectorAll('[aria-label^="Layover after flight"]')).toHaveLength(0);
    expect(text).toContain("LHR → JFK · Direct");
  });

  it("marks an overridden layover only where the operator asks for the hint", () => {
    expect(textOf(roundTripFlightInput().flight, true).text).toContain(
      "(adjusted; flight times give 2h 15m)",
    );
    expect(textOf(roundTripFlightInput().flight, false).text).not.toContain("(adjusted");
  });

  it("names the arrival's day for an overnight flight and for a date-line arrival", () => {
    const { text } = textOf(
      validFlightOrderInput(
        {},
        {
          tripType: FlightTripType.MULTI_CITY,
          outbound: flightJourneyInput([
            flightSegmentInput("Delhi", "London", ["2026-10-10", "22:00"], ["2026-10-11", "03:30"]),
            // Crosses the International Date Line: lands "before" it left.
            flightSegmentInput("Tokyo", "Los Angeles", ["2026-10-12", "17:00"], ["2026-10-12", "10:00"]),
          ]),
        },
      ).flight,
    );
    expect(text).toContain("10:00 PM → 3:30 AM (arrives Oct 11)");
    expect(text).toContain("5:00 PM → 10:00 AM (arrives Oct 12)");
  });

  it("counts flights, not stops, on a multi-city trip", () => {
    expect(textOf(multiCityFlightInput().flight).text).toContain(
      "Delhi → Varanasi → Mumbai → Goa · 3 flights",
    );
  });

  it("keeps a legacy flight's UTC label", () => {
    const { text } = textOf({
      tripType: "ONE_WAY",
      origin: "LHR",
      destination: "JFK",
      departureDate: "2026-11-01T09:15:00.000Z",
      arrivalDate: "2026-11-01T17:40:00.000Z",
    });
    expect(text).toContain("9:15 AM UTC → 5:40 PM UTC");
  });
});
