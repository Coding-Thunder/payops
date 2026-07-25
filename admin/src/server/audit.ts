import "server-only";

import { connectMongo } from "@/server/db/mongoose";
import { AdminAudit } from "@/server/db/models";

/** Append an admin-action row to the admin-owned audit collection. Never
 *  throws to the caller — an audit miss must not fail the action. */
export async function recordAdminAction(input: {
  action: string;
  actorEmail: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
}): Promise<void> {
  try {
    await connectMongo();
    await AdminAudit.create({
      action: input.action,
      actorEmail: input.actorEmail,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      metadata: input.metadata ?? null,
      ip: input.ip ?? null,
      createdAt: new Date(),
    });
  } catch {
    // best-effort
  }
}
