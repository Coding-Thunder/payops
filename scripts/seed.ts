 
/**
 * Bootstrap seed script.
 *
 * Prompts interactively for super-admin credentials so nothing sensitive
 * lives in env files. After the bootstrap user exists, further admins can
 * be created from the UI.
 *
 * Talks directly to the Mongoose models so it can run under plain `tsx`
 * (the service layer is marked `import "server-only"` which would throw
 * outside a Next.js build).
 */

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import { User } from "../src/server/db/models/user.model";
import { Setting } from "../src/server/db/models/setting.model";
import { hashPassword } from "../src/server/auth/password";
import { UserRole, RecordState } from "../src/lib/constants/enums";

const SETTINGS_KEY = "default";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function promptLine(rl: readline.Interface, q: string): Promise<string> {
  return (await rl.question(q)).trim();
}

async function promptHidden(question: string): Promise<string> {
  output.write(question);
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      reject(
        new Error(
          "Password prompt requires an interactive terminal. Run `npm run seed` directly, not piped.",
        ),
      );
      return;
    }
    input.setRawMode(true);
    input.resume();
    let buf = "";
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          output.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "\x03") {
          input.setRawMode(false);
          input.pause();
          output.write("\n");
          process.exit(130);
        } else if (ch === "\x7f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            output.write("\b \b");
          }
        } else {
          buf += ch;
          output.write("*");
        }
      }
    };
    input.on("data", onData);
  });
}

async function gatherAdmin(): Promise<{
  email: string;
  password: string;
  name: string;
}> {
  const rl = readline.createInterface({ input, output });

  console.log("\nCreate the bootstrap super admin.");
  console.log("(This user can be modified or replaced later from the UI.)\n");

  let email = "";
  while (!EMAIL_RE.test(email)) {
    email = (await promptLine(rl, "Email: ")).toLowerCase();
    if (!EMAIL_RE.test(email)) console.log("  ↳ Invalid email, try again.");
  }

  const name =
    (await promptLine(rl, "Full name [Super Admin]: ")) || "Super Admin";

  rl.close();

  let password = "";
  let confirm = "";
  while (true) {
    password = await promptHidden("Password (min 8 chars): ");
    if (password.length < 8) {
      console.log("  ↳ Too short, try again.");
      continue;
    }
    confirm = await promptHidden("Confirm password: ");
    if (password !== confirm) {
      console.log("  ↳ Passwords do not match, try again.");
      continue;
    }
    break;
  }

  return { email, password, name };
}

async function main() {
  const { email, password, name } = await gatherAdmin();

  console.log("\n→ Connecting to MongoDB...");
  await connectMongo();

  console.log("→ Ensuring settings document...");
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  await Setting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    {
      $setOnInsert: {
        key: SETTINGS_KEY,
        paymentExpiryHours: Number(
          process.env.DEFAULT_PAYMENT_EXPIRY_HOURS ?? 24,
        ),
        orderPrefix: process.env.DEFAULT_ORDER_PREFIX ?? "ORD",
        allowedBookingTypes: [
          "NEW_BOOKING",
          "MODIFICATION",
          "CANCELLATION_CHARGE",
        ],
        defaultCurrency: process.env.DEFAULT_CURRENCY ?? "USD",
        supportEmail:
          process.env.SUPPORT_EMAIL ?? "support@payops.example.com",
        supportPhone: process.env.SUPPORT_PHONE ?? "+1-555-0100",
        successRedirectUrl: `${appUrl}/orders/payment/success`,
        cancelRedirectUrl: `${appUrl}/orders/payment/cancelled`,
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  );

  const existing = await User.findOne({ email });
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
      email,
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
