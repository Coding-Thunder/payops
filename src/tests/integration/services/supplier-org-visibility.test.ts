import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import {
  AuditAction,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { PROVIDER_SEED, ProviderId } from "@/lib/constants/providers";
import { ValidationError } from "@/lib/errors";
import type { CreateProviderInput } from "@/lib/validation";
import { POST as createOrderRoute } from "@/app/api/orders/route";
import { GET as listProvidersRoute } from "@/app/api/providers/route";
import {
  AuditLog,
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
  Provider,
} from "@/server/db/models";
import { orgCookieName } from "@/server/auth/org-cookie";
import { createOrder } from "@/server/services/order.service";
import {
  buildProviderSnapshotFromKey,
  createProvider,
  listActiveProviders,
  setProviderStatus,
  updateProvider,
} from "@/server/services/provider.service";
import { createSettings } from "@/tests/factories/settings.factory";
import {
  validCreateOrderInput,
  validFlightOrderInput,
  validHotelOrderInput,
} from "@/tests/fixtures/order-input.fixture";
import { buildRequest, jsonBody, type ApiErr } from "@/tests/utils/api";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";

/**
 * Supplier isolation, enforced by the SERVER.
 *
 * An admin can confine a supplier to named organizations (Admin → Providers,
 * "visible to"; empty = every organization). The create form's dropdown has
 * always honoured that (`listProviders`), but `createOrder` built the order's
 * supplier snapshot from whatever key was posted — before it even knew whose
 * order it was — so a crafted request could book a supplier confined to
 * ANOTHER organization. The order now resolves its organization first, and
 * the snapshot refuses such a supplier with a 422 before anything is written.
 *
 * What must NOT change: a supplier available to everyone — every row stored
 * before the field existed, every built-in brand, every supplier added
 * without a restriction — is booked exactly as before, by every
 * organization, for every service; and an unknown key keeps its exact
 * wording. Only the ORGANIZATION is checked, never the service type: the
 * shared fixtures book flights and hotels with the car supplier BUDGET.
 */

const NOT_AVAILABLE = "This supplier is not available to this organization";
const DISABLED = "That provider is currently disabled";

const actor = actorFor(UserRole.ADMIN);
const SERVICES = [
  ServiceType.CAR_RENTAL,
  ServiceType.FLIGHT,
  ServiceType.HOTEL,
] as const;

const BUDGET = PROVIDER_SEED[ProviderId.BUDGET];
/** What every order booking the built-in car supplier has always frozen. */
const BUDGET_SNAPSHOT = {
  id: BUDGET.id,
  name: BUDGET.name,
  logo: BUDGET.logo,
  primaryColor: BUDGET.primaryColor,
  onPrimaryColor: BUDGET.onPrimaryColor,
};

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
/** The default organization — the incumbent brand. */
let alpha: Types.ObjectId;
/** The brand suppliers get confined to. */
let bravo: Types.ObjectId;
/** A third brand, outside a supplier confined to the other two. */
let charlie: Types.ObjectId;

/** An organization selling all three services, so only a supplier's
 *  organization list can ever be the reason an order is refused. */
async function makeOrg(slug: string, isDefault: boolean): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug,
    name: slug,
    brandName: `${slug} brand`,
    isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
    serviceTypes: [...SERVICES],
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: actor.role,
    status: RecordState.ACTIVE,
  });
  return id;
}

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {});
}

/** A valid order of `serviceType` naming the supplier `provider`. A car
 *  rental posts no `serviceType`, exactly as the car form does. */
function inputFor(serviceType: ServiceType, provider: string) {
  switch (serviceType) {
    case ServiceType.FLIGHT:
      return validFlightOrderInput({ provider });
    case ServiceType.HOTEL:
      return validHotelOrderInput({ provider });
    default:
      return validCreateOrderInput({ provider });
  }
}

/** A supplier for every service — so nothing but its organization list
 *  decides who may book it. No organizations = available to every one. */
