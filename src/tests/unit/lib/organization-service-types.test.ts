import { describe, expect, it } from "vitest";

import { ServiceType } from "@/lib/constants/enums";
import {
  mergeServiceTypes,
  parseServiceTypeList,
  removeServiceTypes,
  serviceTypesOrDefault,
  UnknownServiceTypeError,
} from "@/lib/organization-service-types";
import { serviceTypesOrDefault as serverServiceTypesOrDefault } from "@/server/services/organization-service-types";

/**
 * Which services an organization sells — the pure rules behind
 * `scripts/set-organization-services.ts`.
 *
 * The one that matters most: an organization with NO stored list sells car
 * rental (both incumbent brands are stored that way). Enabling a service
 * must add to that, never replace it — Mongo's `$addToSet` on an absent
 * field would leave only the new service, and car rental would vanish.
 */

const { CAR_RENTAL, FLIGHT, HOTEL } = ServiceType;

describe("serviceTypesOrDefault", () => {
  it("reads an absent or empty list as car rental, and a stored one as stored", () => {
    expect(serviceTypesOrDefault(undefined)).toEqual([CAR_RENTAL]);
    expect(serviceTypesOrDefault(null)).toEqual([CAR_RENTAL]);
    expect(serviceTypesOrDefault([])).toEqual([CAR_RENTAL]);
    expect(serviceTypesOrDefault([FLIGHT, HOTEL])).toEqual([FLIGHT, HOTEL]);
  });

  it("is the very function the server module re-exports, so every import agrees", () => {
    expect(serverServiceTypesOrDefault).toBe(serviceTypesOrDefault);
  });
});

describe("mergeServiceTypes — enabling only ever adds", () => {
  it.each([
    { stored: undefined, what: "absent" },
    { stored: null, what: "null" },
    { stored: [], what: "empty" },
  ])("keeps car rental FIRST when the stored list is $what", ({ stored }) => {
    expect(mergeServiceTypes(stored, [FLIGHT, HOTEL])).toEqual([CAR_RENTAL, FLIGHT, HOTEL]);
  });

  it("keeps the existing services first, as stored, and appends new ones in the order requested", () => {
    // The list is the create page's tab order.
    expect(mergeServiceTypes([FLIGHT], [HOTEL, CAR_RENTAL])).toEqual([FLIGHT, HOTEL, CAR_RENTAL]);
    expect(mergeServiceTypes([HOTEL, CAR_RENTAL], [FLIGHT])).toEqual([HOTEL, CAR_RENTAL, FLIGHT]);
  });

  it("collapses duplicates to their first position", () => {
    expect(mergeServiceTypes([CAR_RENTAL, FLIGHT], [FLIGHT, HOTEL, HOTEL, CAR_RENTAL])).toEqual([
      CAR_RENTAL,
      FLIGHT,
      HOTEL,
    ]);
    // Enabling what is already sold changes nothing.
    expect(mergeServiceTypes(null, [CAR_RENTAL])).toEqual([CAR_RENTAL]);
    expect(mergeServiceTypes([FLIGHT], [])).toEqual([FLIGHT]);
  });

  it("never mutates the stored list it was given", () => {
    const stored = [FLIGHT];
    mergeServiceTypes(stored, [HOTEL]);
    expect(stored).toEqual([FLIGHT]);
  });

  it("refuses a requested value that is not a service type, naming it", () => {
    expect(() => mergeServiceTypes(null, ["FLIGHTS"])).toThrow(UnknownServiceTypeError);
    expect(() => mergeServiceTypes(null, [FLIGHT, "CAR", "hotel"])).toThrow(
      "Unknown service types: CAR, hotel. Use CAR_RENTAL, FLIGHT, HOTEL.",
    );
  });

  it("refuses a stored value that is not a service type rather than carrying it on", () => {
    expect(() => mergeServiceTypes(["CRUISE"], [FLIGHT])).toThrow(
      "Unknown service type: CRUISE. Use CAR_RENTAL, FLIGHT, HOTEL.",
    );
  });
});

describe("parseServiceTypeList — the script's comma lists", () => {
  it("trims, upper-cases and drops blanks", () => {
    expect(parseServiceTypeList(" flight , HOTEL,,")).toEqual([FLIGHT, HOTEL]);
    expect(parseServiceTypeList("")).toEqual([]);
    expect(parseServiceTypeList(undefined)).toEqual([]);
  });

  it("refuses anything that is not a service type — a typo never enables nothing quietly", () => {
    expect(() => parseServiceTypeList("FLIGHT,HOTELS")).toThrow(
      "Unknown service type: HOTELS. Use CAR_RENTAL, FLIGHT, HOTEL.",
    );
    expect(() => parseServiceTypeList("car")).toThrow(UnknownServiceTypeError);
  });
});

describe("removeServiceTypes — disabling is its own step", () => {
  it("drops only what was named, keeping the order", () => {
    expect(removeServiceTypes([CAR_RENTAL, FLIGHT, HOTEL], [FLIGHT])).toEqual([CAR_RENTAL, HOTEL]);
    expect(removeServiceTypes([CAR_RENTAL, FLIGHT], [HOTEL])).toEqual([CAR_RENTAL, FLIGHT]);
  });

  it("refuses to leave an organization selling nothing — an empty list would read as car rental", () => {
    expect(() => removeServiceTypes([FLIGHT], [FLIGHT])).toThrow(/at least one service/);
  });

  it("refuses a value that is not a service type", () => {
    expect(() => removeServiceTypes([CAR_RENTAL, FLIGHT], ["FLIGHTS"])).toThrow(
      UnknownServiceTypeError,
    );
  });
});
