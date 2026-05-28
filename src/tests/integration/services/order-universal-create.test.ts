import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Currency, UserRole } from "@/lib/constants/enums";
import {
  EmailBlockKey,
  ItemAttributeType,
  ItemPricingModel,
  SchedulingType,
} from "@/lib/constants/items";
import { ValidationError } from "@/lib/errors";
import { ItemType, Order, Setting } from "@/server/db/models";
import { createOrder } from "@/server/services/order.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Pass 5d coverage — polymorphic createOrder accepts BOTH the legacy
 * rental shape AND the universal lineItems[] shape, and the universal
 * path enforces ItemType tenant isolation + per-attribute validation.
 *
 * Tests focus on the *new* surface; legacy-shape coverage already exists
 * in order-org-isolation + order.service tests and remains green
 * (this file does NOT re-test it).
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

afterEach(async () => {
  // No global state to reset; resetDatabase between tests is sufficient.
});

function actorFor(): {
  id: string;
  name: string;
  email: string;
  role: UserRole;
} {
  return {
    id: new Types.ObjectId().toString(),
    name: "Test agent",
    email: "agent@tracetxn.test",
    role: UserRole.ADMIN,
  };
}

async function seedSettingsForOrg(orgId: string): Promise<void> {
  await Setting.create({
    orgId: new Types.ObjectId(orgId),
    paymentExpiryHours: 24,
    orderPrefix: "UNI",
    // Universal orders don't read this gate, but settings.findOne still
    // needs allowedBookingTypes to exist for validation defaults.
    defaultCurrency: "USD",
    successRedirectUrl: "http://localhost/pay/success",
    cancelRedirectUrl: "http://localhost/pay/cancelled",
    cancellationPolicy:
      "A sufficiently long cancellation policy for universal-shape tests.",
    cancellationPolicyVersion: "v1",
    consentMode: "ADVISORY",
    consentMessage: "I agree to proceed with this order.",
  });
}

async function seedMilkCartonType(orgId: string): Promise<void> {
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
      {
        key: "carton_size",
        label: "Carton size",
        type: ItemAttributeType.SELECT,
        required: true,
        options: ["500ml", "1L", "2L"],
        displayOrder: 1,
      },
    ],
    confirmationEmailBlocks: [
      EmailBlockKey.PAYMENT_SUMMARY,
      EmailBlockKey.LINE_ITEMS_TABLE,
    ],
  });
}

