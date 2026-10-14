/**
 * Switch an organization's Stripe payments between charge-at-checkout
 * (AUTOMATIC) and authorize-then-capture (MANUAL) — the setting behind the
 * order page's "Capture payment" / "Release hold" controls.
 *
 * Run (reports only, writes nothing):
 *   ORG_SLUG=rentalconfirmation CAPTURE_MODE=MANUAL \
 *     npx tsx --env-file=.env.payops.local scripts/set-organization-capture-mode.ts
 *
 * Apply for real:
 *   APPLY=1 ORG_SLUG=rentalconfirmation CAPTURE_MODE=MANUAL \
 *     npx tsx --env-file=.env.payops.local scripts/set-organization-capture-mode.ts
 *
 * Knobs (env vars):
 *   ORG_SLUG         the organization's slug. Required; an unknown slug is
 *                    refused.
 *   CAPTURE_MODE     AUTOMATIC or MANUAL. Required; any other value is
 *                    refused — nothing is guessed.
 *   APPLY            "1" to write. Anything else = dry run.
 *   ALLOW_AUTOMATIC  "1" to confirm switching a MANUAL organization back to
 *                    AUTOMATIC (see "Switching back" below).
 *
 * WHY THIS IS A SCRIPT:
 *
 *   `payments.captureMode` has no admin screen, and the only code that
 *   ever wrote it is `scripts/seed-globevista.ts`, which sets it once, when
 *   it CREATES GlobeVista. An existing organization — Rental Confirmation,
 *   TripReservations — could only be switched by a hand-written database
 *   update with no dry run, no guard and no read-back. Everything else is
 *   already data-driven: link generation reads the ORDER's organization's
 *   mode on every new link (`getOrganizationCaptureMode`, uncached), and the
 *   capture, release and webhook code acts on the mode each order froze.
 *
 * What MANUAL changes, for the organization's NEW payment links only:
 *   - the Stripe Checkout session authorizes the card instead of charging
 *     it; the order shows "Card authorized — needs capture to take the
 *     money", and the customer gets the "card authorized — not yet charged"
 *     email;
 *   - an ADMIN or SUPER_ADMIN takes the money with "Capture payment" (the
 *     receipt email follows), or lets it go with "Release hold";
 *   - an uncaptured hold lapses after about 7 days (Stripe);
 *   - PayPal links, where enabled, are unaffected: manual capture is
 *     Stripe-only.
 * Orders already paid, and links already generated, are untouched.
 *
 * Switching back (MANUAL → AUTOMATIC) needs ALLOW_AUTOMATIC=1: orders
 * already on the manual lifecycle keep it — every live hold still needs
 * Capture or Release — and regenerating the link of one that is still
 * awaiting authorization leaves its manual capture state in place.
 *
 * Properties:
 *   idempotent  a run that changes nothing writes nothing.
 *   guarded     the write matches the mode exactly as it was read, so a
 *               change made meanwhile aborts this one rather than being
 *               overwritten.
 *   narrow      it writes `payments.captureMode` and nothing else — no
 *               order, gateway, credential, legal text or member is
 *               touched.
 */

import mongoose, { type Types } from "mongoose";

import { env } from "../src/lib/env";
import { Order, Organization } from "../src/server/db/models";
import {
  CaptureMode,
  OrderStatus,
  PaymentCaptureStatus,
} from "../src/lib/constants/enums";
import {
  MANUAL_CAPTURE_STRIPE_EVENTS,
  enabledGateways,
  parseCaptureMode,
  planCaptureMode,
  stripeWebhookPath,
} from "../src/lib/organization-capture-mode";

const APPLY = process.env.APPLY === "1";
const ALLOW_AUTOMATIC = process.env.ALLOW_AUTOMATIC === "1";
const SLUG = (process.env.ORG_SLUG ?? "").trim().toLowerCase();

interface OrgRow {
  _id: Types.ObjectId;
  slug: string;
  brandName: string;
  status: string;
  isDefault?: boolean;
  payments?: {
    provider?: string | null;
    enabledProviders?: string[] | null;
    captureMode?: unknown;
  } | null;
}

/**
 * Connect WITHOUT building indexes or creating collections. The app's
 * shared connectMongo() turns autoIndex on whenever NODE_ENV is not
 * "production" — run from a laptop against the production database, that
 * would start building every index the models declare (and create every
 * missing collection) before even a dry run had read the organization.
 * This script reads, and with APPLY=1 updates, one field of one document;
 * nothing else.
 */
async function connectReadOnlySchema(): Promise<void> {
  const { MONGODB_URI, MONGODB_DB } = env.server;
  await mongoose.connect(MONGODB_URI, {
    dbName: MONGODB_DB,
    bufferCommands: false,
    serverSelectionTimeoutMS: 10_000,
    autoIndex: false,
    autoCreate: false,
  });
}

