 
/**
 * End-to-end user-story exercise — runs against the configured
 * MongoDB (`.env.local`). Drives the same services the API routes
 * call, with a Stripe stub injected so no real charges happen.
 *
 * Story (matches the "first customer" flow):
 *   1. SaaS owner creates the first workspace (signup)
 *   2. Connects Stripe (saves encrypted gateway credentials)
 *   3. Defines a rental_booking ItemType
 *   4. Saves a catalog Item under that type
 *   5. Adds the same customer twice to test the saved-customer
 *      prefill (Pass 6d behavior)
 *   6. Creates a paid order against that catalog item
 *   7. Generates a Stripe checkout session (initiatePayment)
 *   8. Stub flips session → paid; reconciles → order PAID
 *   9. Loads the evidence chain end-to-end
 *  10. Verifies the chain has every expected event with valid hashes
 *
 * Prints PASS/FAIL per step + final summary. Exits non-zero on any
 * failure so this can be wired into CI.
 *
 * Cleans up after itself (deletes its test org's data).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

function loadEnv(file: string): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$/i.exec(line);
      if (!m || m[1].startsWith("#")) continue;
      if (!(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch {
    /* ignore */
  }
}

loadEnv(".env.local");
// Force integration test mode so the Stripe stub is used (no
// network calls against real Stripe).
process.env.TRACETXN_TEST_MODE = "integration";
// Reset cached env-derived master key (envelope cache is module-
// level). The signup flow needs encryption available.
if (!process.env.TRACETXN_MASTER_KEY) {
  process.env.TRACETXN_MASTER_KEY = randomBytes(32).toString("base64");
}

// Imports must come AFTER env setup since env is parsed eagerly.
import mongoose, { Types } from "mongoose";

import { Currency, OrderStatus, PaymentGatewayKey, UserRole } from "@/lib/constants/enums";
import { ItemPricingModel, SchedulingType } from "@/lib/constants/items";
import { _resetMasterKeyForTesting } from "@/lib/crypto/envelope";
import {
  AuditLog,
  GatewayMode,
  ItemType,
  Setting,
  User,
} from "@/server/db/models";
import { createItem } from "@/server/services/item.service";
import {
  createOrder,
  initiatePayment,
  reconcileOrderPayment,
} from "@/server/services/order.service";
import { saveGatewayCredential } from "@/server/payments/gateway-credentials.service";
import { getEvidenceChain } from "@/server/services/evidence.service";
import { setStripeForTesting } from "@/server/payments/stripe";
import { createStripeStub } from "@/tests/mocks/stripe-stub";
import {
  findCustomerByEmail,
  upsertCustomerFromOrder,
} from "@/server/services/customer.service";

interface StepResult {
  step: string;
  status: "PASS" | "FAIL";
  note?: string;
}

const results: StepResult[] = [];

function pass(step: string, note?: string): void {
  results.push({ step, status: "PASS", note });
  console.log(`  ✓ ${step}${note ? ` · ${note}` : ""}`);
}
function fail(step: string, note: string): void {
  results.push({ step, status: "FAIL", note });
  console.log(`  ✗ ${step} · ${note}`);
}

