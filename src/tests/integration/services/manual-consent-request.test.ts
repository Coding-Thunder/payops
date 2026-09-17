import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * The manual collection send: a consent request with NO payment link.
 *
 * The customer's job is to review and confirm; the operator takes the card
 * on a terminal afterwards. So this email must never carry a checkout CTA —
 * including when a superseded link is still sitting on the order, which is
 * exactly the link that must not be paid.
 */

const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (m: Record<string, unknown>) => {
      sentMail.push(m);
      return { messageId: "<id>", response: "250 Accepted" };
    },
  }),
  verifyMailer: async () => {},
}));

const { createOrder, getOrderById } = await import(
  "@/server/services/order.service"
);
const { sendPaymentRequestEmail } = await import(
  "@/server/services/email.service"
);

const admin = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  sentMail.length = 0;
  sessionMock = await mockSession(admin);
  return () => {
    sessionMock?.restore();
    sessionMock = null;
    vi.useRealTimers();
  };
});

const ctx = () => ({ actor: admin, request: null });

async function makeOrder() {
  const { order } = await createOrder(
    validCreateOrderInput({
      charges: [{ name: "Rental cost", amount: 500, timing: "PREPAID" }],
    }),
    ctx(),
  );
  return order;
}

async function send(orderId: string, manualCollection: boolean) {
  sentMail.length = 0;
  const dto = await getOrderById(orderId, { actor: admin });
  await sendPaymentRequestEmail(dto, { manualCollection }, { actor: admin });
  expect(sentMail.length).toBeGreaterThan(0);
  return String(sentMail[0]!.html);
}

describe("manual collection — consent request without a payment link", () => {
  it("sends on an order that has never had a link", async () => {
    // The normal manual case: no gateway was ever contacted. The gateway
    // path refuses this state; the manual path is defined by it.
    const order = await makeOrder();
    const raw = await Order.findById(order.id).lean<{ status: string }>();
    expect(raw!.status).toBe(OrderStatus.NOT_INITIATED);

    const html = await send(order.id, true);
    expect(html).toContain("Review &amp; Confirm Booking");
  });

  it("carries no gateway checkout link", async () => {
    const order = await makeOrder();
    const html = await send(order.id, true);

    expect(html).not.toMatch(/checkout\.stripe\.com/i);
    expect(html).not.toMatch(/paypal\.com\/checkoutnow/i);
    expect(html).not.toMatch(/Pay .* securely with/i);
  });

  it("carries no checkout link even when a superseded one is on the order", async () => {
    // The dangerous case. A stale link exists from an earlier attempt; the
    // manual send must not surface it, because it collects the wrong amount.
    const order = await makeOrder();
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          status: OrderStatus.FAILED,
          "payment.status": OrderStatus.FAILED,
          "payment.gateway": PaymentGatewayKey.STRIPE,
          "payment.stripeSessionId": "cs_old",
          "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_old",
        },
      },
    );

    const html = await send(order.id, true);
    expect(html).not.toContain("checkout.stripe.com/c/pay/cs_old");
    expect(html).not.toMatch(/Pay .* securely with/i);
  });

  it("still sends the ordinary payment-link email on the gateway path", async () => {
    // The manual branch must not have broken the normal flow.
    const order = await makeOrder();
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          status: OrderStatus.LINK_GENERATED,
          "payment.status": OrderStatus.LINK_GENERATED,
          "payment.gateway": PaymentGatewayKey.STRIPE,
          "payment.stripeSessionId": "cs_live",
          "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_live",
        },
      },
    );

    const html = await send(order.id, false);
    // Consent first, then the customer is sent on to checkout. The checkout
    // URL is not in the email itself (nor in the reply-by-email draft).
    expect(html).toMatch(/Review &amp; Confirm Booking/);
    expect(html).toMatch(/\/consent\//);
    expect(html).toMatch(/via Stripe/);
    expect(html).not.toContain("checkout.stripe.com/c/pay/cs_live");
  });

  it("refuses a gateway send with no link, as before", async () => {
    const order = await makeOrder();
    const dto = await getOrderById(order.id, { actor: admin });
    await expect(
      sendPaymentRequestEmail(dto, { manualCollection: false }, { actor: admin }),
    ).rejects.toThrow(/no payment link/i);
  });
});

describe("manual collection — customer-facing wording", () => {
  it("explains that the team will arrange payment separately", async () => {
    const order = await makeOrder();
    const html = await send(order.id, true);

    expect(html).toMatch(/arrange payment with you separately/i);
    expect(html).toMatch(/review/i);
  });

  it("names no payment processor and asks for no card details", async () => {
    const order = await makeOrder();
    const html = await send(order.id, true);

    expect(html).not.toMatch(/stripe/i);
    expect(html).not.toMatch(/paypal/i);
    expect(html).not.toMatch(/card number|cvv|enter your card/i);
  });

  it("does not tell the customer to pay on the page", async () => {
    const order = await makeOrder();
    const html = await send(order.id, true);
    expect(html).toMatch(/nothing to pay on this page/i);
  });

  it("leaves the gateway email's wording alone", async () => {
    const order = await makeOrder();
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          status: OrderStatus.LINK_GENERATED,
          "payment.status": OrderStatus.LINK_GENERATED,
          "payment.gateway": PaymentGatewayKey.STRIPE,
          "payment.stripeSessionId": "cs_live",
          "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_live",
        },
      },
    );
    const html = await send(order.id, false);
    expect(html).not.toMatch(/arrange payment with you separately/i);
  });
});

describe("manual collection — nothing reads as an online payment", () => {
  it("labels the prepaid total without promising an online payment", async () => {
    const order = await makeOrder();
    const html = await send(order.id, true);
    expect(html).not.toMatch(/Amount paid online/i);
    expect(html).toMatch(/Amount to prepay/i);
  });

  it("uses a confirmation subject, not 'complete your payment'", async () => {
    const order = await makeOrder();
    await send(order.id, true);
    const subject = String(sentMail[0]!.subject);
    expect(subject).toMatch(/^Please confirm your .* booking/);
    expect(subject).not.toMatch(/payment/i);
  });

  it("keeps the gateway subject and label on the gateway path", async () => {
    const order = await makeOrder();
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          status: OrderStatus.LINK_GENERATED,
          "payment.status": OrderStatus.LINK_GENERATED,
          "payment.gateway": PaymentGatewayKey.STRIPE,
          "payment.stripeSessionId": "cs_live",
          "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_live",
        },
      },
    );
    const html = await send(order.id, false);
    expect(html).toMatch(/Amount to pay online/i);
    expect(html).not.toMatch(/Amount paid online/i);
    expect(String(sentMail[0]!.subject)).toMatch(/^Complete your .* payment/);
  });
});