/** How the switch lands on the organization's existing orders. */
async function reportOrders(org: OrgRow, after: CaptureMode): Promise<void> {
  // The default organization also owns every order stored without one.
  const owned = org.isDefault
    ? { $or: [{ organizationId: org._id }, { organizationId: null }] }
    : { organizationId: org._id };
  const count = (filter: Record<string, unknown>) =>
    Order.countDocuments({ $and: [owned, filter] });

  const notInitiated = await count({ status: OrderStatus.NOT_INITIATED });
  const openAutomatic = await count({
    status: { $in: [OrderStatus.LINK_GENERATED, OrderStatus.PAYMENT_PENDING] },
    "payment.capture": null,
  });
  const liveManual = await count({
    "payment.capture.method": CaptureMode.MANUAL,
    "payment.capture.status": {
      $in: [
        PaymentCaptureStatus.PENDING_AUTHORIZATION,
        PaymentCaptureStatus.AUTHORIZED,
        PaymentCaptureStatus.CAPTURE_PENDING,
        PaymentCaptureStatus.CAPTURE_FAILED,
      ],
    },
    status: { $ne: OrderStatus.PAID },
  });

  console.log("  • existing orders:");
  console.log(
    `    – ${notInitiated} not yet initiated: their first payment link uses ${after}`,
  );
  if (after === CaptureMode.MANUAL) {
    console.log(
      `    – ${openAutomatic} with an open charge-at-checkout link: that link keeps charging at checkout. Don't regenerate these until it has expired`,
    );
  } else {
    console.log(
      `    – ${liveManual} still on the manual lifecycle: each keeps it and still needs Capture or Release`,
    );
  }
  console.log("    – paid orders: unchanged");
}

async function main() {
  // Every input is checked BEFORE the database is touched.
  if (!SLUG) {
    throw new Error("Set ORG_SLUG to the organization's slug.");
  }
  const requested = parseCaptureMode(process.env.CAPTURE_MODE);

  console.log(
    `→ Setting the capture mode of organization "${SLUG}" to ${requested}${
      APPLY ? "" : " (dry run — set APPLY=1 to write)"
    }`,
  );

  await connectReadOnlySchema();

  const org = await Organization.findOne({ slug: SLUG })
    .select("_id slug brandName status isDefault payments")
    .lean<OrgRow | null>();
  if (!org) {
    const known = await Organization.find({})
      .select("slug")
      .lean<{ slug: string }[]>();
    throw new Error(
      `No organization with slug "${SLUG}". Known slugs: ${
        known.map((o) => o.slug).join(", ") || "(none)"
      }.`,
    );
  }
  // A `$set` on "payments.captureMode" cannot write through a stored null.
  if (!org.payments || typeof org.payments !== "object") {
    throw new Error(
      `Organization "${SLUG}" stores no payments settings object — refusing to write.`,
    );
  }

  const stored = org.payments.captureMode;
  const plan = planCaptureMode({
    stored,
    requested,
    payments: org.payments,
    allowAutomatic: ALLOW_AUTOMATIC,
  });

  console.log(
    `  • organization   ${org.brandName} (${org.slug}, ${String(org._id)}, ${org.status}${
      org.isDefault ? ", default" : ""
    })`,
  );
  console.log(
    `  • stored         ${
      stored === undefined || stored === null
        ? "(none stored — reads as AUTOMATIC)"
        : String(stored)
    }`,
  );
  console.log(`  • before         ${plan.before}`);
  console.log(`  • after          ${plan.after}`);
  console.log(`  • gateways       ${enabledGateways(org.payments).join(", ")}`);
  if (plan.unaffectedGateways.length > 0) {
    console.log(
      `    – ${plan.unaffectedGateways.join(", ")} links keep charging at checkout: manual capture is Stripe-only`,
    );
  }
  await reportOrders(org, plan.after);

  if (plan.after === CaptureMode.MANUAL) {
    console.log(
      `  • Stripe webhook endpoint (this organization's Stripe account): <APP_URL>${stripeWebhookPath(org)}`,
    );
    console.log("    It must be subscribed to:");
    for (const event of MANUAL_CAPTURE_STRIPE_EVENTS) {
      console.log(`      ${event}`);
    }
    console.log(
      "    payment_intent.canceled is the only way the app learns that an uncaptured hold has expired.",
    );
    console.log(
      "    payment_intent.payment_failed is not limited to manual capture: if the endpoint is not",
    );
    console.log(
      "    subscribed to it already, adding it also marks a charge-at-checkout order FAILED when a",
    );
    console.log("    card is declined at checkout. Add it deliberately.");
  }

  if (!plan.changes) {
    console.log("  • nothing to change: no writes made");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log("  • dry run: no writes made");
    await mongoose.disconnect();
    return;
  }

  // Guarded: matches only while the mode is still exactly what was read
  // above — absent / null for an organization that never stored one.
  const unchangedSinceRead =
    stored === undefined || stored === null
      ? {
          $or: [
            { "payments.captureMode": { $exists: false } },
            { "payments.captureMode": null },
          ],
        }
      : { "payments.captureMode": stored };
  const res = await Organization.updateOne(
    { _id: org._id, ...unchangedSinceRead },
    { $set: { "payments.captureMode": plan.after } },
    { runValidators: true },
  );
  if (res.matchedCount === 0) {
    throw new Error(
      "The organization's capture mode changed while this ran — nothing was written. Re-run to see the current value.",
    );
  }

  const written = await Organization.findById(org._id)
    .select("payments.captureMode")
    .lean<{ payments?: { captureMode?: string } } | null>();
  console.log(`  ✓ stored ${written?.payments?.captureMode ?? "(none)"}`);
  console.log("✔ Organization capture mode updated.");

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(
    "set-organization-capture-mode failed:",
    err instanceof Error ? err.message : err,
  );
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
