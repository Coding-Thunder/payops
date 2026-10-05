import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BookingType,
  Currency,
  FlightTripType,
  PaymentGatewayKey,
  PaymentTiming,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { ProviderId } from "@/lib/constants/providers";
import { _resetEnvCacheForTests } from "@/lib/env";
import { _resetOrganizationCacheForTests } from "@/server/auth/organization";
import { Order } from "@/server/db/models";
import { createOrder, getOrderById, initiatePayment } from "@/server/services/order.service";
import { _setPayPalFetchForTesting } from "@/server/payments/gateways/paypal";
import { createSettings } from "@/tests/factories/settings.factory";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { setEnabledProviders } from "@/tests/utils/organization";

/**
 * THE ORDER'S CURRENCY IS THE TRANSACTION CURRENCY.
 *
 * A flight order was created for 120.00 USD and the hosted payment page
 * offered INR. The rule under test is `payment currency = order currency` —
 * NOT "force USD", which would be a different bug for any deployment that
 * sells in anything else.
 *
 * Both gateway requests are inspected directly: Stripe through the existing
 * stub, PayPal through its existing `_setPayPalFetchForTesting` seam. Nothing
 * in `src/server/payments/` is modified; these read what the caller hands it.
 */

const FLIGHT_AMOUNT = 120;

/** Every PayPal create-order request body this test observed. */
let paypalRequests: Array<Record<string, unknown>> = [];

