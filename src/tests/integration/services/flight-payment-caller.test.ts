import { beforeEach, describe, expect, it } from "vitest";

import {
  Currency,
  FlightTripType,
  PaymentTiming,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { ProviderId } from "@/lib/constants/providers";
import { Order } from "@/server/db/models";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

/**
 * WHAT THE FLIGHT ORDER HANDS THE EXISTING PAYMENT LAYER.
 *
 * `src/server/payments/` is unchanged by the flight feature; the only thing
 * that differs is the data the caller supplies. So this asserts the caller's
 * output rather than the gateway's behaviour:
 *
 *   - the amount survives UI -> API -> DB -> gateway intact, to the cent
 *   - the line item describes a flight, not a vehicle
 *   - `metadata.appName` — which becomes the payment-intent description and
 *     PayPal's approval-screen brand — is the FLIGHT brand
 *
 * and the car equivalents are asserted alongside, because "the flight is
 * right" is only half the requirement.
 */

const AMOUNT = 420.5;

function flightInput() {
  return {
    serviceType: ServiceType.FLIGHT,
    bookingType: "NEW_BOOKING" as const,
    provider: ProviderId.BUDGET,
    customer: {
      name: "Ada Lovelace",
      email: "ada@payops.test",
      phone: "+15555550100",
    },
    flight: {
      tripType: FlightTripType.ONE_WAY,
      origin: "London Heathrow",
      destination: "New York JFK",
      departureDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      cabinClass: "ECONOMY",
      passengers: { adults: 1, children: 0, infants: 0 },
    },
    currency: Currency.USD,
    charges: [
      { name: "Airfare", amount: AMOUNT, timing: PaymentTiming.PREPAID },
    ],
  };
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

describe("a FLIGHT order through the existing payment infrastructure", () => {
  it("sends the exact amount to the gateway, in minor units", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const created = await createOrder(flightInput() as never, { actor });
    await initiatePayment(created.order.id, { actor });

    const stripe = getCurrentTestStripe();
    expect(stripe.sessionsCreated).toHaveLength(1);
    const args = stripe.sessionsCreated[0]!.params as unknown as {
      line_items: { price_data: { unit_amount: number; currency: string } }[];
    };
    // 420.50 -> 42050 cents. A rounding or parseInt bug anywhere in the
    // chain shows up here as a different integer.
    expect(args.line_items[0]!.price_data.unit_amount).toBe(42050);
    expect(args.line_items[0]!.price_data.currency).toBe("usd");
  });

  it("describes the flight, not a vehicle", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const created = await createOrder(flightInput() as never, { actor });
    await initiatePayment(created.order.id, { actor });

    const args = getCurrentTestStripe().sessionsCreated[0]!
      .params as unknown as {
      line_items: { price_data: { product_data: { name: string } } }[];
      payment_intent_data: { description: string };
    };
    const name = args.line_items[0]!.price_data.product_data.name;
    expect(name).toContain("London Heathrow → New York JFK");
    expect(name).toContain("flight");
    expect(name).not.toContain("rental");
  });

  it("puts the FLIGHT brand on the payment-intent description", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const created = await createOrder(flightInput() as never, { actor });
    await initiatePayment(created.order.id, { actor });

    const args = getCurrentTestStripe().sessionsCreated[0]!
      .params as unknown as {
      payment_intent_data: { description: string };
      metadata: Record<string, string>;
    };
    // This string is what a cardholder sees on the statement/receipt.
    expect(args.payment_intent_data.description).toContain("Airfare Fees");
    expect(args.metadata.appName).toBe("Airfare Fees");
  });

  it("persists the amount unchanged on the order it just charged", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const created = await createOrder(flightInput() as never, { actor });
    const doc = await Order.findById(created.order.id).lean();
    expect(doc?.pricing.amount).toBe(AMOUNT);
    expect(doc?.charges?.[0]?.amount).toBe(AMOUNT);
  });
});

describe("the CAR order is unaffected", () => {
  it("still sends its own amount and the car brand", async () => {
    const actor = actorFor(UserRole.ADMIN);
    const created = await createOrder(
      validCreateOrderInput({
        charges: [
          { name: "Rental cost", amount: 199.99, timing: PaymentTiming.PREPAID },
        ],
      }),
      { actor },
    );
    await initiatePayment(created.order.id, { actor });

    const args = getCurrentTestStripe().sessionsCreated[0]!
      .params as unknown as {
      line_items: {
        price_data: { unit_amount: number; product_data: { name: string } };
      }[];
      payment_intent_data: { description: string };
      metadata: Record<string, string>;
    };
    expect(args.line_items[0]!.price_data.unit_amount).toBe(19999);
    expect(args.line_items[0]!.price_data.product_data.name).toContain("rental");
    // The flight brand must not reach a car charge.
    expect(args.payment_intent_data.description).not.toContain("Airfare Fees");
    expect(args.metadata.appName).not.toBe("Airfare Fees");
  });
});
