import { describe, expect, it } from "vitest";

import { providersForService } from "@/components/features/orders/service-tabs";
import { ServiceType } from "@/lib/constants/enums";
import type { ProviderDTO } from "@/types";

/**
 * Per-tab supplier narrowing.
 *
 * This is a UI convenience — `buildProviderSnapshotFromKey` re-checks the
 * supplier server-side and is what actually holds — but it is the layer an
 * operator sees, and offering a cruise line on the flight tab is how a
 * mis-branded ticket receipt gets created in the first place.
 */

function provider(
  key: string,
  serviceTypes: ServiceType[] | undefined,
): ProviderDTO {
  return {
    id: `id-${key}`,
    key,
    name: key,
    serviceTypes: serviceTypes as ServiceType[],
    // Empty = usable by every organization, the pre-tenancy default.
    organizationIds: [],
    logo: "/providers/_placeholder.svg",
    primaryColor: "#000000",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    status: "ACTIVE",
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const AIRLINE = provider("EMIRATES", [ServiceType.FLIGHT]);
const CRUISE_LINE = provider("ROYAL_CARIBBEAN", [ServiceType.CRUISE]);
const BOTH = provider("RCR_TRAVEL", [ServiceType.FLIGHT, ServiceType.CRUISE]);
const RENTAL = provider("HERTZ", [ServiceType.CAR_RENTAL]);
/** A row written before `serviceTypes` existed. */
const LEGACY = provider("BUDGET", undefined);
const CATALOG = [AIRLINE, CRUISE_LINE, BOTH, RENTAL, LEGACY];

describe("providersForService", () => {
  it("offers airlines and multi-service suppliers on the flight tab", () => {
    const keys = providersForService(CATALOG, ServiceType.FLIGHT).map(
      (p) => p.key,
    );
    expect(keys).toEqual(["EMIRATES", "RCR_TRAVEL"]);
  });

  it("offers cruise lines and multi-service suppliers on the cruise tab", () => {
    const keys = providersForService(CATALOG, ServiceType.CRUISE).map(
      (p) => p.key,
    );
    expect(keys).toEqual(["ROYAL_CARIBBEAN", "RCR_TRAVEL"]);
  });

  it("keeps an airline off the cruise tab and vice versa", () => {
    expect(
      providersForService(CATALOG, ServiceType.CRUISE).map((p) => p.key),
    ).not.toContain("EMIRATES");
    expect(
      providersForService(CATALOG, ServiceType.FLIGHT).map((p) => p.key),
    ).not.toContain("ROYAL_CARIBBEAN");
  });

  it("treats a row with no serviceTypes as a car-rental supplier", () => {
    // Same legacy rule the server-side filter uses. A provider that predates
    // the field must keep appearing exactly where it appears today — the
    // rental form — and nowhere else.
    const rental = providersForService(CATALOG, ServiceType.CAR_RENTAL).map(
      (p) => p.key,
    );
    expect(rental).toEqual(["HERTZ", "BUDGET"]);
    expect(
      providersForService(CATALOG, ServiceType.FLIGHT).map((p) => p.key),
    ).not.toContain("BUDGET");
  });

  it("treats an EMPTY serviceTypes array as car rental too", () => {
    // `.lean()` reads and hand-written rows can both produce `[]`, and an
    // empty list must not mean "available everywhere".
    const empty = [provider("EMPTY", [])];
    expect(
      providersForService(empty, ServiceType.CAR_RENTAL).map((p) => p.key),
    ).toEqual(["EMPTY"]);
    expect(providersForService(empty, ServiceType.FLIGHT)).toEqual([]);
  });

  it("returns an empty list rather than throwing on an empty catalog", () => {
    // The forms render a "configure a provider first" prompt off this.
    expect(providersForService([], ServiceType.CRUISE)).toEqual([]);
  });
});
