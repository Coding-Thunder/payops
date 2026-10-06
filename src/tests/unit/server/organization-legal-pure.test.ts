// @vitest-environment node

import { describe, expect, it } from "vitest";

import { ServiceType } from "@/lib/constants/enums";
import { isEqual, nextPolicyVersion } from "@/lib/policy-version";
import { updateServiceLegalSchema } from "@/lib/validation";
import {
  DEFAULT_FLIGHT_CANCELLATION_POLICY,
  DEFAULT_FLIGHT_LEGAL_VERSION,
  DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
} from "@/server/db/models/setting.model";
import { pairFlightLegal } from "@/server/services/organization-legal.service";
import {
  resolveOrganizationServiceTypes,
  serviceTypesOrDefault,
} from "@/server/services/organization-service-types";

/**
 * The pure halves of the per-organization flight terms and of the
 * service-types rule. No database: the DB-backed paths are covered in
 * integration/services/organization-legal.test.ts.
 *
 * `pairFlightLegal` is THE pairing rule, shared by the admin form and by
 * `resolveFlightLegal` (what a new flight order freezes), so the form always
 * shows what the next order gets. Each text travels with its OWN version,
 * and the result is never empty — `order.terms.text` is required.
 */

const OWN_TERMS = "Brand A flight terms: tickets are non-transferable.";
const OWN_POLICY = "Brand A flight policy: changes follow the fare rules.";

describe("pairFlightLegal", () => {
  it("falls back to the built-in flight default, at the default version, when nothing is stored", () => {
    for (const stored of [null, undefined, {}, {
      termsAndConditions: "",
      termsVersion: "",
      cancellationPolicy: "",
      cancellationPolicyVersion: "",
    }]) {
      expect(pairFlightLegal(stored)).toEqual({
        termsAndConditions: DEFAULT_FLIGHT_TERMS_AND_CONDITIONS,
        termsVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
        cancellationPolicy: DEFAULT_FLIGHT_CANCELLATION_POLICY,
        cancellationPolicyVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
        termsIsDefault: true,
        policyIsDefault: true,
      });
    }
    expect(DEFAULT_FLIGHT_LEGAL_VERSION).toBe("v1");
  });

  it("uses the organization's own text with its own version", () => {
    expect(
      pairFlightLegal({
        termsAndConditions: OWN_TERMS,
        termsVersion: "v3",
        cancellationPolicy: OWN_POLICY,
        cancellationPolicyVersion: "v7",
      }),
    ).toEqual({
      termsAndConditions: OWN_TERMS,
      termsVersion: "v3",
      cancellationPolicy: OWN_POLICY,
      cancellationPolicyVersion: "v7",
      termsIsDefault: false,
      policyIsDefault: false,
    });
  });

  it("gives an own text with no stored version 'v1'", () => {
    const paired = pairFlightLegal({ termsAndConditions: OWN_TERMS, termsVersion: "  " });
    expect(paired.termsAndConditions).toBe(OWN_TERMS);
    expect(paired.termsVersion).toBe("v1");
  });

  it("pairs each text independently: own terms with the default policy", () => {
    const paired = pairFlightLegal({
      termsAndConditions: OWN_TERMS,
      termsVersion: "v2",
      cancellationPolicy: "   ",
      // A stale label with no text must not travel with the DEFAULT text.
      cancellationPolicyVersion: "v5",
    });
    expect(paired).toMatchObject({
      termsAndConditions: OWN_TERMS,
      termsVersion: "v2",
      termsIsDefault: false,
      cancellationPolicy: DEFAULT_FLIGHT_CANCELLATION_POLICY,
      cancellationPolicyVersion: DEFAULT_FLIGHT_LEGAL_VERSION,
      policyIsDefault: true,
    });
  });

  it("trims what the organization stored", () => {
    expect(
      pairFlightLegal({ termsAndConditions: `  ${OWN_TERMS}\n`, termsVersion: " v4 " }),
    ).toMatchObject({ termsAndConditions: OWN_TERMS, termsVersion: "v4" });
  });

  it("ships a built-in flight default with no rental or airport-desk vocabulary", () => {
    for (const text of [DEFAULT_FLIGHT_TERMS_AND_CONDITIONS, DEFAULT_FLIGHT_CANCELLATION_POLICY]) {
      const lower = text.toLowerCase();
      for (const banned of ["pick-up", "licence", "vehicle", "counter", "rental"]) {
        expect(lower).not.toContain(banned);
      }
    }
  });

  it("never promises the service charge is 'charged today' — a manual-capture brand only holds it", () => {
    expect(DEFAULT_FLIGHT_TERMS_AND_CONDITIONS.toLowerCase()).not.toContain("charged today");
    expect(DEFAULT_FLIGHT_TERMS_AND_CONDITIONS.toLowerCase()).toContain("service charge");
  });
});

