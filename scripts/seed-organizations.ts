/* eslint-disable no-console */
/**
 * Create the default organization from the values this deployment is
 * ALREADY running on, and give every existing user a membership of it.
 *
 * Run (reports only, writes nothing):
 *   tsx --env-file=.env.local scripts/seed-organizations.ts
 *
 * Apply for real:
 *   SEED_ORGS_APPLY=true tsx --env-file=.env.local scripts/seed-organizations.ts
 *
 * Knobs (env vars):
 *   SEED_ORGS_APPLY   "true" to write. Anything else = dry run.
 *   SEED_ORGS_SLUG    slug for the default organization.
 *                     Defaults to "rentalconfirmation".
 *
 * DRY RUN IS THE DEFAULT, which is deliberately the opposite of
 * `backfill-order-providers.ts`. That script's worst case is a re-stamped
 * provider snapshot; this one seeds the tenant every existing record will
 * be attributed to, so the safe default is to make an operator opt in.
 *
 * Idempotent and non-destructive:
 *   - the organization is upserted by slug using `$setOnInsert` only, so a
 *     re-run never overwrites values an admin has since edited in the UI
 *   - memberships are created only where absent
 *   - nothing is deleted, no collection is dropped, no existing document
 *     outside these two new collections is modified
 *
 * What it deliberately does NOT do:
 *   - it does not write any credential into the vault. Stripe and SMTP
 *     secrets stay exactly where they are (env) and keep being used from
 *     there. Moving them is a separate, explicit step — this script must be
 *     safe to run without touching production secrets.
 *   - it does not flip any resolver over to organization values. Creating
 *     these rows changes no behaviour; the readers are switched on in
 *     later phases.
 */

import type { Types } from "mongoose";

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import {
  Branding,
  Organization,
  OrganizationMember,
  Setting,
  User,
} from "../src/server/db/models";

const APPLY = process.env.SEED_ORGS_APPLY === "true";
const SLUG = (process.env.SEED_ORGS_SLUG ?? "rentalconfirmation")
  .trim()
  .toLowerCase();

/**
 * Split an RFC-5322-ish `EMAIL_FROM` into display name and address.
 * "Rental Confirmation <no-reply@x.com>" -> both parts.
 * "no-reply@x.com"                       -> address only.
 */
function parseFrom(raw: string): { fromName: string; fromEmail: string } {
  const value = (raw ?? "").trim();
  const angled = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    return {
      fromName: angled[1]!.replace(/^"|"$/g, "").trim(),
      fromEmail: angled[2]!.trim().toLowerCase(),
    };
  }
  return { fromName: "", fromEmail: value.toLowerCase() };
}

/** Host portion of APP_URL, used as the organization's domain. */
function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

