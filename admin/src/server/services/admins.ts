import "server-only";

import { connectMongo } from "@/server/db/mongoose";
import { AdminUser, type AdminUserDoc } from "@/server/db/models";
import { recordAdminAction } from "@/server/audit";
import { sendAdminWelcomeEmail } from "@/server/email/mailer";
import { bootstrapAdmins, normalizeEmail } from "@/server/auth/allowlist";

/**
 * Admin allow-list management. The `admin_users` collection is the managed
 * source of truth; env `ADMIN_ALLOWLIST` entries are break-glass bootstrap
 * admins that always retain access and can't be removed here.
 */

export interface AdminRow {
  /** null for a bootstrap admin that isn't (yet) a DB row. */
  id: string | null;
  email: string;
  name: string;
  role: "OWNER" | "ADMIN";
  status: "ACTIVE" | "DISABLED";
  /** "bootstrap" = env break-glass (protected); "db" = managed here. */
  source: "bootstrap" | "db";
  invitedByEmail: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
}

function toRow(d: AdminUserDoc, bootstrap: Set<string>): AdminRow {
  return {
    id: String(d._id),
    email: d.email,
    name: d.name,
    role: d.role,
    status: d.status,
    source: bootstrap.has(d.email) ? "bootstrap" : "db",
    invitedByEmail: d.invitedByEmail ?? null,
    lastLoginAt: d.lastLoginAt ? d.lastLoginAt.toISOString() : null,
    createdAt: d.createdAt ? d.createdAt.toISOString() : null,
  };
}

/** Every admin: DB-managed rows plus any bootstrap env admin not yet seeded
 *  into the DB (shown as a protected OWNER). */
export async function listAdmins(): Promise<AdminRow[]> {
  await connectMongo();
  const bootstrap = bootstrapAdmins();
  const docs = await AdminUser.find({})
    .sort({ createdAt: 1 })
    .lean<AdminUserDoc[]>();
  const rows = new Map<string, AdminRow>();
  for (const d of docs) rows.set(d.email, toRow(d, bootstrap));
  for (const email of bootstrap) {
    if (!rows.has(email)) {
      rows.set(email, {
        id: null,
        email,
        name: "Bootstrap admin",
        role: "OWNER",
        status: "ACTIVE",
        source: "bootstrap",
        invitedByEmail: null,
        lastLoginAt: null,
        createdAt: null,
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.email.localeCompare(b.email));
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

  const bootstrap = bootstrapAdmins();
  return toRow(doc as AdminUserDoc, bootstrap);
}

/** Disable a DB-managed admin. Bootstrap admins, yourself, and the last
 *  remaining admin are protected. */
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
  if (bootstrapAdmins().has(target)) {
    throw new Error(
      "This admin is configured in the environment (break-glass) and can't be removed here",
    );
  }
  // Never remove the last route in: count DB-active admins + bootstrap admins.
  const activeDb = await AdminUser.countDocuments({ status: "ACTIVE" });
  if (activeDb + bootstrapAdmins().size <= 1) {
    throw new Error("Can't remove the last remaining admin");
  }
  doc.status = "DISABLED";
  await doc.save();
  await recordAdminAction({
    action: "admin.remove",
    actorEmail: normalizeEmail(actorEmail),
    targetType: "admin_user",
    targetId: target,
    ip,
  });
}

/**
 * Call on every successful sign-in: stamp `lastLoginAt`, and self-heal a
 * bootstrap admin into `admin_users` so they show up in the Admins list.
 */
export async function recordAdminLogin(email: string): Promise<void> {
  await connectMongo();
  const normalized = normalizeEmail(email);
  const isBootstrap = bootstrapAdmins().has(normalized);
  await AdminUser.updateOne(
    { email: normalized },
    {
      $set: { lastLoginAt: new Date() },
      $setOnInsert: {
        email: normalized,
        name: normalized.split("@")[0] || "Admin",
        role: isBootstrap ? "OWNER" : "ADMIN",
        status: "ACTIVE",
        invitedByEmail: null,
      },
    },
    // Only auto-create for bootstrap admins; managed admins already have a row.
    { upsert: isBootstrap },
  );
}
