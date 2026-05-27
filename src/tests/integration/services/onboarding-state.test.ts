import { randomBytes } from "node:crypto";

import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Currency,
  OrderStatus,
  PaymentGatewayKey,
  RecordState,
  UserRole,
} from "@/lib/constants/enums";
import { _resetMasterKeyForTesting } from "@/lib/crypto/envelope";
import {
  Branding,
  GatewayMode,
  Order,
  Organization,
  OrgMember,
  OrgStatus,
  User,
} from "@/server/db/models";
import { LEGACY_ORG_SLUG, _resetLegacyOrgIdForTesting } from "@/server/db/org/legacy";
import { saveGatewayCredential } from "@/server/payments/gateway-credentials.service";
import { getOnboardingState } from "@/server/services/onboarding-state.service";
import { ensureMongo, resetDatabase } from "@/tests/utils/db";

const masterKey = randomBytes(32).toString("base64");

beforeEach(async () => {
  await ensureMongo();
  await resetDatabase();
  process.env.PAYOPS_MASTER_KEY = masterKey;
  _resetMasterKeyForTesting();
  _resetLegacyOrgIdForTesting();
});

afterEach(() => {
  delete process.env.PAYOPS_MASTER_KEY;
  _resetMasterKeyForTesting();
  _resetLegacyOrgIdForTesting();
});

async function makeOrg(opts: { slug?: string } = {}): Promise<string> {
  const ownerId = new Types.ObjectId();
  await User.create({
    _id: ownerId,
    name: "Founder",
    email: `${ownerId.toString().slice(-6)}@x.test`,
    passwordHash: "x".repeat(60),
    role: UserRole.SUPER_ADMIN,
    status: RecordState.ACTIVE,
  });
  const org = await Organization.create({
    slug: opts.slug ?? `test-${ownerId.toString().slice(-6)}`,
    name: "Test Co",
    ownerUserId: ownerId,
    status: OrgStatus.ACTIVE,
  });
  await OrgMember.create({
    orgId: org._id,
    userId: ownerId,
    role: UserRole.SUPER_ADMIN,
    status: RecordState.ACTIVE,
    joinedAt: new Date(),
  });
  return String(org._id);
}

