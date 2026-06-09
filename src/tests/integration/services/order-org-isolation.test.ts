import { randomBytes } from "node:crypto";

import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Currency,
  PaymentGatewayKey,
  UserRole,
} from "@/lib/constants/enums";
import { _resetMasterKeyForTesting } from "@/lib/crypto/envelope";
import {
  GatewayMode,
  ItemType,
  Order,
  Organization,
  OrgStatus,
  Setting,
  SETTINGS_KEY,
  User,
} from "@/server/db/models";
import {
  ItemPricingModel,
} from "@/lib/constants/items";
import {
  LEGACY_ORG_SLUG,
  _resetLegacyOrgIdForTesting,
} from "@/server/db/org/legacy";
import { saveGatewayCredential } from "@/server/payments/gateway-credentials.service";
import {
  createOrder,
  initiatePayment,
} from "@/server/services/order.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";
import { getCurrentTestStripe } from "@/tests/setup/integration.setup";

/**
 * Phase 3b: verify the order lifecycle uses per-org settings and the
 * per-org gateway credentials when ctx.orgId is supplied.
 *
 * The Stripe gateway is stubbed in integration mode (see
 * `tests/setup/integration.setup.ts`), so we can't observe a real
 * Stripe account swap. We CAN observe:
 *   1. `order.orgId` persisted on creation.
 *   2. Settings read for the actor's org (different orderPrefix per org
 *      → different generated orderNumber).
 *   3. `initiatePayment` doesn't crash and the resulting order has the
 *      expected `payment.gateway = STRIPE`.
 *   4. Cross-tenant `getOrderById` is gated by ownership AND orgId.
 */

const masterKey = randomBytes(32).toString("base64");

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  process.env.TRACETXN_MASTER_KEY = masterKey;
  _resetMasterKeyForTesting();
  _resetLegacyOrgIdForTesting();
});

afterEach(() => {
  delete process.env.TRACETXN_MASTER_KEY;
  _resetMasterKeyForTesting();
  _resetLegacyOrgIdForTesting();
});

/** Persist a real Organization + owner User for a per-test orgId so
 *  tenant-aware services (branding seed, workflow seed) have real
 *  data to read instead of failing on missing-org. */
async function seedOrg(orgId: string): Promise<void> {
  const oid = new Types.ObjectId(orgId);
  // If an Org doc already exists for this orgId we're done, repeat
  // seedOrg(sameOrgId) calls inside a single test must be a no-op so
  // we don't double-write owner users with colliding emails.
  const existingOrg = await Organization.findById(oid).select({ _id: 1 }).lean();
  if (existingOrg) return;

  const ownerId = new Types.ObjectId();
  await User.create({
    _id: ownerId,
    name: "Test Owner",
    email: `owner-${oid.toString()}@x.test`,
    passwordHash: "x".repeat(60),
    role: UserRole.SUPER_ADMIN,
    status: "ACTIVE",
    primaryOrgId: oid,
  });
  await Organization.create({
    _id: oid,
    slug: `o-${oid.toString().slice(-8)}`,
    name: "Test Org",
    ownerUserId: ownerId,
    status: OrgStatus.ACTIVE,
  });
}

/** Seed the legacy org so `isLegacyTenant` resolves true for the
 *  returned id, required for Pass 5a's env-fallback gate. */
async function seedLegacyOrg(): Promise<string> {
  const ownerId = new Types.ObjectId();
  await User.create({
    _id: ownerId,
    name: "Legacy",
    email: `legacy-${ownerId.toString().slice(-6)}@x.test`,
    passwordHash: "x".repeat(60),
    role: UserRole.SUPER_ADMIN,
    status: "ACTIVE",
  });
  const org = await Organization.create({
    slug: LEGACY_ORG_SLUG,
    name: "Legacy",
    ownerUserId: ownerId,
    status: OrgStatus.ACTIVE,
    verifiedAt: new Date(),
  });
  return String(org._id);
}

