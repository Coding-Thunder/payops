import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { OrderDetailsCard } from "@/components/features/orders/order-details-card";
import { OrderPaymentCard } from "@/components/features/orders/order-payment-card";
import { HOTEL_CHARGE_WORDING, RENTAL_CHARGE_WORDING } from "@/lib/charges";
import {
  BookingType,
  ConsentStatus,
  Currency,
  OrderStatus,
  PaymentGatewayKey,
  PaymentTiming,
  RecordState,
  ServiceType,
} from "@/lib/constants/enums";
import type { OrderCharge, OrderDTO } from "@/types";

/**
 * The order page for a hotel — its money card and its details card — with
 * the car's pinned beside it.
 *
 * The money card, for the services whose balance can be settled later: a
 * car at the rental counter, a hotel at the property. The car's breakdown
 * is pinned string by string, in order — two brands read it every day and
 * it must not move. A hotel uses its own charge wording
 * (`HOTEL_CHARGE_WORDING`): its due-later lines are "(due at the
 * property)", its due row "Amount due at the property", its total "Total
 * hotel cost" — never the rental counter or a "rental cost".
 *
 * The details card names a hotel's supplier as a hotel's ("Hotel /
 * Supplier"), shows its days as calendar days, and lists what was asked
 * for — the room preference and the operator-only guest notes — each once,
 * in a block of its own, as it does a flight's passenger notes.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => {},
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
  }),
}));

vi.mock("@/components/ui/sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

function order(
  serviceType: ServiceType | undefined,
  charges: OrderCharge[],
  over: Partial<OrderDTO> = {},
): OrderDTO {
  const prepaid = charges
    .filter((c) => c.timing === PaymentTiming.PREPAID)
    .reduce((sum, c) => sum + c.amount, 0);
  return {
    id: "665f1c2b9d3e4a0012345678",
    orderNumber: "TR-10001",
    bookingType: BookingType.NEW_BOOKING,
    serviceType: serviceType as ServiceType,
    status: OrderStatus.NOT_INITIATED,
    state: RecordState.ACTIVE,
    bookingStatus: null,
    customer: { name: "Ada Lovelace", email: "ada@payops.test", phone: "+15555550101" },
    provider: {
      id: "BUDGET",
      name: "Budget",
      logo: "/providers/budget.png",
      primaryColor: "#000000",
      onPrimaryColor: "#FFFFFF",
    },
    vehicle:
      serviceType === ServiceType.HOTEL
        ? null
        : { company: "Toyota", type: "Corolla", imageUrl: null },
    trip:
      serviceType === ServiceType.HOTEL
        ? null
        : {
            pickupDate: "2026-10-17T15:00:00.000Z",
            dropoffDate: "2026-10-20T09:30:00.000Z",
            pickupLocation: null,
            dropoffLocation: null,
          },
    flight: null,
    hotel:
      serviceType === ServiceType.HOTEL
        ? {
            hotelId: null,
            destination: "Paris",
            propertyName: "Hotel Lutetia",
            checkInDate: "2026-10-17T00:00:00.000Z",
            checkOutDate: "2026-10-20T00:00:00.000Z",
            rooms: 1,
            guests: { adults: 2, children: 0 },
            roomPreference: null,
            guestNotes: null,
            confirmationCode: null,
          }
        : null,
    pricing: { amount: prepaid, currency: Currency.USD },
    charges,
    confirmationNumber: null,
    terms: { text: "Terms.", version: "v1" },
    termsAcknowledgement: null,
    payment: {
      gateway: PaymentGatewayKey.PAYPAL,
      paymentSessionId: null,
      paymentUrl: null,
      paymentIntentId: null,
      status: OrderStatus.NOT_INITIATED,
      paidAt: null,
      expiresAt: null,
      amountReceived: null,
      receiptUrl: null,
      failureReason: null,
      confirmationEmailSentAt: null,
      initiatedAt: null,
      capture: null,
    },
    createdBy: {
      userId: "665f1c2b9d3e4a00000000aa",
      name: "Olivia Operator",
      email: "olivia@payops.test",
    },
    policy: { acceptedAt: "2026-10-01T09:00:00.000Z", version: "v1", text: "Policy." },
    risk: { flagged: false },
    consent: {
      status: ConsentStatus.NOT_REQUESTED,
      currentConsentId: null,
      requestedAt: null,
      receivedAt: null,
      verifiedAt: null,
      method: null,
    },
    dispute: null,
    refundedAmount: 0,
    notes: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...over,
  } as OrderDTO;
}

/** The "Charge breakdown" box's text, row by row. */
function breakdownRows(o: OrderDTO): string[] {
  const { container } = render(<OrderPaymentCard order={o} canRegenerate={false} />);
  const title = Array.from(container.querySelectorAll("p")).find(
    (p) => p.textContent === "Charge breakdown",
  );
  expect(title).toBeDefined();
  const box = title!.parentElement!;
  // Every row is a flex line of label + amount.
  return Array.from(box.querySelectorAll("div.flex")).map((row) =>
    Array.from(row.children)
      .map((cell) => cell.textContent)
      .join(" | "),
  );
}

