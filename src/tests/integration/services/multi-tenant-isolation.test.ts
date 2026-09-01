import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { Order, Provider } from "@/server/db/models";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { createSettings } from "@/tests/factories/settings.factory";
import { ensureMongo } from "@/tests/utils/db";
import {
  addMembership,
  disableMembership,
  seedSecondOrganization,
  seedTestOrganization,
} from "@/tests/utils/organization";
import { _nextHeadersState } from "@/tests/utils/next-headers";
import {
  validCreateOrderInput,
  validCruiseOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * TWO ORGANIZATIONS, ONE DATABASE, ONE SHARED USER POOL.
 *
 * This is the production shape: Himanshu (car rental, the compatibility
 * anchor holding all pre-migration history) and RCR Cruise (flights and
 * cruises, a second tenant) live in the same `himanshu-payops` database and
 * draw on the same `users` collection. Nothing here may be provable by
 * inspection alone — every assertion goes through the real service layer.
 *
 * What these tests exist to prevent, in order of severity:
 *   - one tenant reading or mutating the other's orders
 *   - a second tenant inheriting the incumbent's unattributed history
 *   - a user with no membership being served anything at all
 *   - one tenant's suppliers appearing in the other's catalog
 *   - one tenant's customers being sent to the other's domain
 */

const RCR_SLUG = "rcrsecond";

let himanshuId = "";
let rcrId = "";
let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;

/** A user is just a user — there is exactly one pool. Membership is what
 *  makes them a member of a tenant. */
const dualUser = actorFor(UserRole.ADMIN, { email: "dual@payops.test" });
const himanshuOnly = actorFor(UserRole.ADMIN, { email: "him@payops.test" });
const rcrOnly = actorFor(UserRole.ADMIN, { email: "rcr@payops.test" });
const orphan = actorFor(UserRole.SUPER_ADMIN, { email: "orphan@payops.test" });

const { createOrder, getOrderById, listOrders } = await import(
  "@/server/services/order.service"
);
const { listActiveProviders, listProviders } = await import(
  "@/server/services/provider.service"
);

beforeEach(async () => {
  await ensureMongo();
  await createSettings();

  // Himanshu: the incumbent. Holds isDefault and therefore the right to see
  // unattributed pre-migration rows.
  himanshuId = await seedTestOrganization({
    serviceTypes: [ServiceType.CAR_RENTAL],
  });
  // RCR Cruise: the second tenant. NEVER the anchor.
  rcrId = await seedSecondOrganization({
    slug: RCR_SLUG,
    brandName: "RCR Cruise",
    serviceTypes: [ServiceType.FLIGHT, ServiceType.CRUISE],
    appUrl: "https://rcrcruise.example",
    emailCc: "support@rcrcruise.example",
  });

  // RCR's own cruise supplier, restricted to RCR — both guards at once.
  await Provider.create({
    key: "RCRCRUISELINE",
    name: "RCR Cruise Line",
    logo: "/providers/_placeholder.svg",
    primaryColor: "#003DA5",
    onPrimaryColor: "#FFFFFF",
    tagline: "RCR only",
    serviceTypes: [ServiceType.CRUISE],
    organizationIds: [Provider.base.Types.ObjectId.createFromHexString(rcrId)],
    status: RecordState.ACTIVE,
    sortOrder: 200,
  });

  await addMembership(himanshuId, dualUser.id);
  await addMembership(rcrId, dualUser.id);
  await addMembership(himanshuId, himanshuOnly.id);
  await addMembership(rcrId, rcrOnly.id);
  // `orphan` deliberately gets NO membership anywhere.
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  vi.unstubAllEnvs();
});

/**
 * Sign in as `user` with `orgId` selected, the way the console does.
 *
 * The selection is written straight into the mocked cookie jar rather than
 * through the switch route, so these tests exercise the RESOLVER's handling
 * of an arbitrary cookie value — including the case where it names an
 * organization the user may not use.
 */
async function actAs(user: typeof dualUser, orgId?: string) {
  sessionMock?.restore();
  sessionMock = await mockSession(user);
  const { orgCookieName } = await import("@/server/auth/org-cookie");
  const jar = _nextHeadersState().cookies;
  if (orgId) jar.set(orgCookieName(), orgId);
  else jar.delete(orgCookieName());
}

/**
 * An order owned by whichever organization is selected, of the kind that
 * organization actually sells.
 *
 * The service-type allow-list is a real guard — Himanshu sells car rental and
 * RCR Cruise sells flights and cruises — so a fixture that ignored it would
 * only pass by disabling a security control these tests depend on.
 */
async function createOrderFor(user: typeof dualUser, orgId: string) {
  await actAs(user, orgId);
  const input =
    orgId === rcrId
      ? validCruiseOrderInput({ provider: "RCRCRUISELINE" })
      : validCreateOrderInput();
  const { order } = await createOrder(input, { actor: user });
  return order;
}

/* ══════════════════════ order isolation ══════════════════════ */

describe("orders are isolated between organizations", () => {
  it("stamps an order with the SELECTED organization, not the first one found", async () => {
    const order = await createOrderFor(dualUser, rcrId);
    const raw = await Order.findById(order.id).lean<{
      organizationId?: unknown;
    }>();
    expect(String(raw?.organizationId)).toBe(rcrId);
  });

  it("hides one tenant's order from the other tenant's list", async () => {
    const himanshuOrder = await createOrderFor(dualUser, himanshuId);

    await actAs(dualUser, rcrId);
    const rcrList = await listOrders(
      { state: "ACTIVE", page: 1, pageSize: 50 },
      { actor: dualUser },
    );
    expect(rcrList.items.map((o) => o.id)).not.toContain(himanshuOrder.id);
  });

  it("refuses a direct fetch of another tenant's order by id", async () => {
    const himanshuOrder = await createOrderFor(dualUser, himanshuId);

    await actAs(rcrOnly, rcrId);
    // NotFound, not Forbidden — a different status would let a caller probe
    // which order ids exist in other organizations.
    await expect(
      getOrderById(himanshuOrder.id, { actor: rcrOnly }),
    ).rejects.toThrow(/not found/i);
  });

  it("lets the owning tenant read its own order normally", async () => {
    const order = await createOrderFor(dualUser, himanshuId);
    await actAs(himanshuOnly, himanshuId);
    const found = await getOrderById(order.id, { actor: himanshuOnly });
    expect(found.id).toBe(order.id);
  });
});

/* ══════════════════ unattributed history ══════════════════ */

describe("pre-migration history belongs to the anchor alone", () => {
  it("shows an unattributed order to Himanshu but NOT to RCR Cruise", async () => {
    // Exactly what the live database contains: rows written before the
    // organizationId column was stamped everywhere.
    const order = await createOrderFor(dualUser, himanshuId);
    await Order.collection.updateOne(
      { _id: Order.base.Types.ObjectId.createFromHexString(order.id) },
      { $unset: { organizationId: "" } },
    );

    await actAs(dualUser, himanshuId);
    const himanshuList = await listOrders(
      { state: "ACTIVE", page: 1, pageSize: 50 },
      { actor: dualUser },
    );
    expect(himanshuList.items.map((o) => o.id)).toContain(order.id);

    await actAs(dualUser, rcrId);
    const rcrList = await listOrders(
      { state: "ACTIVE", page: 1, pageSize: 50 },
      { actor: dualUser },
    );
    expect(rcrList.items.map((o) => o.id)).not.toContain(order.id);
  });

  it("refuses RCR Cruise a direct fetch of an unattributed order", async () => {
    const order = await createOrderFor(dualUser, himanshuId);
    await Order.collection.updateOne(
      { _id: Order.base.Types.ObjectId.createFromHexString(order.id) },
      { $unset: { organizationId: "" } },
    );

    await actAs(rcrOnly, rcrId);
    await expect(
      getOrderById(order.id, { actor: rcrOnly }),
    ).rejects.toThrow(/not found/i);
  });
});

/* ══════════════════ membership authorization ══════════════════ */

describe("membership is authoritative", () => {
  it("lets a dual-member user act in BOTH organizations", async () => {
    const a = await createOrderFor(dualUser, himanshuId);
    const b = await createOrderFor(dualUser, rcrId);

    await actAs(dualUser, himanshuId);
    expect((await getOrderById(a.id, { actor: dualUser })).id).toBe(a.id);

    await actAs(dualUser, rcrId);
    expect((await getOrderById(b.id, { actor: dualUser })).id).toBe(b.id);
  });

  it("IGNORES a cookie naming an organization the user does not belong to", async () => {
    const himanshuOrder = await createOrderFor(dualUser, himanshuId);

    // rcrOnly forges a selection of Himanshu. The cookie is a hint; the
    // membership row is the authority.
    await actAs(rcrOnly, himanshuId);
    await expect(
      getOrderById(himanshuOrder.id, { actor: rcrOnly }),
    ).rejects.toThrow(/not found/i);
  });

  it("serves NOTHING to a user with no membership anywhere — even SUPER_ADMIN", async () => {
    // A global role must not conjure membership. This is the deliberate
    // divergence from the `main` worktree, where ADMIN/SUPER_ADMIN reach
    // every organization implicitly — here that would mean any admin
    // credential reaches another brand's live Stripe account.
    await createOrderFor(dualUser, himanshuId);

    await actAs(orphan);
    const list = await listOrders(
      { state: "ACTIVE", page: 1, pageSize: 50 },
      { actor: orphan },
    );
    expect(list.total).toBe(0);
    expect(list.items).toEqual([]);
  });

  it("revokes access immediately when a membership is DISABLED", async () => {
    const order = await createOrderFor(dualUser, rcrId);

    await disableMembership(rcrId, rcrOnly.id);
    await actAs(rcrOnly, rcrId);
    await expect(
      getOrderById(order.id, { actor: rcrOnly }),
    ).rejects.toThrow(/not found/i);
  });
});

/* ══════════════════ provider isolation ══════════════════ */

describe("supplier catalogs do not leak between organizations", () => {
  beforeEach(async () => {
    await Provider.create([
      {
        key: "RCRAIR",
        name: "RCR Airways",
        logo: "/providers/_placeholder.svg",
        primaryColor: "#0078D2",
        onPrimaryColor: "#FFFFFF",
        tagline: "RCR only",
        serviceTypes: [ServiceType.FLIGHT],
        organizationIds: [Provider.base.Types.ObjectId.createFromHexString(rcrId)],
        status: RecordState.ACTIVE,
        sortOrder: 100,
      },
      {
        key: "SHAREDSUP",
        name: "Shared Supplier",
        logo: "/providers/_placeholder.svg",
        primaryColor: "#000000",
        onPrimaryColor: "#FFFFFF",
        tagline: "available to all",
        serviceTypes: [ServiceType.CAR_RENTAL],
        // Empty = every organization, which is how every pre-tenancy row
        // behaves. This is the non-regression case.
        organizationIds: [],
        status: RecordState.ACTIVE,
        sortOrder: 1,
      },
    ]);
  });

  it("keeps an RCR-restricted supplier out of Himanshu's catalog", async () => {
    await actAs(dualUser, himanshuId);
    const keys = (await listActiveProviders()).map((p) => p.key);
    expect(keys).not.toContain("RCRAIR");
  });

  it("shows the RCR-restricted supplier to RCR Cruise", async () => {
    await actAs(dualUser, rcrId);
    const keys = (
      await listActiveProviders(ServiceType.FLIGHT)
    ).map((p) => p.key);
    expect(keys).toContain("RCRAIR");
  });

  it("keeps an UNRESTRICTED supplier visible to both — the non-regression case", async () => {
    await actAs(dualUser, himanshuId);
    expect((await listActiveProviders()).map((p) => p.key)).toContain(
      "SHAREDSUP",
    );

    await actAs(dualUser, rcrId);
    const rcrKeys = (
      await listProviders({ status: RecordState.ACTIVE, organizationId: rcrId })
    ).map((p) => p.key);
    expect(rcrKeys).toContain("SHAREDSUP");
  });
});

/* ══════════════════ customer-facing URLs ══════════════════ */

describe("customer-facing URLs follow the order's own brand", () => {
  it("builds RCR Cruise return URLs from the RCR domain, not the deployment's", async () => {
    const { resolveAppUrl } = await import(
      "@/server/auth/organization-config"
    );
    expect(await resolveAppUrl(rcrId)).toBe("https://rcrcruise.example");
  });

  it("falls back to APP_URL for an organization with no own domain", async () => {
    const { resolveAppUrl } = await import(
      "@/server/auth/organization-config"
    );
    // Himanshu sets none, so it keeps the deployment URL exactly as today.
    expect(await resolveAppUrl(himanshuId)).toBe(
      (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
    );
  });

  it("copies each brand's own support inbox, never the other's", async () => {
    const { resolveEmailCc } = await import(
      "@/server/auth/organization-config"
    );
    expect(await resolveEmailCc(rcrId)).toBe("support@rcrcruise.example");
    // Himanshu sets none → the deployment-wide value, unchanged behaviour.
    const himanshuCc = await resolveEmailCc(himanshuId);
    expect(himanshuCc).not.toBe("support@rcrcruise.example");
  });
});

/* ══════════════════ payment credential isolation ══════════════════ */

describe("payment credentials are resolved per organization", () => {
  it("reads each organization's OWN Stripe env credentials", async () => {
    // `ORG_<SLUG>_STRIPE_*` is namespaced by slug, so the two tenants can
    // never reach each other's merchant account.
    vi.stubEnv(`ORG_${RCR_SLUG.toUpperCase()}_STRIPE_SECRET_KEY`, "sk_rcr");
    vi.stubEnv(`ORG_${RCR_SLUG.toUpperCase()}_STRIPE_WEBHOOK_SECRET`, "whsec_rcr");

    const { getGatewayForOrganization } = await import(
      "@/server/payments/resolve-gateway"
    );
    const gw = await getGatewayForOrganization(rcrId, {
      kind: "pinned",
      provider: PaymentGatewayKey.STRIPE,
    });
    expect(gw.key).toBe(PaymentGatewayKey.STRIPE);
  });

  it("refuses a non-default organization with NO credentials rather than falling back", async () => {
    // The env fallback belongs to the compatibility anchor alone. A second
    // tenant with no keys must FAIL LOUDLY — silently charging through the
    // incumbent's merchant account is the worst outcome in this codebase.
    const noCreds = await seedSecondOrganization({
      slug: "nocreds",
      brandName: "No Creds",
    });
    const { getGatewayForOrganization } = await import(
      "@/server/payments/resolve-gateway"
    );
    await expect(
      getGatewayForOrganization(noCreds, {
        kind: "pinned",
        provider: PaymentGatewayKey.STRIPE,
      }),
    ).rejects.toThrow(/credentials/i);
  });

  it("refuses PayPal for an organization that has not enabled it", async () => {
    const { getGatewayForOrganization } = await import(
      "@/server/payments/resolve-gateway"
    );
    await expect(
      getGatewayForOrganization(rcrId, {
        kind: "pinned",
        provider: PaymentGatewayKey.PAYPAL,
      }),
    ).rejects.toThrow(/not enabled/i);
  });
});
