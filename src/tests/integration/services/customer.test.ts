import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Currency, UserRole } from "@/lib/constants/enums";
import { resolveEffectivePermissions } from "@/lib/constants/permissions";
import {
  EmailBlockKey,
  ItemAttributeType,
  ItemPricingModel,
} from "@/lib/constants/items";
import { Customer, ItemType, Setting } from "@/server/db/models";
import {
  createOrder,
  updateOrderCustomer,
} from "@/server/services/order.service";
import {
  bumpCustomerOrderAggregates,
  decrementCustomerOrderCount,
  findCustomerByEmail,
  resolveOrCreateCustomer,
  upsertCustomerFromOrder,
} from "@/server/services/customer.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Pass 6d, saved customer records.
 *
 * The Customer collection auto-populates when an order is created. It's
 * an ergonomic prefill cache, not a source of truth, these tests pin
 * the upsert behavior + cross-tenant isolation + lookup case-handling.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

afterEach(async () => {});

function actorFor() {
  return {
    id: new Types.ObjectId().toString(),
    name: "Test agent",
    email: "agent@tracetxn.test",
    role: UserRole.ADMIN,
    permissions: resolveEffectivePermissions({
      role: UserRole.ADMIN,
      permissionMode: "full",
    }),
  };
}

async function seedSettings(orgId: string): Promise<void> {
  await Setting.create({
    orgId: new Types.ObjectId(orgId),
    paymentExpiryHours: 24,
    orderPrefix: "UNI",
    defaultCurrency: "USD",
    successRedirectUrl: "http://localhost/pay/success",
    cancelRedirectUrl: "http://localhost/pay/cancelled",
    cancellationPolicy:
      "A sufficiently long cancellation policy for the saved-customer tests.",
    cancellationPolicyVersion: "v1",
    consentMode: "ADVISORY",
    consentMessage: "I agree to proceed with this order.",
  });
}

async function seedItemType(orgId: string): Promise<void> {
  await ItemType.create({
    orgId: new Types.ObjectId(orgId),
    key: "milk_carton",
    name: "Milk carton",
    pricingModel: ItemPricingModel.QUANTITY,
    requiresScheduling: false,
    inventoryTracked: false,
    attributeSchema: [
      {
        key: "carton_size",
        label: "Carton size",
        type: ItemAttributeType.SELECT,
        required: true,
        options: ["500ml", "1L"],
        displayOrder: 0,
      },
    ],
    confirmationEmailBlocks: [EmailBlockKey.PAYMENT_SUMMARY],
  });
}

async function makeOrder(
  orgId: string,
  customer: { name: string; email: string; phone: string },
): Promise<void> {
  await createOrder(
    {
      customer,
      lineItems: [
        {
          itemTypeKey: "milk_carton",
          name: "1L whole milk",
          quantity: 1,
          unitPrice: 4,
          total: 4,
          attributes: { carton_size: "1L" },
        },
      ],
      pricing: { amount: 4, currency: Currency.USD },
      scheduling: null,
    },
    { actor: actorFor(), orgId, request: null },
  );
}

describe("createOrder → saves customer", () => {
  it("inserts a Customer row on first order with ordersCount=1", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedSettings(orgId);
    await seedItemType(orgId);
    await makeOrder(orgId, {
      name: "Casey Repeat",
      email: "casey@example.com",
      phone: "+15555550100",
    });

    const saved = await Customer.findOne({
      orgId: new Types.ObjectId(orgId),
      email: "casey@example.com",
    });
    expect(saved).not.toBeNull();
    expect(saved!.name).toBe("Casey Repeat");
    expect(saved!.phone).toBe("+15555550100");
    expect(saved!.ordersCount).toBe(1);
    expect(saved!.lastOrderAt).toBeInstanceOf(Date);
  });

  it("increments ordersCount on a second order to the same email", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedSettings(orgId);
    await seedItemType(orgId);
    await makeOrder(orgId, {
      name: "Casey Repeat",
      email: "casey@example.com",
      phone: "+15555550100",
    });
    await makeOrder(orgId, {
      name: "Casey R.",
      email: "casey@example.com",
      phone: "+15555550200",
    });

    const saved = await Customer.findOne({
      orgId: new Types.ObjectId(orgId),
      email: "casey@example.com",
    });
    expect(saved!.ordersCount).toBe(2);
    // Latest-write-wins on name + phone, operator's freshest typing.
    expect(saved!.name).toBe("Casey R.");
    expect(saved!.phone).toBe("+15555550200");
  });

  it("isolates by org, same email in two orgs creates two rows", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    await seedSettings(orgA);
    await seedSettings(orgB);
    await seedItemType(orgA);
    await seedItemType(orgB);
    await makeOrder(orgA, {
      name: "Alex A",
      email: "shared@example.com",
      phone: "+15555550100",
    });
    await makeOrder(orgB, {
      name: "Alex B",
      email: "shared@example.com",
      phone: "+15555550200",
    });

    const all = await Customer.find({ email: "shared@example.com" });
    expect(all).toHaveLength(2);
    const orgAMatch = all.find((c) => String(c.orgId) === orgA);
    const orgBMatch = all.find((c) => String(c.orgId) === orgB);
    expect(orgAMatch!.name).toBe("Alex A");
    expect(orgBMatch!.name).toBe("Alex B");
  });
});

