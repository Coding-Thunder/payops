import { beforeEach, describe, expect, it } from "vitest";

import { RecordState, ServiceType, UserRole } from "@/lib/constants/enums";
import { Provider } from "@/server/db/models";
import {
  createProvider,
  listProviders,
  updateProvider,
} from "@/server/services/provider.service";
import { actorFor } from "@/tests/utils/auth";
import { ensureMongo } from "@/tests/utils/db";

/**
 * Supplier service-type tagging.
 *
 * The guarantee that matters most here is the LEGACY one: every provider row
 * this deployment already has was written before `serviceTypes` existed and
 * has no such key. Those rows must keep appearing on the car-rental form and
 * must never appear on the flight form. If that filter is wrong in the
 * CAR_RENTAL direction, the entire existing catalog vanishes from the form
 * operators use every day.
 */

const ctx = () => ({ actor: actorFor(UserRole.ADMIN) });

beforeEach(async () => {
  await ensureMongo();
  await Provider.deleteMany({});
});

/** A row exactly as it exists in production today: no `serviceTypes` key. */
async function insertLegacyProvider(key: string) {
  await Provider.collection.insertOne({
    key,
    name: key,
    logo: "/providers/_placeholder.svg",
    primaryColor: "#111111",
    onPrimaryColor: "#FFFFFF",
    tagline: "",
    status: RecordState.ACTIVE,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe("legacy providers (no serviceTypes key)", () => {
  it("still appear on the CAR_RENTAL list", async () => {
    await insertLegacyProvider("LEGACYCAR");
    const car = await listProviders({ serviceType: ServiceType.CAR_RENTAL });
    expect(car.map((p) => p.key)).toContain("LEGACYCAR");
  });

  it("never appear on the FLIGHT list", async () => {
    await insertLegacyProvider("LEGACYCAR");
    const flights = await listProviders({ serviceType: ServiceType.FLIGHT });
    expect(flights.map((p) => p.key)).not.toContain("LEGACYCAR");
  });

  it("are reported as car-rental on the DTO", async () => {
    await insertLegacyProvider("LEGACYCAR");
    const all = await listProviders({});
    const legacy = all.find((p) => p.key === "LEGACYCAR");
    expect(legacy?.serviceTypes).toEqual([ServiceType.CAR_RENTAL]);
  });
});

describe("creating a flight supplier through the service", () => {
  it("tags it FLIGHT and keeps it off the car list", async () => {
    await createProvider(
      {
        key: "BRITISHAIRWAYS",
        name: "British Airways",
        logo: "/providers/_placeholder.svg",
        primaryColor: "#1E3A8A",
        onPrimaryColor: "#FFFFFF",
        tagline: "Full-service carrier",
        serviceTypes: [ServiceType.FLIGHT],
        sortOrder: 10,
      },
      ctx(),
    );

    const flights = await listProviders({ serviceType: ServiceType.FLIGHT });
    expect(flights.map((p) => p.key)).toContain("BRITISHAIRWAYS");

    const cars = await listProviders({ serviceType: ServiceType.CAR_RENTAL });
    expect(cars.map((p) => p.key)).not.toContain("BRITISHAIRWAYS");
  });

  it("supports a supplier available for both services", async () => {
    await createProvider(
      {
        key: "BOTHCO",
        name: "Both Co",
        logo: "/providers/_placeholder.svg",
        primaryColor: "#111111",
        onPrimaryColor: "#FFFFFF",
        tagline: "",
        serviceTypes: [ServiceType.CAR_RENTAL, ServiceType.FLIGHT],
        sortOrder: 0,
      },
      ctx(),
    );

    const cars = await listProviders({ serviceType: ServiceType.CAR_RENTAL });
    const flights = await listProviders({ serviceType: ServiceType.FLIGHT });
    expect(cars.map((p) => p.key)).toContain("BOTHCO");
    expect(flights.map((p) => p.key)).toContain("BOTHCO");
  });
});

describe("editing a supplier's service mix", () => {
  it("moves a car supplier onto the flight form and off the car form", async () => {
    const created = await createProvider(
      {
        key: "SWITCHCO",
        name: "Switch Co",
        logo: "/providers/_placeholder.svg",
        primaryColor: "#111111",
        onPrimaryColor: "#FFFFFF",
        tagline: "",
        serviceTypes: [ServiceType.CAR_RENTAL],
        sortOrder: 0,
      },
      ctx(),
    );

    await updateProvider(
      created.id,
      { serviceTypes: [ServiceType.FLIGHT] },
      ctx(),
    );

    const cars = await listProviders({ serviceType: ServiceType.CAR_RENTAL });
    const flights = await listProviders({ serviceType: ServiceType.FLIGHT });
    expect(cars.map((p) => p.key)).not.toContain("SWITCHCO");
    expect(flights.map((p) => p.key)).toContain("SWITCHCO");
  });
});
