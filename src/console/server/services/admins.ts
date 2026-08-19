import "server-only";

import { connectMongo } from "@/console/server/db/mongoose";
import { AdminUser, type AdminUserDoc } from "@/console/server/db/models";
import { recordAdminAction } from "@/console/server/audit";
import { sendAdminWelcomeEmail } from "@/console/server/email/mailer";
import { normalizeEmail } from "@/console/server/auth/allowlist";

/**
 * Admin allow-list management. The `admin_users` collection is the ONLY source
 * of truth — every admin is a DB row, created here and revoked here.
 */

export interface AdminRow {
  id: string;
  email: string;
  name: string;
  role: "OWNER" | "ADMIN";
  status: "ACTIVE" | "DISABLED";
  invitedByEmail: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
}

function toRow(d: AdminUserDoc): AdminRow {
  return {
    id: String(d._id),
    email: d.email,
    name: d.name,
    role: d.role,
    status: d.status,
    invitedByEmail: d.invitedByEmail ?? null,
    lastLoginAt: d.lastLoginAt ? d.lastLoginAt.toISOString() : null,
    createdAt: d.createdAt ? d.createdAt.toISOString() : null,
  };
}

/** Every admin, oldest first. */
export async function listAdmins(): Promise<AdminRow[]> {
  await connectMongo();
  const docs = await AdminUser.find({})
    .sort({ createdAt: 1 })
    .lean<AdminUserDoc[]>();
  return docs.map(toRow).sort((a, b) => a.email.localeCompare(b.email));
}

export interface AddAdminInput {
  email: string;
  name: string;
  role?: "OWNER" | "ADMIN";
}

/** Add (or re-activate) an admin, then send them a welcome email. */
export async function addAdmin(
  input: AddAdminInput,
  actorEmail: string,
  ip: string | null,
): Promise<AdminRow> {
  await connectMongo();
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  const role: "OWNER" | "ADMIN" = input.role === "OWNER" ? "OWNER" : "ADMIN";
  if (!email) throw new Error("A valid email is required");
  if (!name) throw new Error("A name is required");

  const existing = await AdminUser.findOne({ email });
  const wasActive = existing?.status === "ACTIVE";
  let doc: AdminUserDoc & { _id: unknown };
  if (existing) {
    existing.name = name;
    existing.role = role;
    existing.status = "ACTIVE";
    if (!existing.invitedByEmail) existing.invitedByEmail = normalizeEmail(actorEmail);
    doc = await existing.save();
  } else {
    doc = await AdminUser.create({
      email,
      name,
      role,
      status: "ACTIVE",
      invitedByEmail: normalizeEmail(actorEmail),
    });
  }

  await recordAdminAction({
    action: existing ? "admin.reactivate" : "admin.add",
    actorEmail: normalizeEmail(actorEmail),
    targetType: "admin_user",
    targetId: email,
    metadata: { name, role },
    ip,
  });

  // Welcome email is best-effort: a mail hiccup must not fail the add (the
  // admin already has access). Re-activating an already-active admin skips
  // the email to avoid re-notifying on an idempotent edit.
  if (!wasActive) {
    try {
      await sendAdminWelcomeEmail({ to: email, name, invitedByEmail: actorEmail });
    } catch (err) {
      console.error(
        `[admin] welcome email failed for ${email}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return toRow(doc as AdminUserDoc);
}

/** Disable an admin. Yourself and the last remaining active admin are
 *  protected — there is no env-level way back in, so the console must never
 *  let the final route in be closed from inside. */
export async function removeAdmin(
  id: string,
  actorEmail: string,
  ip: string | null,
): Promise<void> {
  await connectMongo();
  const doc = await AdminUser.findById(id);
  if (!doc) throw new Error("Admin not found");
  const target = normalizeEmail(doc.email);
  if (target === normalizeEmail(actorEmail)) {
    throw new Error("You can't remove your own admin access");
  }
  // Never close the last route in. `admin_users` is the only source of truth
  // (there is no environment fallback), so reaching zero ACTIVE rows locks
  // everyone out permanently and can only be undone in the database.
  //
  // Counting and then saving is a check-then-act race: two admins removing
  // each other concurrently both read 2, both pass, both disable. Instead,
  // disable OPTIMISTICALLY and roll back if we turn out to have taken the
  // last one. `countDocuments` after our own write sees a state that already
  // includes it, so at most one of two concurrent removals can survive.
  const res = await AdminUser.updateOne(
    { _id: doc._id, status: "ACTIVE" },
    { $set: { status: "DISABLED" } },
  );
  if (res.matchedCount === 0) {
    // Already disabled by someone else — idempotent success.
    return;
  }
  const remaining = await AdminUser.countDocuments({ status: "ACTIVE" });
  if (remaining === 0) {
    // We took the last one. Put it back and refuse.
    await AdminUser.updateOne(
      { _id: doc._id },
      { $set: { status: "ACTIVE" } },
    );
    throw new Error("Can't remove the last remaining admin");
  }
  await recordAdminAction({
    action: "admin.remove",
    actorEmail: normalizeEmail(actorEmail),
    targetType: "admin_user",
    targetId: target,
    ip,
  });
}

/**
 * Call on every successful sign-in: stamp `lastLoginAt`.
 *
 * Never creates a row. A sign-in can only happen after `isAllowedEmail()` has
 * already found an ACTIVE `admin_users` row, so there is nothing to heal —
 * and auto-creating an admin as a side effect of logging in would make the
 * login path itself a grant path.
 */
export async function recordAdminLogin(email: string): Promise<void> {
  await connectMongo();
  await AdminUser.updateOne(
    { email: normalizeEmail(email) },
    { $set: { lastLoginAt: new Date() } },
  );
}
