import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import {
  AuditAction,
  CaptureMode,
  EmailKind,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import {
  AuditLog,
  EmailTemplate,
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
  PendingEmail,
  PendingEmailStatus,
} from "@/server/db/models";
import { logger } from "@/lib/logger";
import { orgCookieName } from "@/server/auth/org-cookie";
import { createOrder, initiatePayment } from "@/server/services/order.service";
import { createProvider } from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  roundTripFlightInput,
  validCreateOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import type { OrderDTO } from "@/types";

/**
 * Payment webhook → confirmation email, in a deployment with several
 * organizations.
 *
 * The webhook settles the order and queues the confirmation in the outbox;
 * the outbox then delivers it on its own — right after the webhook
 * response, or on its timer — inside whatever request context happened to
 * start it. A webhook delivery carries no session and no organization
 * cookie, and an operator request carries THEIR selected brand. Neither
 * says which brand the email belongs to: the paid ORDER does. These tests
 * drain the outbox exactly as the background job does and check the email
 * goes out at once, as the order's own brand, with the order's own terms,
 * and is recorded against that brand — and that a failed send is never
 * reported as sent.
 */

const { sentMail, smtp } = vi.hoisted(() => ({
  sentMail: [] as Array<Record<string, unknown>>,
  smtp: { failNext: 0 },
}));

vi.mock("@/server/email/smtp", () => {
  const sender = (transport: string) => async (m: Record<string, unknown>) => {
    if (smtp.failNext > 0) {
      smtp.failNext -= 1;
      throw new Error("451 4.3.0 temporary SMTP failure");
    }
    sentMail.push({ ...m, __transport: transport });
    return { messageId: `<${transport}>`, response: "250 OK" };
  };
  return {
    getMailer: () => ({ sendMail: sender("deployment") }),
    getMailerFor: (cfg: { user: string }) => ({
      sendMail: sender(`org:${cfg.user}`),
    }),
    verifyMailer: async () => {},
    _resetOrgMailersForTests: () => {},
  };
});

const { processGatewayEvent } = await import("@/server/services/webhook.service");
const { drainOnePendingEmail } = await import(
  "@/server/services/email-outbox.service"
);

const actor = actorFor(UserRole.ADMIN);

interface Brand {
  slug: string;
  envPrefix: string;
  brandName: string;
  fromEmail: string;
  carTerms: string;
  flightTerms: string;
}

const ALPHA: Brand = {
  slug: "alphatrips",
  envPrefix: "ORG_ALPHATRIPS_",
  brandName: "Alpha Trips",
  fromEmail: "no-reply@alphatrips.test",
  carTerms: "ALPHA CAR TERMS: the main driver shows a full licence at the desk.",
  flightTerms: "ALPHA FLIGHT TERMS: each flight follows the airline conditions of carriage.",
};

const BRAVO: Brand = {
  slug: "bravojet",
  envPrefix: "ORG_BRAVOJET_",
  brandName: "Bravo Jet Travel",
  fromEmail: "no-reply@bravojet.test",
  carTerms: "BRAVO CAR TERMS: return the car with the fuel level it left with.",
  flightTerms: "BRAVO FLIGHT TERMS: names must match the passport exactly.",
};

const BRAND_ENV: Record<string, string> = {
  ORG_ALPHATRIPS_STRIPE_SECRET_KEY: "sk_test_alphatrips_only",
  ORG_ALPHATRIPS_STRIPE_WEBHOOK_SECRET: "whsec_alphatrips_only",
  ORG_BRAVOJET_STRIPE_SECRET_KEY: "sk_test_bravojet_only",
  ORG_BRAVOJET_STRIPE_WEBHOOK_SECRET: "whsec_bravojet_only",
};

const orgIds = new Map<string, Types.ObjectId>();
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let eventSeq = 0;

async function makeBrand(brand: Brand): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: brand.slug,
    name: brand.slug,
    brandName: brand.brandName,
    isDefault: false,
    payments: { provider: PaymentGatewayKey.STRIPE },
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    email: { fromName: brand.brandName, fromEmail: brand.fromEmail },
    support: { email: `support@${brand.slug}.test`, phone: "+442079460000" },
    legal: {
      termsAndConditions: brand.carTerms,
      termsVersion: "v1",
      cancellationPolicy: `${brand.brandName} car cancellation policy.`,
      cancellationPolicyVersion: "v1",
      services: {
        FLIGHT: {
          termsAndConditions: brand.flightTerms,
          termsVersion: "v1",
          cancellationPolicy: `${brand.brandName} flight cancellation policy.`,
          cancellationPolicyVersion: "v1",
        },
      },
    },
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

/** An operator signed in with `brand` selected. */
async function actingAs(brand: Brand) {
  sessionMock?.restore();
  sessionMock = await mockSession(actor);
  setNextHeaders({ cookies: { [orgCookieName()]: String(orgIds.get(brand.slug)) } });
}

/** A gateway webhook delivery: no session, no organization cookie. */
function asWebhookDelivery() {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
}

type Service = "car" | "flight";

async function linkedOrder(brand: Brand, service: Service): Promise<OrderDTO> {
  await actingAs(brand);
  const input =
    service === "flight"
      ? roundTripFlightInput({ provider: "AIRINDIA" })
      : validCreateOrderInput();
  const { order } = await createOrder(input, { actor });
  const { order: linked } = await initiatePayment(order.id, { actor });
  return linked;
}

/** What the brand's Stripe webhook endpoint does with a paid checkout. */
async function payViaWebhook(brand: Brand, order: OrderDTO) {
  asWebhookDelivery();
  eventSeq += 1;
  return processGatewayEvent(
    {
      eventId: `evt_outbox_${eventSeq}`,
      type: "checkout.completed",
      sessionId: order.payment.paymentSessionId,
      orderId: order.id,
      paymentIntentId: order.payment.paymentIntentId,
      amountTotalMinor: Math.round(order.pricing.amount * 100),
      occurredAtMs: Date.now(),
      raw: {},
    },
    String(orgIds.get(brand.slug)),
  );
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  Object.assign(process.env, BRAND_ENV);
  sentMail.length = 0;
  smtp.failNext = 0;
  orgIds.clear();
  orgIds.set(ALPHA.slug, await makeBrand(ALPHA));
  orgIds.set(BRAVO.slug, await makeBrand(BRAVO));
  await actingAs(ALPHA);
  await createProvider(
    {
      key: "AIRINDIA",
      name: "Air India",
      logo: "/providers/air-india.png",
      primaryColor: "#C8102E",
      onPrimaryColor: "#FFFFFF",
      tagline: "",
      sortOrder: 0,
      serviceTypes: [ServiceType.FLIGHT],
    } as Parameters<typeof createProvider>[0],
    { actor },
  );
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  for (const k of Object.keys(BRAND_ENV)) delete process.env[k];
  setNextHeaders({});
});

