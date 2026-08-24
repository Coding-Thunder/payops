import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Customer-facing copy must name the processor that actually took the money.
 *
 * This survives from a file that framed the same rule as a BRAND problem
 * ("brand B's customer must not read brand A's identity"). The brand
 * dimension is gone with the second organization; the PROVIDER dimension is
 * not, and it is live the moment a deployment offers more than one gateway —
 * which this one is architected for even while only Stripe is switched on.
 *
 * These are the regression guard for the "payment copy is provider-neutral"
 * work. Hardcoded "Stripe" in shared copy is invisible while Stripe is the
 * only provider and wrong the day it is not.
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<t>", response: "250" };
    },
  }),
  getMailerFor: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<t>", response: "250" };
    },
  }),
  verifyMailer: async () => {},
  _resetOrgMailersForTests: () => {},
}));

const { sendPaymentConfirmationEmail, composePaymentRequestProps } =
  await import("@/server/services/email.service");
const { createOrder, getOrderById } = await import(
  "@/server/services/order.service"
);

const actor = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  sentMail.length = 0;
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
});

/** An order settled through `gateway`, without touching that gateway. */
async function orderPaidVia(gateway: PaymentGatewayKey) {
  const { order } = await createOrder(validCreateOrderInput(), { actor });
  await Order.updateOne(
    { _id: order.id },
    { $set: { "payment.gateway": gateway } },
  );
  return getOrderById(order.id, { actor });
}

describe("the confirmation receipt names the real processor", () => {
  it("does not claim Stripe processed a PayPal payment", async () => {
    // The receipt is the document most likely to be kept, forwarded, or
    // attached to a chargeback. Asserting a processor that was not in the
    // transaction — and a PCI attestation about it — is the worst place in
    // the product to be wrong.
    await sendPaymentConfirmationEmail(
      await orderPaidVia(PaymentGatewayKey.PAYPAL),
    );

    const html = String(sentMail.at(-1)!.html);
    expect(html).toContain("PayPal");
    expect(html).not.toContain("Stripe");
  });

  it("leaves a Stripe order's copy exactly as it was", async () => {
    await sendPaymentConfirmationEmail(
      await orderPaidVia(PaymentGatewayKey.STRIPE),
    );

    const html = String(sentMail.at(-1)!.html);
    expect(html).toContain(
      "Payment processed securely by Stripe — PCI-DSS Level 1 certified",
    );
    expect(html).toContain("Powered by Stripe.");
  });
});

describe("the payment button names the real processor", () => {
  it("says PayPal on a PayPal order", async () => {
    const order = await orderPaidVia(PaymentGatewayKey.PAYPAL);
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          "payment.checkoutUrl": "https://www.paypal.com/checkoutnow?token=X",
          "consent.status": "RECEIVED",
        },
      },
    );
    const props = await composePaymentRequestProps(
      await getOrderById(order.id, { actor }),
    );

    expect(props.gatewayLabel).toBe("PayPal");
    if (props.primaryCta) {
      expect(props.primaryCta.label).not.toContain("Stripe");
    }
  });

  it("says Stripe on a Stripe order", async () => {
    const order = await orderPaidVia(PaymentGatewayKey.STRIPE);
    const props = await composePaymentRequestProps(
      await getOrderById(order.id, { actor }),
    );
    expect(props.gatewayLabel).toBe("Stripe");
  });
});
