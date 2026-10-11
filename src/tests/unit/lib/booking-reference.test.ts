import { describe, expect, it } from "vitest";

import {
  BookingReferenceCopy,
  bookingReferenceCopy,
  FLIGHT_PROVIDER_LABEL,
  HOTEL_PROVIDER_LABEL,
  HotelPaymentTimingLabel,
  PaymentTimingLabel,
  providerLabelFor,
} from "@/lib/constants/labels";
import { ServiceType } from "@/lib/constants/enums";
import {
  bookingReference,
  bookingReferenceWording,
  flightPnr,
  hasSeparateLegacyPnr,
  serviceDetailRows,
} from "@/lib/service-summary";
import { roundTripFlightInput } from "@/tests/fixtures/order-input.fixture";

/**
 * The supplier's booking reference — ONE value per order. The agent pastes
 * it into `confirmationNumber`; a flight created before that held its PNR
 * keeps it in the legacy `flight.pnr`, read as the fallback. Each service
 * names it its own way: a flight's PNR, a hotel's confirmation number, a
 * car's confirmation number — the car's words exactly as they always were.
 */

const flight = () => roundTripFlightInput().flight;

describe("bookingReference — one value per order", () => {
  it("reads the agent's confirmation number, trimmed, for every service", () => {
    for (const serviceType of Object.values(ServiceType)) {
      expect(bookingReference({ serviceType, confirmationNumber: "  AXXXYY " })).toBe("AXXXYY");
    }
  });

  it("falls back to a legacy flight's PNR — and only a flight's", () => {
    expect(
      bookingReference({
        serviceType: ServiceType.FLIGHT,
        confirmationNumber: null,
        flight: { ...flight(), pnr: " QX7T2L " },
      }),
    ).toBe("QX7T2L");
    // The canonical field wins over the legacy one.
    expect(
      bookingReference({
        serviceType: ServiceType.FLIGHT,
        confirmationNumber: "AXXXYY",
        flight: { ...flight(), pnr: "QX7T2L" },
      }),
    ).toBe("AXXXYY");
    // A non-flight never reads a flight block.
    expect(
      bookingReference({
        serviceType: ServiceType.HOTEL,
        confirmationNumber: null,
        flight: { ...flight(), pnr: "QX7T2L" },
      }),
    ).toBeNull();
  });

  it("is null until set — blank counts as unset", () => {
    expect(bookingReference({ serviceType: ServiceType.CAR_RENTAL })).toBeNull();
    expect(
      bookingReference({
        serviceType: ServiceType.FLIGHT,
        confirmationNumber: "   ",
        flight: { ...flight(), pnr: "  " },
      }),
    ).toBeNull();
    // A blank confirmation number still lets a legacy PNR through.
    expect(
      bookingReference({
        serviceType: ServiceType.FLIGHT,
        confirmationNumber: "   ",
        flight: { ...flight(), pnr: "ABC123" },
      }),
    ).toBe("ABC123");
  });
});

describe("the flight summary rows show the one reference as 'PNR'", () => {
  it("labels the row 'PNR' — the consent mailto selects it by that label — with the canonical value", () => {
    for (const legacyPnr of [null, "AXXXYY"]) {
      const rows = serviceDetailRows({
        serviceType: ServiceType.FLIGHT,
        confirmationNumber: "AXXXYY",
        flight: { ...flight(), pnr: legacyPnr },
      });
      expect(rows.filter((r) => r.label === "PNR")).toEqual([{ label: "PNR", value: "AXXXYY" }]);
    }
  });

  it("can leave the row out for a surface that shows the reference on its own", () => {
    const rows = serviceDetailRows(
      { serviceType: ServiceType.FLIGHT, confirmationNumber: "AXXXYY", flight: { ...flight(), pnr: null } },
      undefined,
      { omitReference: true },
    );
    expect(rows.some((r) => r.label === "PNR")).toBe(false);
  });

  it("shows a frozen consent snapshot's PNR (it carries no confirmation number)", () => {
    const rows = serviceDetailRows({ serviceType: ServiceType.FLIGHT, flight: { ...flight(), pnr: "QX7T2L" } });
    expect(rows).toContainEqual({ label: "PNR", value: "QX7T2L" });
  });
});

