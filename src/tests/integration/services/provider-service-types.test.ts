import { beforeEach, describe, expect, it } from "vitest";
import { Types } from "mongoose";

import { RecordState, ServiceType, UserRole } from "@/lib/constants/enums";
import { Provider } from "@/server/db/models";
import {
  createProvider,
  listActiveProviders,
  updateProvider,
} from "@/server/services/provider.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";

/**
 * The provider catalog's service-type and organization write-path.
 *
 * WHY THIS FILE EXISTS: `serviceTypes` was added to the Provider model and
 * to the list FILTER, but never to the create/update SCHEMAS or to
 * `createProvider`. The field was therefore permanently stuck at its
 * `[CAR_RENTAL]` default, `listProviders({serviceType: FLIGHT})` matched
 * nothing, and the flight/hotel order forms' REQUIRED provider dropdown was
 * empty — making those forms unsubmittable by construction. These tests pin
 * the write path shut.
 *
 * The other half of what they pin is the incumbents' guarantee: a supplier
 * created WITHOUT `serviceTypes`, and every row that predates the field,
 * must keep appearing in a car-rental list exactly as before.
 */

const actor = actorFor(UserRole.ADMIN);
const ctx = { actor };

function providerInput(over: Record<string, unknown> = {}) {
  return {
    key: "TESTBRAND",
    name: "Test Brand",
    logo: "/providers/test.png",
    primaryColor: "#1E3A8A",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    sortOrder: 0,
    ...over,
  } as Parameters<typeof createProvider>[0];
}

beforeEach(async () => {
  await ensureMongo();
});

describe("createProvider — serviceTypes write path", () => {
  it("defaults to CAR_RENTAL when serviceTypes is omitted", async () => {
    const dto = await createProvider(providerInput(), ctx);
    expect(dto.serviceTypes).toEqual([ServiceType.CAR_RENTAL]);
    expect(dto.organizationIds).toEqual([]);
  });

  it("persists an airline as FLIGHT — the case that was impossible before", async () => {
    const dto = await createProvider(
      providerInput({
        key: "DELTA",
        name: "Delta",
        serviceTypes: [ServiceType.FLIGHT],
      }),
      ctx,
    );
    expect(dto.serviceTypes).toEqual([ServiceType.FLIGHT]);

    // The real acceptance criterion: it is findable by the filter the
    // flight order form uses. Before the fix this returned [].
    const flights = await listActiveProviders({
      serviceType: ServiceType.FLIGHT,
    });
    expect(flights.map((p) => p.key)).toContain("DELTA");
  });

  it("persists a hotel group as HOTEL", async () => {
    await createProvider(
      providerInput({
        key: "HILTON",
        name: "Hilton",
        serviceTypes: [ServiceType.HOTEL],
      }),
      ctx,
    );
    const hotels = await listActiveProviders({
      serviceType: ServiceType.HOTEL,
    });
    expect(hotels.map((p) => p.key)).toContain("HILTON");
  });

  it("supports a supplier that serves more than one service", async () => {
    await createProvider(
      providerInput({
        key: "MULTI",
        serviceTypes: [ServiceType.FLIGHT, ServiceType.HOTEL],
      }),
      ctx,
    );
    const flights = await listActiveProviders({
      serviceType: ServiceType.FLIGHT,
    });
    const hotels = await listActiveProviders({ serviceType: ServiceType.HOTEL });
    expect(flights.map((p) => p.key)).toContain("MULTI");
    expect(hotels.map((p) => p.key)).toContain("MULTI");
  });
});

describe("updateProvider — serviceTypes write path", () => {
  it("re-tags an existing car-rental supplier as FLIGHT", async () => {
    const created = await createProvider(providerInput({ key: "RETAG" }), ctx);
    expect(created.serviceTypes).toEqual([ServiceType.CAR_RENTAL]);

    const updated = await updateProvider(
      created.id,
      { serviceTypes: [ServiceType.FLIGHT] },
      ctx,
    );
    expect(updated.serviceTypes).toEqual([ServiceType.FLIGHT]);
  });

  it("compares arrays BY VALUE, so an unchanged list is not a change", async () => {
    const created = await createProvider(providerInput({ key: "SAMEVAL" }), ctx);
    // Two arrays are never `!==`-equal by reference. If the update loop
    // compared by reference this would silently register a change instead
    // of raising, and every no-op save would write an audit row.
    await expect(
      updateProvider(created.id, { serviceTypes: [ServiceType.CAR_RENTAL] }, ctx),
    ).rejects.toThrow(/No changes to apply/i);
  });
});

describe("incumbent brands keep their exact catalog", () => {
  it("a row with NO serviceTypes key still matches a CAR_RENTAL filter", async () => {
    // Simulates a pre-existing production row: written through the raw
    // driver so Mongoose defaults are bypassed entirely.
    await Provider.collection.insertOne({
      key: "LEGACY",
      name: "Legacy Brand",
      logo: "/providers/legacy.png",
      primaryColor: "#1E3A8A",
      onPrimaryColor: "#FFFFFF",
      tagline: "",
      status: RecordState.ACTIVE,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const rentals = await listActiveProviders({
      serviceType: ServiceType.CAR_RENTAL,
    });
    expect(rentals.map((p) => p.key)).toContain("LEGACY");
  });

  it("an airline does NOT appear in a car-rental list", async () => {
    await createProvider(
      providerInput({ key: "AIRONLY", serviceTypes: [ServiceType.FLIGHT] }),
      ctx,
    );
    const rentals = await listActiveProviders({
      serviceType: ServiceType.CAR_RENTAL,
    });
    expect(rentals.map((p) => p.key)).not.toContain("AIRONLY");
  });

  it("an empty organizationIds means available to EVERY organization", async () => {
    await createProvider(providerInput({ key: "SHARED" }), ctx);
    const someOrg = new Types.ObjectId();
    const visible = await listActiveProviders({
      serviceType: ServiceType.CAR_RENTAL,
      organizationId: String(someOrg),
    });
    expect(visible.map((p) => p.key)).toContain("SHARED");
  });

  it("a non-empty organizationIds restricts the supplier to that brand", async () => {
    const globevista = new Types.ObjectId();
    const other = new Types.ObjectId();
    await createProvider(
      providerInput({
        key: "FBONLY",
        serviceTypes: [ServiceType.FLIGHT],
        organizationIds: [String(globevista)],
      }),
      ctx,
    );

    const forGlobevista = await listActiveProviders({
      serviceType: ServiceType.FLIGHT,
      organizationId: String(globevista),
    });
    expect(forGlobevista.map((p) => p.key)).toContain("FBONLY");

    const forOther = await listActiveProviders({
      serviceType: ServiceType.FLIGHT,
      organizationId: String(other),
    });
    expect(forOther.map((p) => p.key)).not.toContain("FBONLY");
  });
});
