import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UserRole } from "@/lib/constants/enums";
import { POST as setupRoute } from "@/app/api/onboarding/business-setup/route";
import { ItemType } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { buildRequest, jsonBody } from "@/tests/utils/api";
import { mockNextHeaders } from "@/tests/utils/next-headers";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * Pass 6b — API contract for the onboarding wizard's final commit.
 *
 * Focus: RBAC + happy path + collision handling. Vertical-by-vertical
 * coverage lives in business-setup.test.ts (service layer).
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

const retailBody = {
  vertical: "retail" as const,
  itemType: {
    key: "product",
    name: "Product",
    description: "A physical item your customer takes home.",
    pricingModel: "QUANTITY",
    requiresScheduling: false,
    inventoryTracked: false,
    attributeSchema: [
      {
        key: "sku",
        label: "SKU",
        type: "STRING",
        required: false,
        displayOrder: 0,
      },
      {
        key: "size",
        label: "Size",
        type: "SELECT",
        required: false,
        options: ["S", "M", "L"],
        displayOrder: 1,
      },
    ],
    confirmationEmailBlocks: ["line_items_table"],
  },
};

describe("POST /api/onboarding/business-setup", () => {
  it("ADMIN can seed a retail template", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await setupRoute(
      buildRequest("/api/onboarding/business-setup", {
        method: "POST",
        body: retailBody,
      }),
    );
    const { status, body } = await jsonBody<{
      data: { vertical: string; itemType: { key: string } };
    }>(res);
    expect(status).toBe(201);
    expect(body.data.vertical).toBe("retail");
    expect(body.data.itemType.key).toBe("product");

    const persisted = await ItemType.findOne({ key: "product" }).lean();
    expect(persisted).not.toBeNull();
    expect(persisted?.attributeSchema?.length).toBe(2);
  });

  it("STAFF is forbidden — wizard is admin-only", async () => {
    session = await mockSession(actorFor(UserRole.STAFF));
    const res = await setupRoute(
      buildRequest("/api/onboarding/business-setup", {
        method: "POST",
        body: retailBody,
      }),
    );
    const { status } = await jsonBody(res);
    expect(status).toBe(403);
  });

  it("returns 409 on duplicate (orgId, key) so the wizard can prompt rename", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    // First seed succeeds.
    const first = await setupRoute(
      buildRequest("/api/onboarding/business-setup", {
        method: "POST",
        body: retailBody,
      }),
    );
    expect((await jsonBody(first)).status).toBe(201);

    // Re-submit with the same key for the same org → collision.
    const dupe = await setupRoute(
      buildRequest("/api/onboarding/business-setup", {
        method: "POST",
        body: retailBody,
      }),
    );
    const { status } = await jsonBody(dupe);
    expect(status).toBe(409);
  });

  it("422 on a SELECT field with no options", async () => {
    session = await mockSession(actorFor(UserRole.ADMIN));
    const res = await setupRoute(
      buildRequest("/api/onboarding/business-setup", {
        method: "POST",
        body: {
          ...retailBody,
          itemType: {
            ...retailBody.itemType,
            attributeSchema: [
              {
                key: "size",
                label: "Size",
                type: "SELECT",
                required: false,
                // no options
                displayOrder: 0,
              },
            ],
          },
        },
      }),
    );
    expect((await jsonBody(res)).status).toBe(422);
  });
});
