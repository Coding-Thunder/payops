import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Currency, RecordState } from "@/lib/constants/enums";
import {
  ItemAttributeType,
  ItemPricingModel,
} from "@/lib/constants/items";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "@/lib/errors";
import { Item, ItemType } from "@/server/db/models";
import {
  archiveItem,
  createItem,
  getItemById,
  listActiveItems,
  restoreItem,
  updateItem,
} from "@/server/services/item.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Pass 6c, catalog Item service coverage.
 *
 * Focus on the business-critical edges:
 *   - Attribute payloads are validated against the referenced
 *     ItemType (closes the "garbage SKU attribute" hole).
 *   - SKU is unique per-tenant (catches "two products with the same
 *     SKU" admin mistake at write time).
 *   - Cross-tenant id-guess fails closed.
 *   - Archive / restore lifecycle preserves historical data.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

afterEach(async () => {
  // Nothing to undo, resetDatabase covers it in beforeEach.
});

function ctxFor(orgId: string) {
  return {
    orgId,
    actorId: new Types.ObjectId().toString(),
    actorName: "Test actor",
  };
}

async function seedRetailType(orgId: string): Promise<void> {
  await ItemType.create({
    orgId: new Types.ObjectId(orgId),
    key: "product",
    name: "Product",
    pricingModel: ItemPricingModel.QUANTITY,
    requiresScheduling: false,
    inventoryTracked: false,
    attributeSchema: [
      {
        key: "sku",
        label: "SKU",
        type: ItemAttributeType.STRING,
        required: false,
        displayOrder: 0,
      },
      {
        key: "size",
        label: "Size",
        type: ItemAttributeType.SELECT,
        required: false,
        options: ["S", "M", "L"],
        displayOrder: 1,
      },
    ],
    confirmationEmailBlocks: [],
  });
}

describe("createItem", () => {
  it("persists a catalog row with validated attributes", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedRetailType(orgId);

    const result = await createItem(
      {
        itemTypeKey: "product",
        name: "Cotton t-shirt",
        basePrice: { amount: 29, currency: Currency.USD },
        sku: "TSHIRT-001",
        attributes: { size: "M" },
      },
      ctxFor(orgId),
    );

    expect(result.name).toBe("Cotton t-shirt");
    expect(result.sku).toBe("TSHIRT-001");
    expect(result.basePrice?.amount).toBe(29);
    expect(result.attributes).toMatchObject({ size: "M" });
  });

  it("REFUSES an unknown attribute key for the chosen item type", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedRetailType(orgId);

    await expect(
      createItem(
        {
          itemTypeKey: "product",
          name: "Mug",
          attributes: { capacity_ml: 250 }, // not declared on `product`
        },
        ctxFor(orgId),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("REFUSES a SELECT value outside the spec's options", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedRetailType(orgId);

    await expect(
      createItem(
        {
          itemTypeKey: "product",
          name: "Hoodie",
          attributes: { size: "XXXL" }, // not in [S, M, L]
        },
        ctxFor(orgId),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("REFUSES creating an item for an undefined item type", async () => {
    const orgId = new Types.ObjectId().toString();
    // No itemType seeded.
    await expect(
      createItem(
        {
          itemTypeKey: "product",
          name: "Mug",
          attributes: {},
        },
        ctxFor(orgId),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("REFUSES duplicate SKU within the same org", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedRetailType(orgId);

    await createItem(
      {
        itemTypeKey: "product",
        name: "Mug",
        sku: "MUG-001",
        attributes: {},
      },
      ctxFor(orgId),
    );
    await expect(
      createItem(
        {
          itemTypeKey: "product",
          name: "Different mug",
          sku: "MUG-001",
          attributes: {},
        },
        ctxFor(orgId),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("ALLOWS the same SKU in two different orgs (per-tenant scope)", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    await seedRetailType(orgA);
    await seedRetailType(orgB);

    await createItem(
      { itemTypeKey: "product", name: "Mug", sku: "MUG-001", attributes: {} },
      ctxFor(orgA),
    );
    await createItem(
      { itemTypeKey: "product", name: "Mug B", sku: "MUG-001", attributes: {} },
      ctxFor(orgB),
    );

    expect(await Item.countDocuments({ sku: "MUG-001" })).toBe(2);
  });
});

describe("listActiveItems / getItemById", () => {
  it("listActiveItems hides ARCHIVED rows; getItemById refuses cross-tenant", async () => {
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    await seedRetailType(orgA);
    await seedRetailType(orgB);

    const a = await createItem(
      { itemTypeKey: "product", name: "Active", attributes: {} },
      ctxFor(orgA),
    );
    const archived = await createItem(
      { itemTypeKey: "product", name: "ToArchive", attributes: {} },
      ctxFor(orgA),
    );
    await archiveItem(archived.id, ctxFor(orgA));

    const active = await listActiveItems(orgA);
    expect(active.map((i) => i.name)).toEqual(["Active"]);

    // Org B trying to read orgA's item: NotFoundError.
    await expect(getItemById(a.id, ctxFor(orgB))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("filters by itemTypeKey when supplied", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedRetailType(orgId);
    // Seed a second item type so the filter has something to discriminate against.
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

    await createItem(
      { itemTypeKey: "product", name: "Mug", attributes: {} },
      ctxFor(orgId),
    );
    await createItem(
      { itemTypeKey: "service_visit", name: "Tune-up", attributes: {} },
      ctxFor(orgId),
    );

    const products = await listActiveItems(orgId, { itemTypeKey: "product" });
    expect(products.map((i) => i.name)).toEqual(["Mug"]);
  });
});

describe("updateItem / archive lifecycle", () => {
  it("update preserves itemTypeKey + re-validates attributes against the original type", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedRetailType(orgId);
    const created = await createItem(
      {
        itemTypeKey: "product",
        name: "Original",
        attributes: { size: "M" },
      },
      ctxFor(orgId),
    );

    const updated = await updateItem(
      created.id,
      { name: "Renamed", attributes: { size: "L" } },
      ctxFor(orgId),
    );
    expect(updated.name).toBe("Renamed");
    expect(updated.attributes).toMatchObject({ size: "L" });
    // Item type cannot change.
    expect(updated.itemTypeKey).toBe("product");
  });

  it("archive flips status; restore returns it", async () => {
    const orgId = new Types.ObjectId().toString();
    await seedRetailType(orgId);
    const created = await createItem(
      { itemTypeKey: "product", name: "Mug", attributes: {} },
      ctxFor(orgId),
    );

    const archived = await archiveItem(created.id, ctxFor(orgId));
    expect(archived.status).toBe(RecordState.ARCHIVED);

    const restored = await restoreItem(created.id, ctxFor(orgId));
    expect(restored.status).toBe(RecordState.ACTIVE);
  });
});