describe("getOnboardingState", () => {
  it("brand-new org: zero steps complete, not legacy, banner shows", async () => {
    const orgId = await makeOrg();
    const state = await getOnboardingState(orgId);
    expect(state.complete).toBe(false);
    expect(state.isLegacy).toBe(false);
    expect(state.steps).toEqual({
      gatewayConfigured: false,
      brandingSet: false,
      firstOrderCreated: false,
      teamMemberAdded: false,
    });
  });

  it("flips gatewayConfigured to true after a credential row is saved", async () => {
    const orgId = await makeOrg();
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_abcdef1234567890",
        webhookSecret: "whsec_test_1234567890ab",
      },
      {
        actor: {
          id: new Types.ObjectId().toString(),
          name: "Ada",
          role: UserRole.SUPER_ADMIN,
        },
        orgId,
        request: null,
      },
    );
    const state = await getOnboardingState(orgId);
    expect(state.steps.gatewayConfigured).toBe(true);
  });

  it("flips brandingSet when a Branding row has a brandName", async () => {
    const orgId = await makeOrg();
    await Branding.create({
      orgId: new Types.ObjectId(orgId),
      brandName: "My Custom Brand",
      supportEmail: "support@x.test",
      supportPhone: "+1-555-0000",
      primaryColor: "#000000",
    });
    const state = await getOnboardingState(orgId);
    expect(state.steps.brandingSet).toBe(true);
  });

  it("flips firstOrderCreated after an order is persisted", async () => {
    const orgId = await makeOrg();
    await Order.create({
      orgId: new Types.ObjectId(orgId),
      orderNumber: "TST-1",
      status: OrderStatus.NOT_INITIATED,
      state: RecordState.ACTIVE,
      customer: { name: "Cx", email: "cx@x.test", phone: "+1" },
      lineItems: [
        {
          itemTypeKey: "service_visit",
          name: "Test order",
          quantity: 1,
          unitPrice: 100,
          total: 100,
          attributes: {},
        },
      ],
      pricing: { amount: 100, currency: "USD" as Currency },
      payment: {
        status: OrderStatus.NOT_INITIATED,
        processedWebhookEventIds: [],
      },
      createdBy: {
        userId: new Types.ObjectId(),
        name: "Ada",
        email: "ada@x.test",
      },
      policy: {
        acceptedAt: new Date(),
        version: "v1",
        text: "Test policy text long enough to satisfy validation.",
      },
    });
    const state = await getOnboardingState(orgId);
    expect(state.steps.firstOrderCreated).toBe(true);
  });

  it("flips teamMemberAdded when a SECOND member joins", async () => {
    const orgId = await makeOrg();
    // Founder already has one member row (from makeOrg). Add a second.
    const secondUserId = new Types.ObjectId();
    await User.create({
      _id: secondUserId,
      name: "Second",
      email: "second@x.test",
      passwordHash: "x".repeat(60),
      role: UserRole.ADMIN,
      status: RecordState.ACTIVE,
    });
    await OrgMember.create({
      orgId: new Types.ObjectId(orgId),
      userId: secondUserId,
      role: UserRole.ADMIN,
      status: RecordState.ACTIVE,
      joinedAt: new Date(),
    });
    const state = await getOnboardingState(orgId);
    expect(state.steps.teamMemberAdded).toBe(true);
  });

  it("complete=true only when ALL required steps done (team optional)", async () => {
    const orgId = await makeOrg();

    // Hydrate the required three. Skip team — it's optional.
    await Branding.create({
      orgId: new Types.ObjectId(orgId),
      brandName: "Brand",
      supportEmail: "s@x.test",
      supportPhone: "+1",
      primaryColor: "#000000",
    });
    await Order.create({
      orgId: new Types.ObjectId(orgId),
      orderNumber: "TST-2",
      status: OrderStatus.NOT_INITIATED,
      state: RecordState.ACTIVE,
      customer: { name: "Cx", email: "cx@x.test", phone: "+1" },
      lineItems: [
        {
          itemTypeKey: "service_visit",
          name: "Test",
          quantity: 1,
          unitPrice: 100,
          total: 100,
          attributes: {},
        },
      ],
      pricing: { amount: 100, currency: "USD" as Currency },
      payment: {
        status: OrderStatus.NOT_INITIATED,
        processedWebhookEventIds: [],
      },
      createdBy: {
        userId: new Types.ObjectId(),
        name: "Ada",
        email: "ada@x.test",
      },
      policy: {
        acceptedAt: new Date(),
        version: "v1",
        text: "Test policy text long enough to satisfy validation.",
      },
    });
    await saveGatewayCredential(
      {
        gateway: PaymentGatewayKey.STRIPE,
        mode: GatewayMode.TEST,
        secretKey: "sk_test_abcdef1234567890",
        webhookSecret: "whsec_test_1234567890ab",
      },
      {
        actor: {
          id: new Types.ObjectId().toString(),
          name: "Ada",
          role: UserRole.SUPER_ADMIN,
        },
        orgId,
        request: null,
      },
    );

    const state = await getOnboardingState(orgId);
    expect(state.complete).toBe(true);
    expect(state.steps.teamMemberAdded).toBe(false); // optional, still false
  });

  it("legacy tenant: always complete (checklist suppressed)", async () => {
    const orgId = await makeOrg({ slug: LEGACY_ORG_SLUG });
    const state = await getOnboardingState(orgId);
    // Even with ZERO steps done, legacy never shows the banner.
    expect(state.isLegacy).toBe(true);
    expect(state.complete).toBe(true);
  });

  it("null orgId: returns a no-op state (no banner)", async () => {
    const state = await getOnboardingState(null);
    expect(state.complete).toBe(true);
    expect(state.isLegacy).toBe(false);
  });

  it("malformed orgId: returns a no-op state without throwing", async () => {
    const state = await getOnboardingState("not-an-objectid");
    expect(state.complete).toBe(true);
  });
});
