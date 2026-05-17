/* eslint-disable no-console */
/**
 * Bulk password reset utility.
 *
 * Usage:
 *   PASSWORD_UPDATES='[
 *     {"email":"a@x.com","password":"new-password"},
 *     {"email":"b@x.com","password":"another"}
 *   ]' npx tsx --env-file=.env.local scripts/reset-passwords.ts
 *
 * - Only touches users that already exist (won't create accounts).
 * - Skips entries whose new password matches the current hash, so reruns
 *   are idempotent and don't churn `updatedAt`.
 * - Same 8-char minimum as the password hasher.
 */

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { User } from "../src/server/db/models/user.model";
import { hashPassword, verifyPassword } from "../src/server/auth/password";

interface PasswordUpdate {
  email: string;
  password: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function readUpdates(): PasswordUpdate[] {
  const raw = process.env.PASSWORD_UPDATES?.trim();
  if (!raw) {
    console.error(
      "PASSWORD_UPDATES env var is required (JSON array of {email,password}).",
    );
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `PASSWORD_UPDATES is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error("PASSWORD_UPDATES must be a JSON array.");
    process.exit(1);
  }
  const updates: PasswordUpdate[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      console.error("Each entry must be an object with email + password.");
      process.exit(1);
    }
    const obj = entry as Record<string, unknown>;
    const email = typeof obj.email === "string" ? obj.email.toLowerCase().trim() : "";
    const password = typeof obj.password === "string" ? obj.password : "";
    if (!EMAIL_RE.test(email)) {
      console.error(`Invalid email: "${email}"`);
      process.exit(1);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      console.error(
        `Password for ${email} is shorter than ${MIN_PASSWORD_LENGTH} chars.`,
      );
      process.exit(1);
    }
    updates.push({ email, password });
  }
  return updates;
}

async function main() {
  const updates = readUpdates();

  console.log(`→ Connecting to MongoDB...`);
  await connectMongo();

  console.log(`→ Resetting password on ${updates.length} account(s)...`);
  for (const update of updates) {
    const user = await User.findOne({ email: update.email }).select(
      "+passwordHash name email",
    );
    if (!user) {
      console.warn(`  • not found, skipped: ${update.email}`);
      continue;
    }
    const sameAsCurrent = await verifyPassword(update.password, user.passwordHash);
    if (sameAsCurrent) {
      console.log(`  • already set, skipped: ${update.email}`);
      continue;
    }
    user.passwordHash = await hashPassword(update.password);
    await user.save();
    console.log(`  ✓ password updated: ${update.email}`);
  }

  await disconnectMongo();
  console.log("✔ Done.");
}

main().catch(async (err) => {
  console.error("Reset failed:", err);
  await disconnectMongo();
  process.exit(1);
});
