import path from "node:path";
import fs from "node:fs";

import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import { loadEnvFile } from "./load-env";

/**
 * Playwright global setup.
 *
 *   1. Load .env.smoke so MONGODB_URI etc. point at the dedicated
 *      tracetxn-smoke database. Refuse to run if it doesn't.
 *   2. Connect to Mongo and drop the database, every run starts clean.
 *   3. Seed deterministic fixtures: admin user, staff user, settings doc.
 *   4. Write the credentials to a tmp file the tests read.
 *
 * Runs ONCE per test run, before Playwright spawns the webServer.
 *
 * Implementation note: this file deliberately avoids importing anything
 * from `src/server` or `src/lib`. Playwright's TS loader doesn't always
 * transpile ESM imports inside ad-hoc dynamic imports, so we go direct
 * to Mongoose + bcrypt and reproduce the minimal schema we need. The
 * real app still uses its own connection + models at runtime.
 */

const CREDS_FILE = path.resolve(process.cwd(), "reports/.smoke-creds.json");
const SETTINGS_KEY = "default";

const DEFAULT_CANCELLATION_POLICY = [
  "Cancellations made more than 24 hours before pick-up are eligible for a full refund.",
  "Cancellations made within 24 hours of pick-up forfeit the deposit.",
  "Modification fees (date or vehicle changes) are non-refundable once paid.",
  "Refunds are processed within 5-10 business days to the original payment method.",
  "To request a refund, reply to this email or contact our support team using the details below.",
].join("\n");

export default async function globalSetup() {
  loadEnvFile(".env.smoke");

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri?.includes("tracetxn-smoke")) {
    throw new Error(
      `[smoke] Refusing to run, MONGODB_URI must point at tracetxn-smoke (got ${uri}).`,
    );
  }

  await mongoose.connect(uri, {
    dbName,
    serverSelectionTimeoutMS: 10_000,
  });

  const db = mongoose.connection.db;
  if (!db) throw new Error("[smoke] Mongo connection has no db handle");

  // Hard reset: drop every collection so the previous run's audit
  // trail, orders, users, etc. don't bleed across runs.
  const existing = await db.collections();
  for (const c of existing) {
    await c.deleteMany({});
  }

  const adminPassword = "AdminPass1234";
  const staffPassword = "StaffPass1234";

  const now = new Date();
  const admin = {
    _id: new mongoose.Types.ObjectId(),
    name: "Smoke Admin",
    email: "admin@smoke.tracetxn.test",
    passwordHash: await bcrypt.hash(adminPassword, 12),
    role: "ADMIN",
    status: "ACTIVE",
    createdBy: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };

  const staff = {
    _id: new mongoose.Types.ObjectId(),
    name: "Smoke Staff",
    email: "staff@smoke.tracetxn.test",
    passwordHash: await bcrypt.hash(staffPassword, 12),
    role: "STAFF",
    status: "ACTIVE",
    createdBy: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection("users").insertMany([admin, staff]);
  await db.collection("users").createIndex(
    { email: 1 },
    { unique: true, name: "email_unique" },
  );

  await db.collection("settings").updateOne(
    { key: SETTINGS_KEY },
    {
      $set: {
        key: SETTINGS_KEY,
        paymentExpiryHours: 24,
        orderPrefix: "SMK",
        defaultCurrency: "USD",
        supportEmail: "support@smoke.tracetxn.test",
        supportPhone: "+15555550100",
        successRedirectUrl: `${process.env.APP_URL}/pay/success`,
        cancelRedirectUrl: `${process.env.APP_URL}/pay/cancelled`,
        cancellationPolicy: DEFAULT_CANCELLATION_POLICY,
        cancellationPolicyVersion: "v1",
        updatedAt: now,
        createdAt: now,
      },
    },
    { upsert: true },
  );

  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(
    CREDS_FILE,
    JSON.stringify(
      {
        admin: {
          id: String(admin._id),
          email: admin.email,
          password: adminPassword,
          role: admin.role,
        },
        staff: {
          id: String(staff._id),
          email: staff.email,
          password: staffPassword,
          role: staff.role,
        },
        webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
        baseUrl: process.env.APP_URL ?? "http://127.0.0.1:3100",
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}
