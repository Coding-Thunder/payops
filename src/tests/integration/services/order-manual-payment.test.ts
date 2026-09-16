import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuditAction,
  ConsentStatus,
  OrderStatus,
  PaymentGatewayKey,
  UserRole,
} from "@/lib/constants/enums";
import { AuditLog, Order } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { seedTestOrganization } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * REQ-3 — money collected outside PayOps, recorded inside it.
 *
 * The operator charges a physical terminal; PayOps records the confirmation.
 * No gateway is called and no transaction is fabricated.
 *
 * The safety rule that shapes this: a FAILED order routinely still holds a
 * payable link, because `failOrder` never expires the session and a Stripe
 * decline happens inside a session that stays open. So "it failed" is not
 * evidence that no money can still arrive, and the live session is stood
 * down server-side before settling — not merely warned about in the UI.
 */

const { createOrder, recordManualPayment } = await import(
  "@/server/services/order.service"
);

const admin = actorFor(UserRole.ADMIN);
const staff = actorFor(UserRole.STAFF);
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

const ctx = (actor = admin) => ({ actor, request: null });
const lines = (n: number) => [
  { name: "Rental cost", amount: n, timing: "PREPAID" as const },
];
const good = { method: "Card terminal", reference: "AUTH-004521" };

/** An order that has failed at the gateway and HAS consent — the state the
 *  manual fallback actually starts from. */
async function failedOrderWithConsent(amount = 500) {
  const { order } = await createOrder(
    validCreateOrderInput({ charges: lines(amount) }),
    ctx(),
  );
  await Order.updateOne(
    { _id: order.id },
    {
      $set: {
        status: OrderStatus.FAILED,
        "payment.status": OrderStatus.FAILED,
        "payment.gateway": PaymentGatewayKey.STRIPE,
        "payment.stripeSessionId": "cs_failed",
        "payment.checkoutUrl": "https://checkout.stripe.com/c/pay/cs_failed",
        "payment.failureReason": "card_declined",
        "consent.status": ConsentStatus.RECEIVED,
      },
    },
  );
  return order;
}

describe("recordManualPayment — the happy path", () => {
  it("settles the order for the full prepaid amount", async () => {
    const order = await failedOrderWithConsent(500);
    const r = await recordManualPayment(order.id, good, ctx());

    expect(r.id).toBe(order.id);
    expect(r.status).toBe(OrderStatus.PAID);

    const raw = await Order.findById(order.id).lean<{
      status: string;
      payment: {
        gateway: string;
        amountReceived: number;
        manualMethod: string;
        manualReference: string;
        paidAt: Date;
      };
    }>();
    expect(raw!.status).toBe(OrderStatus.PAID);
    expect(raw!.payment.gateway).toBe(PaymentGatewayKey.MANUAL);
    expect(raw!.payment.amountReceived).toBe(500);
    expect(raw!.payment.manualMethod).toBe("Card terminal");
    expect(raw!.payment.manualReference).toBe("AUTH-004521");
    expect(raw!.payment.paidAt).toBeTruthy();
  });

  it("keeps the same order and creates no duplicate", async () => {
    const order = await failedOrderWithConsent();
    const before = await Order.countDocuments({});
    const r = await recordManualPayment(order.id, good, ctx());
    expect(r.orderNumber).toBe(order.orderNumber);
    expect(await Order.countDocuments({})).toBe(before);
  });

  it("preserves the failed gateway attempt as history", async () => {
    const order = await failedOrderWithConsent(500);
    await recordManualPayment(order.id, good, ctx());

    const raw = await Order.findById(order.id).lean<{
      payment: { attempts: Array<{ gateway: string; sessionId: string | null }> };
    }>();
    const stripe = raw!.payment.attempts.find((a) => a.sessionId === "cs_failed");
    expect(stripe).toBeTruthy();
    expect(stripe!.gateway).toBe(PaymentGatewayKey.STRIPE);
  });

  it("stands down a still-payable link before settling", async () => {
    // The double-payment guard, enforced in the backend rather than the UI.
    const order = await failedOrderWithConsent();
    await recordManualPayment(order.id, good, ctx());

    const raw = await Order.findById(order.id).lean<{
      payment: { checkoutUrl: string | null; attempts: Array<{ supersededAt: Date | null }> };
    }>();
    expect(raw!.payment.checkoutUrl).toBeNull();
    expect(raw!.payment.attempts.some((a) => a.supersededAt)).toBe(true);
  });

  it("names the real operator in the audit trail", async () => {
    const order = await failedOrderWithConsent();
    await recordManualPayment(order.id, good, ctx());

    const rows = await AuditLog.find({
      entityId: String(order.id),
      action: AuditAction.MANUAL_PAYMENT_RECORDED,
    }).lean<Array<{ actor: { userId: string }; metadata: Record<string, unknown> }>>();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(String(rows[0].actor.userId)).toBe(admin.id);
    expect(rows[0].metadata.reference).toBe("AUTH-004521");
  });

  it("stores no card data anywhere on the order", async () => {
    const order = await failedOrderWithConsent();
    await recordManualPayment(order.id, good, ctx());
    const raw = await Order.findById(order.id).lean();
    const blob = JSON.stringify(raw);
    // Nothing resembling a PAN can have reached the document.
    expect(/\b\d{13,19}\b/.test(blob.replace(/"_id":"[a-f0-9]+"/g, ""))).toBe(false);
  });
});

