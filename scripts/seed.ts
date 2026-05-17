/* eslint-disable no-console */
import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { User } from "../src/server/db/models/user.model";
import { ensureSettingsDocument } from "../src/server/services/settings.service";
import { hashPassword } from "../src/server/auth/password";
import { UserRole, RecordState } from "../src/lib/constants/enums";

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = process.env.BOOTSTRAP_ADMIN_NAME ?? "Super Admin";

  if (!email || !password) {
    console.error(
      "Missing BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD environment variables.",
    );
    process.exit(1);
  }

  console.log("→ Connecting to MongoDB...");
  await connectMongo();

  console.log("→ Ensuring settings document...");
  await ensureSettingsDocument();

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    if (existing.role !== UserRole.SUPER_ADMIN) {
      existing.role = UserRole.SUPER_ADMIN;
      existing.status = RecordState.ACTIVE;
      await existing.save();
      console.log(`→ Promoted existing user ${email} to SUPER_ADMIN.`);
    } else {
      console.log(`→ Super admin ${email} already exists. Skipping.`);
    }
  } else {
    const passwordHash = await hashPassword(password);
    await User.create({
      name,
      email: email.toLowerCase(),
      passwordHash,
      role: UserRole.SUPER_ADMIN,
      status: RecordState.ACTIVE,
    });
    console.log(`→ Created super admin: ${email}`);
  }

  await disconnectMongo();
  console.log("✔ Seed complete.");
}

main().catch(async (err) => {
  console.error("Seed failed:", err);
  await disconnectMongo();
  process.exit(1);
});
