import { beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import {
  createOrder,
  initiatePayment,
  regeneratePaymentLink,
} from "@/server/services/order.service";
import { actorFor } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

/**
 * CHARACTERIZATION — the exact arguments RentalConfirmation sends to Stripe
 * today.
 *
 * This file is not testing that the behaviour is *correct*. It is recording
 * what production currently does, byte for byte, so that the organization
 * migration can prove it changed nothing. A diff here means the payload
 * reaching Stripe changed: treat that as a deliberate decision to sign off,
 * never as a snapshot to bless away.
 *
 * The important thing this pins down: there are TWO builders, and they are
 * NOT equivalent.
 *
 *   initiatePayment       -> gateway.createSession   (payments/gateways/stripe.ts)
 *   regeneratePaymentLink -> buildCheckoutSession    (order.service.ts, direct)
 *
 * Differences, all verified below:
 *   1. product_data.images  — the gateway emits `images: []` when every
 *      candidate URL is non-http; the direct builder omits the key entirely.
 *   2. payment_intent_data.description — the gateway reads
 *      `metadata.appName ?? "PayOps"`, the direct builder reads
 *      `branding.brandName`. Identical today only because order.service sets
 *      `metadata.appName = branding.brandName` before calling the gateway.
 *   3. below-minimum amounts throw `Error` in the gateway and
 *      `ValidationError` in the direct builder.
 *
 * Routing regenerate through the gateway would therefore change the outgoing
 * request. That is a real decision, not a tidy-up.
 */

const ACTOR_EMAIL = "admin@payops.test";
const CUSTOMER_EMAIL = "ada@payops.test";

/** Replace everything that legitimately varies per run, so what remains is
 *  the shape and the constants we actually care about. */
function normalise(
  value: unknown,
  ids: { orderId: string; orderNumber: string; actorId: string },
): unknown {
  const json = JSON.stringify(value)
    .split(ids.orderId)
    .join("<ORDER_ID>")
    .split(ids.orderNumber)
    .join("<ORDER_NUMBER>")
    .split(ids.actorId)
    .join("<ACTOR_ID>")
    // Trip dates are relative to now in the fixture.
    .replace(/\d{4}-\d{2}-\d{2}/g, "<DATE>");
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (typeof parsed.expires_at === "number") {
    parsed.expires_at = "<EPOCH_SECONDS>";
  }
  return parsed;
}

/** Everything both builders agree on today. */
function commonExpectation(images: { images: string[] } | Record<string, never>) {
  return {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: CUSTOMER_EMAIL,
    client_reference_id: "<ORDER_ID>",
    success_url:
      "http://localhost:3000/pay/success?order=<ORDER_NUMBER>&session_id={CHECKOUT_SESSION_ID}",
    cancel_url: "http://localhost:3000/pay/cancelled?order=<ORDER_NUMBER>",
    expires_at: "<EPOCH_SECONDS>",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 24999,
          product_data: {
            name: "Budget • Toyota Camry rental",
            description:
              "Pick-up: <DATE> (LAX Airport — Terminal 1) • Drop-off: <DATE> (San Diego Downtown)",
            ...images,
          },
        },
      },
    ],
    metadata: {
      orderId: "<ORDER_ID>",
      orderNumber: "<ORDER_NUMBER>",
      bookingType: "NEW_BOOKING",
      actorId: "<ACTOR_ID>",
      actorEmail: ACTOR_EMAIL,
      appName: "Rental Confirmation",
    },
    payment_intent_data: {
      description: "Rental Confirmation • <ORDER_NUMBER>",
      metadata: {
        orderId: "<ORDER_ID>",
        orderNumber: "<ORDER_NUMBER>",
      },
    },
  };
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
});

async function orderWithImage(imageUrl: string | null) {
  const actor = actorFor(UserRole.ADMIN);
  const { order: draft } = await createOrder(
    validCreateOrderInput({
      vehicle: { company: "Toyota", type: "Camry", imageUrl },
    }),
    { actor },
  );
  const { order } = await initiatePayment(draft.id, { actor });
  return { actor, order };
}

