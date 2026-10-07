import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import PaymentSuccessPage from "@/app/pay/success/page";
import { FLIGHT_AMOUNT_LABELS, LEGACY_FLIGHT_AMOUNT_LABELS } from "@/lib/charges";
import {
  BookingType,
  CaptureMode,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  ServiceType,
} from "@/lib/constants/enums";
import { FLIGHT_PROVIDER_LABEL } from "@/lib/constants/labels";
import { Order } from "@/server/db/models";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import {
  createOrder as factoryCreateOrder,
  itineraryFlight,
  type OrderSeed,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";

/**
 * /pay/success — the receipt a customer lands on straight from the gateway,
 * rendered for real (server component, real services, real database).
 *
 * For an itinerary flight it must say what the payment covered — the
 * service charge, "paid" or "on hold" — set against the full booking value,
 * show every flight, and never use rental vocabulary. A flight created
 * before itineraries is worded neutrally. A car receipt keeps every string,
 * and a PayPal order's "still confirming" line names PayPal (it used to say
 * Stripe to everyone).
 */

const SESSION = "cs_test_receipt";

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  // No pending-order reconcile may ever reach a real gateway.
  _setPayPalFetchForTesting((async () => {
    throw new Error("network disabled in this test");
  }) as unknown as typeof fetch);
});

afterEach(() => {
  _setPayPalFetchForTesting(null);
});

/** Seed an order the customer is returning for, pinned to `gateway`. */
async function seeded(
  seed: OrderSeed,
  gateway: PaymentGatewayKey = PaymentGatewayKey.STRIPE,
) {
  const status = seed.status ?? OrderStatus.PAID;
  const doc = await factoryCreateOrder({
    ...seed,
    status,
    payment: {
      status,
      stripeSessionId: SESSION,
      paidAt: status === OrderStatus.PAID ? new Date("2026-10-06T10:00:00.000Z") : null,
      amountReceived: status === OrderStatus.PAID ? (seed.pricing?.amount ?? 199.5) : null,
      processedWebhookEventIds: [],
      ...(seed.payment ?? {}),
    } as OrderSeed["payment"],
  });
  await Order.updateOne({ _id: doc._id }, { $set: { "payment.gateway": gateway } });
  return doc;
}

/** The page's visible text for the returning customer, whitespace collapsed. */
async function receiptText(
  orderNumber: string,
  query: Record<string, string> = { session_id: SESSION },
): Promise<string> {
  const page = await PaymentSuccessPage({
    searchParams: Promise.resolve({ order: orderNumber, ...query }),
  } as Parameters<typeof PaymentSuccessPage>[0]);
  const html = renderToStaticMarkup(page);
  return html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");
}

const RENTAL_WORDS = ["Vehicle", "Pick-up", "Drop-off", "rental", "counter"];

const itineraryFlightSeed = (airlineFare: number | null = 400): OrderSeed => ({
  serviceType: ServiceType.FLIGHT,
  flight: itineraryFlight({ airlineFare }),
  pricing: { amount: 100, currency: "USD" as never },
  charges: [{ name: "Service charge", amount: 100, timing: PaymentTiming.PREPAID }],
});