function makeSupplier(key: string, organizationIds: Types.ObjectId[] = []) {
  const input: CreateProviderInput = {
    key,
    name: `${key} Travel`,
    logo: `/providers/${key.toLowerCase()}.png`,
    primaryColor: "#123456",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    sortOrder: 0,
    serviceTypes: [...SERVICES],
    organizationIds: organizationIds.map(String),
  };
  return createProvider(input, { actor });
}

/** A provider row as production stored it before `serviceTypes` and
 *  `organizationIds` existed — for the raw driver, so no Mongoose default
 *  can fill either in. */
function legacyRow(key: string, over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    key,
    name: `${key} Legacy`,
    logo: `/providers/${key.toLowerCase()}.png`,
    primaryColor: "#1E3A8A",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    status: RecordState.ACTIVE,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** The ValidationError an attempt was refused with. */
async function refusal(attempt: Promise<unknown>): Promise<ValidationError> {
  const outcome = await attempt.then(
    () => null,
    (err: unknown) => err,
  );
  expect(outcome, "expected the order to be refused").toBeInstanceOf(
    ValidationError,
  );
  return outcome as ValidationError;
}

/** A refused order writes nothing: no order, no audit row, no evidence. */
async function expectNothingStored() {
  expect(await Order.countDocuments({})).toBe(0);
  expect(
    await AuditLog.countDocuments({ action: AuditAction.ORDER_CREATED }),
  ).toBe(0);
  expect(await OrderEvidence.countDocuments({})).toBe(0);
}

/** The organization an order was stored under (null when unowned). */
async function storedOrganization(orderId: string): Promise<string | null> {
  const doc = await Order.findById(orderId)
    .select("organizationId")
    .lean<{ organizationId?: Types.ObjectId | null } | null>();
  expect(doc, `order ${orderId} was stored`).not.toBeNull();
  return doc!.organizationId ? String(doc!.organizationId) : null;
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings();
  sessionMock = await mockSession(actor);
  alpha = await makeOrg("alpha", true);
  bravo = await makeOrg("bravo", false);
  charlie = await makeOrg("charlie", false);
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
});

/* ------------------------------------------------------------------ *
 * A supplier confined to an organization
 * ------------------------------------------------------------------ */