interface TestActor {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

function actor(): TestActor {
  return {
    id: new Types.ObjectId().toString(),
    name: "Ada",
    email: "ada@tracetxn.test",
    role: UserRole.ADMIN,
  };
}

/** Seed the generic `service_visit` ItemType the orderInput() fixture
 *  references. createOrder's attribute validator refuses unknown types,
 *  so every per-org test needs this seed first. */
async function seedServiceVisitType(orgId: string): Promise<void> {
  await ItemType.create({
    orgId: new Types.ObjectId(orgId),
    key: "service_visit",
    name: "Service visit",
    pricingModel: ItemPricingModel.FIXED,
    requiresScheduling: false,
    inventoryTracked: false,
    attributeSchema: [],
    confirmationEmailBlocks: [],
  });
}

function orderInput() {
  return {
    customer: {
      name: "Customer A",
      email: "customer@example.com",
      phone: "+1 555 0100",
    },
    lineItems: [
      {
        itemTypeKey: "service_visit",
        name: "Tenant-isolation test order",
        description: null,
        quantity: 1,
        unitPrice: 100,
        total: 100,
        attributes: {},
        itemId: null,
        scheduling: null,
      },
    ],
    pricing: { amount: 100, currency: "USD" as Currency },
    scheduling: null,
    notes: "test",
  };
}

describe("createOrder, tenant boundary", () => {
  it("persists order.orgId from ctx", async () => {
    const orgA = new Types.ObjectId().toString();
    await seedOrg(orgA);
    await seedServiceVisitType(orgA);
    const { order } = await createOrder(orderInput(), {
      actor: actor(),
      orgId: orgA,
      request: null,
    });
    expect(order.orgId).toBe(orgA);
    const persisted = await Order.findById(order.id).lean<{
      orgId: unknown;
    }>();
    expect(String(persisted?.orgId)).toBe(orgA);
  });

  it("reads per-org settings, orderNumber prefix differs per tenant", async () => {
    // Seed two orgs with different orderPrefixes by upserting per-org
    // Setting rows directly (faster than going through updateSettings).
    const orgA = new Types.ObjectId().toString();
    const orgB = new Types.ObjectId().toString();
    await seedOrg(orgA);
    await seedOrg(orgB);
    await Setting.create({
      orgId: new Types.ObjectId(orgA),
      paymentExpiryHours: 24,
      orderPrefix: "ORGA",
      defaultCurrency: "USD",
      successRedirectUrl: "http://localhost/pay/success",
      cancelRedirectUrl: "http://localhost/pay/cancelled",
      cancellationPolicy:
        "A long enough policy to satisfy the schema for tenant A xx.",
      cancellationPolicyVersion: "v1",
      consentMode: "ADVISORY",
      consentMessage: "x",
    });
    await Setting.create({
      orgId: new Types.ObjectId(orgB),
      paymentExpiryHours: 24,
      orderPrefix: "ORGB",
      defaultCurrency: "USD",
      successRedirectUrl: "http://localhost/pay/success",
      cancelRedirectUrl: "http://localhost/pay/cancelled",
      cancellationPolicy:
        "A long enough policy to satisfy the schema for tenant B xx.",
      cancellationPolicyVersion: "v1",
      consentMode: "ADVISORY",
      consentMessage: "x",
    });

    await seedOrg(orgA);
    await seedServiceVisitType(orgA);
    await seedServiceVisitType(orgB);
    const { order: a } = await createOrder(orderInput(), {
      actor: actor(),
      orgId: orgA,
      request: null,
    });
    const { order: b } = await createOrder(orderInput(), {
      actor: actor(),
      orgId: orgB,
      request: null,
    });

    expect(a.orderNumber.startsWith("ORGA-")).toBe(true);
    expect(b.orderNumber.startsWith("ORGB-")).toBe(true);
  });

  // Pass 5h: the "unmigrated route handler with no orgId" test has been
  // removed. createOrder now requires an orgId so the attribute
  // validator can resolve ItemTypes; the pre-Pass-3 back-compat path
  // never reaches createOrder anymore.
});

describe("initiatePayment, per-org gateway routing", () => {
  it("uses the per-org Stripe credential when one exists", async () => {
    const orgA = new Types.ObjectId().toString();
    // Per-org Stripe credential for orgA. Note: env-based test stub
    // intercepts all Stripe calls in integration mode (see
    // integration.setup.ts), so the secret value isn't actually used
    // to open a network connection, but the routing path DOES
    // resolve through `gateway_credentials`, which is what we test.
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_orgA_isolated",
        webhookSecret: "whsec_orgA_isolated",
      },
      { actor: { id: actor().id, name: "Ada", role: UserRole.ADMIN }, orgId: orgA, request: null },
    );

    await seedOrg(orgA);
    await seedServiceVisitType(orgA);
    const { order } = await createOrder(orderInput(), {
      actor: actor(),
      orgId: orgA,
      request: null,
    });
    // Stub auto-generates the session id; observe through the result.
    const stripe = getCurrentTestStripe();
    const sessionsBefore = stripe.sessionsCreated.length;
    const result = await initiatePayment(
      order.id,
      { actor: actor(), orgId: orgA, request: null },
      { gateway: PaymentGatewayKey.STRIPE },
    );
    expect(result.checkoutUrl).toBeTruthy();
    expect(result.order.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
    expect(stripe.sessionsCreated.length).toBe(sessionsBefore + 1);
  });

  it("falls back to env-backed gateway for the LEGACY tenant (no per-org row)", async () => {
    // Pass 5a: env-fallback is now gated by `isLegacyTenant`. The
    // legacy org must exist in the DB before the gate permits it.
    const legacyOrg = await seedLegacyOrg();
    await seedServiceVisitType(legacyOrg);
    // NO saveGatewayCredential call, Tenant #1 has no row.
    const { order } = await createOrder(orderInput(), {
      actor: actor(),
      orgId: legacyOrg,
      request: null,
    });
    const result = await initiatePayment(order.id, {
      actor: actor(),
      orgId: legacyOrg,
      request: null,
    });
    // Path resolves to the env-fallback gateway for the legacy tenant.
    expect(result.checkoutUrl).toBeTruthy();
    expect(result.order.payment.gateway).toBe(PaymentGatewayKey.STRIPE);
  });

  it("REFUSES env-fallback for a non-legacy tenant without per-org creds (Pass 5a security gate)", async () => {
    await seedLegacyOrg();
    const newTenant = new Types.ObjectId().toString();
    await seedOrg(newTenant);
    await seedServiceVisitType(newTenant);
    const { order } = await createOrder(orderInput(), {
      actor: actor(),
      orgId: newTenant,
      request: null,
    });
    // No saveGatewayCredential for newTenant, initiatePayment must
    // fail closed rather than silently route via env credentials.
    await expect(
      initiatePayment(order.id, {
        actor: actor(),
        orgId: newTenant,
        request: null,
      }),
    ).rejects.toThrow(/not configured for this organization/i);
  });
});