describe("an itinerary flight's receipt", () => {
  it("says the service charge was paid, against the full booking value", async () => {
    const order = await seeded(itineraryFlightSeed());
    const text = await receiptText(order.orderNumber);

    expect(text).toContain(FLIGHT_AMOUNT_LABELS.paidNow);
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.breakdownTitle);
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.airlineFareNote);
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.bookingTotal);
    expect(text).toContain("$400.00");
    expect(text).toContain("$100.00");
    expect(text).toContain("$500.00");
  });

  it("lists the four rows in order — the last one what was paid — then says the airline charge was not collected", async () => {
    const order = await seeded(itineraryFlightSeed());
    const text = await receiptText(order.orderNumber);
    const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
    expect(box).toContain(
      [
        FLIGHT_AMOUNT_LABELS.airlineFare,
        FLIGHT_AMOUNT_LABELS.airlineFareNote,
        "$400.00",
        FLIGHT_AMOUNT_LABELS.serviceCharge,
        "$100.00",
        FLIGHT_AMOUNT_LABELS.bookingTotal,
        "$500.00",
        FLIGHT_AMOUNT_LABELS.paidNow,
        "$100.00",
        FLIGHT_AMOUNT_LABELS.airlineFareExplainer,
      ].join(" "),
    );
  });

  it("names the airline or supplier and shows every flight and layover", async () => {
    const order = await seeded(itineraryFlightSeed());
    const text = await receiptText(order.orderNumber);

    expect(text).toContain(FLIGHT_PROVIDER_LABEL);
    expect(text).toContain("Itinerary");
    expect(text).toContain("Delhi → Varanasi");
    expect(text).toContain("Varanasi → Mumbai");
    expect(text).toContain("Layover: 2h 30m — Varanasi");
    for (const word of RENTAL_WORDS) {
      expect(text, `receipt contains "${word}"`).not.toContain(word);
    }
  });

  it.each([0, null])(
    "leaves the airline row and its explainer out with no airline charge (%s)",
    async (airlineFare) => {
      const order = await seeded(itineraryFlightSeed(airlineFare));
      const text = await receiptText(order.orderNumber);
      expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFare);
      expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFareNote);
      expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFareExplainer);
      expect(text).toContain(`${FLIGHT_AMOUNT_LABELS.bookingTotal} $100.00`);
      expect(text).not.toContain("$0.00");
    },
  );

  it("while the payment is still being confirmed, ends with Amount Payable Now — never a second Service Charge row", async () => {
    const order = await seeded({ ...itineraryFlightSeed(), status: OrderStatus.PAYMENT_PENDING });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("Confirming with Stripe…");
    const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
    expect(box).toContain(
      [
        FLIGHT_AMOUNT_LABELS.serviceCharge,
        "$100.00",
        FLIGHT_AMOUNT_LABELS.bookingTotal,
        "$500.00",
        FLIGHT_AMOUNT_LABELS.payableNow,
        "$100.00",
        FLIGHT_AMOUNT_LABELS.airlineFareExplainer,
      ].join(" "),
    );
    expect(box.split(`${FLIGHT_AMOUNT_LABELS.serviceCharge} $`).length - 1).toBe(1);
    expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.paidNow);
  });

  it("says the service charge is ON HOLD on a manual-capture authorization", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(),
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        capture: {
          method: CaptureMode.MANUAL,
          status: PaymentCaptureStatus.AUTHORIZED,
          authorizedAt: new Date("2026-10-06T10:00:00.000Z"),
          amountAuthorized: 100,
          captureExpiresAt: new Date("2026-10-13T10:00:00.000Z"),
        },
      } as OrderSeed["payment"],
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain(FLIGHT_AMOUNT_LABELS.heldNow);
    expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.paidNow);
    // The breakdown ends with the hold, too.
    const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
    expect(box).toContain(`${FLIGHT_AMOUNT_LABELS.heldNow} $100.00`);
  });
});

describe("a MODIFICATION of an itinerary flight", () => {
  it("is worded neutrally on the receipt", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(),
      bookingType: BookingType.MODIFICATION,
      charges: [{ name: "Change fee", amount: 100, timing: PaymentTiming.PREPAID }],
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.paidNow);
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge);
    expect(text.toLowerCase()).not.toContain("service charge");
    expect(text).toContain("Delhi → Varanasi");
  });
});