describe("webhook payment → confirmation email, per organization", () => {
  it.each([
    { brand: ALPHA, other: BRAVO, service: "car" as const },
    { brand: BRAVO, other: ALPHA, service: "car" as const },
    { brand: ALPHA, other: BRAVO, service: "flight" as const },
    { brand: BRAVO, other: ALPHA, service: "flight" as const },
  ])(
    "$brand.brandName $service: the webhook-queued confirmation goes out at once, as that brand",
    async ({ brand, other, service }) => {
      const order = await linkedOrder(brand, service);
      const settled = await payViaWebhook(brand, order);
      expect(settled).toMatchObject({ handled: true, duplicate: false });

      // Queued in the same transaction that paid the order, stamped with the
      // order's own organization — durable, not inferred from the request.
      const queued = await PendingEmail.findOne({ orderId: order.id }).lean();
      expect(queued?.kind).toBe(EmailKind.PAYMENT_CONFIRMATION);
      expect(queued?.status).toBe(PendingEmailStatus.PENDING);
      expect(String(queued?.organizationId)).toBe(
        String(orgIds.get(brand.slug)),
      );

      // The background drain, still inside the webhook delivery's context.
      const drained = await drainOnePendingEmail();
      expect(drained).toEqual({
        id: String(queued?._id),
        status: PendingEmailStatus.SENT,
      });

      expect(sentMail).toHaveLength(1);
      const mail = sentMail[0];
      expect(mail.to).toBe(order.customer.email);
      expect(String(mail.from)).toContain(brand.fromEmail);
      const html = String(mail.html);
      expect(html).toContain(brand.brandName);
      expect(html).toContain(
        service === "flight" ? brand.flightTerms : brand.carTerms,
      );
      expect(html).not.toContain(other.brandName);
      expect(html).not.toContain(other.carTerms);
      expect(html).not.toContain(other.flightTerms);

      const row = await PendingEmail.findById(queued?._id).lean();
      expect(row?.status).toBe(PendingEmailStatus.SENT);
      expect(row?.lastError ?? null).toBeNull();

      const paid = await Order.findById(order.id).lean();
      expect(paid?.status).toBe(OrderStatus.PAID);
      expect(paid?.payment.confirmationEmailSentAt).toBeInstanceOf(Date);

      // Recorded against the order's brand, not unattributed.
      const sentAudit = await AuditLog.findOne({
        action: AuditAction.EMAIL_SENT,
        entityId: order.id,
      }).lean();
      expect(String(sentAudit?.organizationId)).toBe(
        String(orgIds.get(brand.slug)),
      );
    },
  );

  it("delivers another brand's email correctly even when an operator request starts the drain", async () => {
    const order = await linkedOrder(BRAVO, "car");
    await payViaWebhook(BRAVO, order);

    // The drain is kicked from an operator request looking at ALPHA.
    await actingAs(ALPHA);
    const drained = await drainOnePendingEmail();
    expect(drained?.status).toBe(PendingEmailStatus.SENT);

    expect(sentMail).toHaveLength(1);
    expect(String(sentMail[0].from)).toContain(BRAVO.fromEmail);
    expect(String(sentMail[0].html)).toContain(BRAVO.brandName);
    expect(String(sentMail[0].html)).not.toContain(ALPHA.brandName);

    const sentAudit = await AuditLog.findOne({
      action: AuditAction.EMAIL_SENT,
      entityId: order.id,
    }).lean();
    expect(String(sentAudit?.organizationId)).toBe(
      String(orgIds.get(BRAVO.slug)),
    );
  });

  it("uses the order's organization's own email template, not another brand's", async () => {
    // Copy is per service: this is ALPHA's FLIGHT receipt copy, and the
    // orders below are flights.
    await EmailTemplate.create({
      organizationId: orgIds.get(ALPHA.slug),
      templateKey: "payment-confirmation",
      serviceType: ServiceType.FLIGHT,
      version: 1,
      active: true,
      subject: "ALPHA CUSTOM RECEIPT SUBJECT",
      createdBy: { userId: new Types.ObjectId(actor.id), name: actor.name },
    });
    const alphaOrder = await linkedOrder(ALPHA, "flight");
    const bravoOrder = await linkedOrder(BRAVO, "flight");
    await payViaWebhook(ALPHA, alphaOrder);
    await payViaWebhook(BRAVO, bravoOrder);

    asWebhookDelivery();
    expect((await drainOnePendingEmail())?.status).toBe(PendingEmailStatus.SENT);
    expect((await drainOnePendingEmail())?.status).toBe(PendingEmailStatus.SENT);

    const byRecipientBrand = (brand: Brand) =>
      sentMail.find((m) => String(m.from).includes(brand.fromEmail));
    expect(byRecipientBrand(ALPHA)?.subject).toBe("ALPHA CUSTOM RECEIPT SUBJECT");
    expect(byRecipientBrand(BRAVO)?.subject).not.toBe(
      "ALPHA CUSTOM RECEIPT SUBJECT",
    );
  });

  it("sends a manual-capture brand's authorized email straight after the authorization webhook", async () => {
    await Organization.updateOne(
      { _id: orgIds.get(ALPHA.slug) },
      { $set: { "payments.captureMode": CaptureMode.MANUAL } },
    );
    const order = await linkedOrder(ALPHA, "flight");
    const minor = Math.round(order.pricing.amount * 100);

    asWebhookDelivery();
    eventSeq += 1;
    const authorized = await processGatewayEvent(
      {
        eventId: `evt_outbox_${eventSeq}`,
        type: "payment.authorized",
        sessionId: order.payment.paymentSessionId,
        orderId: order.id,
        paymentIntentId: order.payment.paymentIntentId,
        amountTotalMinor: minor,
        occurredAtMs: Date.now(),
        authorization: {
          paymentIntentId: order.payment.paymentIntentId,
          captureMethod: "manual",
          paymentIntentStatus: "requires_capture",
          amountCapturableMinor: minor,
          amountReceivedMinor: 0,
          cancellationReason: null,
        },
        raw: {},
      },
      String(orgIds.get(ALPHA.slug)),
    );
    expect(authorized).toMatchObject({ handled: true, duplicate: false });

    const queued = await PendingEmail.findOne({ orderId: order.id }).lean();
    expect(queued?.kind).toBe(EmailKind.PAYMENT_AUTHORIZED);
    expect(String(queued?.organizationId)).toBe(String(orgIds.get(ALPHA.slug)));

    const drained = await drainOnePendingEmail();
    expect(drained?.status).toBe(PendingEmailStatus.SENT);
    expect(sentMail).toHaveLength(1);
    expect(String(sentMail[0].from)).toContain(ALPHA.fromEmail);
    expect(
      (sentMail[0].headers as Record<string, string>)["X-Entity-Kind"],
    ).toBe(EmailKind.PAYMENT_AUTHORIZED);
    expect(String(sentMail[0].html)).toContain(ALPHA.flightTerms);
    // An authorization is not a payment: no "confirmation sent" stamp.
    const held = await Order.findById(order.id).lean();
    expect(held?.payment.confirmationEmailSentAt ?? null).toBeNull();
  });

  it("still delivers a row queued before rows carried an organization", async () => {
    const order = await linkedOrder(ALPHA, "flight");
    await payViaWebhook(ALPHA, order);
    await PendingEmail.updateOne(
      { orderId: order.id },
      { $set: { organizationId: null } },
    );

    asWebhookDelivery();
    const drained = await drainOnePendingEmail();
    expect(drained?.status).toBe(PendingEmailStatus.SENT);
    expect(String(sentMail[0].from)).toContain(ALPHA.fromEmail);
    expect(String(sentMail[0].html)).toContain(ALPHA.flightTerms);
  });

  it("sends a row stamped with another organization as the ORDER's brand, never the stamp's", async () => {
    // How a pre-tenancy row looks after the organization back-fill stamped
    // it with the default organization: the stamp disagrees with the order.
    const order = await linkedOrder(BRAVO, "car");
    await payViaWebhook(BRAVO, order);
    await PendingEmail.updateOne(
      { orderId: order.id },
      { $set: { organizationId: orgIds.get(ALPHA.slug) } },
    );

    const warn = vi.spyOn(logger, "warn");
    asWebhookDelivery();
    const drained = await drainOnePendingEmail();
    expect(drained?.status).toBe(PendingEmailStatus.SENT);
    // The disagreement is reported, not silently absorbed.
    expect(warn).toHaveBeenCalledWith(
      "email_outbox.organization_mismatch",
      expect.objectContaining({
        orderId: order.id,
        queuedFor: String(orgIds.get(ALPHA.slug)),
        orderOrganizationId: String(orgIds.get(BRAVO.slug)),
      }),
    );
    expect(sentMail).toHaveLength(1);
    expect(String(sentMail[0].from)).toContain(BRAVO.fromEmail);
    const html = String(sentMail[0].html);
    expect(html).toContain(BRAVO.brandName);
    expect(html).toContain(BRAVO.carTerms);
    expect(html).not.toContain(ALPHA.brandName);
    expect(html).not.toContain(ALPHA.carTerms);
    const sentAudit = await AuditLog.findOne({
      action: AuditAction.EMAIL_SENT,
      entityId: order.id,
    }).lean();
    expect(String(sentAudit?.organizationId)).toBe(
      String(orgIds.get(BRAVO.slug)),
    );
  });
});