async function main() {
  console.log(
    `→ Seeding default organization slug=${SLUG}${APPLY ? "" : " (dry run — pass SEED_ORGS_APPLY=true to write)"}`,
  );

  await connectMongo();

  // Read the CURRENT deployment values. `Branding.findOne` deliberately,
  // NOT the branding service's getBranding(): that helper upserts the
  // document as a side effect of reading it, and a reporting run must not
  // mutate anything.
  const branding = await Branding.findOne({}).lean<{
    brandName?: string;
    supportEmail?: string;
    supportPhone?: string;
    logo?: string;
    primaryColor?: string;
    footerTagline?: string;
  } | null>();
  const setting = await Setting.findOne({}).lean<{
    defaultCurrency?: string;
  } | null>();

  if (!branding) {
    console.log(
      "  • no branding document found — falling back to environment values",
    );
  }
  if (!setting) {
    console.log("  • no settings document found (not required)");
  }

  const from = parseFrom(process.env.EMAIL_FROM ?? "");
  const brandName =
    branding?.brandName?.trim() ||
    process.env.CUSTOMER_BRAND_NAME?.trim() ||
    "Rental Confirmation";
  const secretKey = process.env.STRIPE_SECRET_KEY ?? "";

  const desired = {
    slug: SLUG,
    name: brandName,
    brandName,
    domain: hostOf(process.env.APP_URL ?? ""),
    status: "ACTIVE",
    isDefault: true,
    branding: {
      logo: branding?.logo ?? "",
      primaryColor: branding?.primaryColor ?? "#0B1220",
      onPrimaryColor: "#FFFFFF",
      footerTagline: branding?.footerTagline ?? "",
    },
    support: {
      email: (
        branding?.supportEmail ??
        process.env.SUPPORT_EMAIL ??
        ""
      ).toLowerCase(),
      phone: branding?.supportPhone ?? process.env.SUPPORT_PHONE ?? "",
    },
    email: {
      fromName: from.fromName || brandName,
      fromEmail: from.fromEmail,
      replyTo: (process.env.EMAIL_REPLY_TO ?? "").toLowerCase(),
      transport: {
        host: process.env.SMTP_HOST ?? "",
        port: Number(process.env.SMTP_PORT ?? 587) || 587,
        secure: process.env.SMTP_SECURE === "true",
        user: process.env.SMTP_USER ?? "",
      },
    },
    payments: {
      provider: "STRIPE",
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
      // Best-effort: Stripe test keys are prefixed. Only a hint for the UI.
      sandbox: secretKey.startsWith("sk_test"),
    },
  };

  console.log("  • resolved organization configuration:");
  console.log(`    – brandName      ${desired.brandName}`);
  console.log(`    – domain         ${desired.domain || "(unset)"}`);
  console.log(
    `    – from           ${desired.email.fromName} <${desired.email.fromEmail || "(unset)"}>`,
  );
  console.log(`    – replyTo        ${desired.email.replyTo || "(none)"}`);
  console.log(
    `    – smtp           ${desired.email.transport.host || "(unset)"}:${desired.email.transport.port}`,
  );
  console.log(
    `    – payments       ${desired.payments.provider}${desired.payments.sandbox ? " (sandbox key)" : ""}`,
  );
  console.log(`    – currency       ${setting?.defaultCurrency ?? "(default)"}`);

  const existing = await Organization.findOne({ slug: SLUG }).lean<{
    _id: unknown;
  } | null>();
  const userCount = await User.countDocuments({});

  if (existing) {
    console.log(`  • organization "${SLUG}" already exists — leaving it as is`);
  } else {
    console.log(`  • organization "${SLUG}" would be CREATED`);
  }
  console.log(`  • users needing a membership: checked below (${userCount} total)`);

  if (!APPLY) {
    console.log("  • dry run: no writes made");
    await disconnectMongo();
    return;
  }

  // `$setOnInsert` only — a re-run must never clobber edits made in the
  // admin UI after the first seed.
  const org = await Organization.findOneAndUpdate(
    { slug: SLUG },
    { $setOnInsert: desired },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
    },
  ).lean<{ _id: Types.ObjectId } | null>();

  if (!org) throw new Error("Upsert returned no organization");
  const orgId = org._id;
  console.log(`  ✓ organization ready (${String(orgId)})`);

  // Every existing user keeps working exactly as before by becoming a
  // member of the default organization with their current global role.
  const users = await User.find({}, { _id: 1, role: 1 }).lean<
    { _id: Types.ObjectId; role: string }[]
  >();
  let created = 0;
  let skipped = 0;
  for (const u of users) {
    const res = await OrganizationMember.updateOne(
      { organizationId: orgId, userId: u._id },
      {
        $setOnInsert: {
          organizationId: orgId,
          userId: u._id,
          role: u.role,
          status: "ACTIVE",
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount > 0) created += 1;
    else skipped += 1;
  }
  console.log(`  ✓ memberships created ${created}, already present ${skipped}`);

  console.log("✔ Organization seed complete.");
  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("Organization seed failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