describe("a flight receipt names what ACTUALLY happened to the money", () => {
  it.each([PaymentCaptureStatus.CAPTURE_PENDING, PaymentCaptureStatus.CAPTURE_FAILED])(
    "a hold that is %s still reads as ON HOLD — never paid, never payable",
    async (captureStatus) => {
      const order = await seeded({
        ...itineraryFlightSeed(),
        status: OrderStatus.PAYMENT_PENDING,
        payment: {
          capture: {
            method: CaptureMode.MANUAL,
            status: captureStatus,
            authorizedAt: new Date("2026-10-06T10:00:00.000Z"),
            amountAuthorized: 100,
            captureExpiresAt: new Date("2026-10-13T10:00:00.000Z"),
          },
        } as OrderSeed["payment"],
      });
      const text = await receiptText(order.orderNumber);
      const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
      expect(box).toContain(`${FLIGHT_AMOUNT_LABELS.heldNow} $100.00`);
      expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.paidNow);
      expect(box).not.toContain(FLIGHT_AMOUNT_LABELS.payableNow);
    },
  );

  it("an order that is neither paid nor pending never says Paid", async () => {
    const order = await seeded({ ...itineraryFlightSeed(), status: OrderStatus.EXPIRED });
    const text = await receiptText(order.orderNumber);
    const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
    expect(box).toContain(`${FLIGHT_AMOUNT_LABELS.payableNow} $100.00`);
    expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.paidNow);
  });

  it("a pending LEGACY flight says Amount Payable Now in the hero and the breakdown — never Amount Paid", async () => {
    const order = await seeded({
      serviceType: ServiceType.FLIGHT,
      status: OrderStatus.PAYMENT_PENDING,
      pricing: { amount: 420.5, currency: "USD" as never },
    });
    const text = await receiptText(order.orderNumber);
    expect(text).not.toContain(LEGACY_FLIGHT_AMOUNT_LABELS.paidNow);
    expect(text).toContain(`${LEGACY_FLIGHT_AMOUNT_LABELS.payableNow} $420.50`);
    expect(text.split(LEGACY_FLIGHT_AMOUNT_LABELS.payableNow).length - 1).toBe(2);
  });
});

describe("a LEGACY flight's receipt", () => {
  it("is worded neutrally — never a 'service charge'", async () => {
    const order = await seeded({
      serviceType: ServiceType.FLIGHT,
      pricing: { amount: 420.5, currency: "USD" as never },
    });
    const text = await receiptText(order.orderNumber);

    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.paidNow); // "Amount paid"
    expect(text).toContain(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge); // "Charged online"
    expect(text.toLowerCase()).not.toContain("service charge");
    expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.airlineFareNote);
    expect(text).toContain(FLIGHT_PROVIDER_LABEL);
    expect(text).toContain("LHR → JFK");
    for (const word of RENTAL_WORDS) {
      expect(text, `receipt contains "${word}"`).not.toContain(word);
    }
  });
});

describe("a car rental's receipt is unchanged", () => {
  it("keeps every car string, including the counter balance breakdown", async () => {
    const order = await seeded({
      pricing: { amount: 199.5, currency: "USD" as never },
      charges: [
        { name: "Rental cost", amount: 199.5, timing: PaymentTiming.PREPAID },
        { name: "Deposit", amount: 100, timing: PaymentTiming.DUE_AT_COUNTER },
      ],
    });
    const text = await receiptText(order.orderNumber);
    for (const phrase of [
      "Amount paid",
      "Charge breakdown",
      "Remaining balance due at rental counter",
      "Total rental cost",
      "Provider",
      "Vehicle",
      "Pick-up",
      "Drop-off",
      "Toyota",
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    expect(text).not.toContain(FLIGHT_PROVIDER_LABEL);
    expect(text).not.toContain(FLIGHT_AMOUNT_LABELS.breakdownTitle);
    expect(text.toLowerCase()).not.toContain("service charge");
  });

  it("says Stripe while a Stripe payment is still being confirmed — as before", async () => {
    const order = await seeded({ status: OrderStatus.PAYMENT_PENDING });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("Confirming with Stripe…");
  });

  it("names PayPal while a PayPal payment is still being confirmed", async () => {
    const order = await seeded(
      { status: OrderStatus.PAYMENT_PENDING },
      PaymentGatewayKey.PAYPAL,
    );
    // PayPal returns the customer with `token`, not `session_id`.
    const text = await receiptText(order.orderNumber, { token: SESSION });
    expect(text).toContain("Confirming with PayPal…");
    expect(text).toContain("waiting for PayPal");
    expect(text).not.toContain("Stripe");
  });

  it("shows nothing about the order when the session does not match", async () => {
    const order = await seeded({});
    const text = await receiptText(order.orderNumber, { session_id: "cs_test_someone_else" });
    expect(text).not.toContain("Toyota");
    expect(text).not.toContain(order.customer.email);
  });
});
