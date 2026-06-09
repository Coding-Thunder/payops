import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Currency, UserRole } from "@/lib/constants/enums";
import {
  ItemAttributeType,
  ItemPricingModel,
} from "@/lib/constants/items";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { ItemType, Order, Setting } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

let headers: Awaited<ReturnType<typeof mockNextHeaders>>;
let session: Awaited<ReturnType<typeof mockSession>> | null = null;

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  headers = await mockNextHeaders();
});

afterEach(async () => {
  await headers.restore();
  if (session) {
    session.restore();
    session = null;
  }
});

async function seedSettingsForOrg(orgId: string): Promise<void> {
  await Setting.create({
    orgId: new Types.ObjectId(orgId),
    paymentExpiryHours: 24,
    orderPrefix: "UNI",
    defaultCurrency: "USD",
    successRedirectUrl: "http://localhost/pay/success",
    cancelRedirectUrl: "http://localhost/pay/cancelled",
    cancellationPolicy:
      "A sufficiently long cancellation policy for the universal-route API tests.",
    cancellationPolicyVersion: "v1",
    consentMode: "ADVISORY",
    consentMessage: "I agree to proceed with this order.",
  });
}

async function seedMilkType(orgId: string): Promise<void> {
  await ItemType.create({
    orgId: new Types.ObjectId(orgId),
    key: "milk_carton",
    name: "Milk carton",
    pricingModel: ItemPricingModel.QUANTITY,
    requiresScheduling: false,
    inventoryTracked: false,
    attributeSchema: [
      {
        key: "fat_percent",
        label: "Fat %",
        type: ItemAttributeType.NUMBER,
        required: true,
        displayOrder: 0,
      },
    ],
    confirmationEmailBlocks: [],
  });
}

describe("POST /api/orders, polymorphic body", () => {
  it("UNIVERSAL shape (lineItems[]) creates an order with no legacy fields", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    await seedSettingsForOrg(session.user.orgId!);
    await seedMilkType(session.user.orgId!);

    const res = await createOrderRoute(
      buildRequest("/api/orders", {
        method: "POST",
        body: {
          customer: {
            name: "Customer A",
            email: "a@example.com",
            phone: "+15555550100",
          },
          lineItems: [
            {
              itemTypeKey: "milk_carton",
              name: "1L whole milk",
              quantity: 2,
              unitPrice: 4,
              total: 8,
              attributes: { fat_percent: 3.5 },
            },
          ],
          pricing: { amount: 8, currency: Currency.USD },
          scheduling: null,
        },
      }),
    );
    const { status, body } = await jsonBody<{
      data: {
        order: {
          id: string;
          lineItems: { itemTypeKey: string }[];
        };
      };
    }>(res);
    expect(status).toBe(201);
    expect(body.data.order.lineItems).toHaveLength(1);
    expect(body.data.order.lineItems[0].itemTypeKey).toBe("milk_carton");

    const doc = await Order.findById(body.data.order.id).lean<{
      orgId: unknown;
    }>();
    expect(String(doc?.orgId)).toBe(session.user.orgId);
  });

  it("REFUSES universal body that references an unknown ItemType", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    await seedSettingsForOrg(session.user.orgId!);

    const res = await createOrderRoute(
      buildRequest("/api/orders", {
        method: "POST",
        body: {
          customer: {
            name: "Customer C",
            email: "c@example.com",
            phone: "+15555550100",
          },
          lineItems: [
            {
              itemTypeKey: "milk_carton", // not seeded
              name: "1L milk",
              quantity: 1,
              unitPrice: 4,
              total: 4,
              attributes: {},
            },
          ],
          pricing: { amount: 4, currency: Currency.USD },
          scheduling: null,
        },
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(422);
  });
});
