import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import PaymentSuccessPage, { generateMetadata } from "@/app/pay/success/page";
import {
  DEFAULT_FLIGHT_CHARGE_NAME,
  FLIGHT_AMOUNT_LABELS,
  flightLabelsWithCharge,
  LEGACY_FLIGHT_AMOUNT_LABELS,
  LEGACY_FLIGHT_CHARGE_NAME,
} from "@/lib/charges";
import {
  BookingType,
  CaptureMode,
  OrderStatus,
  PaymentCaptureStatus,
  PaymentGatewayKey,
  PaymentTiming,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { FLIGHT_PROVIDER_LABEL } from "@/lib/constants/labels";
import { Order, Organization } from "@/server/db/models";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import {
  createOrder,
  initiatePayment,
} from "@/server/services/order.service";
import {
  createOrder as factoryCreateOrder,
  itineraryFlight,
  type OrderSeed,
} from "@/tests/factories/order.factory";
import { createSettings } from "@/tests/factories/settings.factory";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";

/**
 * /pay/success — the receipt a customer lands on straight from the gateway,
 * rendered for real (server component, real services, real database).
 *
 * For an itinerary flight it must say what the payment covered — the
 * charge, by the name the operator gave it ("Service Charge" by default),
 * "paid" or "on hold" — set against the full booking value, show every
 * flight, and never use rental vocabulary. A modification shows its
 * charge's name in neutral sentences. A flight created before itineraries,
 * or a modification whose charge was never named, is worded neutrally. A
 * car receipt keeps every string — its "Confirmation #" row included — and
 * a PayPal order's "still confirming" line names PayPal (it used to say
 * Stripe to everyone).
 *
 * Every receipt shows the booking's ONE supplier reference once, named the
 * service's way (a flight's "PNR" row, a hotel's "Hotel confirmation #"),
 * and none says "Payment confirmed" before the gateway has: an order whose
 * link was copied (LINK_GENERATED) is reconciled and waited on exactly like
 * one whose request was emailed (PAYMENT_PENDING).
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

/** An itinerary flight: $400 airline charge, $100 collected under
 *  `chargeName` — by default the name a new order stores when its operator
 *  left it blank. */
const itineraryFlightSeed = (
  airlineFare: number | null = 400,
  chargeName: string = DEFAULT_FLIGHT_CHARGE_NAME,
): OrderSeed => ({
  serviceType: ServiceType.FLIGHT,
  flight: itineraryFlight({ airlineFare }),
  pricing: { amount: 100, currency: "USD" as never },
  charges: [{ name: chargeName, amount: 100, timing: PaymentTiming.PREPAID }],
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

describe("an itinerary flight's receipt names the charge as the operator did", () => {
  it.each([DEFAULT_FLIGHT_CHARGE_NAME, LEGACY_FLIGHT_CHARGE_NAME])(
    "reads the default 'Service Charge' for a line stored as '%s'",
    async (stored) => {
      const order = await seeded(itineraryFlightSeed(400, stored));
      const text = await receiptText(order.orderNumber);
      expect(text).toContain(
        `has confirmed your ${DEFAULT_FLIGHT_CHARGE_NAME} payment and a receipt is on its way to your inbox.`,
      );
      const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
      expect(box).toContain(`${FLIGHT_AMOUNT_LABELS.serviceCharge} $100.00`);
      expect(box).toContain(`${FLIGHT_AMOUNT_LABELS.paidNow} $100.00`);
    },
  );

  it("paid: the hero confirms the 'Processing Fee' payment and the rows carry its name — never 'Service Charge'", async () => {
    const order = await seeded(itineraryFlightSeed(400, "Processing Fee"));
    const text = await receiptText(order.orderNumber);
    const labels = flightLabelsWithCharge("Processing Fee");
    expect(labels.paidNow).toBe("Processing Fee Paid");

    expect(text).toContain(
      "has confirmed your Processing Fee payment and a receipt is on its way to your inbox.",
    );
    // The amount hero says what was paid.
    expect(text).toContain(`${labels.paidNow} $100.00 Order`);
    const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
    expect(box).toContain(
      [
        FLIGHT_AMOUNT_LABELS.airlineFare,
        FLIGHT_AMOUNT_LABELS.airlineFareNote,
        "$400.00",
        "Processing Fee",
        "$100.00",
        FLIGHT_AMOUNT_LABELS.bookingTotal,
        "$500.00",
        labels.paidNow,
        "$100.00",
        FLIGHT_AMOUNT_LABELS.airlineFareExplainer,
      ].join(" "),
    );
    expect(text).not.toContain(DEFAULT_FLIGHT_CHARGE_NAME);
    expect(text.toLowerCase()).not.toContain("service charge");
  });

  it("pending: the hero waits on the 'Rental Cost' payment, and the breakdown ends with Amount Payable Now", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(400, "Rental Cost"),
      status: OrderStatus.PAYMENT_PENDING,
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("is waiting for Stripe to finalise your Rental Cost payment.");
    // Nothing collected yet: the amount hero names WHAT the amount is.
    expect(text).toContain("Rental Cost $100.00 Order");
    const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
    expect(box).toContain(
      [
        "Rental Cost",
        "$100.00",
        FLIGHT_AMOUNT_LABELS.bookingTotal,
        "$500.00",
        FLIGHT_AMOUNT_LABELS.payableNow,
        "$100.00",
        FLIGHT_AMOUNT_LABELS.airlineFareExplainer,
      ].join(" "),
    );
    expect(box.split("Rental Cost $").length - 1).toBe(1);
    expect(text).not.toContain("Rental Cost Paid");
    expect(text).not.toContain(DEFAULT_FLIGHT_CHARGE_NAME);
    expect(text.toLowerCase()).not.toContain("service charge");
  });

  it("on hold: the hero says the hold is for the 'Agency Fee', and the breakdown ends with 'Agency Fee On Hold'", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(400, "Agency Fee"),
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
    const labels = flightLabelsWithCharge("Agency Fee");
    expect(labels.heldNow).toBe("Agency Fee On Hold");
    expect(text).toContain("has placed a hold on your card for the Agency Fee of $100.00.");
    const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
    expect(box).toContain(`${labels.heldNow} $100.00`);
    expect(text).not.toContain(labels.paidNow);
    expect(text).not.toContain(DEFAULT_FLIGHT_CHARGE_NAME);
    expect(text.toLowerCase()).not.toContain("service charge");
  });
});

describe("a MODIFICATION of an itinerary flight", () => {
  it("shows the operator's name for its charge — in neutral sentences", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(400, "Change Fee"),
      bookingType: BookingType.MODIFICATION,
    });
    const text = await receiptText(order.orderNumber);
    const labels = flightLabelsWithCharge("Change Fee");
    expect(text).toContain(labels.paidNow); // "Change Fee Paid"
    const box = text.slice(text.indexOf(FLIGHT_AMOUNT_LABELS.breakdownTitle));
    expect(box).toContain(`Change Fee $100.00 ${FLIGHT_AMOUNT_LABELS.bookingTotal} $500.00`);
    expect(box).toContain(`${labels.paidNow} $100.00`);
    // The hero sentence names no charge — a modification is not the
    // booking's own charge.
    expect(text).toContain("has confirmed your payment and a receipt is on its way to your inbox.");
    expect(text).not.toContain("your Change Fee payment");
    // Its name, not the neutral wording of a charge nobody named.
    expect(text).not.toContain(LEGACY_FLIGHT_AMOUNT_LABELS.paidNow);
    expect(text).not.toContain(LEGACY_FLIGHT_AMOUNT_LABELS.serviceCharge);
    expect(text.toLowerCase()).not.toContain("service charge");
    expect(text).toContain("Delhi → Varanasi");
  });

  it("is worded neutrally on the receipt when its charge was never named (the pre-naming 'Service charge')", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(400, LEGACY_FLIGHT_CHARGE_NAME),
      bookingType: BookingType.MODIFICATION,
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

  it("shows the supplier's number on its 'Confirmation #' row, straight after the drop-off", async () => {
    const order = await seeded({ confirmationNumber: "SUPP-9F3K2218" });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("San Diego Downtown Confirmation # SUPP-9F3K2218");
  });

  it("has no 'Confirmation #' row until the number is pasted", async () => {
    const order = await seeded({});
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("Drop-off");
    expect(text).not.toContain("Confirmation #");
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

/* ------------------------------------------------------------------ *
 * The booking reference — one row, named the service's way
 * ------------------------------------------------------------------ */

describe("the receipt shows the booking's one supplier reference, once, named the service's way", () => {
  it("FLIGHT: the shared 'PNR' row carries the order's reference — no second 'Confirmation #' row", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(),
      flight: itineraryFlight({ airlineFare: 400, pnr: null }),
      confirmationNumber: "AXXXYY",
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("PNR AXXXYY");
    expect(text.split("AXXXYY")).toHaveLength(2);
    expect(text).not.toContain("Confirmation #");
  });

  it("FLIGHT: an older flight holding its airline PNR AND a different pasted supplier number shows both, each under its own name", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(),
      flight: itineraryFlight({ airlineFare: 400, pnr: "OLDPNR1" }),
      confirmationNumber: "AXXXYY",
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("PNR OLDPNR1");
    expect(text).toContain("Confirmation # AXXXYY");
    // The supplier number is never presented as the PNR.
    expect(text).not.toContain("PNR AXXXYY");
  });

  it("FLIGHT: a flight created before the reference moved shows its legacy PNR on that one row", async () => {
    const order = await seeded({
      ...itineraryFlightSeed(),
      flight: itineraryFlight({ airlineFare: 400, pnr: "LEGACY7" }),
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("PNR LEGACY7");
    expect(text.split("LEGACY7")).toHaveLength(2);
    expect(text).not.toContain("Confirmation #");
  });

  it("HOTEL: one 'Hotel confirmation #' row, after the stay — never the car's 'Confirmation #'", async () => {
    const order = await seeded({
      serviceType: ServiceType.HOTEL,
      pricing: { amount: 300, currency: "USD" as never },
      charges: [{ name: "Room charge", amount: 300, timing: PaymentTiming.PREPAID }],
      confirmationNumber: "83920174",
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("Guests 2 adults Hotel confirmation # 83920174");
    expect(text.split("83920174")).toHaveLength(2);
    expect(text).not.toContain("Confirmation #");
  });

  it("HOTEL: no reference row until one is pasted", async () => {
    const order = await seeded({
      serviceType: ServiceType.HOTEL,
      pricing: { amount: 300, currency: "USD" as never },
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("Check-out");
    expect(text).not.toContain("confirmation #");
  });
});

/* ------------------------------------------------------------------ *
 * Never "Payment confirmed" before the gateway confirms it
 * ------------------------------------------------------------------ */

describe("a copied link (LINK_GENERATED) is waited on like an emailed one — never 'Payment confirmed' early", () => {
  it("reconciles a LINK_GENERATED order whose Stripe checkout completed: the order is PAID and the page says so", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const { order: draft } = await createOrder(validCreateOrderInput(), { actor });
    const { order: linked } = await initiatePayment(draft.id, { actor });
    expect(linked.status).toBe(OrderStatus.LINK_GENERATED);
    // The customer paid from the copied link; no webhook has landed yet.
    const session = getCurrentTestStripe().sessionsCreated[0]!.result as unknown as {
      status: string;
      payment_status: string;
    };
    session.status = "complete";
    session.payment_status = "paid";

    const text = await receiptText(linked.orderNumber, {
      session_id: linked.payment.paymentSessionId!,
    });

    expect((await Order.findById(linked.id).lean())?.status).toBe(OrderStatus.PAID);
    expect(text).toContain("Payment confirmed");
    expect(text).toContain("Payment received");
  });

  it("waits on a LINK_GENERATED Stripe checkout that has not completed — 'Confirming with Stripe…', not 'Payment confirmed'", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const { order: draft } = await createOrder(validCreateOrderInput(), { actor });
    const { order: linked } = await initiatePayment(draft.id, { actor });

    const text = await receiptText(linked.orderNumber, {
      session_id: linked.payment.paymentSessionId!,
    });

    expect(text).toContain("Confirming with Stripe…");
    expect(text).toContain("We’re confirming your payment");
    expect(text).not.toContain("Payment confirmed");
    expect((await Order.findById(linked.id).lean())?.status).toBe(OrderStatus.LINK_GENERATED);
  });

  it("asks PayPal about a LINK_GENERATED order and, while PayPal says APPROVED, shows the 'confirming with PayPal' wait", async () => {
    const env = {
      ORG_TRIPSTAYS_PAYPAL_CLIENT_ID: "test-client-id",
      ORG_TRIPSTAYS_PAYPAL_CLIENT_SECRET: "test-client-secret",
      ORG_TRIPSTAYS_PAYPAL_WEBHOOK_ID: "TESTWEBHOOK",
      ORG_TRIPSTAYS_PAYPAL_SANDBOX: "true",
    };
    Object.assign(process.env, env);
    const asked: string[] = [];
    _setPayPalFetchForTesting((async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/oauth2/token")) {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      asked.push(url);
      // The buyer approved on PayPal; nothing has been captured.
      return new Response(
        JSON.stringify({
          id: SESSION,
          status: "APPROVED",
          purchase_units: [{ amount: { currency_code: "USD", value: "199.50" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch);
    try {
      const org = await Organization.create({
        slug: "tripstays",
        name: "tripstays",
        brandName: "Trip Stays",
        isDefault: false,
        payments: { provider: PaymentGatewayKey.PAYPAL },
      });
      const order = await seeded(
        { status: OrderStatus.LINK_GENERATED, organizationId: org._id },
        PaymentGatewayKey.PAYPAL,
      );

      // PayPal returns the customer with `token`.
      const text = await receiptText(order.orderNumber, { token: SESSION });

      expect(asked.some((u) => u.includes(`/v2/checkout/orders/${SESSION}`))).toBe(true);
      expect(text).toContain("Confirming with PayPal…");
      expect(text).toContain("waiting for PayPal");
      expect(text).not.toContain("Payment confirmed");
      expect(text).not.toContain("Stripe");
      expect((await Order.findById(order._id).lean())?.status).toBe(OrderStatus.LINK_GENERATED);
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  it("shows the HOLD on a manual-capture authorization reached from a copied link — 'Card authorized', in the tab title too", async () => {
    const order = await seeded({
      status: OrderStatus.LINK_GENERATED,
      payment: {
        capture: {
          method: CaptureMode.MANUAL,
          status: PaymentCaptureStatus.AUTHORIZED,
          authorizedAt: new Date("2026-10-06T10:00:00.000Z"),
          amountAuthorized: 199.5,
          captureExpiresAt: new Date("2026-10-13T10:00:00.000Z"),
        },
      } as OrderSeed["payment"],
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("Card authorized");
    expect(text).toContain("Your card has been authorized");
    expect(text).toContain("You have not been charged yet");
    expect(text).toContain("Amount on hold $199.50");
    expect(text).not.toContain("Payment confirmed");
    expect(text).not.toContain("Payment received");

    const meta = await generateMetadata({
      searchParams: Promise.resolve({ order: order.orderNumber, session_id: SESSION }),
    } as Parameters<typeof generateMetadata>[0]);
    expect(String(meta.title.absolute)).toMatch(/^Card authorized • /);
  });

  it("leaves a PAYMENT_PENDING hold exactly as before", async () => {
    const order = await seeded({
      status: OrderStatus.PAYMENT_PENDING,
      payment: {
        capture: {
          method: CaptureMode.MANUAL,
          status: PaymentCaptureStatus.AUTHORIZED,
          authorizedAt: new Date("2026-10-06T10:00:00.000Z"),
          amountAuthorized: 199.5,
          captureExpiresAt: new Date("2026-10-13T10:00:00.000Z"),
        },
      } as OrderSeed["payment"],
    });
    const text = await receiptText(order.orderNumber);
    expect(text).toContain("Card authorized");
    expect(text).toContain("Amount on hold $199.50");
    expect(text).not.toContain("Payment confirmed");
  });
});
