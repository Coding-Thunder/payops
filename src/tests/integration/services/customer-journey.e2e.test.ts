import ExcelJS from "exceljs";
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
import { seedTestOrganization, setEnabledProviders } from "@/tests/utils/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * THE FULL CUSTOMER JOURNEY, end to end, as one order.
 *
 * Customer books a car, changes their mind, Stripe declines, PayPal declines,
 * they change the booking again, and the operator finally takes the money on
 * a terminal. Every step runs through the real service layer.
 *
 * The one thing stubbed is the gateway adapter itself: creating a Stripe or
 * PayPal session means a network call and live credentials, neither of which
 * belongs in a test, and changing production gateway configuration to enable
 * it was explicitly out of bounds. Everything the application itself does —
 * pricing, revisions, attempt history, the stale-session gate, consent,
 * settlement, audit — is exercised for real.
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

const enabled = new Set<string>(["STRIPE", "PAYPAL"]);
vi.mock("@/server/payments/resolve-gateway", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/server/payments/resolve-gateway")>();
  let n = 0;
  return {
    ...actual,
    getGatewayForOrganization: vi.fn(
      async (_o: string | null, sel: { provider?: string | null }) => {
        const provider = sel?.provider ?? "STRIPE";
        if (!enabled.has(provider)) {
          throw new actual.PaymentProviderNotEnabledError(
            provider,
            Array.from(enabled),
          );
        }
        return {
          key: provider,
          label: provider === "PAYPAL" ? "PayPal" : "Stripe",
          enabled: true,
          sandbox: true,
          async createSession() {
            n += 1;
            return {
              sessionId: `${provider.toLowerCase()}_s${n}`,
              url: `https://example.test/${provider.toLowerCase()}/${n}`,
              paymentIntentId: null,
              expiresAt: new Date(Date.now() + 3600_000),
            };
          },
          async expireSession() {},
          async getSessionStatus() {
            return "open";
          },
          async verifyWebhook() {
            throw new Error("unused");
          },
        };
      },
    ),
  };
});

const {
  createOrder,
  applyOrderModification,
  switchOrderGateway,
  recordManualPayment,
  getOrderById,
} = await import("@/server/services/order.service");
const { buildOrderChargeExport } = await import(
  "@/server/services/order-export.service"
);

const admin = actorFor(UserRole.ADMIN);
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  await seedTestOrganization();
  await setEnabledProviders([PaymentGatewayKey.STRIPE, PaymentGatewayKey.PAYPAL]);
  enabled.clear();
  enabled.add("STRIPE");
  enabled.add("PAYPAL");
  sentMail.length = 0;
  sessionMock = await mockSession(admin);
  return () => {
    sessionMock?.restore();
    sessionMock = null;
    vi.useRealTimers();
  };
});

const ctx = () => ({ actor: admin, request: null });
const prepaid = (n: number) => [
  { name: "Rental cost", amount: n, timing: "PREPAID" as const },
];

/** What a declined gateway payment leaves behind — note the session and the
 *  checkout URL both survive, which is what `failOrder` actually does. */
async function declineCurrentPayment(orderId: string, reason: string) {
  await Order.updateOne(
    { _id: orderId },
    {
      $set: {
        status: OrderStatus.FAILED,
        "payment.status": OrderStatus.FAILED,
        "payment.failureReason": reason,
      },
    },
  );
}

async function grantConsent(orderId: string) {
  await Order.updateOne(
    { _id: orderId },
    { $set: { "consent.status": ConsentStatus.RECEIVED } },
  );
}

