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

vi.mock("@/server/email/smtp", () => ({
  getMailer: vi.fn(),
  verifyMailer: vi.fn(),
}));

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
  it("wraps a transport failure as ExternalServiceError (502), not a raw 500", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedOrgEmailDeps(orgId);

    // Configured relay whose send rejects — the real-world crash trigger.
    mockGetMailer.mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error("EAUTH: invalid credentials")),
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
    // The raw SMTP reason must NOT leak into the client-facing message.
    await expect(promise).rejects.not.toThrow(/EAUTH/);
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
