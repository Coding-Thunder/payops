import { Types } from "mongoose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Currency, OrderStatus, RecordState } from "@/lib/constants/enums";
import { ItemPricingModel } from "@/lib/constants/items";
import { ExternalServiceError } from "@/lib/errors";
import { Branding, ItemType } from "@/server/db/models";
import { sendPaymentRequestEmail } from "@/server/services/email.service";
import { getMailer } from "@/server/email/smtp";
import { deliverViaResend, resendApiKey } from "@/server/email/resend";
import type { OrderDTO } from "@/types";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

vi.mock("@/server/email/smtp", async (importActual) => {
  // Keep the real classifyMailError (the send path calls it); stub only
  // the transport accessors so we can drive the failure.
  const actual = await importActual<typeof import("@/server/email/smtp")>();
  return { ...actual, getMailer: vi.fn(), verifyMailer: vi.fn() };
});

const mockGetMailer = vi.mocked(getMailer);

vi.mock("@/server/email/resend", async (importActual) => {
  // Keep real key-detection/delivery; the tests drive the transport branch.
  const actual = await importActual<typeof import("@/server/email/resend")>();
  return { ...actual, resendApiKey: vi.fn(() => null), deliverViaResend: vi.fn() };
});
const mockResendApiKey = vi.mocked(resendApiKey);
const mockDeliverViaResend = vi.mocked(deliverViaResend);

beforeAll(async () => {
  await ensureMongo();
});
beforeEach(async () => {
  await resetDatabase();
  mockGetMailer.mockReset();
  // Default: no Resend key → send path takes the SMTP branch (the SMTP suite
  // relies on this). The Resend suite overrides it per-test.
  mockResendApiKey.mockReturnValue(null);
  mockDeliverViaResend.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function requestOrder(orgId: string): OrderDTO {
  return {
    id: new Types.ObjectId().toString(),
    orgId,
    orderNumber: "ORD-260704-J229YANS33",
    status: OrderStatus.LINK_GENERATED,
    state: RecordState.ACTIVE,
    customerId: null,
    customer: { name: "Jane", email: "jane@example.com", phone: "+15555550100" },
    pricing: { amount: 199.5, currency: Currency.USD },
    payment: {
      gateway: "STRIPE" as OrderDTO["payment"]["gateway"],
      paymentSessionId: "cs_test_x",
      paymentUrl: "https://checkout.stripe.com/pay/cs_test_x",
      paymentIntentId: null,
      status: OrderStatus.LINK_GENERATED,
      paidAt: null,
      expiresAt: null,
      amountReceived: null,
      receiptUrl: null,
      failureReason: null,
      confirmationEmailSentAt: null,
      initiatedAt: null,
    },
    createdBy: { userId: new Types.ObjectId().toString(), name: "Op", email: "op@x.io" },
    policy: { acceptedAt: new Date().toISOString(), version: "v1", text: "Policy." },
    risk: { flagged: false },
    consent: { status: "NOT_REQUESTED" } as OrderDTO["consent"],
    dispute: null,
    refundedAmount: 0,
    notes: null,
    lineItems: [
      {
        itemId: null,
        itemTypeKey: "service_visit",
        name: "Test service visit",
        description: null,
        quantity: 1,
        unitPrice: 199.5,
        total: 199.5,
        attributes: {},
        scheduling: null,
      },
    ],
    scheduling: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as OrderDTO;
}

async function seedOrgEmailDeps(orgId: string) {
  await Branding.create({
    orgId: new Types.ObjectId(orgId),
    brandName: "Acme Rentals",
    supportEmail: "support@acme.test",
    senderEmail: "",
    primaryColor: "#0B1220",
  });
  await ItemType.create({
    orgId: new Types.ObjectId(orgId),
    key: "service_visit",
    name: "Service visit",
    pricingModel: ItemPricingModel.FIXED,
    requiresScheduling: false,
    inventoryTracked: false,
    attributeSchema: [],
    confirmationEmailBlocks: [],
  });
}

describe("sendPaymentRequestEmail — SMTP failure error contract", () => {
  it("wraps a transport failure as an actionable ExternalServiceError (502), not a raw 500", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedOrgEmailDeps(orgId);

    // Realistic Nodemailer auth rejection — the real-world crash trigger.
    const smtpErr = Object.assign(new Error("Invalid login"), {
      code: "EAUTH",
      responseCode: 535,
      response: "535-5.7.8 Username and Password not accepted",
      command: "AUTH PLAIN",
    });
    mockGetMailer.mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(smtpErr),
    } as unknown as ReturnType<typeof getMailer>);

    const promise = sendPaymentRequestEmail(
      requestOrder(orgId),
      { subject: "Complete your payment", greeting: null, intro: null, note: null },
    );

    await expect(promise).rejects.toBeInstanceOf(ExternalServiceError);
    await expect(promise).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_ERROR",
      statusCode: 502,
    });
    // Auth failures get a credentials-specific, actionable message...
    await expect(promise).rejects.toThrow(/app password/i);
    // ...and the raw SMTP response never leaks to the client.
    await expect(promise).rejects.not.toThrow(/5\.7\.8/);
  });

  it("THROWS when SMTP is unconfigured — a payment request must never be marked sent without delivery (#11)", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedOrgEmailDeps(orgId);
    mockGetMailer.mockReturnValue(null);

    // The payment-request send is `required`, so a non-delivery is a hard
    // failure the caller must see — not a silent skip that would let the
    // order flip to PAYMENT_PENDING + record a "sent" timeline event.
    await expect(
      sendPaymentRequestEmail(requestOrder(orgId), {
        subject: "Complete your payment",
        greeting: null,
        intro: null,
        note: null,
      }),
    ).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("sendPaymentRequestEmail — Resend HTTP failure contract", () => {
  it("wraps a Resend 401 (invalid API key) as an actionable 502 — the exact prod outage path", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedOrgEmailDeps(orgId);

    // Prod sets a Resend key, so the send takes the deliverViaResend branch —
    // NOT the SMTP branch the tests above cover. This is the path that actually
    // broke in production (the deployed key rejected with 401).
    mockResendApiKey.mockReturnValue("re_live_testkey");
    const resendErr = Object.assign(new Error("Resend API 401"), {
      responseCode: 401,
      response: JSON.stringify({
        statusCode: 401,
        name: "validation_error",
        message: "API key is invalid",
      }),
    });
    mockDeliverViaResend.mockRejectedValue(resendErr);

    const promise = sendPaymentRequestEmail(requestOrder(orgId), {
      subject: "Complete your payment",
      greeting: null,
      intro: null,
      note: null,
    });

    await expect(promise).rejects.toBeInstanceOf(ExternalServiceError);
    await expect(promise).rejects.toMatchObject({
      code: "EXTERNAL_SERVICE_ERROR",
      statusCode: 502,
    });
    // 401 → a config-error message telling the operator to fix credentials,
    // never a transient "try again"...
    await expect(promise).rejects.toThrow(/credential|api key|configuration/i);
    await expect(promise).rejects.not.toThrow(/try again/i);
    // ...and the raw Resend body never leaks to the client.
    await expect(promise).rejects.not.toThrow(/validation_error/);
  });
});
