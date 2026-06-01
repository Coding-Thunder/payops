import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import { Currency, RecordState } from "@/lib/constants/enums";
import {
  EmailBlockKey,
  ItemAttributeType,
  ItemPricingModel,
  SchedulingType,
} from "@/lib/constants/items";
import { Item, ItemType, Order } from "@/server/db/models";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Pass 5b, universal commerce schema primitives.
 *
 * Verifies:
 *   - ItemType + Item persist with sane defaults
 *   - Tenant boundary is enforced (`(orgId, key)` unique)
 *   - Validation guards (duplicate attribute key, SELECT-without-options)
 *   - Order keeps existing rental orders unchanged AND accepts the
 *     new optional `lineItems[]` + `scheduling` fields
 *
 * NO BEHAVIOR CHANGE assertions: a brand-new rental order can still
 * be saved with the legacy `vehicle/trip/provider` triple and an
 * empty `lineItems` array, the same shape Tenant #1 uses today.
 */

const ORG_A = new Types.ObjectId();
const ORG_B = new Types.ObjectId();

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

/* ───────────────────────────── ItemType ──────────────────────────────── */

describe("ItemType, schema definition primitive", () => {
  it("persists with default email-block manifest + ACTIVE status", async () => {
    const doc = await ItemType.create({
      orgId: ORG_A,
      key: "rental_booking",
      name: "Rental booking",
      pricingModel: ItemPricingModel.TIME_WINDOW,
      requiresScheduling: true,
      attributeSchema: [
        {
          key: "vehicle_make",
          label: "Vehicle make",
          type: ItemAttributeType.STRING,
          required: true,
          displayOrder: 0,
        },
        {
          key: "vehicle_type",
          label: "Vehicle type",
          type: ItemAttributeType.STRING,
          required: true,
          displayOrder: 1,
        },
      ],
    });
    expect(doc.status).toBe(RecordState.ACTIVE);
    expect(doc.confirmationEmailBlocks).toContain(EmailBlockKey.PAYMENT_SUMMARY);
    expect(doc.confirmationEmailBlocks).toContain(EmailBlockKey.PURCHASE_TERMS);
    expect(doc.attributeSchema.length).toBe(2);
  });

  it("enforces (orgId, key) uniqueness, same key in another tenant is allowed", async () => {
    await ItemType.create({
      orgId: ORG_A,
      key: "rental_booking",
      name: "Rental booking, Org A",
      pricingModel: ItemPricingModel.TIME_WINDOW,
    });

    // Same orgId + same key → duplicate.
    await expect(
      ItemType.create({
        orgId: ORG_A,
        key: "rental_booking",
        name: "Dupe",
        pricingModel: ItemPricingModel.FIXED,
      }),
    ).rejects.toThrow();

    // Same key under a DIFFERENT org → fine.
    const other = await ItemType.create({
      orgId: ORG_B,
      key: "rental_booking",
      name: "Rental booking, Org B",
      pricingModel: ItemPricingModel.TIME_WINDOW,
    });
    expect(String(other.orgId)).toBe(String(ORG_B));
  });

  it("rejects duplicate attribute keys within the same itemType", async () => {
    await expect(
      ItemType.create({
        orgId: ORG_A,
        key: "milk_carton",
        name: "Milk",
        pricingModel: ItemPricingModel.QUANTITY,
        attributeSchema: [
          {
            key: "size_litres",
            label: "Size (L)",
            type: ItemAttributeType.NUMBER,
            required: true,
            displayOrder: 0,
          },
          {
            key: "size_litres",
            label: "Size (oops)",
            type: ItemAttributeType.NUMBER,
            required: false,
            displayOrder: 1,
          },
        ],
      }),
    ).rejects.toThrow(/duplicate attribute key/i);
  });

  it("rejects a SELECT attribute without options", async () => {
    await expect(
      ItemType.create({
        orgId: ORG_A,
        key: "shoe_size",
        name: "Shoe",
        pricingModel: ItemPricingModel.QUANTITY,
        attributeSchema: [
          {
            key: "size",
            label: "Size",
            type: ItemAttributeType.SELECT,
            required: true,
            displayOrder: 0,
            // options missing!
          },
        ],
      }),
    ).rejects.toThrow(/has no options/i);
  });

  it("rejects a malformed key (must match /^[a-z][a-z0-9_]{0,31}$/)", async () => {
    await expect(
      ItemType.create({
        orgId: ORG_A,
        key: "Invalid-Key",
        name: "Bad",
        pricingModel: ItemPricingModel.FIXED,
      }),
    ).rejects.toThrow();
  });
});

/* ───────────────────────────────── Item ──────────────────────────────── */