describe("updateOrderCustomer → refreshes customer (no count bump)", () => {
  it("updates saved name/phone but does NOT increment ordersCount", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedSettings(orgId);
    await seedItemType(orgId);
    const actor = actorFor();
    const { order } = await createOrder(
      {
        customer: {
          name: "Casey Repeat",
          email: "casey@example.com",
          phone: "+15555550100",
        },
        lineItems: [
          {
            itemTypeKey: "milk_carton",
            name: "1L",
            quantity: 1,
            unitPrice: 4,
            total: 4,
            attributes: { carton_size: "1L" },
          },
        ],
        pricing: { amount: 4, currency: Currency.USD },
        scheduling: null,
      },
      { actor, orgId, request: null },
    );

    await updateOrderCustomer(
      order.id,
      { name: "Casey Updated", phone: "+15555550999" },
      { actor, orgId, request: null },
    );

    const saved = await Customer.findOne({
      orgId: new Types.ObjectId(orgId),
      email: "casey@example.com",
    });
    expect(saved!.name).toBe("Casey Updated");
    expect(saved!.phone).toBe("+15555550999");
    // The patch path doesn't pass countAsOrder, so still 1.
    expect(saved!.ordersCount).toBe(1);
  });
});

describe("findCustomerByEmail", () => {
  it("matches case-insensitively and returns null on miss", async () => {
    const orgId = new Types.ObjectId().toString();
    await upsertCustomerFromOrder(orgId, {
      name: "Drew",
      email: "Drew.Lower@Example.COM",
      phone: "+15555550100",
    });

    const hit = await findCustomerByEmail(orgId, "DREW.LOWER@example.com");
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe("Drew");

    const miss = await findCustomerByEmail(orgId, "nobody@example.com");
    expect(miss).toBeNull();
  });

  it("refuses to leak cross-tenant matches", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    await upsertCustomerFromOrder(orgA, {
      name: "A's customer",
      email: "shared@example.com",
      phone: "+15555550100",
    });
    const orgBLookup = await findCustomerByEmail(orgB, "shared@example.com");
    expect(orgBLookup).toBeNull();
  });
});

describe("bumpCustomerOrderAggregates (FK counter path)", () => {
  it("stamps firstOrderAt from a null seed and keeps earliest/ latest", async () => {
    const orgId = new Types.ObjectId().toString();
    // resolveOrCreateCustomer makes a profile with firstOrderAt=null.
    const customerId = await resolveOrCreateCustomer(orgId, {
      name: "Vela",
      email: "vela@example.com",
      phone: "+15555550100",
    });
    expect(customerId).not.toBeNull();
    const seeded = await Customer.findById(customerId!).lean();
    expect(seeded!.firstOrderAt).toBeNull();

    const t2 = new Date("2026-02-01T00:00:00.000Z");
    await bumpCustomerOrderAggregates(orgId, customerId!, {
      name: "Vela",
      phone: "+15555550100",
      orderCreatedAt: t2,
    });
    let doc = await Customer.findById(customerId!).lean();
    // Regression: a plain $min against null keeps null (BSON null < Date).
    expect(doc!.firstOrderAt?.toISOString()).toBe(t2.toISOString());
    expect(doc!.lastOrderAt?.toISOString()).toBe(t2.toISOString());
    expect(doc!.ordersCount).toBe(1);

    // An EARLIER order moves firstOrderAt back but not lastOrderAt.
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    await bumpCustomerOrderAggregates(orgId, customerId!, {
      name: "Vela",
      phone: "+15555550100",
      orderCreatedAt: t1,
    });
    doc = await Customer.findById(customerId!).lean();
    expect(doc!.firstOrderAt?.toISOString()).toBe(t1.toISOString());
    expect(doc!.lastOrderAt?.toISOString()).toBe(t2.toISOString());
    expect(doc!.ordersCount).toBe(2);
  });

  it("decrementCustomerOrderCount floors at zero and is tenant-pinned", async () => {
    const orgId = new Types.ObjectId().toString();
    const other = new Types.ObjectId().toString();
    const customerId = await resolveOrCreateCustomer(orgId, {
      name: "Vela",
      email: "vela@example.com",
      phone: "+15555550100",
    });
    await bumpCustomerOrderAggregates(orgId, customerId!, {
      name: "Vela",
      phone: "+15555550100",
      orderCreatedAt: new Date("2026-02-01T00:00:00.000Z"),
    });

    // Wrong tenant can't touch the counter.
    await decrementCustomerOrderCount(other, { customerId });
    expect((await Customer.findById(customerId!).lean())!.ordersCount).toBe(1);

    await decrementCustomerOrderCount(orgId, { customerId });
    expect((await Customer.findById(customerId!).lean())!.ordersCount).toBe(0);

    // Already at zero — the ordersCount>0 guard prevents going negative.
    await decrementCustomerOrderCount(orgId, { customerId });
    expect((await Customer.findById(customerId!).lean())!.ordersCount).toBe(0);
  });
});
