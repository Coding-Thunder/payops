import { Types } from "mongoose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Currency, OrderStatus, RecordState } from "@/lib/constants/enums";
import { ItemPricingModel } from "@/lib/constants/items";
import { ExternalServiceError } from "@/lib/errors";
import { Branding, ItemType } from "@/server/db/models";
import { sendPaymentRequestEmail } from "@/server/services/email.service";
import { getMailer } from "@/server/email/smtp";
import type { OrderDTO } from "@/types";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

vi.mock("@/server/email/smtp", async (importActual) => {
  // Keep the real classifyMailError (the send path calls it); stub only
  // the transport accessors so we can drive the failure.
  const actual = await importActual<typeof import("@/server/email/smtp")>();
  return { ...actual, getMailer: vi.fn(), verifyMailer: vi.fn() };
});

const mockGetMailer = vi.mocked(getMailer);

beforeAll(async () => {
  await ensureMongo();
});
beforeEach(async () => {
  await resetDatabase();
  mockGetMailer.mockReset();
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

  it("returns a null message id (no throw) when SMTP is unconfigured", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedOrgEmailDeps(orgId);
    mockGetMailer.mockReturnValue(null);

    const result = await sendPaymentRequestEmail(
      requestOrder(orgId),
      { subject: "Complete your payment", greeting: null, intro: null, note: null },
    );
    expect(result.id).toBeNull();
  });
});
