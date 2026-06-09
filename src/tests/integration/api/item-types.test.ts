import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import {
  ItemAttributeType,
  ItemPricingModel,
} from "@/lib/constants/items";
import { GET as listActive } from "@/app/api/item-types/route";
import {
  GET as listAdmin,
  POST as createAdmin,
} from "@/app/api/admin/item-types/route";
import {
  GET as readOne,
  PATCH as updateOne,
} from "@/app/api/admin/item-types/[id]/route";
import { ItemType } from "@/server/db/models";
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

interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** Read a wrapped `{ ok, data }` envelope so test asserts target `.data.*`. */
async function readData<T>(
  res: Response,
): Promise<{ status: number; data: T | undefined; ok: boolean }> {
  const { status, body } = await jsonBody<ApiEnvelope<T>>(res);
  return { status, data: body.data, ok: body.ok };
}

const validBody = {
  key: "milk_carton",
  name: "Milk carton",
  description: "Standard retail milk SKU.",
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
};

describe("POST /api/admin/item-types, create", () => {
  it("ADMIN can create a new item type for their org", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: validBody,
      }),
    );
    const { status, data } = await readData<{ key: string; id: string }>(res);
    expect(status).toBe(201);
    expect(data?.key).toBe("milk_carton");
    const persisted = await ItemType.findById(data!.id);
    expect(persisted?.orgId.toString()).toBe(session.user.orgId);
  });

  it("STAFF is forbidden, ITEM_TYPE_MANAGE is admin-only", async () => {
    session = await mockSession(actorFor(UserRole.STAFF));
    const res = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: validBody,
      }),
    );
    const { status } = await readData(res);
    expect(status).toBe(403);
  });

  it("REFUSES duplicate (orgId, key), returns 409", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const first = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: validBody,
      }),
    );
    expect((await readData(first)).status).toBe(201);

    const dupe = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: validBody,
      }),
    );
    expect((await readData(dupe)).status).toBe(409);
  });

  it("REFUSES SELECT attribute with no options", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: {
          ...validBody,
          attributeSchema: [
            {
              key: "size",
              label: "Size",
              type: ItemAttributeType.SELECT,
              required: true,
              displayOrder: 0,
            },
          ],
        },
      }),
    );
    expect((await readData(res)).status).toBe(422);
  });

  it("REFUSES duplicate attribute keys", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: {
          ...validBody,
          attributeSchema: [
            {
              key: "fat_percent",
              label: "Fat",
              type: ItemAttributeType.NUMBER,
              required: false,
              displayOrder: 0,
            },
            {
              key: "fat_percent",
              label: "Fat again",
              type: ItemAttributeType.NUMBER,
              required: false,
              displayOrder: 1,
            },
          ],
        },
      }),
    );
    expect((await readData(res)).status).toBe(422);
  });
});

describe("GET /api/item-types, caller-org active list", () => {
  it("returns only ACTIVE rows in the actor's org (cross-tenant refusal)", async () => {
    const orgA = new Types.ObjectId();
    const orgB = new Types.ObjectId();
    await ItemType.create({
      orgId: orgA,
      key: "milk_carton",
      name: "Milk carton",
      pricingModel: ItemPricingModel.QUANTITY,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [],
    });
    await ItemType.create({
      orgId: orgB,
      key: "service_visit",
      name: "Service visit",
      pricingModel: ItemPricingModel.FIXED,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [],
    });

    session = await mockSession(actorFor(UserRole.ADMIN));
    Object.assign(session.user, { orgId: orgA.toString() });

    const res = await listActive(
      buildRequest("/api/item-types", { method: "GET" }),
    );
    const { status, data } = await readData<{
      items: { key: string }[];
    }>(res);
    expect(status).toBe(200);
    expect(data?.items.map((i) => i.key)).toEqual(["milk_carton"]);
  });

  it("hides ARCHIVED rows from the active list", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const created = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: validBody,
      }),
    );
    const { data: createdData } = await readData<{ id: string }>(created);
    const id = createdData!.id;

    await updateOne(
      buildRequest(`/api/admin/item-types/${id}`, {
        method: "PATCH",
        body: { status: "ARCHIVED" },
      }),
      { params: Promise.resolve({ id }) },
    );

    const activeRes = await listActive(
      buildRequest("/api/item-types", { method: "GET" }),
    );
    const { data: activeData } = await readData<{ items: unknown[] }>(activeRes);
    expect(activeData?.items).toEqual([]);

    const adminAfter = await listAdmin(
      buildRequest("/api/admin/item-types", { method: "GET" }),
    );
    const { data: adminAfterData } = await readData<{
      items: { status: string }[];
    }>(adminAfter);
    expect(adminAfterData?.items.map((i) => i.status)).toEqual(["ARCHIVED"]);
  });
});

