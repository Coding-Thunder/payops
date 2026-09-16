import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * The composer's preview must show what will actually be sent.
 *
 * It renders through `composePaymentRequestProps` — the same function the
 * send uses — so these assertions are about the props the preview receives,
 * not a second rendering path. The bug this pins: the preview did not see
 * the operator's collection choice, so selecting "Manual charge" left a
 * Stripe checkout CTA on screen while the email that would actually go out
 * carried none.
 */

const { createOrder, getOrderById, applyOrderModification } = await import(
  "@/server/services/order.service"
);
const { composePaymentRequestProps } = await import(
  "@/server/services/email.service"
);

const admin = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  sessionMock = await mockSession(admin);
  return () => {
    sessionMock?.restore();
    sessionMock = null;
    vi.useRealTimers();
  };
});

const ctx = () => ({ actor: admin, request: null });

async function orderWithLink(gateway: PaymentGatewayKey, amount = 500) {
  const { order } = await createOrder(
    validCreateOrderInput({
      charges: [{ name: "Rental cost", amount, timing: "PREPAID" }],
    }),
    ctx(),
  );
  await Order.updateOne(
    { _id: order.id },
    {
      $set: {
        status: OrderStatus.LINK_GENERATED,
        "payment.status": OrderStatus.LINK_GENERATED,
        "payment.gateway": gateway,
        "payment.stripeSessionId": "sess_1",
        "payment.checkoutUrl": "https://checkout.example.test/sess_1",
      },
    },
  );
  return order.id;
}

const preview = async (id: string, manualCollection: boolean) =>
  composePaymentRequestProps(await getOrderById(id, { actor: admin }), {
    manualCollection,
  });

/** Consent already given — the only state in which the email links straight
 *  to checkout. Before that, BOTH paths correctly route through consent. */
async function grantConsent(id: string) {
  await Order.updateOne(
    { _id: id },
    { $set: { "consent.status": "RECEIVED" } },
  );
}

describe("preview reflects the selected payment method", () => {
  it("Stripe, consent pending: does not promise that payment is arranged separately", async () => {
    // With consent not mandatory on this deployment both paths route through
    // the consent page, so the LABEL alone does not distinguish them. The
    // copy does, and that is what the operator reads in the pane.
    const id = await orderWithLink(PaymentGatewayKey.STRIPE);
    const props = await preview(id, false);
    expect(props.primaryCta?.helperText ?? "").not.toMatch(
      /arrange payment with you separately/i,
    );
    expect(props.intro ?? "").not.toMatch(/arrange payment with you separately/i);
  });

  it("Stripe, consent given: offers the checkout CTA", async () => {
    const id = await orderWithLink(PaymentGatewayKey.STRIPE);
    await grantConsent(id);
    const props = await preview(id, false);
    expect(props.primaryCta?.url).toContain("checkout.example.test");
    expect(props.primaryCta?.label ?? "").toMatch(/pay .*securely/i);
  });

  it("PayPal, consent given: offers the checkout CTA and names PayPal", async () => {
    const id = await orderWithLink(PaymentGatewayKey.PAYPAL);
    await grantConsent(id);
    const props = await preview(id, false);
    expect(props.primaryCta?.url).toContain("checkout.example.test");
    expect(props.primaryCta?.label ?? "").toMatch(/paypal/i);
  });

  it("Manual, consent given: STILL no checkout CTA", async () => {
    // The dangerous case. Consent is in, a live link exists, and the gateway
    // path would now link straight to checkout — the manual path must not.
    const id = await orderWithLink(PaymentGatewayKey.STRIPE);
    await grantConsent(id);
    const props = await preview(id, true);
    expect(props.primaryCta?.url ?? "").not.toContain("checkout.example.test");
    expect(props.primaryCta?.label ?? "").not.toMatch(/pay .*securely/i);
  });

  it("Manual: offers the consent CTA only, with no checkout URL", async () => {
    // Same order, same live link — only the operator's choice differs.
    const id = await orderWithLink(PaymentGatewayKey.STRIPE);
    const props = await preview(id, true);

    expect(props.primaryCta?.label).toBe("Review & Confirm Booking");
    expect(props.primaryCta?.url ?? "").not.toContain("checkout.example.test");
    expect(props.primaryCta?.label ?? "").not.toMatch(/pay .*securely/i);
  });

  it("switching method changes the preview for the same order", async () => {
    // The exact failure reported: same order, same everything, only the
    // operator's choice differs — the preview must not come back identical.
    const id = await orderWithLink(PaymentGatewayKey.STRIPE);
    const gateway = await preview(id, false);
    const manual = await preview(id, true);

    expect(manual.primaryCta?.helperText).not.toBe(gateway.primaryCta?.helperText);
    expect(manual.primaryCta?.helperText ?? "").toMatch(
      /arrange payment with you separately/i,
    );
    expect(manual.intro).not.toBe(gateway.intro);
  });

  it("Manual preview explains that payment is arranged separately", async () => {
    const id = await orderWithLink(PaymentGatewayKey.STRIPE);
    const props = await preview(id, true);
    expect(props.primaryCta?.helperText ?? "").toMatch(
      /arrange payment with you separately/i,
    );
  });
});

describe("preview reflects the current amount", () => {
  it("shows the re-priced amount after a booking edit", async () => {
    const id = await orderWithLink(PaymentGatewayKey.STRIPE, 500);
    const before = await preview(id, false);
    expect(JSON.stringify(before)).toContain("500");

    await applyOrderModification(
      id,
      {
        vehicle: { company: "BMW", type: "X3" },
        charges: [{ name: "Rental cost", amount: 650, timing: "PREPAID" }],
      },
      ctx(),
    );

    const after = await preview(id, false);
    const blob = JSON.stringify(after);
    // The stale figure must be gone, not merely accompanied by the new one.
    expect(blob).toContain("650");
    expect(after.primaryCta?.label ?? "").not.toContain("500");
  });

  it("carries the edited vehicle into the preview", async () => {
    const id = await orderWithLink(PaymentGatewayKey.STRIPE, 500);
    await applyOrderModification(
      id,
      { vehicle: { company: "BMW", type: "X3" } },
      ctx(),
    );
    const props = await preview(id, false);
    expect(JSON.stringify(props)).toMatch(/BMW/);
  });
});