describe("BookingReferenceCopy — each service's own words", () => {
  it("keeps the car's words exactly as they always were", () => {
    expect(BookingReferenceCopy.CAR_RENTAL).toEqual({
      label: "Confirmation number",
      receiptLabel: "Confirmation #",
      noun: "confirmation number",
      description:
        "Paste the supplier confirmation number. It appears at the top of the customer's confirmation email.",
      placeholder: "e.g. ABC-12345678",
      notSet: "No confirmation number set yet.",
      saved: "Confirmation number saved",
      cleared: "Confirmation number cleared",
    });
  });

  it("calls a flight's reference the PNR and a hotel's the hotel confirmation number", () => {
    expect(BookingReferenceCopy.FLIGHT.label).toBe("PNR");
    expect(BookingReferenceCopy.FLIGHT.description).toContain("airline booking reference (PNR)");
    expect(BookingReferenceCopy.FLIGHT.noun).toBe("PNR");
    expect(BookingReferenceCopy.HOTEL.label).toBe("Hotel confirmation number");
    expect(BookingReferenceCopy.HOTEL.receiptLabel).toBe("Hotel confirmation #");
    expect(BookingReferenceCopy.HOTEL.noun).toBe("hotel confirmation number");
    for (const copy of [BookingReferenceCopy.FLIGHT, BookingReferenceCopy.HOTEL]) {
      for (const text of Object.values(copy)) {
        expect(text.toLowerCase()).not.toMatch(/rental|vehicle|pick-up|counter/);
      }
    }
  });

  it("uses the car's words for an order written before service types existed", () => {
    expect(bookingReferenceCopy(undefined)).toBe(BookingReferenceCopy.CAR_RENTAL);
    expect(bookingReferenceCopy(null)).toBe(BookingReferenceCopy.CAR_RENTAL);
    expect(bookingReferenceCopy(ServiceType.HOTEL)).toBe(BookingReferenceCopy.HOTEL);
  });
});

describe("each service names its provider and its payment timings", () => {
  it("a hotel's provider is the hotel or its supplier — never the car's wording", () => {
    expect(HOTEL_PROVIDER_LABEL).toBe("Hotel / Supplier");
    expect(providerLabelFor(ServiceType.HOTEL, "Rental provider")).toBe("Hotel / Supplier");
    expect(providerLabelFor(ServiceType.FLIGHT, "Rental provider")).toBe(FLIGHT_PROVIDER_LABEL);
  });

  it("a car keeps each surface's own word, as do orders written before service types", () => {
    expect(providerLabelFor(ServiceType.CAR_RENTAL, "Rental provider")).toBe("Rental provider");
    expect(providerLabelFor(ServiceType.CAR_RENTAL, "Provider")).toBe("Provider");
    expect(providerLabelFor(undefined, "Provider")).toBe("Provider");
    expect(providerLabelFor(null, "Rental provider")).toBe("Rental provider");
  });

  it("a hotel's balance is due at the property; the car's timings are unchanged", () => {
    expect(HotelPaymentTimingLabel).toEqual({
      PREPAID: "Paid online now",
      DUE_AT_COUNTER: "Due at the property",
    });
    expect(PaymentTimingLabel).toEqual({
      PREPAID: "Prepaid",
      DUE_AT_COUNTER: "Due at counter",
    });
  });
});

describe("an older flight holding TWO different references keeps both", () => {
  // Before the PNR moved into `confirmationNumber`, the create form stored
  // the airline's PNR in `flight.pnr` and an agent could later paste a
  // supplier's confirmation number into the order page. Both were shown,
  // each under its own name — and still are.
  const both = () => ({
    serviceType: ServiceType.FLIGHT,
    confirmationNumber: "SUPP-55555",
    flight: { ...flight(), pnr: "QX7T2L" },
  });

  it("recognises only a flight whose two values differ", () => {
    expect(hasSeparateLegacyPnr(both())).toBe(true);
    expect(hasSeparateLegacyPnr({ ...both(), confirmationNumber: " QX7T2L " })).toBe(false);
    expect(hasSeparateLegacyPnr({ ...both(), confirmationNumber: null })).toBe(false);
    expect(hasSeparateLegacyPnr({ ...both(), flight: { ...flight(), pnr: null } })).toBe(false);
    expect(hasSeparateLegacyPnr({ ...both(), serviceType: ServiceType.HOTEL })).toBe(false);
  });

  it("shows the airline PNR as the 'PNR' row — never the supplier number — even where the reference is shown on its own", () => {
    for (const options of [{}, { omitReference: true }]) {
      const rows = serviceDetailRows(both(), undefined, options);
      expect(rows.filter((r) => r.label === "PNR")).toEqual([{ label: "PNR", value: "QX7T2L" }]);
      expect(rows.some((r) => r.value === "SUPP-55555")).toBe(false);
    }
    expect(flightPnr(both())).toBe("QX7T2L");
  });

  it("keeps the pasted number as the supplier 'Confirmation number' it was entered as", () => {
    expect(bookingReference(both())).toBe("SUPP-55555");
    expect(bookingReferenceWording(both())).toBe(BookingReferenceCopy.CAR_RENTAL);
    expect(bookingReferenceWording(both()).label).toBe("Confirmation number");
  });

  it("reads every other order exactly as the one-reference model", () => {
    const single = { serviceType: ServiceType.FLIGHT, confirmationNumber: "AXXXYY", flight: { ...flight(), pnr: null } };
    expect(flightPnr(single)).toBe("AXXXYY");
    expect(bookingReferenceWording(single)).toBe(BookingReferenceCopy.FLIGHT);
    expect(bookingReferenceWording({ serviceType: ServiceType.HOTEL, confirmationNumber: "HC-1" })).toBe(
      BookingReferenceCopy.HOTEL,
    );
    expect(flightPnr({ serviceType: ServiceType.CAR_RENTAL, confirmationNumber: "CR-1" })).toBeNull();
  });
});
