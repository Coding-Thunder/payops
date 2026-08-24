import { beforeEach, describe, expect, it } from "vitest";
import type { Model, Schema } from "mongoose";
import { Types } from "mongoose";

import {
  AuditLog,
  Dispute,
  EmailTemplate,
  Order,
  OrderDraft,
  OrderEvidence,
  PaymentConsent,
  PendingEmail,
  ProcessedWebhookEvent,
  Quotation,
} from "@/server/db/models";
import { createOrder } from "@/server/services/order.service";
import { UserRole } from "@/lib/constants/enums";
import { actorFor } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import { resolveOrganizationId } from "@/server/auth/organization";
import { validCreateOrderInput } from "@/tests/fixtures/order-input.fixture";

/**
 * Tenancy column coverage.
 *
 * `organizationId` was applied across eleven schemas by a single mechanical
 * pass. That is exactly the kind of change that rots quietly — a model added
 * later forgets the plugin, and its rows become invisible to every scoped
 * query without anything failing loudly. This file is the guard: it asserts
 * the column and its index exist on every collection the migration claims to
 * own, so a new org-owned model that skips `schema.plugin(organizationScope)`
 * fails here rather than in production.
 *
 * CarLink is intentionally absent: the car library is shared reference data,
 * like the `providers` catalog, not tenant-owned.
 */

/** Every collection the migration declares organization-owned. */
const SCOPED: [string, Model<never>][] = [
  ["Order", Order as unknown as Model<never>],
  ["OrderDraft", OrderDraft as unknown as Model<never>],
  ["OrderEvidence", OrderEvidence as unknown as Model<never>],
  ["PaymentConsent", PaymentConsent as unknown as Model<never>],
  ["Dispute", Dispute as unknown as Model<never>],
  ["Quotation", Quotation as unknown as Model<never>],
  ["AuditLog", AuditLog as unknown as Model<never>],
  ["EmailTemplate", EmailTemplate as unknown as Model<never>],
  ["PendingEmail", PendingEmail as unknown as Model<never>],
  ["ProcessedWebhookEvent", ProcessedWebhookEvent as unknown as Model<never>],
];

function declaredIndexes(schema: Schema) {
  return schema.indexes() as Array<
    [Record<string, unknown>, Record<string, unknown> | undefined]
  >;
}

beforeEach(async () => {
  await ensureMongo();
});

describe("every organization-owned model carries the tenancy column", () => {
  it.each(SCOPED)("%s declares organizationId", (_name, model) => {
    expect(model.schema.path("organizationId")).toBeDefined();
  });

  it.each(SCOPED)("%s defaults organizationId to null", (_name, model) => {
    // Null rather than undefined matters: the compatibility rule is "null
    // means the default organization", and a reader distinguishes that from
    // a field that was never declared.
    expect(model.schema.path("organizationId").options.default).toBeNull();
  });

  it.each(SCOPED)("%s declares a sparse organizationId index", (_name, model) => {
    const match = declaredIndexes(model.schema).find(
      ([key]) => Object.keys(key).join(",") === "organizationId",
    );
    expect(match).toBeDefined();
    expect(match![1]).toMatchObject({ sparse: true });
  });
});

describe("the column is inert until something sets it", () => {
  it("stamps the deployment's organization on a normally-created order", async () => {
    // This assertion INVERTED, deliberately.
    //
    // It used to require `null` — the column existed but no write path set
    // it, which is what made the multi-brand migration safe to deploy ahead
    // of its backfill. With one organization resolved server-side there is
    // no longer a request that cannot name its tenant, so every ordinary
    // write is attributed. That is the point of the change: "every record
    // must be unambiguously associated with the organization" is not true of
    // a null column.
    await createSettings();
    const { order } = await createOrder(validCreateOrderInput(), {
      actor: actorFor(UserRole.ADMIN),
    });
    const doc = await Order.findById(order.id).lean<{
      organizationId?: unknown;
    } | null>();
    expect(doc!.organizationId).toBeTruthy();
    expect(String(doc!.organizationId)).toBe(await resolveOrganizationId());
  });

  it("accepts and round-trips an organization id once attributed", async () => {
    await createSettings();
    const { order } = await createOrder(validCreateOrderInput(), {
      actor: actorFor(UserRole.ADMIN),
    });
    const orgId = new Types.ObjectId();
    await Order.updateOne(
      { _id: order.id },
      { $set: { organizationId: orgId } },
    );
    const doc = await Order.findById(order.id).lean<{
      organizationId?: Types.ObjectId | null;
    } | null>();
    expect(String(doc!.organizationId)).toBe(String(orgId));
  });

  it("keeps a sparse index from indexing unattributed rows", async () => {
    // The sparse-ness is why adding this index to a large, entirely
    // unattributed collection costs almost nothing.
    await Order.init();
    await createSettings();
    await createOrder(validCreateOrderInput(), {
      actor: actorFor(UserRole.ADMIN),
    });
    const stats = await Order.collection.indexInformation({ full: true });
    const idx = (stats as unknown as { name: string; sparse?: boolean }[]).find(
      (i) => i.name === "organizationId_1",
    );
    expect(idx?.sparse).toBe(true);
  });
});
