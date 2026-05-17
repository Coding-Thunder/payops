/* eslint-disable no-console */
/**
 * Bootstrap seed script — three modes:
 *
 *  1) Non-interactive, MULTI admin (preferred for ops):
 *       BOOTSTRAP_ADMINS='[
 *         {"email":"a@x.com","password":"...","name":"A"},
 *         {"email":"b@x.com","password":"...","name":"B"}
 *       ]'
 *
 *  2) Non-interactive, SINGLE admin (legacy env vars):
 *       BOOTSTRAP_ADMIN_EMAIL=...
 *       BOOTSTRAP_ADMIN_PASSWORD=...
 *       BOOTSTRAP_ADMIN_NAME=...
 *
 *  3) Interactive (no env set):
 *       prompts on stdin for email + password (hidden) + name.
 *
 * Existing users with the same email are promoted to SUPER_ADMIN; their
 * password is left untouched. Truly new emails are created with the
 * supplied initial password. Idempotent — safe to re-run.
 *
 * Talks directly to the Mongoose models so it can run under plain `tsx`.
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
const MIN_PASSWORD_LENGTH = 8;

interface AdminSeed {
  email: string;
  password: string;
  name: string;
  role: UserRole;
}

const VALID_ROLES = new Set<UserRole>([
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN,
  UserRole.STAFF,
]);

/* ───────────────────────────── env-driven inputs ───────────────────────── */

function readAdminsFromEnv(): AdminSeed[] | null {
  const list: AdminSeed[] = [];

  const raw = process.env.BOOTSTRAP_ADMINS?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `BOOTSTRAP_ADMINS is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error("BOOTSTRAP_ADMINS must be a JSON array");
    }
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        throw new Error("BOOTSTRAP_ADMINS entries must be objects");
      }
      const obj = entry as Record<string, unknown>;
      const email = typeof obj.email === "string" ? obj.email : "";
      const password = typeof obj.password === "string" ? obj.password : "";
      const name = typeof obj.name === "string" ? obj.name : "Super Admin";
      const rawRole = typeof obj.role === "string" ? obj.role : UserRole.SUPER_ADMIN;
      if (!EMAIL_RE.test(email)) {
        throw new Error(`Invalid email in BOOTSTRAP_ADMINS: "${email}"`);
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(
          `Password for ${email} is shorter than ${MIN_PASSWORD_LENGTH} chars`,
        );
      }
      if (!VALID_ROLES.has(rawRole as UserRole)) {
        throw new Error(
          `Invalid role "${rawRole}" for ${email} (allowed: SUPER_ADMIN, ADMIN, STAFF)`,
        );
      }
      list.push({ email, password, name, role: rawRole as UserRole });
    }
  }

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = process.env.BOOTSTRAP_ADMIN_NAME ?? "Super Admin";
  if (email && password) {
    if (!EMAIL_RE.test(email)) {
      throw new Error(`Invalid BOOTSTRAP_ADMIN_EMAIL: "${email}"`);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `BOOTSTRAP_ADMIN_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} chars`,
      );
    }
    if (!list.some((a) => a.email.toLowerCase() === email.toLowerCase())) {
      list.push({ email, password, name, role: UserRole.SUPER_ADMIN });
    }
  }

  return list.length > 0 ? list : null;
}

/* ────────────────────────── interactive fallback ───────────────────────── */

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

async function gatherAdminInteractively(): Promise<AdminSeed> {
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
  while (true) {
    password = await promptHidden(
      `Password (min ${MIN_PASSWORD_LENGTH} chars): `,
    );
    if (password.length < MIN_PASSWORD_LENGTH) {
      console.log("  ↳ Too short, try again.");
      continue;
    }
    const confirm = await promptHidden("Confirm password: ");
    if (password !== confirm) {
      console.log("  ↳ Passwords do not match, try again.");
      continue;
    }
    break;
  }

  return { email, password, name, role: UserRole.SUPER_ADMIN };
}

/* ────────────────────────────── seed core ──────────────────────────────── */

async function ensureSettingsDocument() {
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
        successRedirectUrl: `${appUrl}/pay/success`,
        cancelRedirectUrl: `${appUrl}/pay/cancelled`,
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  );
}

async function upsertAdmin(admin: AdminSeed): Promise<void> {
  const email = admin.email.toLowerCase().trim();
  const existing = await User.findOne({ email });
  if (existing) {
    let dirty = false;
    if (existing.role !== admin.role) {
      existing.role = admin.role;
      dirty = true;
    }
    if (existing.status !== RecordState.ACTIVE) {
      existing.status = RecordState.ACTIVE;
      dirty = true;
    }
    if (dirty) {
      await existing.save();
      console.log(`  ✓ updated existing user → ${admin.role}: ${email}`);
    } else {
      console.log(`  • already ${admin.role}, skipped: ${email}`);
    }
    return;
  }
  const passwordHash = await hashPassword(admin.password);
  await User.create({
    name: admin.name,
    email,
    passwordHash,
    role: admin.role,
    status: RecordState.ACTIVE,
  });
  console.log(`  ✓ created ${admin.role}: ${email}`);
}

async function main() {
  let admins: AdminSeed[];
  try {
    const envAdmins = readAdminsFromEnv();
    admins =
      envAdmins && envAdmins.length > 0
        ? envAdmins
        : [await gatherAdminInteractively()];
  } catch (err) {
    console.error(
      `Seed input error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log("\n→ Connecting to MongoDB...");
  await connectMongo();

  console.log("→ Ensuring settings document...");
  await ensureSettingsDocument();

  console.log(`→ Seeding ${admins.length} super admin(s)...`);
  for (const admin of admins) {
    try {
      await upsertAdmin(admin);
    } catch (err) {
      console.error(
        `  ✗ failed for ${admin.email}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exitCode = 1;
    }
  }

  await disconnectMongo();
  console.log("✔ Seed complete.");
}

main().catch(async (err) => {
  console.error("Seed failed:", err);
  await disconnectMongo();
  process.exit(1);
});