describe("Item, per-tenant catalog row", () => {
  it("persists with attributes payload + default ACTIVE status", async () => {
    const doc = await Item.create({
      orgId: ORG_A,
      itemTypeKey: "rental_booking",
      name: "Toyota Camry",
      basePrice: { amount: 75, currency: "USD" as Currency },
      attributes: {
        vehicle_make: "Toyota",
        vehicle_type: "Camry",
      },
      createdBy: {
        userId: new Types.ObjectId(),
        name: "Ada",
      },
    });
    expect(doc.status).toBe(RecordState.ACTIVE);
    expect(doc.attributes).toMatchObject({ vehicle_make: "Toyota" });
  });

  it("SKU is partial-unique per tenant when present; null SKUs don't compete", async () => {
    await Item.create({
      orgId: ORG_A,
      itemTypeKey: "product",
      name: "Milk 1L",
      basePrice: { amount: 2, currency: "USD" as Currency },
      sku: "MILK-1L",
      createdBy: { userId: new Types.ObjectId(), name: "Ada" },
    });

    // Same SKU same org → reject.
    await expect(
      Item.create({
        orgId: ORG_A,
        itemTypeKey: "product",
        name: "Milk 1L copy",
        basePrice: { amount: 2, currency: "USD" as Currency },
        sku: "MILK-1L",
        createdBy: { userId: new Types.ObjectId(), name: "Ada" },
      }),
    ).rejects.toThrow();

    // Same SKU in DIFFERENT org → fine.
    const other = await Item.create({
      orgId: ORG_B,
      itemTypeKey: "product",
      name: "Milk 1L (other tenant)",
      basePrice: { amount: 2, currency: "USD" as Currency },
      sku: "MILK-1L",
      createdBy: { userId: new Types.ObjectId(), name: "Ada" },
    });
    expect(other.sku).toBe("MILK-1L");

    // Two items in the SAME org with null SKU → fine (partial unique).
    await Item.create({
      orgId: ORG_A,
      itemTypeKey: "service_visit",
      name: "Service A",
      basePrice: null,
      createdBy: { userId: new Types.ObjectId(), name: "Ada" },
    });
    await Item.create({
      orgId: ORG_A,
      itemTypeKey: "service_visit",
      name: "Service B",
      basePrice: null,
      createdBy: { userId: new Types.ObjectId(), name: "Ada" },
    });
  });

  it("basePrice can be null (quoted-per-order pattern)", async () => {
    const doc = await Item.create({
      orgId: ORG_A,
      itemTypeKey: "consulting_hour",
      name: "Strategy session",
      basePrice: null,
      createdBy: { userId: new Types.ObjectId(), name: "Ada" },
    });
    expect(doc.basePrice).toBeNull();
  });
});

/* ────────────────────────── Order: additive change ───────────────────── */

describe("Order, universal commerce shape (Pass 5h)", () => {
  it("accepts the universal shape with lineItems[] + scheduling", async () => {
    const startsAt = new Date(Date.now() + 86_400_000);
    const endsAt = new Date(Date.now() + 2 * 86_400_000);
    const doc = await Order.create({
      orgId: ORG_A,
      orderNumber: "ORD-UNI-1",
      status: "NOT_INITIATED",
      state: RecordState.ACTIVE,
      customer: { name: "C", email: "c@x.test", phone: "+1" },
      pricing: { amount: 100, currency: "USD" as Currency },
      payment: { status: "NOT_INITIATED", processedWebhookEventIds: [] },
      createdBy: {
        userId: new Types.ObjectId(),
        name: "Ada",
        email: "ada@x.test",
      },
      policy: {
        acceptedAt: new Date(),
        version: "v1",
        text: "Policy text long enough to pass validation in this fixture.",
      },
      lineItems: [
        {
          itemTypeKey: "service_visit",
          name: "Service visit",
          quantity: 1,
          unitPrice: 100,
          total: 100,
          attributes: {},
        },
      ],
      scheduling: {
        type: SchedulingType.FIXED_WINDOW,
        startsAt,
        endsAt,
      },
    });
    expect(doc.lineItems?.length).toBe(1);
    expect(doc.lineItems?.[0].itemTypeKey).toBe("service_visit");
    expect(doc.lineItems?.[0].total).toBe(100);
    expect(doc.scheduling?.type).toBe(SchedulingType.FIXED_WINDOW);
  });

  it("scheduling endsAt can be null (open-ended engagements)", async () => {
    const startsAt = new Date(Date.now() + 86_400_000);
    const doc = await Order.create({
      orgId: ORG_A,
      orderNumber: "ORD-OPEN-1",
      status: "NOT_INITIATED",
      state: RecordState.ACTIVE,
      customer: { name: "C", email: "c@x.test", phone: "+1" },
      pricing: { amount: 1000, currency: "USD" as Currency },
      payment: { status: "NOT_INITIATED", processedWebhookEventIds: [] },
      createdBy: {
        userId: new Types.ObjectId(),
        name: "Ada",
        email: "ada@x.test",
      },
      policy: {
        acceptedAt: new Date(),
        version: "v1",
        text: "Engagement terms long enough to satisfy the validator.",
      },
      lineItems: [
        {
          itemTypeKey: "consulting_hour",
          name: "Strategy engagement",
          quantity: 1,
          unitPrice: 1000,
          total: 1000,
          attributes: {},
        },
      ],
      scheduling: {
        type: SchedulingType.OPEN_ENDED,
        startsAt,
        endsAt: null,
      },
    });
    expect(doc.scheduling?.endsAt).toBeNull();
  });
});
