/* eslint-disable no-console */
/**
 * Seed the GlobeVista organization (customer brand: FlightBizz).
 *
 * Run (reports only, writes nothing):
 *   npm run seed:globevista
 *
 * Apply for real:
 *   SEED_GLOBEVISTA_APPLY=true npm run seed:globevista
 *
 * Knobs (env vars):
 *   SEED_GLOBEVISTA_APPLY    "true" to write. Anything else = dry run.
 *   GLOBEVISTA_DOMAIN        primary domain for the brand (optional).
 *   GLOBEVISTA_MEMBER_EMAILS comma-separated operator emails to grant
 *                            membership. Each is matched against an
 *                            EXISTING user; unknown addresses are reported
 *                            and skipped, never created.
 *
 * WHY THIS IS A SEPARATE SCRIPT AND NOT `seed:orgs` WITH A DIFFERENT SLUG:
 *
 *   `scripts/seed-organizations.ts` hardcodes `isDefault: true` and grants
 *   EVERY user in the database a membership. Pointing it at a second slug
 *   would therefore (a) create a SECOND default organization — and the
 *   partial unique index that is supposed to prevent that may not exist in
 *   production, which runs autoIndex:false — making
 *   `Organization.findOne({ isDefault: true })` non-deterministic and
 *   handing GlobeVista ownership of RentalConfirmation's unattributed
 *   history; and (b) give every incumbent operator access to a tenant they
 *   have no business seeing. Both are unacceptable, so this script exists.
 *
 * Properties:
 *   idempotent      the organization is upserted by slug with `$setOnInsert`
 *                   ONLY, and with `timestamps: false` so not even
 *                   `updatedAt` moves. A re-run writes nothing at all and
 *                   never clobbers a value an admin has since edited in
 *                   the UI. Running it twice cannot create two GlobeVista
 *                   organizations — `slug` is uniquely indexed and the
 *                   upsert matches on it.
 *   non-destructive nothing is deleted; no existing organization, user,
 *                   provider, setting or order is modified.
 *   secret-free     it NEVER writes a credential. It reports only whether
 *                   each expected env var is PRESENT — never its value.
 */

import type { Types } from "mongoose";

import { connectMongo, disconnectMongo } from "../src/server/db/mongoose";
import {
  Organization,
  OrganizationMember,
  User,
} from "../src/server/db/models";
import {
  CaptureMode,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
} from "../src/lib/constants/enums";

const APPLY = process.env.SEED_GLOBEVISTA_APPLY === "true";

// Read for the two derived values below. The SECRET key is used ONLY to
// derive the sandbox flag from its prefix — never logged, never stored,
// never echoed. The publishable key is safe to persist by definition.
const SECRET_KEY = (process.env.ORG_GLOBEVISTA_STRIPE_SECRET_KEY ?? "").trim();
const PUBLISHABLE_KEY = (
  process.env.ORG_GLOBEVISTA_STRIPE_PUBLISHABLE_KEY ?? ""
).trim();

/** Internal, operations-facing organization name. Never shown to customers. */
const ORG_NAME = "GlobeVista";
/** The ONLY name a GlobeVista customer ever sees. */
const BRAND_NAME = "FlightBizz";
const SLUG = "globevista";

/**
 * Credentials and sender identity are read from the environment at request
 * time by `resolve-gateway.ts` and `email/identity.ts` — they are looked up
 * dynamically off `process.env`, so no change to `src/lib/env.ts` is needed
 * or wanted. This script only REPORTS which are set.
 */
const EXPECTED_ENV_KEYS = [
  "ORG_GLOBEVISTA_STRIPE_SECRET_KEY",
  "ORG_GLOBEVISTA_STRIPE_WEBHOOK_SECRET",
  "ORG_GLOBEVISTA_STRIPE_PUBLISHABLE_KEY",
  "ORG_GLOBEVISTA_EMAIL_FROM",
  "ORG_GLOBEVISTA_EMAIL_FROM_NAME",
  "ORG_GLOBEVISTA_EMAIL_REPLY_TO",
  "ORG_GLOBEVISTA_SMTP_HOST",
  "ORG_GLOBEVISTA_SMTP_PORT",
  "ORG_GLOBEVISTA_SMTP_SECURE",
  "ORG_GLOBEVISTA_SMTP_USER",
  "ORG_GLOBEVISTA_SMTP_PASSWORD",
] as const;

function envPresence(): { key: string; present: boolean }[] {
  return EXPECTED_ENV_KEYS.map((key) => ({
    key,
    present: Boolean(process.env[key]?.trim()),
  }));
}