describe("PATCH /api/admin/item-types/[id]", () => {
  it("updates name + attributeSchema in place", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const created = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: validBody,
      }),
    );
    const { data: createdData } = await readData<{ id: string }>(created);
    const id = createdData!.id;

    const res = await updateOne(
      buildRequest(`/api/admin/item-types/${id}`, {
        method: "PATCH",
        body: {
          name: "Milk carton (renamed)",
          attributeSchema: [
            {
              key: "fat_percent",
              label: "Fat percent",
              type: ItemAttributeType.NUMBER,
              required: true,
              displayOrder: 0,
            },
          ],
        },
      }),
      { params: Promise.resolve({ id }) },
    );
    const { status, data } = await readData<{
      name: string;
      attributeSchema: unknown[];
    }>(res);
    expect(status).toBe(200);
    expect(data?.name).toBe("Milk carton (renamed)");
    expect(data?.attributeSchema).toHaveLength(1);
  });

  it("REFUSES cross-tenant edit (id-guess returns 404)", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const created = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: validBody,
      }),
    );
    const { data: createdData } = await readData<{ id: string }>(created);
    const id = createdData!.id;
    session.restore();

    // Org B admin tries to patch it.
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await updateOne(
      buildRequest(`/api/admin/item-types/${id}`, {
        method: "PATCH",
        body: { name: "Org B steals" },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect((await readData(res)).status).toBe(404);
  });

  it("status-only PATCH archives + restores", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const created = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: validBody,
      }),
    );
    const { data: createdData } = await readData<{ id: string }>(created);
    const id = createdData!.id;

    const archived = await updateOne(
      buildRequest(`/api/admin/item-types/${id}`, {
        method: "PATCH",
        body: { status: "ARCHIVED" },
      }),
      { params: Promise.resolve({ id }) },
    );
    const { data: archivedData } = await readData<{ status: string }>(archived);
    expect(archivedData?.status).toBe("ARCHIVED");

    const restored = await updateOne(
      buildRequest(`/api/admin/item-types/${id}`, {
        method: "PATCH",
        body: { status: "ACTIVE" },
      }),
      { params: Promise.resolve({ id }) },
    );
    const { data: restoredData } = await readData<{ status: string }>(restored);
    expect(restoredData?.status).toBe("ACTIVE");
  });
});

describe("GET /api/admin/item-types/[id], read one", () => {
  it("returns the row when the actor owns it", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const created = await createAdmin(
      buildRequest("/api/admin/item-types", {
        method: "POST",
        body: validBody,
      }),
    );
    const { data: createdData } = await readData<{ id: string }>(created);
    const id = createdData!.id;

    const res = await readOne(
      buildRequest(`/api/admin/item-types/${id}`, { method: "GET" }),
      { params: Promise.resolve({ id }) },
    );
    const { status, data } = await readData<{ key: string }>(res);
    expect(status).toBe(200);
    expect(data?.key).toBe("milk_carton");
  });
});
