import { Types } from "mongoose";
import { beforeEach, describe, expect, it } from "vitest";

import { AuditAction, AuditEntity } from "@/lib/constants/enums";
import { AuditLog } from "@/server/db/models";
import { listAuditLogs, recordAudit } from "@/server/services/audit.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

/**
 * The audit trail must never widen when a caller has no organization.
 *
 * `listAuditLogs` applies its org filter only when `orgId` is truthy, and its
 * cross-tenant mode is a documented, intentional capability for platform-side
 * views that omit the field. The accident was that a caller passing `null` —
 * a session with no active workspace — got that same cross-tenant mode. The
 * permission check cannot catch it: AUDIT_VIEW says what a user may read, not
 * whose. The GET route had no guard where DELETE did.
 *
 * So `null` is now a thrown error and omission stays a choice, and the route
 * refuses before reaching the service at all.
 */

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
});

const ORG_A = new Types.ObjectId();
const ORG_B = new Types.ObjectId();

async function seedTwoTenants() {
  for (const [orgId, email] of [
    [ORG_A, "a@tenant-a.test"],
    [ORG_B, "b@tenant-b.test"],
  ] as const) {
    await recordAudit({
      action: AuditAction.USER_LOGIN,
      entityType: AuditEntity.USER,
      entityId: String(new Types.ObjectId()),
      orgId: String(orgId),
      actor: { userId: null, name: null, email, role: null },
      request: null,
      // The DTO exposes neither orgId nor the actor email, so the tenant is
      // marked in metadata — which it does expose — to make a leak visible
      // rather than merely counted.
      metadata: { tenant: String(orgId) },
    });
  }
  expect(await AuditLog.countDocuments({})).toBe(2);
}

describe("listAuditLogs tenant scoping", () => {
  it("returns only the named tenant's rows", async () => {
    await seedTwoTenants();
    const res = await listAuditLogs({ orgId: String(ORG_A) });
    expect(res.items).toHaveLength(1);
    expect(res.total).toBe(1);
    expect(res.items[0]!.metadata).toMatchObject({ tenant: String(ORG_A) });
  });

  it("THROWS on a null orgId instead of returning every tenant", async () => {
    await seedTwoTenants();
    // This is the whole finding: null used to mean "no filter", so a session
    // with no workspace read the entire platform's audit trail.
    await expect(listAuditLogs({ orgId: null })).rejects.toThrow(
      /orgId was null/i,
    );
  });

  it("still allows a DELIBERATE cross-tenant read by omitting the field", async () => {
    await seedTwoTenants();
    // SCOPE_OK: platform-side view, intentionally unscoped.
    const res = await listAuditLogs({});
    expect(res.items).toHaveLength(2);
  });

  it("does not leak tenant B into a tenant A query under any filter", async () => {
    await seedTwoTenants();
    for (const extra of [
      { action: AuditAction.USER_LOGIN },
      { entityType: AuditEntity.USER },
      { page: 1, pageSize: 100 },
    ]) {
      const res = await listAuditLogs({ orgId: String(ORG_A), ...extra });
      for (const row of res.items) {
        expect(
          (row.metadata as { tenant?: string } | null)?.tenant,
          "a row from another tenant reached a scoped query",
        ).toBe(String(ORG_A));
      }
    }
  });
});