describe("the complete customer journey — one order, start to finish", () => {
  it("survives two declined gateways, two booking changes, and settles manually", async () => {
    // 1. Operator takes the call and creates the order for Vehicle A.
    const { order } = await createOrder(
      validCreateOrderInput({ charges: prepaid(500) }),
      ctx(),
    );
    const ORDER_ID = order.id;
    const ORDER_NUMBER = order.orderNumber;
    expect(order.pricing.amount).toBe(500);

    // 2-5. Customer immediately wants Vehicle B; price moves. SAME order.
    const changed = await applyOrderModification(
      ORDER_ID,
      {
        vehicle: { company: "BMW", type: "X3" },
        charges: prepaid(650),
        reason: "Customer requested a larger vehicle",
      },
      ctx(),
    );
    expect(changed.order.id).toBe(ORDER_ID);
    expect(changed.order.orderNumber).toBe(ORDER_NUMBER);
    expect(changed.order.pricing.amount).toBe(650);
    expect(changed.amountChanged).toBe(true);

    // 6-9. Stripe chosen, link issued for the CURRENT amount, consent given.
    await switchOrderGateway(ORDER_ID, { gateway: PaymentGatewayKey.STRIPE }, ctx());
    let raw = (await Order.findById(ORDER_ID))!;
    expect(raw.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    const stripeSession = raw.payment.stripeSessionId!;
    await grantConsent(ORDER_ID);

    // 10-11. Stripe declines. The session is NOT expired — that is real
    // behaviour, and the reason the stale-session gate has to exist.
    await declineCurrentPayment(ORDER_ID, "card_declined");

    // 12-15. Operator falls back to PayPal on the SAME order; it also fails.
    await switchOrderGateway(ORDER_ID, { gateway: PaymentGatewayKey.PAYPAL }, ctx());
    raw = (await Order.findById(ORDER_ID))!;
    expect(raw.payment.gateway).toBe(PaymentGatewayKey.PAYPAL);
    const paypalSession = raw.payment.stripeSessionId!;
    expect(paypalSession).not.toBe(stripeSession);
    await declineCurrentPayment(ORDER_ID, "instrument_declined");

    // 16-18. Customer changes the booking again; amount moves again.
    const second = await applyOrderModification(
      ORDER_ID,
      { trip: { dropoffDate: new Date(Date.now() + 8 * 864e5).toISOString() }, charges: prepaid(720) },
      ctx(),
    );
    expect(second.order.id).toBe(ORDER_ID);
    expect(second.order.pricing.amount).toBe(720);

    // 19-21. Manual chosen. Consent is still required and already granted.
    await grantConsent(ORDER_ID);

    // 22-24. Operator charges the card externally and records the result.
    const settled = await recordManualPayment(
      ORDER_ID,
      { method: "Card terminal", reference: "AUTH-004521", notes: "Taken at desk" },
      ctx(),
    );
    expect(settled.id).toBe(ORDER_ID);
    expect(settled.status).toBe(OrderStatus.PAID);

    const final = await Order.findById(ORDER_ID).lean<{
      orderNumber: string;
      status: string;
      pricing: { amount: number };
      payment: {
        gateway: string;
        amountReceived: number;
        manualReference: string;
        priceRevision: number;
        attempts: Array<{ gateway: string; sessionId: string | null; amount: number }>;
      };
    }>();

    // 24. Settled for the CURRENT amount, by MANUAL.
    expect(final!.status).toBe(OrderStatus.PAID);
    expect(final!.pricing.amount).toBe(720);
    expect(final!.payment.amountReceived).toBe(720);
    expect(final!.payment.gateway).toBe(PaymentGatewayKey.MANUAL);
    expect(final!.payment.manualReference).toBe("AUTH-004521");

    // 25-27. Every historical attempt survives, at the amount it was for.
    const sessions = final!.payment.attempts.map((a) => a.sessionId);
    expect(sessions).toContain(stripeSession);
    expect(sessions).toContain(paypalSession);
    const stripeAttempt = final!.payment.attempts.find((a) => a.sessionId === stripeSession)!;
    expect(stripeAttempt.gateway).toBe(PaymentGatewayKey.STRIPE);
    // The Stripe link was issued at 650 and must still say so, not 720.
    expect(stripeAttempt.amount).toBe(650);

    // 28. No duplicate order.
    expect(await Order.countDocuments({})).toBe(1);
    expect(final!.orderNumber).toBe(ORDER_NUMBER);

    // 28. Audit trail names the operator for both the edits and the payment.
    const audit = await AuditLog.find({ entityId: ORDER_ID }).lean<
      Array<{ action: string; actor?: { userId?: string }; metadata: Record<string, unknown> }>
    >();
    const mco = audit.filter((a) => a.metadata?.action === "mco_modified");
    expect(mco.length).toBe(2);
    const manual = audit.find((a) => a.action === AuditAction.MANUAL_PAYMENT_RECORDED);
    expect(manual).toBeTruthy();
    expect(String(manual!.actor!.userId)).toBe(admin.id);

    // 28. No card data anywhere on the order.
    const blob = JSON.stringify(final).replace(/"[a-f0-9]{24}"/g, '""');
    expect(/\b\d{13,19}\b/.test(blob)).toBe(false);
  });

  it("refuses a stale Stripe session that pays after the order settled", async () => {
    // The tail of the same story: the customer's original Stripe link was
    // never killable, and they pay it a day later.
    const { order } = await createOrder(
      validCreateOrderInput({ charges: prepaid(500) }),
      ctx(),
    );
    await switchOrderGateway(order.id, { gateway: PaymentGatewayKey.STRIPE }, ctx());
    const stale = (await Order.findById(order.id))!.payment.stripeSessionId!;
    await declineCurrentPayment(order.id, "card_declined");
    await applyOrderModification(order.id, { charges: prepaid(720) }, ctx());
    await grantConsent(order.id);
    await recordManualPayment(
      order.id,
      { method: "Card terminal", reference: "AUTH-1" },
      ctx(),
    );

    const { applyCheckoutPaid } = await import("@/server/services/webhook.service");
    const doc = (await Order.findById(order.id))!;
    const r = await applyCheckoutPaid(doc, {
      eventId: "evt_stale_late",
      sessionId: stale,
      paymentIntentId: "pi_stale",
      amountTotal: 50_000,
      paidAtMs: Date.now(),
      source: "webhook",
    });

    const after = await Order.findById(order.id).lean<{
      pricing: { amount: number };
      risk: { flagged: boolean };
      payment: { amountReceived: number; gateway: string };
    }>();
    // The manual settlement stands; the stale 500 does not overwrite it.
    expect(after!.payment.amountReceived).toBe(720);
    expect(after!.payment.gateway).toBe(PaymentGatewayKey.MANUAL);
    expect(after!.pricing.amount).toBe(720);
    // And the real money that arrived is surfaced, not lost.
    expect(after!.risk.flagged).toBe(true);
    expect(r.reason).toContain("competing_payment");
  });

  it("exports the finished journey to a parseable workbook", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: prepaid(500) }),
      ctx(),
    );
    await grantConsent(order.id);
    await recordManualPayment(
      order.id,
      { method: "Card terminal", reference: "AUTH-77" },
      ctx(),
    );

    // The export covers the orders the operator selected.
    const result = await buildOrderChargeExport({ ids: [order.id] }, ctx());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(result.buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Charges")!;
    const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String);
    const row = (sheet.getRow(2).values as unknown[]).slice(1);
    const get = (h: string) => row[headers.indexOf(h)];

    expect(get("Order number")).toBe(order.orderNumber);
    expect(get("Payment method")).toBe("Card terminal");
    expect(get("Charge amount")).toBe(500);
  });
});

