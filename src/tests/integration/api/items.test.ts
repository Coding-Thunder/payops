import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import {
  ItemAttributeType,
  ItemPricingModel,
} from "@/lib/constants/items";
import { GET as listActiveRoute } from "@/app/api/items/route";
import {
  GET as listAdmin,
  POST as createAdmin,
} from "@/app/api/admin/items/route";
import {
  GET as readOne,
  PATCH as updateOne,
} from "@/app/api/admin/items/[id]/route";
import { ItemType } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Pass 6c — Item catalog API contracts.
 *
 * Service-layer coverage is in item.test.ts. This file covers the
 * route-level behavior: RBAC, body shape, status-only PATCH, and the
 * cross-tenant id-guess refusal.
 */

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

async function readData<T>(
  res: Response,
): Promise<{ status: number; data: T | undefined; ok: boolean }> {
  const { status, body } = await jsonBody<ApiEnvelope<T>>(res);
  return { status, data: body.data, ok: body.ok };
}

async function seedProductType(orgId: string): Promise<void> {
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
    ],
    confirmationEmailBlocks: [],
  });
}

const validBody = {
  itemTypeKey: "product",
  name: "Cotton t-shirt",
  basePrice: { amount: 29, currency: "USD" },
  sku: "TSHIRT-001",
  attributes: { sku: "TSHIRT-001" },
};

describe("POST /api/admin/items — create", () => {
  it("ADMIN can create a catalog item", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    await seedProductType(session.user.orgId!);

    const res = await createAdmin(
      buildRequest("/api/admin/items", { method: "POST", body: validBody }),
    );
    const { status, data } = await readData<{ id: string; name: string }>(res);
    expect(status).toBe(201);
    expect(data?.name).toBe("Cotton t-shirt");
  });

  it("STAFF is forbidden — catalog is admin-only", async () => {
    session = await mockSession(actorFor(UserRole.STAFF));
    const res = await createAdmin(
      buildRequest("/api/admin/items", { method: "POST", body: validBody }),
    );
    expect((await readData(res)).status).toBe(403);
  });

  it("REFUSES duplicate SKU in same org (409)", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    await seedProductType(session.user.orgId!);
    const first = await createAdmin(
      buildRequest("/api/admin/items", { method: "POST", body: validBody }),
    );
    expect((await readData(first)).status).toBe(201);

    const dupe = await createAdmin(
      buildRequest("/api/admin/items", { method: "POST", body: validBody }),
    );
    expect((await readData(dupe)).status).toBe(409);
  });
});

describe("GET /api/items — staff/operator read", () => {
  it("returns only ACTIVE rows for the actor's org", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    await seedProductType(session.user.orgId!);
    const created = await createAdmin(
      buildRequest("/api/admin/items", { method: "POST", body: validBody }),
    );
    const { data: createdData } = await readData<{ id: string }>(created);
    const id = createdData!.id;
    // Archive it.
    await updateOne(
      buildRequest(`/api/admin/items/${id}`, {
        method: "PATCH",
        body: { status: "ARCHIVED" },
      }),
      { params: Promise.resolve({ id }) },
    );

    const active = await listActiveRoute(
      buildRequest("/api/items", { method: "GET" }),
    );
    const { data } = await readData<{ items: unknown[] }>(active);
    expect(data?.items).toEqual([]);

    // Admin list still sees the archived row.
    const adminList = await listAdmin(
      buildRequest("/api/admin/items", { method: "GET" }),
    );
    const { data: adminData } = await readData<{
      items: { status: string }[];
    }>(adminList);
    expect(adminData?.items.map((i) => i.status)).toEqual(["ARCHIVED"]);
  });

  it("filters by itemTypeKey query param", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    await seedProductType(session.user.orgId!);
    await ItemType.create({
      orgId: new Types.ObjectId(session.user.orgId!),
      key: "service_visit",
      name: "Service visit",
      pricingModel: ItemPricingModel.FIXED,
      requiresScheduling: false,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [],
    });
    await createAdmin(
      buildRequest("/api/admin/items", { method: "POST", body: validBody }),
    );
    await createAdmin(
      buildRequest("/api/admin/items", {
        method: "POST",
        body: {
          itemTypeKey: "service_visit",
          name: "Tune-up",
          attributes: {},
        },
      }),
    );

    const filtered = await listActiveRoute(
      buildRequest("/api/items?itemTypeKey=product", { method: "GET" }),
    );
    const { data } = await readData<{ items: { name: string }[] }>(filtered);
    expect(data?.items.map((i) => i.name)).toEqual(["Cotton t-shirt"]);
  });
});

describe("PATCH /api/admin/items/[id]", () => {
  it("REFUSES cross-tenant edit (id-guess returns 404)", async () => {
    // Org A creates the item.
    session = await mockSession(actorFor(UserRole.ADMIN));
    await seedProductType(session.user.orgId!);
    const created = await createAdmin(
      buildRequest("/api/admin/items", { method: "POST", body: validBody }),
    );
    const { data } = await readData<{ id: string }>(created);
    const id = data!.id;
    session.restore();

    // Org B admin attempts to PATCH.
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await updateOne(
      buildRequest(`/api/admin/items/${id}`, {
        method: "PATCH",
        body: { name: "Org B's renaming attempt" },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect((await readData(res)).status).toBe(404);
  });

  it("status-only PATCH archives + restores", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    await seedProductType(session.user.orgId!);
    const created = await createAdmin(
      buildRequest("/api/admin/items", { method: "POST", body: validBody }),
    );
    const { data } = await readData<{ id: string }>(created);
    const id = data!.id;

    const archived = await updateOne(
      buildRequest(`/api/admin/items/${id}`, {
        method: "PATCH",
        body: { status: "ARCHIVED" },
      }),
      { params: Promise.resolve({ id }) },
    );
    const { data: archivedData } = await readData<{ status: string }>(archived);
    expect(archivedData?.status).toBe("ARCHIVED");

    const restored = await updateOne(
      buildRequest(`/api/admin/items/${id}`, {
        method: "PATCH",
        body: { status: "ACTIVE" },
      }),
      { params: Promise.resolve({ id }) },
    );
    const { data: restoredData } = await readData<{ status: string }>(restored);
    expect(restoredData?.status).toBe("ACTIVE");
  });
});

describe("GET /api/admin/items/[id] — read one", () => {
  it("returns the row when the actor owns it", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    await seedProductType(session.user.orgId!);
    const created = await createAdmin(
      buildRequest("/api/admin/items", { method: "POST", body: validBody }),
    );
    const { data } = await readData<{ id: string }>(created);
    const id = data!.id;

    const res = await readOne(
      buildRequest(`/api/admin/items/${id}`, { method: "GET" }),
      { params: Promise.resolve({ id }) },
    );
    const { status, data: read } = await readData<{ name: string }>(res);
    expect(status).toBe(200);
    expect(read?.name).toBe("Cotton t-shirt");
  });
});