describe("initiatePayment -> Stripe (via the gateway abstraction)", () => {
  it("sends exactly these arguments when the vehicle image is not an http URL", async () => {
    const { actor, order } = await orderWithImage("data:image/png;base64,AAA");
    const stripe = getCurrentTestStripe();
    expect(stripe.sessionsCreated).toHaveLength(1);

    const ids = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      actorId: actor.id,
    };

    // NOTE the `images: []`. The gateway branches on "were any URLs
    // supplied", then filters — so a single non-http URL yields an empty
    // array rather than no key. Recorded, not endorsed.
    expect(normalise(stripe.sessionsCreated[0]!.params, ids)).toEqual(
      commonExpectation({ images: [] }),
    );
    expect(stripe.sessionsCreated[0]!.options).toEqual({
      idempotencyKey: `order:${order.id}:checkout`,
    });
  });

  it("forwards a valid http image URL", async () => {
    const { actor, order } = await orderWithImage(
      "https://cdn.example.com/camry.png",
    );
    const stripe = getCurrentTestStripe();
    const ids = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      actorId: actor.id,
    };
    expect(normalise(stripe.sessionsCreated[0]!.params, ids)).toEqual(
      commonExpectation({ images: ["https://cdn.example.com/camry.png"] }),
    );
  });

  it("omits the images key entirely when no image was captured", async () => {
    const { actor, order } = await orderWithImage(null);
    const stripe = getCurrentTestStripe();
    const ids = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      actorId: actor.id,
    };
    expect(normalise(stripe.sessionsCreated[0]!.params, ids)).toEqual(
      commonExpectation({}),
    );
  });
});

describe("regeneratePaymentLink -> Stripe (bypasses the gateway)", () => {
  it("sends exactly these arguments — note images is ABSENT, not empty", async () => {
    const { actor, order } = await orderWithImage("data:image/png;base64,AAA");
    await regeneratePaymentLink(order.id, { actor });

    const stripe = getCurrentTestStripe();
    expect(stripe.sessionsCreated).toHaveLength(2);

    const ids = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      actorId: actor.id,
    };

    // The direct builder guards on the regex before constructing the key, so
    // the key never appears. This is the observable divergence from the
    // gateway path above, which sent `images: []` for the same order.
    expect(normalise(stripe.sessionsCreated[1]!.params, ids)).toEqual(
      commonExpectation({}),
    );
  });

  it("reuses the SAME idempotency key as the original session", async () => {
    // Recorded because it is a live hazard, not because it is desirable.
    // Against real Stripe an idempotency key is honoured for 24h, so a
    // regenerate inside that window returns the ORIGINAL session (with its
    // original expiry) instead of a fresh one — or 400s if any parameter
    // changed. The in-process stub does not deduplicate, so no test can
    // observe the real consequence. Verify against Stripe directly before
    // changing anything on this path.
    const { actor, order } = await orderWithImage(null);
    await regeneratePaymentLink(order.id, { actor });

    const stripe = getCurrentTestStripe();
    const keys = stripe.sessionsCreated.map(
      (s) => (s.options as { idempotencyKey?: string } | undefined)?.idempotencyKey,
    );
    expect(keys).toEqual([
      `order:${order.id}:checkout`,
      `order:${order.id}:checkout`,
    ]);
  });

  it("produces a payload identical to the gateway's apart from images", async () => {
    // Pins difference #2 as currently INERT: payment_intent_data.description
    // resolves to the same string through both code paths today, because
    // order.service seeds metadata.appName from branding.brandName. If that
    // assignment is ever removed, the gateway silently falls back to the
    // literal "PayOps" and this fails.
    const { actor, order } = await orderWithImage(null);
    await regeneratePaymentLink(order.id, { actor });

    const stripe = getCurrentTestStripe();
    const ids = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      actorId: actor.id,
    };
    const viaGateway = normalise(stripe.sessionsCreated[0]!.params, ids);
    const viaDirect = normalise(stripe.sessionsCreated[1]!.params, ids);
    expect(viaDirect).toEqual(viaGateway);
    expect(
      (viaGateway as { payment_intent_data: { description: string } })
        .payment_intent_data.description,
    ).toBe("Rental Confirmation • <ORDER_NUMBER>");
  });
});
