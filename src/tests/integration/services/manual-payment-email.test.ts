import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConsentStatus, OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * The confirmation email for a payment PayOps did not process.
 *
 * Two independent requirements meet here. The customer must not be told a
 * gateway handled the money when none did — and they must not be told their
 * card details are encrypted by us when we never received any. The second
 * was a pre-existing defect: the card sentence rendered unconditionally,
 * making it a false assurance on every non-gateway payment.
 */

// Hoisted so the recorder exists when the (hoisted) mock factory runs.
const { sentMail } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/email/smtp", () => ({
  getMailer: () => ({
    sendMail: async (message: Record<string, unknown>) => {
      sentMail.push(message);
      return { messageId: "<test-message-id>", response: "250 Accepted" };
    },
  }),
  verifyMailer: async () => {},
}));

const { createOrder, recordManualPayment, getOrderById } = await import(
  "@/server/services/order.service"
);
const { sendPaymentConfirmationEmail } = await import(
  "@/server/services/email.service"
);

async function confirmationHtmlFor(orderId: string): Promise<string> {
  sentMail.length = 0;
  // The sender takes the DTO, which is also what production passes it.
  const dto = await getOrderById(orderId, { actor: admin });
  await sendPaymentConfirmationEmail(dto);
  expect(sentMail.length).toBeGreaterThan(0);
  return String(sentMail[0]!.html);
}

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

async function manuallyPaidOrder() {
  const { order } = await createOrder(
    validCreateOrderInput({
      charges: [{ name: "Rental cost", amount: 500, timing: "PREPAID" }],
    }),
    ctx(),
  );
  await Order.updateOne(
    { _id: order.id },
    {
      $set: {
        status: OrderStatus.FAILED,
        "payment.status": OrderStatus.FAILED,
        "payment.gateway": PaymentGatewayKey.STRIPE,
        "consent.status": ConsentStatus.RECEIVED,
      },
    },
  );
  await recordManualPayment(
    order.id,
    { method: "Card terminal", reference: "AUTH-004521" },
    ctx(),
  );
  return order.id;
}

describe("manual-payment confirmation email", () => {
  it("names no payment gateway", async () => {
    const id = await manuallyPaidOrder();
    const html = await confirmationHtmlFor(id);

    expect(html).not.toMatch(/stripe/i);
    expect(html).not.toMatch(/paypal/i);
  });

  it("does not claim we encrypt card details we never received", async () => {
    const id = await manuallyPaidOrder();
    const html = await confirmationHtmlFor(id);

    expect(html).not.toMatch(/card details are encrypted/i);
    expect(html).not.toMatch(/PCI-DSS/i);
    expect(html).toMatch(/no card details are held/i);
  });

  it("carries no payment call-to-action", async () => {
    const id = await manuallyPaidOrder();
    const html = await confirmationHtmlFor(id);

    // The confirmation says the booking is settled; it must never invite a
    // second payment.
    expect(html).not.toMatch(/pay .* securely with/i);
    expect(html).not.toMatch(/checkout\.stripe\.com/i);
    expect(html).not.toMatch(/paypal\.com\/checkoutnow/i);
  });

  it("still names the gateway on an ordinary gateway payment", async () => {
    // The fix must not strip accurate copy from the normal path.
    const { order } = await createOrder(
      validCreateOrderInput({
        charges: [{ name: "Rental cost", amount: 500, timing: "PREPAID" }],
      }),
      ctx(),
    );
    await Order.updateOne(
      { _id: order.id },
      {
        $set: {
          status: OrderStatus.PAID,
          "payment.status": OrderStatus.PAID,
          "payment.gateway": PaymentGatewayKey.STRIPE,
          "payment.amountReceived": 500,
          "payment.paidAt": new Date(),
        },
      },
    );
    const html = await confirmationHtmlFor(order.id);

    expect(html).toMatch(/stripe/i);
    expect(html).toMatch(/PCI-DSS/i);
  });
});