describe("recordManualPayment — refusals", () => {
  it("refuses when consent has not been received", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(500) }),
      ctx(),
    );
    await expect(recordManualPayment(order.id, good, ctx())).rejects.toThrow(
      /consent/i,
    );
  });

  it("refuses an order that is already paid", async () => {
    const order = await failedOrderWithConsent();
    await recordManualPayment(order.id, good, ctx());
    await expect(recordManualPayment(order.id, good, ctx())).rejects.toThrow(
      /already paid/i,
    );
  });

  it("does not double-settle on a repeated recording", async () => {
    const order = await failedOrderWithConsent(500);
    await recordManualPayment(order.id, good, ctx());
    await recordManualPayment(order.id, good, ctx()).catch(() => undefined);

    const raw = await Order.findById(order.id).lean<{
      payment: { amountReceived: number };
    }>();
    expect(raw!.payment.amountReceived).toBe(500);
  });

  it("refuses an unauthorized operator", async () => {
    const order = await failedOrderWithConsent();
    await expect(
      recordManualPayment(order.id, good, ctx(staff)),
    ).rejects.toThrow();
  });
});

/**
 * Consent the way a customer actually gives it: through the hosted page.
 *
 * The tests above set `consent.status` directly, which hid a defect: the
 * hosted page moves the order straight to VERIFIED, and the manual-payment
 * gate accepted only RECEIVED — so every manual booking whose customer had
 * confirmed was refused at the final step.
 */
describe("recordManualPayment — after real hosted-page consent", () => {
  async function orderWithHostedConsent(amount = 500) {
    const { requestConsent, recordConsentFromToken } = await import(
      "@/server/services/consent.service"
    );
    const { order } = await createOrder(
      validCreateOrderInput({ charges: lines(amount) }),
      ctx(),
    );
    const requested = await requestConsent(
      {
        orderId: order.id,
        customerEmail: order.customer.email,
        customerName: order.customer.name,
        consentMessage:
          "I confirm that I understand and agree to proceed with this booking.",
        consentEmailSubject: "Please confirm your booking",
        snapshot: {
          bookingType: order.bookingType,
          provider: order.provider.name,
          vehicle: `${order.vehicle.company} • ${order.vehicle.type}`,
          pickupDate: order.trip.pickupDate,
          dropoffDate: order.trip.dropoffDate,
          amount: order.pricing.amount,
          currency: order.pricing.currency,
          paymentLinkRef: null,
        },
      },
      { actor: admin, appUrl: "http://127.0.0.1:3100" },
    );
    return { order, requested, recordConsentFromToken };
  }

  it("records the payment once the customer has confirmed", async () => {
    const { order, requested, recordConsentFromToken } =
      await orderWithHostedConsent(500);
    const view = await recordConsentFromToken(
      {
        token: requested.token,
        acknowledgement: requested.consent.consentMessage,
        signedName: "Ada Lovelace",
      },
      { branding: { brandName: "Test Brand" }, request: null },
    );
    // The hosted page verifies on submission — this is the state the
    // manual-payment gate has to accept.
    expect(view.status).toBe(ConsentStatus.VERIFIED);

    await recordManualPayment(order.id, good, ctx());

    const raw = await Order.findById(order.id).lean<{
      status: string;
      payment: { amountReceived: number };
    }>();
    expect(raw!.status).toBe(OrderStatus.PAID);
    expect(raw!.payment.amountReceived).toBe(500);
  });

  it("still refuses while the consent request is only pending", async () => {
    const { order } = await orderWithHostedConsent(500);
    const raw = await Order.findById(order.id).lean<{
      consent: { status: string };
    }>();
    expect(raw!.consent.status).toBe(ConsentStatus.REQUESTED);

    await expect(recordManualPayment(order.id, good, ctx())).rejects.toThrow(
      /consent/i,
    );
  });
});
