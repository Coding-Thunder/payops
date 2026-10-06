import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";

import {
  OrderEvidenceEventType,
  PaymentGatewayKey,
  RecordState,
  ServiceType,
  UserRole,
} from "@/lib/constants/enums";
import { logger } from "@/lib/logger";
import {
  Order,
  OrderEvidence,
  Organization,
  OrganizationMember,
} from "@/server/db/models";
import {
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { orgCookieName } from "@/server/auth/org-cookie";
import { createOrder } from "@/server/services/order.service";
import { createSettings } from "@/tests/factories/settings.factory";
import { actorFor, mockSession } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";
import { setNextHeaders } from "@/tests/utils/next-headers";
import {
  validCreateOrderInput,
  validFlightOrderInput,
} from "@/tests/fixtures/order-input.fixture";

/**
 * Which Terms & cancellation policy a new order freezes — per organization
 * AND per service.
 *
 * The bug this fixes: a brand selling flights froze its car-rental terms
 * (or the deployment's, which are also car terms) onto flight orders, so a
 * flight passenger agreed to rules about pick-up, licences and counter
 * deposits. The rule now:
 *
 *   CAR_RENTAL → the organization's own top-level text, else the deployment
 *                Settings singleton — exactly as before;
 *   FLIGHT     → the organization's own `legal.services.FLIGHT` text, else
 *                the built-in flight default — NEVER the organization's car
 *                text and NEVER the Settings singleton.
 *
 * Each text travels with its own version, and everything is resolved from
 * the ORDER's organization, so brand A's text can never reach brand B.
 */

const actor = actorFor(UserRole.ADMIN);

/** The deployment singleton — car-rental text, in production. */
const SETTINGS_LEGAL = {
  termsAndConditions: "SETTINGS CAR TERMS: present a valid licence at pick-up.",
  termsVersion: "v3",
  cancellationPolicy: "SETTINGS CAR POLICY: deposits are refunded at the rental counter.",
  cancellationPolicyVersion: "v4",
};

interface BrandLegal {
  car: { terms: string; termsVersion: string; policy: string; policyVersion: string };
  flight: { terms: string; termsVersion: string; policy: string; policyVersion: string } | null;
}

const ALPHA: BrandLegal = {
  car: {
    terms: "ALPHA CAR TERMS: drivers must be 25 or older.",
    termsVersion: "v2",
    policy: "ALPHA CAR POLICY: free cancellation up to 48 hours before pick-up.",
    policyVersion: "v2",
  },
  flight: {
    terms: "ALPHA FLIGHT TERMS: tickets are issued under the operating airline's conditions.",
    termsVersion: "v5",
    policy: "ALPHA FLIGHT POLICY: changes follow the fare rules of the ticket.",
    policyVersion: "v6",
  },
};

const BRAVO: BrandLegal = {
  car: {
    terms: "BRAVO CAR TERMS: one additional driver is included.",
    termsVersion: "v7",
    policy: "BRAVO CAR POLICY: no-shows are charged in full.",
    policyVersion: "v8",
  },
  flight: {
    terms: "BRAVO FLIGHT TERMS: names must match the passport exactly.",
    termsVersion: "v9",
    policy: "BRAVO FLIGHT POLICY: refunds are released when the airline refunds us.",
    policyVersion: "v10",
  },
};

/** Sells flights, has car text of its own — but no flight text. */
const CHARLIE: BrandLegal = {
  car: {
    terms: "CHARLIE CAR TERMS: present your licence and a credit card at pick-up.",
    termsVersion: "v2",
    policy: "CHARLIE CAR POLICY: vehicle returns after hours incur a counter fee.",
    policyVersion: "v2",
  },
  flight: null,
};

let sessionMock: Awaited<ReturnType<typeof mockSession>> | null = null;
let rentalconfirmation: Types.ObjectId;
let alpha: Types.ObjectId;
let bravo: Types.ObjectId;
let charlie: Types.ObjectId;

async function makeOrg(opts: {
  slug: string;
  isDefault: boolean;
  serviceTypes: ServiceType[];
  legal?: Record<string, unknown>;
}): Promise<Types.ObjectId> {
  const doc = await Organization.create({
    slug: opts.slug,
    name: opts.slug,
    brandName: `${opts.slug} brand`,
    isDefault: opts.isDefault,
    payments: { provider: PaymentGatewayKey.STRIPE },
    serviceTypes: opts.serviceTypes,
    ...(opts.legal ? { legal: opts.legal } : {}),
  });
  const id = doc._id as Types.ObjectId;
  await OrganizationMember.create({
    organizationId: id,
    userId: new Types.ObjectId(actor.id),
    role: UserRole.ADMIN,
    status: RecordState.ACTIVE,
  });
  return id;
}

function legalDoc(brand: BrandLegal, flightBlock?: Record<string, unknown> | null) {
  return {
    termsAndConditions: brand.car.terms,
    termsVersion: brand.car.termsVersion,
    cancellationPolicy: brand.car.policy,
    cancellationPolicyVersion: brand.car.policyVersion,
    services: {
      FLIGHT:
        flightBlock !== undefined
          ? flightBlock
          : brand.flight
            ? {
                termsAndConditions: brand.flight.terms,
                termsVersion: brand.flight.termsVersion,
                cancellationPolicy: brand.flight.policy,
                cancellationPolicyVersion: brand.flight.policyVersion,
              }
            : null,
    },
  };
}

function actingAs(orgId: Types.ObjectId | null) {
  setNextHeaders(orgId ? { cookies: { [orgCookieName()]: String(orgId) } } : {});
}

/** The terms and policy frozen onto a new order of `serviceType` in `orgId`. */
async function frozenLegal(orgId: Types.ObjectId | null, serviceType: ServiceType) {
  actingAs(orgId);
  const input =
    serviceType === ServiceType.FLIGHT ? validFlightOrderInput() : validCreateOrderInput();
  const { order } = await createOrder(input, { actor });
  const doc = await Order.findById(order.id).lean<{
    terms: { text: string; version: string };
    policy: { text: string; version: string };
  } | null>();
  return { orderId: order.id, terms: doc!.terms, policy: doc!.policy };
}

beforeEach(async () => {
  await ensureMongo();
  await createSettings(SETTINGS_LEGAL);
  sessionMock = await mockSession(actor);
  rentalconfirmation = await makeOrg({
    slug: "rentalconfirmation",
    isDefault: true,
    serviceTypes: [ServiceType.CAR_RENTAL],
  });
  alpha = await makeOrg({
    slug: "alphaair",
    isDefault: false,
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    legal: legalDoc(ALPHA),
  });
  bravo = await makeOrg({
    slug: "bravotrips",
    isDefault: false,
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    legal: legalDoc(BRAVO),
  });
  charlie = await makeOrg({
    slug: "charlieholidays",
    isDefault: false,
    serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
    legal: legalDoc(CHARLIE),
  });
});

afterEach(() => {
  sessionMock?.restore();
  sessionMock = null;
  setNextHeaders({});
});

describe("the T&C matrix: two organizations × two services", () => {
  const cases = [
    { brand: "A", service: ServiceType.CAR_RENTAL, expected: () => ALPHA.car, org: () => alpha },
    { brand: "A", service: ServiceType.FLIGHT, expected: () => ALPHA.flight!, org: () => alpha },
    { brand: "B", service: ServiceType.CAR_RENTAL, expected: () => BRAVO.car, org: () => bravo },
    { brand: "B", service: ServiceType.FLIGHT, expected: () => BRAVO.flight!, org: () => bravo },
  ];

  it.each(cases)(
    "$brand + $service freezes exactly that brand's text for that service",
    async ({ org, service, expected }) => {
      const want = expected();
      const { terms, policy } = await frozenLegal(org(), service);
      expect(terms).toEqual({ text: want.terms, version: want.termsVersion });
      expect(policy).toMatchObject({ text: want.policy, version: want.policyVersion });
    },
  );

  it("never lets one brand's text reach the other brand, in either service", async () => {
    const a = await frozenLegal(alpha, ServiceType.FLIGHT);
    const b = await frozenLegal(bravo, ServiceType.FLIGHT);
    for (const text of [a.terms.text, a.policy.text]) {
      expect(text).not.toContain("BRAVO");
      expect(text).not.toContain("CAR");
    }
    for (const text of [b.terms.text, b.policy.text]) {
      expect(text).not.toContain("ALPHA");
      expect(text).not.toContain("CAR");
    }
  });

  it("freezes the flight text into the genesis evidence row too", async () => {
    const { orderId } = await frozenLegal(alpha, ServiceType.FLIGHT);
    const row = await OrderEvidence.findOne({
      orderId: new Types.ObjectId(orderId),
      eventType: OrderEvidenceEventType.ORDER_CREATED,
    }).lean<{ payload: { terms: unknown; policy: { text: string; version: string } } } | null>();
    expect(row!.payload.terms).toEqual({
      text: ALPHA.flight!.terms,
      version: ALPHA.flight!.termsVersion,
    });
    expect(row!.payload.policy).toMatchObject({
      text: ALPHA.flight!.policy,
      version: ALPHA.flight!.policyVersion,
    });
  });
});

describe("an organization that sells flights but has no flight text of its own", () => {
  const BANNED = ["pick-up", "licence", "vehicle", "counter", "rental"];

  function expectBuiltInDefault(legal: Awaited<ReturnType<typeof frozenLegal>>) {
    expect(legal.terms).toEqual({
      text: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    expect(legal.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
    for (const text of [legal.terms.text, legal.policy.text]) {
      const lower = text.toLowerCase();
      for (const word of BANNED) expect(lower).not.toContain(word);
    }
  }

  it("freezes the BUILT-IN flight default — not its car text, not the Settings singleton", async () => {
    const legal = await frozenLegal(charlie, ServiceType.FLIGHT);
    expectBuiltInDefault(legal);
    expect(legal.terms.text).not.toBe(CHARLIE.car.terms);
    expect(legal.terms.text).not.toBe(SETTINGS_LEGAL.termsAndConditions);
    expect(legal.policy.text).not.toBe(CHARLIE.car.policy);
    expect(legal.policy.text).not.toBe(SETTINGS_LEGAL.cancellationPolicy);
  });

  it("does the same with the seed's empty flight block, and with no legal at all", async () => {
    await Organization.updateOne(
      { _id: charlie },
      {
        $set: {
          "legal.services.FLIGHT": {
            termsAndConditions: "",
            termsVersion: "",
            cancellationPolicy: "",
            cancellationPolicyVersion: "",
          },
        },
      },
    );
    expectBuiltInDefault(await frozenLegal(charlie, ServiceType.FLIGHT));

    const bare = await makeOrg({
      slug: "bareair",
      isDefault: false,
      serviceTypes: [ServiceType.FLIGHT],
    });
    expectBuiltInDefault(await frozenLegal(bare, ServiceType.FLIGHT));
  });

  it("still gives its CAR orders its own car text", async () => {
    const legal = await frozenLegal(charlie, ServiceType.CAR_RENTAL);
    expect(legal.terms).toEqual({ text: CHARLIE.car.terms, version: CHARLIE.car.termsVersion });
  });

  it("pairs each text with its own version when only the terms are its own", async () => {
    await Organization.updateOne(
      { _id: charlie },
      {
        $set: {
          "legal.services.FLIGHT": {
            termsAndConditions: "CHARLIE FLIGHT TERMS: arrive two hours before departure.",
            termsVersion: "v4",
            cancellationPolicy: "",
            // A stale label with no text must not travel with the default.
            cancellationPolicyVersion: "v9",
          },
        },
      },
    );
    const legal = await frozenLegal(charlie, ServiceType.FLIGHT);
    expect(legal.terms).toEqual({
      text: "CHARLIE FLIGHT TERMS: arrive two hours before departure.",
      version: "v4",
    });
    expect(legal.policy).toMatchObject({
      text: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      version: DEFAULT_FLIGHT_LEGAL_VERSION,
    });
  });

  it("logs that the built-in default was used, naming the organization", async () => {
    const warn = vi.spyOn(logger, "warn");
    await frozenLegal(charlie, ServiceType.FLIGHT);
    expect(warn).toHaveBeenCalledWith(
      "legal.flight.default_used",
      expect.objectContaining({
        organizationId: String(charlie),
        terms: "default",
        policy: "default",
      }),
    );
  });
});

describe("car rentals are resolved exactly as before", () => {
  it("the DEFAULT organization's car order freezes the Settings text exactly", async () => {
    const legal = await frozenLegal(rentalconfirmation, ServiceType.CAR_RENTAL);
    expect(legal.terms).toEqual({
      text: SETTINGS_LEGAL.termsAndConditions,
      version: SETTINGS_LEGAL.termsVersion,
    });
    expect(legal.policy).toMatchObject({
      text: SETTINGS_LEGAL.cancellationPolicy,
      version: SETTINGS_LEGAL.cancellationPolicyVersion,
    });
  });

  it("an unattributed (pre-migration style) car order freezes the Settings text too", async () => {
    const legal = await frozenLegal(null, ServiceType.CAR_RENTAL);
    expect(legal.terms.text).toBe(SETTINGS_LEGAL.termsAndConditions);
    expect(legal.policy.text).toBe(SETTINGS_LEGAL.cancellationPolicy);
  });

  it("a car brand's own flight text never leaks into its car orders", async () => {
    const legal = await frozenLegal(alpha, ServiceType.CAR_RENTAL);
    expect(legal.terms.text).not.toContain("FLIGHT");
    expect(legal.policy.text).not.toContain("FLIGHT");
  });
});
