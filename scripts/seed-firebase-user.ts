 
/**
 * Seed a Firebase Auth user + provision the matching TraceTxn workspace.
 *
 * Idempotent: re-running with the same email resets the Firebase password
 * to the requested value and ensures the Mongo User/Org/Member rows exist
 * and are linked via externalAuth.firebaseUid.
 *
 *   npx tsx --require ./scripts/shim-server-only.cjs scripts/seed-firebase-user.ts \
 *     vinaymaheshwari35@gmail.com 'odn$3875G' "Vinay Maheshwari"
 *
 * Args (positional):
 *   1. email
 *   2. password
 *   3. display name      (optional — defaults to local-part of email)
 */

import mongoose from "mongoose";

import { getFirebaseAdminAuth } from "@/lib/firebase/admin";
import { User } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { signupFounderFromFirebase } from "@/server/services/signup.service";

async function main() {
  const [email, password, displayNameArg] = process.argv.slice(2);
  if (!email || !password) {
    console.error(
      "usage: tsx --require ./scripts/shim-server-only.cjs scripts/seed-firebase-user.ts <email> <password> [name]",
    );
    process.exit(2);
  }
  const name =
    displayNameArg?.trim() ||
    email
      .split("@")[0]
      .replace(/[._-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  // ── Firebase side ──────────────────────────────────────────────
  const admin = getFirebaseAdminAuth();
  if (!admin) {
    console.error(
      "FIREBASE_SERVICE_ACCOUNT not set or unparseable — cannot reach Firebase Admin SDK.",
    );
    process.exit(2);
  }

  let firebaseUid: string;
  try {
    const existing = await admin.getUserByEmail(email);
    firebaseUid = existing.uid;
    // Idempotent reset — guarantees the requested password works even if
    // the row already existed with a different one.
    await admin.updateUser(existing.uid, {
      password,
      displayName: name,
      emailVerified: true,
      disabled: false,
    });
    console.log(`Firebase: updated existing user ${email} (uid=${firebaseUid})`);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== "auth/user-not-found") throw err;
    const created = await admin.createUser({
      email,
      password,
      displayName: name,
      emailVerified: true,
    });
    firebaseUid = created.uid;
    console.log(`Firebase: created user ${email} (uid=${firebaseUid})`);
  }

  // ── Mongo side ─────────────────────────────────────────────────
  await connectMongo();

  const lowerEmail = email.trim().toLowerCase();
  const existingMongo = await User.findOne({ email: lowerEmail })
    .select({ _id: 1, externalAuth: 1, primaryOrgId: 1 })
    .lean<{
      _id: unknown;
      externalAuth?: { firebaseUid?: string | null } | null;
      primaryOrgId?: unknown;
    } | null>();

  if (existingMongo) {
    const currentUid = existingMongo.externalAuth?.firebaseUid;
    if (currentUid !== firebaseUid) {
      await User.updateOne(
        { _id: existingMongo._id },
        { $set: { "externalAuth.firebaseUid": firebaseUid } },
      );
      console.log(
        `Mongo:    linked existing User._id=${String(existingMongo._id)} → firebaseUid`,
      );
    } else {
      console.log(
        `Mongo:    existing User._id=${String(existingMongo._id)} already linked`,
      );
    }
    console.log(
      `Mongo:    primaryOrgId=${String(existingMongo.primaryOrgId ?? "(none)")}`,
    );
  } else {
    const result = await signupFounderFromFirebase(
      { email: lowerEmail, name, firebaseUid },
      null,
    );
    console.log(
      `Mongo:    provisioned new tenant — userId=${result.user.id} orgId=${result.orgId} slug=${result.orgSlug}`,
    );
  }

  await mongoose.disconnect();
  console.log("");
  console.log("──────── ready ────────");
  console.log(`  email:    ${email}`);
  console.log(`  password: ${password}`);
  console.log(`  uid:      ${firebaseUid}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