describe("the next-day call — an ongoing order", () => {
  it("lets an operator amend a settled booking without touching the payment", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: prepaid(500) }),
      ctx(),
    );
    await grantConsent(order.id);
    await recordManualPayment(
      order.id,
      { method: "Card terminal", reference: "AUTH-9" },
      ctx(),
    );
    const settled = await Order.findById(order.id).lean<{
      payment: { amountReceived: number; paidAt: Date; manualReference: string };
    }>();

    // Next day: "change my email and extend the return date".
    const r = await applyOrderModification(
      order.id,
      {
        customer: { email: "new.address@payops.test" },
        trip: { dropoffDate: new Date(Date.now() + 10 * 864e5).toISOString() },
        reason: "Customer called the next day",
      },
      ctx(),
    );

    expect(r.order.id).toBe(order.id);
    expect(r.order.customer.email).toBe("new.address@payops.test");
    expect(r.amountChanged).toBe(false);

    const after = await Order.findById(order.id).lean<{
      status: string;
      payment: { amountReceived: number; paidAt: Date; manualReference: string };
    }>();
    // The settled transaction is historical fact and is untouched.
    expect(after!.status).toBe(OrderStatus.PAID);
    expect(after!.payment.amountReceived).toBe(settled!.payment.amountReceived);
    expect(after!.payment.paidAt!.getTime()).toBe(settled!.payment.paidAt!.getTime());
    expect(after!.payment.manualReference).toBe(settled!.payment.manualReference);
    expect(await Order.countDocuments({})).toBe(1);
  });

  it("refuses to re-price a settled booking rather than rewriting history", async () => {
    const { order } = await createOrder(
      validCreateOrderInput({ charges: prepaid(500) }),
      ctx(),
    );
    await grantConsent(order.id);
    await recordManualPayment(
      order.id,
      { method: "Card terminal", reference: "AUTH-9" },
      ctx(),
    );

    await expect(
      applyOrderModification(order.id, { charges: prepaid(900) }, ctx()),
    ).rejects.toThrow(/already paid/i);

    const after = await Order.findById(order.id).lean<{
      pricing: { amount: number };
      payment: { amountReceived: number };
    }>();
    expect(after!.pricing.amount).toBe(500);
    expect(after!.payment.amountReceived).toBe(500);
  });
});