function installPayPalCapture() {
  paypalRequests = [];
  _setPayPalFetchForTesting((async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/v1/oauth2/token")) {
      return new Response(
        JSON.stringify({ access_token: "test-token", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (href.includes("/v2/checkout/orders")) {
      if (init?.body) {
        paypalRequests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          id: "PAYPAL-ORDER-1",
          status: "CREATED",
          links: [{ rel: "payer-action", href: "https://paypal.test/approve" }],
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch);
}

function flightInput(overrides: Record<string, unknown> = {}) {
  return {
    serviceType: ServiceType.FLIGHT,
    bookingType: BookingType.NEW_BOOKING,
    provider: ProviderId.BUDGET,
    customer: { name: "Ada Lovelace", email: "ada@payops.test", phone: "+15555550100" },
    flight: {
      tripType: FlightTripType.ONE_WAY,
      origin: "London Heathrow",
      destination: "New York JFK",
      departureDate: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      airline: "American Airlines",
      flightNumber: "AA101",
      pnr: "QR7X2B",
      cabinClass: "ECONOMY",
      passengers: { adults: 1, children: 0, infants: 0 },
    },
    currency: Currency.USD,
    charges: [{ name: "Airfare", amount: FLIGHT_AMOUNT, timing: PaymentTiming.PREPAID }],
    ...overrides,
  };
}

const actor = actorFor(UserRole.ADMIN);

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  installPayPalCapture();
});

afterEach(() => {
  _setPayPalFetchForTesting(null);
});

describe("a 120.00 USD flight order through STRIPE", () => {
  it("stores USD and sends usd / 12000 to Stripe", async () => {
    const created = await createOrder(flightInput() as never, { actor });

    const doc = await Order.findById(created.order.id).lean();
    expect(doc?.pricing.currency).toBe("USD");
    expect(doc?.pricing.amount).toBe(120);

    await initiatePayment(created.order.id, { actor });
    const params = getCurrentTestStripe().sessionsCreated[0]!.params as unknown as {
      line_items: { price_data: { currency: string; unit_amount: number } }[];
    };
    expect(params.line_items[0]!.price_data.currency).toBe("usd");
    expect(params.line_items[0]!.price_data.unit_amount).toBe(12000);
  });

  it("passes no locale, no currency conversion and no adaptive-pricing option", async () => {
    const created = await createOrder(flightInput() as never, { actor });
    await initiatePayment(created.order.id, { actor });

    // If any of these were sent, the app itself would be localising the
    // transaction. None is: the INR offer originates in Stripe's account
    // settings, not here.
    const params = getCurrentTestStripe().sessionsCreated[0]!.params as unknown as
      Record<string, unknown>;
    expect(params.locale).toBeUndefined();
    expect(params.currency_conversion).toBeUndefined();
    expect(params.adaptive_pricing).toBeUndefined();
  });

  it("agrees with the DTO the operator UI and emails read", async () => {
    const created = await createOrder(flightInput() as never, { actor });
    const dto = await getOrderById(created.order.id, { actor });
    expect(dto.pricing.currency).toBe("USD");
    expect(dto.pricing.amount).toBe(120);
  });
});

describe("a 120.00 USD flight order through PAYPAL", () => {
  beforeEach(async () => {
    // Deployment-level PayPal credentials, which the DEFAULT organization is
    // allowed to use — the same arrangement `paypal-credential-resolution`
    // pins. Fake values: the HTTP layer is stubbed, nothing leaves the box.
    for (const [k, v] of Object.entries({
      PAYPAL_CLIENT_ID: "test-client-id",
      PAYPAL_CLIENT_SECRET: "test-client-secret",
      PAYPAL_WEBHOOK_ID: "test-webhook-id",
    })) {
      vi.stubEnv(k, v);
    }
    _resetEnvCacheForTests();
    _resetOrganizationCacheForTests();
    await setEnabledProviders([PaymentGatewayKey.STRIPE, PaymentGatewayKey.PAYPAL]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetEnvCacheForTests();
    _resetOrganizationCacheForTests();
  });

  it("sends currency_code USD and value 120.00", async () => {
    const created = await createOrder(flightInput() as never, { actor });
    await initiatePayment(created.order.id, { actor }, {
      gateway: PaymentGatewayKey.PAYPAL,
    });

    expect(paypalRequests).toHaveLength(1);
    const unit = (
      paypalRequests[0] as {
        purchase_units: { amount: { currency_code: string; value: string } }[];
      }
    ).purchase_units[0]!;
    expect(unit.amount.currency_code).toBe("USD");
    expect(unit.amount.value).toBe("120.00");
  });

  it("does not ask PayPal to localise the transaction", async () => {
    const created = await createOrder(flightInput() as never, { actor });
    await initiatePayment(created.order.id, { actor }, {
      gateway: PaymentGatewayKey.PAYPAL,
    });

    const body = paypalRequests[0] as {
      payment_source?: { paypal?: { experience_context?: Record<string, unknown> } };
    };
    const ctx = body.payment_source?.paypal?.experience_context ?? {};
    // No locale and no buyer-country hint — PayPal's own conversion offer is
    // an account/buyer-side feature, not something this request requests.
    expect(ctx.locale).toBeUndefined();
    expect(ctx.shipping_preference).not.toBe("GET_FROM_FILE");
  });
});

describe("the rule is order-currency, not forced USD", () => {
  it("sends EUR to Stripe for a EUR flight order", async () => {
    const created = await createOrder(
      flightInput({
        currency: Currency.EUR,
        charges: [{ name: "Airfare", amount: 99.5, timing: PaymentTiming.PREPAID }],
      }) as never,
      { actor },
    );
    await initiatePayment(created.order.id, { actor });
    const params = getCurrentTestStripe().sessionsCreated[0]!.params as unknown as {
      line_items: { price_data: { currency: string; unit_amount: number } }[];
    };
    expect(params.line_items[0]!.price_data.currency).toBe("eur");
    expect(params.line_items[0]!.price_data.unit_amount).toBe(9950);
  });
});

describe("CAR currency behaviour is unchanged", () => {
  it("still sends its own currency and amount to Stripe", async () => {
    const created = await createOrder(
      validCreateOrderInput({
        currency: Currency.USD,
        charges: [{ name: "Rental cost", amount: 199.99, timing: PaymentTiming.PREPAID }],
      }),
      { actor },
    );
    await initiatePayment(created.order.id, { actor });
    const params = getCurrentTestStripe().sessionsCreated[0]!.params as unknown as {
      line_items: { price_data: { currency: string; unit_amount: number } }[];
    };
    expect(params.line_items[0]!.price_data.currency).toBe("usd");
    expect(params.line_items[0]!.price_data.unit_amount).toBe(19999);
  });
});