describe("the drain's audit trail belongs to the order's brand", () => {
  it("records an evidence write that fails during the drain against the order's brand, and still sends", async () => {
    const order = await linkedOrder(ALPHA, "car");
    await payViaWebhook(ALPHA, order);
    vi.spyOn(OrderEvidence, "create").mockRejectedValueOnce(
      new Error("evidence store unavailable"),
    );

    asWebhookDelivery();
    const drained = await drainOnePendingEmail();
    // Evidence is best-effort: the customer's email still goes out.
    expect(drained?.status).toBe(PendingEmailStatus.SENT);
    expect(sentMail).toHaveLength(1);

    const failed = await AuditLog.findOne({
      action: AuditAction.EVIDENCE_RECORD_FAILED,
      entityId: order.id,
    }).lean();
    expect(failed?.metadata).toMatchObject({
      error: "evidence store unavailable",
    });
    expect(String(failed?.organizationId)).toBe(
      String(orgIds.get(ALPHA.slug)),
    );
  });
});

describe("a failed send is never reported as sent", () => {
  it("records the error, keeps the row for retry, and sends on the retry", async () => {
    const order = await linkedOrder(BRAVO, "flight");
    await payViaWebhook(BRAVO, order);

    smtp.failNext = 1;
    asWebhookDelivery();
    const first = await drainOnePendingEmail();
    expect(first?.status).toBe(PendingEmailStatus.PENDING);
    expect(sentMail).toHaveLength(0);

    const retrying = await PendingEmail.findOne({ orderId: order.id }).lean();
    expect(retrying?.attempts).toBe(1);
    expect(retrying?.lastError).toContain("451 4.3.0 temporary SMTP failure");
    expect(retrying?.sentAt ?? null).toBeNull();
    expect(retrying?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    const unsent = await Order.findById(order.id).lean();
    expect(unsent?.payment.confirmationEmailSentAt ?? null).toBeNull();

    const failedAudit = await AuditLog.findOne({
      action: AuditAction.EMAIL_FAILED,
      entityId: order.id,
    }).lean();
    expect(String(failedAudit?.organizationId)).toBe(
      String(orgIds.get(BRAVO.slug)),
    );
    expect(String((failedAudit?.metadata as { error?: string })?.error)).toContain(
      "451 4.3.0",
    );

    // The backoff elapses; the next drain delivers it.
    await PendingEmail.updateOne(
      { orderId: order.id },
      { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
    );
    const second = await drainOnePendingEmail();
    expect(second?.status).toBe(PendingEmailStatus.SENT);
    expect(sentMail).toHaveLength(1);
    expect(String(sentMail[0].from)).toContain(BRAVO.fromEmail);
    const sent = await Order.findById(order.id).lean();
    expect(sent?.payment.confirmationEmailSentAt).toBeInstanceOf(Date);
  });

  it("gives up as FAILED after the last attempt, with the error kept", async () => {
    const order = await linkedOrder(ALPHA, "car");
    await payViaWebhook(ALPHA, order);
    await PendingEmail.updateOne({ orderId: order.id }, { $set: { attempts: 4 } });

    smtp.failNext = 1;
    asWebhookDelivery();
    const result = await drainOnePendingEmail();
    expect(result?.status).toBe(PendingEmailStatus.FAILED);
    const row = await PendingEmail.findOne({ orderId: order.id }).lean();
    expect(row?.attempts).toBe(5);
    expect(row?.lastError).toContain("451 4.3.0 temporary SMTP failure");
    expect(sentMail).toHaveLength(0);
    const unsent = await Order.findById(order.id).lean();
    expect(unsent?.payment.confirmationEmailSentAt ?? null).toBeNull();
  });
});