async function main() {
  console.log("\n──── TraceTxn end-to-end user story ────\n");

  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB;
  if (!uri) throw new Error("MONGODB_URI not set");
  await mongoose.connect(uri, dbName ? { dbName } : undefined);
  console.log(`Connected to ${dbName ?? "(default)"}\n`);

  // Reset the envelope's cached master key (lazy-init at module load)
  // so the freshly-set env var is picked up.
  _resetMasterKeyForTesting();

  // Inject the Stripe stub so initiatePayment doesn't hit real Stripe.
  const stripe = createStripeStub({
    successBaseUrl: process.env.APP_URL ?? "http://localhost:3000",
  });
  setStripeForTesting(stripe.asStripe());

  const runId = randomBytes(4).toString("hex");
  const orgId = new Types.ObjectId().toString();
  const ownerEmail = `userstory-${runId}@tracetxn.test`;

  // Step 1: workspace (User + Setting) — signup_test style
  const ownerId = new Types.ObjectId();
  try {
    // User model doesn't carry orgId/orgIds on its schema — that
    // lives on OrgMember. For the user-story we just need a User
    // doc the actor.id can reference.
    await User.create({
      _id: ownerId,
      name: "User Story Owner",
      email: ownerEmail,
      passwordHash: "$2b$12$" + "x".repeat(53),
      role: UserRole.SUPER_ADMIN,
      state: "ACTIVE",
    } as never);
    await Setting.create({
      orgId: new Types.ObjectId(orgId),
      paymentExpiryHours: 24,
      orderPrefix: "ORD",
      defaultCurrency: "USD",
      successRedirectUrl: "http://localhost:3000/pay/success",
      cancelRedirectUrl: "http://localhost:3000/pay/cancelled",
      cancellationPolicy:
        "Cancel within 24h of booking start for a full refund.",
      cancellationPolicyVersion: "v1",
      consentMode: "ADVISORY",
      consentMessage: "I agree to proceed with this booking.",
    });
    pass("1. Workspace created", `orgId=${orgId.slice(-8)}`);
  } catch (err) {
    fail("1. Workspace created", String(err));
    return finish();
  }

  const actor = {
    id: String(ownerId),
    name: "User Story Owner",
    email: ownerEmail,
    role: UserRole.SUPER_ADMIN,
  };

  // Step 2: connect Stripe (per-org encrypted credentials)
  try {
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_userstory",
        webhookSecret: "whsec_userstory",
      },
      { actor, orgId, request: null },
    );
    pass("2. Stripe credential saved (encrypted)");
  } catch (err) {
    fail("2. Stripe credential saved", String(err));
    return finish();
  }

  // Step 3: define ItemType
  try {
    await ItemType.create({
      orgId: new Types.ObjectId(orgId),
      key: "rental_booking",
      name: "Rental booking",
      pricingModel: ItemPricingModel.FIXED,
      requiresScheduling: true,
      inventoryTracked: false,
      attributeSchema: [],
      confirmationEmailBlocks: [],
    });
    pass("3. ItemType defined", "rental_booking");
  } catch (err) {
    fail("3. ItemType defined", String(err));
    return finish();
  }

  // Step 4: save a catalog Item
  let itemId: string;
  try {
    const item = await createItem(
      {
        itemTypeKey: "rental_booking",
        name: "Toyota Camry XLE 2025",
        basePrice: { amount: 249.99, currency: Currency.USD },
        sku: "TC-XLE-2025",
        attributes: {},
      },
      { orgId, actorId: actor.id, actorName: actor.name },
    );
    itemId = item.id;
    pass("4. Catalog item created", `id=${itemId.slice(-8)}`);
  } catch (err) {
    fail("4. Catalog item created", String(err));
    return finish();
  }

  // Step 5: customer prefill (Pass 6d) — upsert twice, second should
  // increment ordersCount and overwrite name/phone with the latest input.
  const customerEmail = "talia.berenson@example.com";
  try {
    await upsertCustomerFromOrder(
      orgId,
      { name: "Talia M. Berenson", email: customerEmail, phone: "+15555550100" },
      { countAsOrder: true },
    );
    const found1 = await findCustomerByEmail(orgId, customerEmail);
    if (!found1) throw new Error("first upsert: customer not found");
    if (found1.ordersCount !== 1) throw new Error(`expected ordersCount=1, got ${found1.ordersCount}`);
    pass("5a. Customer record created", `ordersCount=${found1.ordersCount}`);

    await upsertCustomerFromOrder(
      orgId,
      { name: "T. Berenson", email: customerEmail, phone: "+15555550200" },
      { countAsOrder: true },
    );
    const found2 = await findCustomerByEmail(orgId, customerEmail);
    if (!found2) throw new Error("second upsert: customer not found");
    if (found2.ordersCount !== 2) throw new Error(`expected ordersCount=2, got ${found2.ordersCount}`);
    if (found2.name !== "T. Berenson") throw new Error(`name not updated: ${found2.name}`);
    pass("5b. Customer prefill: upsert idempotent + latest-wins", `ordersCount=${found2.ordersCount}, name="${found2.name}"`);
  } catch (err) {
    fail("5. Customer prefill", String(err));
    return finish();
  }

  // Step 6: create order against the catalog item
  const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const endsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  let orderId: string;
  try {
    const { order } = await createOrder(
      {
        customer: {
          name: "Talia M. Berenson",
          email: customerEmail,
          phone: "+15555550100",
        },
        lineItems: [
          {
            itemId,
            itemTypeKey: "rental_booking",
            name: "Toyota Camry XLE 2025",
            description: null,
            quantity: 1,
            unitPrice: 249.99,
            total: 249.99,
            attributes: {},
            scheduling: null,
          },
        ],
        pricing: { amount: 249.99, currency: Currency.USD },
        scheduling: {
          type: SchedulingType.FIXED_WINDOW,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
        notes: "User-story exercise",
      },
      { actor, orgId, request: null },
    );
    orderId = order.id;
    if (order.status !== OrderStatus.NOT_INITIATED) {
      throw new Error(`expected NOT_INITIATED, got ${order.status}`);
    }
    pass("6. Order created", `id=${orderId.slice(-8)}, status=${order.status}`);
  } catch (err) {
    fail("6. Order created", String(err));
    return finish();
  }

  // Step 7: initiatePayment → generates a Stripe checkout session
  let sessionId: string | null = null;
  try {
    const result = await initiatePayment(orderId, { actor, orgId });
    if (result.order.status !== OrderStatus.LINK_GENERATED) {
      throw new Error(`expected LINK_GENERATED, got ${result.order.status}`);
    }
    sessionId = result.order.payment.paymentSessionId;
    if (!sessionId) throw new Error("no sessionId on order");
    pass("7. Payment link generated", `sessionId=${sessionId.slice(-12)}`);
  } catch (err) {
    fail("7. Payment link generated", String(err));
    return finish();
  }

  // Step 8: flip stub session to paid + reconcile
  try {
    const session = stripe.sessionsCreated[0]!.result as unknown as {
      status: string;
      payment_status: string;
      amount_total: number | null;
    };
    session.status = "complete";
    session.payment_status = "paid";
    session.amount_total = Math.round(249.99 * 100);

    const result = await reconcileOrderPayment(orderId, { actor, orgId });
    if (!result.changed) throw new Error("reconcile reported changed=false");
    if (result.order.status !== OrderStatus.PAID) {
      throw new Error(`expected PAID, got ${result.order.status}`);
    }
    pass("8. Order reconciled to PAID");
  } catch (err) {
    fail("8. Order reconciled to PAID", String(err));
    return finish();
  }

  // Step 9: load evidence chain
  let eventCount = 0;
  try {
    const chain = await getEvidenceChain(orderId, { actor, orgId });
    eventCount = chain.events.length;
    if (eventCount === 0) throw new Error("evidence chain is empty");
    if (!chain.verification.valid) {
      const seqs = chain.events.map((e) => `${e.sequence}:${e.eventType}`).join(", ");
      const broken = chain.events.find(
        (e) => e.sequence === chain.verification.brokenAtSequence,
      );
      if (broken) {
        const { canonicalJSON } = await import("@/lib/crypto/canonical");
        const { sha256 } = await import("@/lib/crypto/hash-chain");
        const recomputed = sha256(canonicalJSON(broken.payload));
        console.log("    DEBUG stored snapshotHash:    ", broken.snapshotHash);
        console.log("    DEBUG recomputed snapshotHash:", recomputed);
        console.log(
          "    DEBUG payload (first 600 chars):",
          JSON.stringify(broken.payload).slice(0, 600),
        );
      }
      throw new Error(
        `chain integrity broken at seq=${chain.verification.brokenAtSequence} (${chain.verification.reason}) · events: ${seqs}`,
      );
    }
    if (chain.order.id !== orderId) {
      throw new Error(`evidence order id mismatch: ${chain.order.id} vs ${orderId}`);
    }
    pass("9. Evidence chain loaded", `${eventCount} events, integrity=VALID`);

    // Verify expected event types are present
    const expected: string[] = ["ORDER_CREATED", "PAYMENT_LINK_GENERATED"];
    const actualTypes = new Set<string>(chain.events.map((e) => e.eventType));
    const missing = expected.filter((t) => !actualTypes.has(t));
    if (missing.length > 0) {
      throw new Error(`missing expected event types: ${missing.join(", ")}`);
    }
    pass("10. Expected event types present", [...actualTypes].join(", "));
  } catch (err) {
    fail("9/10. Evidence chain", String(err));
  }

  // Step 11: audit log captured the lifecycle
  try {
    const audits = await AuditLog.find({
      entityId: orderId,
    }).lean();
    if (audits.length === 0) throw new Error("no audit rows for order");
    pass("11. Audit log written", `${audits.length} rows`);
  } catch (err) {
    fail("11. Audit log", String(err));
  }

  await finish();

  async function finish() {
    // Cleanup
    try {
      const db = mongoose.connection.db;
      if (db) {
        const orgFilter = { orgId: new Types.ObjectId(orgId) };
        for (const c of [
          "orders",
          "order_evidence",
          "customers",
          "items",
          "item_types",
          "audit_logs",
          "gateway_credentials",
          "settings",
          "users",
        ]) {
          if (c === "users") {
            await db.collection(c).deleteMany({ _id: ownerId });
          } else {
            await db.collection(c).deleteMany(orgFilter);
          }
        }
      }
    } catch (err) {
      console.log(`  cleanup error: ${err instanceof Error ? err.message : err}`);
    }

    await mongoose.disconnect();

    const passed = results.filter((r) => r.status === "PASS").length;
    const failed = results.filter((r) => r.status === "FAIL").length;
    console.log(`\n──── Summary ────`);
    console.log(`  ${passed} passed · ${failed} failed`);
    if (failed > 0) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