const CAR_CHARGES: OrderCharge[] = [
  { name: "Rental cost", amount: 150, timing: PaymentTiming.PREPAID },
  { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
];

const HOTEL_CHARGES: OrderCharge[] = [
  { name: "Room charge", amount: 640, timing: PaymentTiming.PREPAID },
  { name: "City tax", amount: 25.5, timing: PaymentTiming.DUE_AT_COUNTER },
];

describe("CAR_RENTAL — the breakdown is byte-for-byte what it always was", () => {
  const CAR_ROWS = [
    "Rental cost· prepaid | $150.00",
    "Deposit· at counter | $100.00",
    "Amount paid online | $150.00",
    "Amount due at counter | $100.00",
    "Total rental cost | $250.00",
  ];

  it("pins every row, in order", () => {
    expect(breakdownRows(order(ServiceType.CAR_RENTAL, CAR_CHARGES))).toEqual(CAR_ROWS);
  });

  it("reads the same for an order stored before service types existed", () => {
    expect(breakdownRows(order(undefined, CAR_CHARGES))).toEqual(CAR_ROWS);
  });

  it("still leaves the due row out when nothing is due at the counter", () => {
    expect(
      breakdownRows(order(ServiceType.CAR_RENTAL, [CAR_CHARGES[0]!])),
    ).toEqual([
      "Rental cost· prepaid | $150.00",
      "Amount paid online | $150.00",
      "Total rental cost | $150.00",
    ]);
  });

  it("matches the rental charge wording the emails use", () => {
    expect(RENTAL_CHARGE_WORDING).toMatchObject({
      prepaidLabel: "Amount paid online",
      dueLabel: "Amount due at counter",
      totalLabel: "Total rental cost",
    });
  });
});

describe("HOTEL — its balance is due at the property", () => {
  it("words every row for a hotel", () => {
    expect(breakdownRows(order(ServiceType.HOTEL, HOTEL_CHARGES))).toEqual([
      "Room charge· prepaid | $640.00",
      "City tax(due at the property) | $25.50",
      "Amount paid online | $640.00",
      "Amount due at the property | $25.50",
      "Total hotel cost | $665.50",
    ]);
  });

  it("is the hotel charge wording, so the card and the emails agree", () => {
    const rows = breakdownRows(order(ServiceType.HOTEL, HOTEL_CHARGES)).join("\n");
    expect(rows).toContain(HOTEL_CHARGE_WORDING.dueSuffix);
    expect(rows).toContain(HOTEL_CHARGE_WORDING.dueLabel);
    expect(rows).toContain(HOTEL_CHARGE_WORDING.totalLabel);
  });

  it("never mentions the rental counter or a rental cost", () => {
    const { container } = render(
      <OrderPaymentCard order={order(ServiceType.HOTEL, HOTEL_CHARGES)} canRegenerate={false} />,
    );
    expect(container.textContent!.toLowerCase()).not.toMatch(/counter|rental/);
  });
});

/* ------------------------------------------------------------------ *
 * The details card
 * ------------------------------------------------------------------ */

/** Runs `fn` with the process in another time zone — the agent's browser. */
function inTimeZone(tz: string, fn: () => void) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function hotelWithRequests(): OrderDTO {
  const base = order(ServiceType.HOTEL, HOTEL_CHARGES);
  return {
    ...base,
    hotel: {
      ...base.hotel!,
      roomPreference: "King bed, high floor",
      guestNotes: "Anniversary — arriving after midnight.",
    },
  };
}

/** Label → value of every detail on the card, in order. */
function details(o: OrderDTO): [string, string][] {
  const { container } = render(<OrderDetailsCard order={o} />);
  return Array.from(container.querySelectorAll("p.uppercase")).map((label) => [
    label.textContent ?? "",
    label.nextElementSibling?.textContent ?? "",
  ]);
}

function providerEyebrow(o: OrderDTO): string | null {
  const { container } = render(<OrderDetailsCard order={o} />);
  return container.querySelector("p.uppercase")?.textContent ?? null;
}

describe("OrderDetailsCard — a hotel", () => {
  it("names its supplier as a hotel's", () => {
    expect(providerEyebrow(hotelWithRequests())).toBe("Hotel / Supplier");
  });

  it("shows check-in and check-out as calendar days, in the agent's time zone too", () => {
    inTimeZone("America/New_York", () => {
      const rows = new Map(details(hotelWithRequests()));
      expect(rows.get("Check-in")).toBe("17 Oct 2026");
      expect(rows.get("Check-out")).toBe("20 Oct 2026");
    });
  });

  it("lists the room preference and the guest notes once each, in blocks of their own", () => {
    const rows = details(hotelWithRequests());
    expect(rows.filter(([label]) => label === "Room preference")).toEqual([
      ["Room preference", "King bed, high floor"],
    ]);
    expect(rows.filter(([label]) => label === "Guest notes")).toEqual([
      ["Guest notes", "Anniversary — arriving after midnight."],
    ]);
    // The requests come after the booking facts, before the internal notes.
    const labels = rows.map(([label]) => label);
    expect(labels.indexOf("Room preference")).toBeGreaterThan(labels.indexOf("Guests"));
  });

  it("shows no request block when nothing was asked", () => {
    const labels = details(order(ServiceType.HOTEL, HOTEL_CHARGES)).map(([l]) => l);
    expect(labels).not.toContain("Room preference");
    expect(labels).not.toContain("Guest notes");
  });

  it("leaves the booking reference to its own card", () => {
    const labels = details({ ...hotelWithRequests(), confirmationNumber: "83920174" }).map(
      ([l]) => l,
    );
    expect(labels.some((l) => /confirmation/i.test(l))).toBe(false);
  });
});

describe("OrderDetailsCard — a car and a flight keep their cards", () => {
  it("a car still says 'Rental provider' and lists no requests", () => {
    const car = order(ServiceType.CAR_RENTAL, CAR_CHARGES);
    expect(providerEyebrow(car)).toBe("Rental provider");
    expect(details(car).map(([l]) => l)).toEqual([
      "Rental provider",
      "Booking type",
      "Created",
      "Customer",
      "Vehicle",
      "Pick-up",
      "Drop-off",
      "Created by",
    ]);
  });

  it("a flight keeps its passenger notes block, and its PNR is left to the PNR card", () => {
    const flight = order(ServiceType.FLIGHT, [
      { name: "Service Charge", amount: 100, timing: PaymentTiming.PREPAID },
    ], {
      vehicle: null,
      trip: null,
      confirmationNumber: "AXXXYY",
      flight: {
        tripType: "ONE_WAY",
        outbound: {
          segments: [
            {
              origin: "Delhi",
              destination: "Mumbai",
              departure: { date: "2026-10-17", time: "10:30" },
              arrival: { date: "2026-10-17", time: "12:45" },
              airline: "Air India",
              flightNumber: "AI101",
              details: null,
            },
          ],
          connections: [],
        },
        return: null,
        airlineFare: 400,
        cabinClass: "ECONOMY",
        passengers: { adults: 1, children: 0, infants: 0 },
        passengerNotes: "Wheelchair at arrival.",
        pnr: null,
        airline: null,
        flightNumber: null,
        origin: null,
        destination: null,
        departureDate: null,
        departureTimePreference: null,
        arrivalDate: null,
        returnDate: null,
        returnTimePreference: null,
      } as OrderDTO["flight"],
    });
    expect(providerEyebrow(flight)).toBe("Airline / Supplier");
    const rows = details(flight);
    expect(rows.filter(([l]) => l === "Passenger notes")).toEqual([
      ["Passenger notes", "Wheelchair at arrival."],
    ]);
    expect(rows.map(([l]) => l)).not.toContain("PNR");

    // An OLDER flight that also holds a different airline PNR: the card
    // edits the pasted supplier number, so the grid keeps the PNR row.
    const older = {
      ...flight,
      flight: { ...flight.flight!, pnr: "QX7T2L" },
    } as OrderDTO;
    expect(details(older).filter(([l]) => l === "PNR")).toEqual([["PNR", "QX7T2L"]]);
  });
});