async function main() {
  console.log(
    `→ Seeding organization "${ORG_NAME}" (brand "${BRAND_NAME}", slug ${SLUG})${
      APPLY ? "" : " (dry run — set SEED_GLOBEVISTA_APPLY=true to write)"
    }`,
  );

  await connectMongo();

  // PARANOIA CHECK. If some other organization already holds isDefault and
  // this run were ever to produce a second one, `findOne({ isDefault: true })`
  // — which the webhook cross-tenant guard depends on — becomes
  // non-deterministic. We never set isDefault below, but assert the invariant
  // loudly rather than trusting an index that may not exist in production.
  const defaults = await Organization.find({ isDefault: true })
    .select("slug")
    .lean<{ slug: string }[]>();
  if (defaults.length > 1) {
    throw new Error(
      `Refusing to run: ${defaults.length} organizations already have isDefault=true (${defaults
        .map((d) => d.slug)
        .join(", ")}). Fix that first.`,
    );
  }
  if (defaults.length === 1) {
    console.log(`  • existing default organization: ${defaults[0]!.slug} (untouched)`);
  }

  const existing = await Organization.findOne({ slug: SLUG })
    .select("_id name brandName")
    .lean<{ _id: Types.ObjectId; name: string; brandName: string } | null>();

  const desired = {
    slug: SLUG,
    name: ORG_NAME,
    brandName: BRAND_NAME,
    domain: (process.env.GLOBEVISTA_DOMAIN ?? "").trim().toLowerCase(),
    status: RecordState.ACTIVE,
    // NEVER true. GlobeVista must not become the compatibility anchor for
    // unattributed historical records, and must not be the fallback any
    // other tenant's payment can land on.
    isDefault: false,
    branding: {
      logo: "",
      primaryColor: "#0E7490",
      onPrimaryColor: "#FFFFFF",
      footerTagline: "",
    },
    support: { email: "", phone: "" },
    email: {
      // The customer-facing sender name is the BRAND, not the internal
      // organization name. A FlightBizz customer must never see "GlobeVista".
      fromName: BRAND_NAME,
      fromEmail: "",
      replyTo: "",
      transport: { host: "", port: 587, secure: false, user: "" },
    },
    payments: {
      provider: PaymentGatewayKey.STRIPE,
      enabledProviders: [PaymentGatewayKey.STRIPE],
      // Stored for operator visibility only — it records WHICH Stripe
      // account this brand is on. Nothing in the Stripe path reads it:
      // checkout is gateway-hosted, there is no Stripe.js on the client,
      // and resolve-gateway only consults this field on the PayPal branch
      // as a clientId fallback. Safe by definition (publishable keys are
      // designed to be public), which is why it lives on the document
      // rather than in the credential vault.
      publishableKey: PUBLISHABLE_KEY,
      // Derived from the SECRET key's prefix, the same way
      // seed-organizations.ts derives it. Hardcoding false would mislead
      // the admin UI into showing "live" for a test-mode setup — which is
      // exactly the confusion the flag exists to prevent.
      sandbox:
        SECRET_KEY.startsWith("sk_test") || SECRET_KEY.startsWith("rk_test"),
      // THE load-bearing value. Authorize at checkout, capture only once an
      // operator confirms the booking.
      captureMode: CaptureMode.MANUAL,
    },
    serviceTypes: [
      ServiceType.FLIGHT,
      ServiceType.HOTEL,
      ServiceType.CAR_RENTAL,
    ],
    legal: {
      termsAndConditions: "",
      termsVersion: "",
      cancellationPolicy: "",
      cancellationPolicyVersion: "",
    },
  };

  console.log("  • resolved configuration:");
  console.log(`    – internal name   ${desired.name}`);
  console.log(`    – customer brand  ${desired.brandName}`);
  console.log(`    – slug            ${desired.slug}`);
  console.log(`    – isDefault       ${desired.isDefault}`);
  console.log(`    – domain          ${desired.domain || "(unset)"}`);
  console.log(`    – provider        ${desired.payments.provider}`);
  console.log(
    `    – enabled         [${desired.payments.enabledProviders.join(", ")}]`,
  );
  console.log(`    – capture mode    ${desired.payments.captureMode}`);
  console.log(`    – service types   [${desired.serviceTypes.join(", ")}]`);

  console.log("  • expected environment keys (presence only, values never printed):");
  for (const { key, present } of envPresence()) {
    console.log(`    – ${present ? "SET    " : "MISSING"} ${key}`);
  }
  console.log(
    `  • webhook endpoint to register in FlightBizz's Stripe dashboard:\n    <APP_URL>/api/webhooks/stripe/${SLUG}`,
  );
  console.log(
    "  • required Stripe events: checkout.session.completed, checkout.session.expired,",
  );
  console.log(
    "    payment_intent.amount_capturable_updated, payment_intent.succeeded,",
  );
  console.log(
    "    payment_intent.canceled, payment_intent.payment_failed, charge.refunded,",
  );
  console.log("    charge.dispute.created/updated/closed/funds_withdrawn");
  console.log(
    "    (without amount_capturable_updated, authorizations are never recorded)",
  );

  if (existing) {
    console.log(
      `  • organization "${SLUG}" already exists (${String(existing._id)}) — it will be LEFT AS IS`,
    );
  } else {
    console.log(`  • organization "${SLUG}" would be CREATED`);
  }

  // MEMBERSHIP MODE.
  //
  // Default is ALL EXISTING USERS, matching how `seed-organizations.ts`
  // seeds the default organization: one operations team works every brand
  // on this deployment, so a new tenant that nobody could see would be
  // useless. Membership grants VISIBILITY — the ability to switch into
  // GlobeVista and work its orders.
  //
  // What it does NOT grant is the ability to move money: capture and
  // release are gated on ORDER_CAPTURE_PAYMENT / ORDER_VOID_AUTHORIZATION,
  // which are ADMIN and above, so a STAFF agent who gains visibility here
  // still cannot charge or release a FlightBizz authorization.
  //
  // Set GLOBEVISTA_MEMBER_EMAILS to a comma-separated list to restrict
  // membership to specific operators instead.
  const memberEmails = (process.env.GLOBEVISTA_MEMBER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const grantAllUsers = memberEmails.length === 0;
  if (grantAllUsers) {
    const userCount = await User.countDocuments({ status: RecordState.ACTIVE });
    console.log(
      `  • members: ALL ${userCount} active users (no GLOBEVISTA_MEMBER_EMAILS set) — every existing RentalConfirmation / TripReservations operator will be able to switch into FlightBizz`,
    );
  } else {
    console.log(`  • members requested: ${memberEmails.join(", ")}`);
  }

  if (!APPLY) {
    console.log("  • dry run: no writes made");
    await disconnectMongo();
    return;
  }

  // `$setOnInsert` ONLY — a re-run must never clobber edits made in the
  // admin UI after the first seed. This is also what makes the script safe
  // to run repeatedly: the second run matches the existing slug and writes
  // nothing.
  const org = await Organization.findOneAndUpdate(
    { slug: SLUG },
    { $setOnInsert: desired },
    {
      upsert: true,
      returnDocument: "after",
      setDefaultsOnInsert: true,
      // `timestamps: false` makes a re-run a TRUE no-op. Mongoose's
      // `timestamps: true` on the schema appends `$set: { updatedAt }` to
      // every findOneAndUpdate — including one whose only operator is
      // `$setOnInsert` — so without this the second run rewrites
      // `updatedAt` and an operator auditing "when was this tenant last
      // changed" sees the last deploy rather than the last real edit.
      // `createdAt` is still set on insert, because $setOnInsert carries
      // the document itself.
      timestamps: false,
    },
  ).lean<{ _id: Types.ObjectId } | null>();

  if (!org) throw new Error("Upsert returned no organization");
  const orgId = org._id;
  console.log(`  ✓ organization ready (${String(orgId)})`);

  // Resolve the target users: every ACTIVE user by default, or just the
  // named allow-list when GLOBEVISTA_MEMBER_EMAILS is set. Each keeps the
  // role they already hold — this grants no privilege a user did not
  // already have, only the ability to see a second tenant.
  let created = 0;
  let already = 0;
  let missing = 0;
  const targets: { _id: Types.ObjectId; role: string }[] = grantAllUsers
    ? await User.find({ status: RecordState.ACTIVE })
        .select("_id role")
        .lean<{ _id: Types.ObjectId; role: string }[]>()
    : [];

  if (!grantAllUsers) {
    for (const email of memberEmails) {
      const user = await User.findOne({ email })
        .select("_id role")
        .lean<{ _id: Types.ObjectId; role: string } | null>();
      if (!user) {
        console.log(`    – no such user, skipped: ${email}`);
        missing += 1;
        continue;
      }
      targets.push(user);
    }
  }

  for (const user of targets) {
    const res = await OrganizationMember.updateOne(
      { organizationId: orgId, userId: user._id },
      {
        $setOnInsert: {
          organizationId: orgId,
          userId: user._id,
          role: user.role,
          status: RecordState.ACTIVE,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount > 0) created += 1;
    else already += 1;
  }
  console.log(
    `  ✓ memberships created ${created}, already present ${already}, unknown emails ${missing}`,
  );

  console.log("");
  console.log("  NEXT STEPS (none of which this script performs):");
  console.log(
    "   1. Set the ORG_GLOBEVISTA_* environment values listed above in the deployment.",
  );
  console.log(
    "   2. Register the webhook endpoint + events in FlightBizz's own Stripe account.",
  );
  console.log(
    "   3. Set the organization's support email/phone and legal text in the admin UI,",
  );
  console.log(
    "      or FlightBizz customers will be shown no support contact and the deployment's",
  );
  console.log("      car-rental terms.");
  console.log(
    "   4. Run `npm run indexes:audit` — production runs autoIndex:false.",
  );
  console.log("✔ GlobeVista seed complete.");

  await disconnectMongo();
}

main().catch(async (err) => {
  console.error("GlobeVista seed failed:", err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