describe("updateServiceLegalSchema", () => {
  const valid = {
    serviceType: ServiceType.FLIGHT,
    termsAndConditions: OWN_TERMS,
    cancellationPolicy: OWN_POLICY,
  };

  it("accepts FLIGHT terms and trims them", () => {
    expect(
      updateServiceLegalSchema.parse({
        ...valid,
        termsAndConditions: `   ${OWN_TERMS}   `,
      }).termsAndConditions,
    ).toBe(OWN_TERMS);
  });

  it("drops an organizationId from the body — the route never reads one", () => {
    const parsed = updateServiceLegalSchema.parse({
      ...valid,
      organizationId: "6a92a08d27239e5a6e0f0316",
    });
    expect("organizationId" in parsed).toBe(false);
  });

  it("carries the stale-tab guard fields through — they refuse a save, they choose nothing", () => {
    const parsed = updateServiceLegalSchema.parse({
      ...valid,
      expectedOrganizationId: " 6a92a08d27239e5a6e0f0316 ",
      expectedTermsVersion: "v2",
      expectedCancellationPolicyVersion: "v1",
    });
    expect(parsed).toMatchObject({
      expectedOrganizationId: "6a92a08d27239e5a6e0f0316",
      expectedTermsVersion: "v2",
      expectedCancellationPolicyVersion: "v1",
    });
    // All optional: an editor that sends none still saves.
    expect(updateServiceLegalSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts exactly the services with a legal slot of their own: FLIGHT and HOTEL", () => {
    for (const serviceType of [ServiceType.FLIGHT, ServiceType.HOTEL]) {
      expect(updateServiceLegalSchema.safeParse({ ...valid, serviceType }).success).toBe(true);
    }
    // Car rental has no slot (its text is the organization's top-level
    // legal, else the deployment settings), and a missing type is refused.
    for (const serviceType of [ServiceType.CAR_RENTAL, undefined, "TRAIN"]) {
      expect(updateServiceLegalSchema.safeParse({ ...valid, serviceType }).success).toBe(false);
    }
  });

  it("uses the same length rules and messages as the deployment-wide text", () => {
    const short = updateServiceLegalSchema.safeParse({
      ...valid,
      termsAndConditions: "too short",
      cancellationPolicy: "x".repeat(4001),
    });
    expect(short.success).toBe(false);
    const messages = short.success ? [] : short.error.issues.map((i) => i.message);
    expect(messages).toContain("Terms must be at least 20 characters");
    expect(messages).toContain("Policy must be 4000 characters or fewer");
  });
});

describe("policy versioning (shared by Settings and organization terms)", () => {
  it("bumps a version label, starting anything unparseable from v1", () => {
    expect(nextPolicyVersion("v1")).toBe("v2");
    expect(nextPolicyVersion("v3")).toBe("v4");
    expect(nextPolicyVersion("V9")).toBe("v10");
    expect(nextPolicyVersion("")).toBe("v2");
    expect(nextPolicyVersion("draft")).toBe("v2");
    expect(nextPolicyVersion("v0")).toBe("v2");
  });

  it("compares text ignoring surrounding whitespace, arrays in order", () => {
    expect(isEqual(" terms ", "terms")).toBe(true);
    expect(isEqual("terms", "Terms")).toBe(false);
    expect(isEqual(["A", "B"], ["A", "B"])).toBe(true);
    expect(isEqual(["A", "B"], ["B", "A"])).toBe(false);
    expect(isEqual(1, "1")).toBe(false);
  });
});

describe("serviceTypesOrDefault / resolveOrganizationServiceTypes", () => {
  it("keeps a stored list that has entries", () => {
    expect(serviceTypesOrDefault([ServiceType.FLIGHT])).toEqual([ServiceType.FLIGHT]);
    expect(
      serviceTypesOrDefault([ServiceType.CAR_RENTAL, ServiceType.FLIGHT]),
    ).toEqual([ServiceType.CAR_RENTAL, ServiceType.FLIGHT]);
  });

  it("reads an absent or empty list as [CAR_RENTAL] — both incumbent brands", () => {
    expect(serviceTypesOrDefault(undefined)).toEqual([ServiceType.CAR_RENTAL]);
    expect(serviceTypesOrDefault(null)).toEqual([ServiceType.CAR_RENTAL]);
    expect(serviceTypesOrDefault([])).toEqual([ServiceType.CAR_RENTAL]);
  });

  it("gives no organization at all [CAR_RENTAL] without touching the database", async () => {
    await expect(resolveOrganizationServiceTypes(null)).resolves.toEqual([
      ServiceType.CAR_RENTAL,
    ]);
  });
});