describe("createOrder — universal shape (Pass 5d)", () => {
  it("persists a single-line milk order, recomputes total, and writes lineItems", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedSettingsForOrg(orgId);
    await seedMilkCartonType(orgId);

    const { order } = await createOrder(
      {
        customer: {
          name: "Customer Z",
          email: "z@example.com",
          phone: "+15555550100",
        },
        lineItems: [
          {
            itemTypeKey: "milk_carton",
            name: "1L whole milk",
            quantity: 3,
            unitPrice: 4,
            total: 12,
            attributes: { fat_percent: 3.5, carton_size: "1L" },
          },
        ],
        pricing: { amount: 12, currency: Currency.USD },
        scheduling: null,
      },
      { actor: actorFor(), orgId, request: null },
    );

    expect(order.lineItems).toHaveLength(1);
    expect(order.lineItems[0].itemTypeKey).toBe("milk_carton");
    expect(order.lineItems[0].total).toBe(12);
    expect(order.lineItems[0].attributes).toMatchObject({
      fat_percent: 3.5,
      carton_size: "1L",
    });
    // Universal-shape order: legacy fields are absent.
    // Pass 5h: rental fields are gone from OrderDTO entirely.
  });

  it("REFUSES a universal order when the itemType is unknown for this org", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedSettingsForOrg(orgId);
    // No ItemType seeded — milk_carton doesn't exist for this org.

    await expect(
      createOrder(
        {
          customer: {
            name: "Customer Y",
            email: "y@example.com",
            phone: "+15555550100",
          },
          lineItems: [
            {
              itemTypeKey: "milk_carton",
              name: "1L whole milk",
              quantity: 1,
              unitPrice: 4,
              total: 4,
              attributes: {},
            },
          ],
          pricing: { amount: 4, currency: Currency.USD },
          scheduling: null,
        },
        { actor: actorFor(), orgId, request: null },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("REFUSES cross-tenant ItemType reuse — Org B cannot reference Org A's milk_carton", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    await seedSettingsForOrg(orgA);
    await seedSettingsForOrg(orgB);
    await seedMilkCartonType(orgA); // Only Org A has the type.

    await expect(
      createOrder(
        {
          customer: {
            name: "Customer X",
            email: "x@example.com",
            phone: "+15555550100",
          },
          lineItems: [
            {
              itemTypeKey: "milk_carton",
              name: "1L whole milk",
              quantity: 1,
              unitPrice: 4,
              total: 4,
              attributes: { fat_percent: 3.5, carton_size: "1L" },
            },
          ],
          pricing: { amount: 4, currency: Currency.USD },
          scheduling: null,
        },
        { actor: actorFor(), orgId: orgB, request: null },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("REFUSES when a required attribute is missing", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedSettingsForOrg(orgId);
    await seedMilkCartonType(orgId);

    await expect(
      createOrder(
        {
          customer: {
            name: "Customer W",
            email: "w@example.com",
            phone: "+15555550100",
          },
          lineItems: [
            {
              itemTypeKey: "milk_carton",
              name: "1L whole milk",
              quantity: 1,
              unitPrice: 4,
              total: 4,
              // Missing `fat_percent` — required by the schema.
              attributes: { carton_size: "1L" },
            },
          ],
          pricing: { amount: 4, currency: Currency.USD },
          scheduling: null,
        },
        { actor: actorFor(), orgId, request: null },
      ),
    ).rejects.toThrow(/fat_percent/);
  });

  it("REFUSES when a SELECT value is not in the spec's options", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedSettingsForOrg(orgId);
    await seedMilkCartonType(orgId);

    await expect(
      createOrder(
        {
          customer: {
            name: "Customer V",
            email: "v@example.com",
            phone: "+15555550100",
          },
          lineItems: [
            {
              itemTypeKey: "milk_carton",
              name: "1L whole milk",
              quantity: 1,
              unitPrice: 4,
              total: 4,
              attributes: { fat_percent: 3.5, carton_size: "5L" }, // not in options
            },
          ],
          pricing: { amount: 4, currency: Currency.USD },
          scheduling: null,
        },
        { actor: actorFor(), orgId, request: null },
      ),
    ).rejects.toThrow(/carton_size/);
  });

  it("REFUSES when grand total disagrees with sum of line totals (anti-tamper)", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedSettingsForOrg(orgId);
    await seedMilkCartonType(orgId);

    await expect(
      createOrder(
        {
          customer: {
            name: "Customer U",
            email: "u@example.com",
            phone: "+15555550100",
          },
          lineItems: [
            {
              itemTypeKey: "milk_carton",
              name: "1L whole milk",
              quantity: 1,
              unitPrice: 4,
              total: 4,
              attributes: { fat_percent: 3.5, carton_size: "1L" },
            },
          ],
          // Client claims $1 grand total but the line sums to $4.
          pricing: { amount: 1, currency: Currency.USD },
          scheduling: null,
        },
        { actor: actorFor(), orgId, request: null },
      ),
    ).rejects.toThrow(/grand total/i);
  });

  it("persists order-level scheduling for time-windowed orders", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedSettingsForOrg(orgId);
    // Use a TIME_WINDOW item type to model e.g. a rental.
    await ItemType.create({
      orgId: new Types.ObjectId(orgId),
      key: "service_window",
      name: "Service window",
      pricingModel: ItemPricingModel.TIME_WINDOW,
      requiresScheduling: true,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [EmailBlockKey.SCHEDULING_WINDOW],
    });
    const startsAt = new Date(Date.now() + 86_400_000);
    const endsAt = new Date(Date.now() + 2 * 86_400_000);

    const { order } = await createOrder(
      {
        customer: {
          name: "Customer T",
          email: "t@example.com",
          phone: "+15555550100",
        },
        lineItems: [
          {
            itemTypeKey: "service_window",
            name: "Maintenance visit",
            quantity: 1,
            unitPrice: 150,
            total: 150,
            attributes: {},
          },
        ],
        pricing: { amount: 150, currency: Currency.USD },
        scheduling: {
          type: SchedulingType.FIXED_WINDOW,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
      },
      { actor: actorFor(), orgId, request: null },
    );

    expect(order.scheduling).not.toBeNull();
    expect(order.scheduling?.type).toBe(SchedulingType.FIXED_WINDOW);
    expect(order.scheduling?.startsAt).toBe(startsAt.toISOString());
    expect(order.scheduling?.endsAt).toBe(endsAt.toISOString());
  });
});

// Pass 5h: the legacy-shape dual-write tests have been removed. The
// legacy rental input contract (bookingType + provider + vehicle + trip)
// no longer exists; every order goes through the universal flow.