describe("a supplier confined to one organization", () => {
  it.each(SERVICES)(
    "%s: is refused for another organization — a 422, nothing stored — and booked by its own",
    async (serviceType) => {
      await makeSupplier("BRAVOONLY", [bravo]);

      actingAs(alpha);
      const err = await refusal(
        createOrder(inputFor(serviceType, "BRAVOONLY"), { actor }),
      );
      expect(err).toMatchObject({
        statusCode: 422,
        code: "VALIDATION_ERROR",
        message: NOT_AVAILABLE,
      });
      await expectNothingStored();

      actingAs(bravo);
      const { order } = await createOrder(inputFor(serviceType, "BRAVOONLY"), {
        actor,
      });
      expect(order.serviceType).toBe(serviceType);
      expect(order.provider).toMatchObject({
        id: "BRAVOONLY",
        name: "BRAVOONLY Travel",
        logo: "/providers/bravoonly.png",
        primaryColor: "#123456",
        onPrimaryColor: "#FFFFFF",
      });
      expect(await storedOrganization(order.id)).toBe(String(bravo));
      expect(await Order.countDocuments({})).toBe(1);
    },
  );

  it("one confined to several organizations is booked by each of them and refused for the rest", async () => {
    await makeSupplier("ALPHABRAVO", [alpha, bravo]);

    for (const org of [alpha, bravo]) {
      actingAs(org);
      const { order } = await createOrder(
        validCreateOrderInput({ provider: "ALPHABRAVO" }),
        { actor },
      );
      expect(await storedOrganization(order.id)).toBe(String(org));
    }

    actingAs(charlie);
    const err = await refusal(
      createOrder(validFlightOrderInput({ provider: "ALPHABRAVO" }), { actor }),
    );
    expect(err.message).toBe(NOT_AVAILABLE);
    expect(await Order.countDocuments({})).toBe(2);
  });

  it("reads as not available to another organization — never as disabled, which is its own organization's business", async () => {
    const supplier = await makeSupplier("BRAVOONLY", [bravo]);
    await setProviderStatus(
      supplier.id,
      { status: RecordState.DISABLED },
      { actor },
    );

    actingAs(alpha);
    expect(
      (
        await refusal(
          createOrder(validCreateOrderInput({ provider: "BRAVOONLY" }), {
            actor,
          }),
        )
      ).message,
    ).toBe(NOT_AVAILABLE);

    actingAs(bravo);
    expect(
      (
        await refusal(
          createOrder(validCreateOrderInput({ provider: "BRAVOONLY" }), {
            actor,
          }),
        )
      ).message,
    ).toBe(DISABLED);
    await expectNothingStored();
  });

  it("follows the live catalog: confining a supplier later refuses it, lifting the restriction books it again", async () => {
    const supplier = await makeSupplier("CHANGING");
    const stay = () => validHotelOrderInput({ provider: "CHANGING" });

    actingAs(alpha);
    await createOrder(stay(), { actor });

    await updateProvider(
      supplier.id,
      { organizationIds: [String(bravo)] },
      { actor },
    );
    expect((await refusal(createOrder(stay(), { actor }))).message).toBe(
      NOT_AVAILABLE,
    );

    await updateProvider(supplier.id, { organizationIds: [] }, { actor });
    await createOrder(stay(), { actor });
    expect(await Order.countDocuments({ organizationId: alpha })).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Suppliers available to everyone — unchanged
 * ------------------------------------------------------------------ */

describe("a supplier available to every organization", () => {
  it.each(SERVICES)(
    "%s: is booked by every organization",
    async (serviceType) => {
      await makeSupplier("EVERYONE");

      for (const org of [alpha, bravo, charlie]) {
        actingAs(org);
        const { order } = await createOrder(inputFor(serviceType, "EVERYONE"), {
          actor,
        });
        expect(order.provider.id).toBe("EVERYONE");
        expect(await storedOrganization(order.id)).toBe(String(org));
      }
      expect(await Order.countDocuments({})).toBe(3);
    },
  );

  it("a row stored before organizationIds existed is available to every organization", async () => {
    await Provider.collection.insertOne(legacyRow("OLDROW"));

    for (const org of [alpha, bravo, charlie]) {
      actingAs(org);
      const { order } = await createOrder(
        validCreateOrderInput({ provider: "OLDROW" }),
        { actor },
      );
      expect(order.provider).toMatchObject({ id: "OLDROW", name: "OLDROW Legacy" });
    }
  });
});

describe("the built-in car suppliers", () => {
  it("BUDGET with no providers row yet is seeded unrestricted and booked by both organizations", async () => {
    // Every test starts from an empty catalog: no row for the built-in.
    expect(await Provider.countDocuments({ key: ProviderId.BUDGET })).toBe(0);

    for (const org of [alpha, bravo]) {
      actingAs(org);
      const { order } = await createOrder(validCreateOrderInput(), { actor });
      expect(order.provider).toEqual(BUDGET_SNAPSHOT);
      expect(await storedOrganization(order.id)).toBe(String(org));
    }

    const seeded = await Provider.findOne({ key: ProviderId.BUDGET }).lean<{
      organizationIds: Types.ObjectId[];
    } | null>();
    expect(seeded?.organizationIds).toEqual([]);
  });

  it("a legacy BUDGET row, stored before serviceTypes and organizationIds existed, is booked by both — car, flight and hotel", async () => {
    await Provider.collection.insertOne(
      legacyRow(ProviderId.BUDGET, {
        name: BUDGET.name,
        logo: BUDGET.logo,
        primaryColor: BUDGET.primaryColor,
        onPrimaryColor: BUDGET.onPrimaryColor,
        tagline: BUDGET.tagline,
      }),
    );

    for (const org of [alpha, bravo]) {
      actingAs(org);
      for (const serviceType of SERVICES) {
        const { order } = await createOrder(
          inputFor(serviceType, ProviderId.BUDGET),
          { actor },
        );
        expect(order.provider, `${serviceType}`).toEqual(BUDGET_SNAPSHOT);
      }
    }
    expect(await Order.countDocuments({})).toBe(6);
  });

  it("a built-in brand an admin confined to one organization obeys the same rule as any supplier", async () => {
    const budget = (await listActiveProviders()).find(
      (p) => p.key === ProviderId.BUDGET,
    );
    expect(budget).toBeDefined();
    await updateProvider(
      budget!.id,
      { organizationIds: [String(bravo)] },
      { actor },
    );

    actingAs(alpha);
    expect(
      (await refusal(createOrder(validCreateOrderInput(), { actor }))).message,
    ).toBe(NOT_AVAILABLE);
    await expectNothingStored();

    actingAs(bravo);
    const { order } = await createOrder(validCreateOrderInput(), { actor });
    expect(order.provider).toEqual(BUDGET_SNAPSHOT);
  });
});

/* ------------------------------------------------------------------ *
 * Unknown suppliers, and orders with no organization
 * ------------------------------------------------------------------ */

describe("an unknown supplier keeps its exact wording", () => {
  it.each([
    [ServiceType.CAR_RENTAL, "Unknown rental provider"],
    [ServiceType.FLIGHT, "Unknown airline or supplier"],
    [ServiceType.HOTEL, "Unknown hotel or supplier"],
  ] as const)("%s: %s", async (serviceType, message) => {
    actingAs(alpha);
    const err = await refusal(
      createOrder(inputFor(serviceType, "NOSUCHSUPPLIER"), { actor }),
    );
    expect(err.message).toBe(message);
    // The organization never changes the unknown wording.
    await expect(
      buildProviderSnapshotFromKey("NOSUCHSUPPLIER", serviceType, alpha),
    ).rejects.toThrow(new RegExp(`^${message}$`));
    await expectNothingStored();
  });
});

describe("an order with no organization", () => {
  it("can book only an unrestricted supplier — the unowned car rental is otherwise unchanged", async () => {
    await makeSupplier("BRAVOONLY", [bravo]);
    // Organizations exist but none is selected: the historic unowned car
    // rental, which belongs to no organization a restriction could name.
    actingAs(null);

    const err = await refusal(
      createOrder(validCreateOrderInput({ provider: "BRAVOONLY" }), { actor }),
    );
    expect(err.message).toBe(NOT_AVAILABLE);
    await expectNothingStored();

    const { order } = await createOrder(validCreateOrderInput(), { actor });
    expect(order.provider).toEqual(BUDGET_SNAPSHOT);
    expect(await storedOrganization(order.id)).toBeNull();
  });
});

describe("buildProviderSnapshotFromKey takes the order's organization", () => {
  it("as an ObjectId or a string; with none, only an unrestricted supplier resolves", async () => {
    await makeSupplier("BRAVOONLY", [bravo]);
    await makeSupplier("EVERYONE");

    await expect(
      buildProviderSnapshotFromKey("BRAVOONLY", ServiceType.FLIGHT, bravo),
    ).resolves.toMatchObject({ id: "BRAVOONLY", name: "BRAVOONLY Travel" });
    await expect(
      buildProviderSnapshotFromKey(" bravoonly ", ServiceType.HOTEL, String(bravo)),
    ).resolves.toMatchObject({ id: "BRAVOONLY" });

    for (const other of [alpha, String(charlie), null, undefined]) {
      await expect(
        buildProviderSnapshotFromKey("BRAVOONLY", ServiceType.FLIGHT, other),
        String(other),
      ).rejects.toThrow(new RegExp(`^${NOT_AVAILABLE}$`));
    }
    await expect(buildProviderSnapshotFromKey("BRAVOONLY")).rejects.toThrow(
      new RegExp(`^${NOT_AVAILABLE}$`),
    );

    for (const any of [alpha, String(bravo), null, undefined]) {
      await expect(
        buildProviderSnapshotFromKey("EVERYONE", ServiceType.CAR_RENTAL, any),
        String(any),
      ).resolves.toMatchObject({ id: "EVERYONE" });
    }
  });
});

/* ------------------------------------------------------------------ *
 * The dropdown and the server agree
 * ------------------------------------------------------------------ */

describe("the server and the create form's dropdown agree", () => {
  it("each organization can book exactly the suppliers its dropdown lists, and is refused every other", async () => {
    await makeSupplier("EVERYONE");
    await makeSupplier("BRAVOONLY", [bravo]);
    await makeSupplier("ALPHABRAVO", [alpha, bravo]);
    await Provider.collection.insertOne(legacyRow("OLDROW"));

    const every = (await listActiveProviders()).map((p) => p.key).sort();
    expect(every).toEqual(
      [
        ...Object.keys(PROVIDER_SEED),
        "ALPHABRAVO",
        "BRAVOONLY",
        "EVERYONE",
        "OLDROW",
      ].sort(),
    );

    const cases = [
      ["alpha", alpha, every.filter((k) => k !== "BRAVOONLY")],
      ["bravo", bravo, every],
      [
        "charlie",
        charlie,
        every.filter((k) => k !== "BRAVOONLY" && k !== "ALPHABRAVO"),
      ],
    ] as const;

    for (const [slug, org, expected] of cases) {
      // The create form's dropdown for this organization.
      const listed = (await listActiveProviders({ organizationId: String(org) }))
        .map((p) => p.key)
        .sort();
      expect(listed, slug).toEqual(expected);

      actingAs(org);
      for (const key of every) {
        const outcome = await createOrder(
          validCreateOrderInput({ provider: key }),
          { actor },
        ).then(
          () => "booked",
          (err: Error) => err.message,
        );
        expect(outcome, `${slug} → ${key}`).toBe(
          listed.includes(key) ? "booked" : NOT_AVAILABLE,
        );
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Through the real route
 * ------------------------------------------------------------------ */

describe("POST /api/orders", () => {
  function post(body: unknown) {
    return createOrderRoute(buildRequest("/api/orders", { method: "POST", body }));
  }

  it.each(SERVICES)(
    "%s: another organization's supplier is a 422 that stores nothing; its own organization gets a 201",
    async (serviceType) => {
      await makeSupplier("BRAVOONLY", [bravo]);

      actingAs(alpha);
      const refused = await jsonBody<ApiErr>(
        await post(inputFor(serviceType, "BRAVOONLY")),
      );
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR", message: NOT_AVAILABLE },
      });
      await expectNothingStored();

      actingAs(bravo);
      const created = await jsonBody<{
        ok: true;
        data: { order: { id: string; serviceType: string; provider: { id: string } } };
      }>(await post(inputFor(serviceType, "BRAVOONLY")));
      expect(created.status).toBe(201);
      expect(created.body.data.order.serviceType).toBe(serviceType);
      expect(created.body.data.order.provider.id).toBe("BRAVOONLY");
      expect(await storedOrganization(created.body.data.order.id)).toBe(
        String(bravo),
      );
    },
  );
});

describe("GET /api/providers — the catalog an operator can read", () => {
  async function listedKeys(): Promise<string[]> {
    const res = await listProvidersRoute(buildRequest("/api/providers"));
    const { status, body } = await jsonBody<{ ok: boolean; data: { items: { key: string }[] } }>(res);
    expect(status).toBe(200);
    return body.data.items.map((p) => p.key);
  }

  it("never lists a supplier confined to another organization — only the selected one's and everyone's", async () => {
    await makeSupplier("EVERYONE");
    await makeSupplier("BRAVOONLY", [bravo]);

    actingAs(alpha);
    const forAlpha = await listedKeys();
    expect(forAlpha).toContain("EVERYONE");
    expect(forAlpha).not.toContain("BRAVOONLY");

    actingAs(bravo);
    const forBravo = await listedKeys();
    expect(forBravo).toContain("EVERYONE");
    expect(forBravo).toContain("BRAVOONLY");
  });
});
