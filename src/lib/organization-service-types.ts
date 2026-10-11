import { SERVICE_TYPES, ServiceType } from "@/lib/constants/enums";

/**
 * Which service types an organization sells — the pure rules.
 *
 * Deliberately free of server-only imports so the service layer, the
 * operations scripts (`scripts/set-organization-services.ts`) and tests can
 * all share ONE definition. `@/server/services/organization-service-types`
 * re-exports `serviceTypesOrDefault` alongside the database lookup.
 */

/**
 * Which service types an organization sells — ONE rule for every surface
 * that asks (the create-order page and its config endpoint, the orders
 * list's filters, the organization switcher's payload).
 *
 * The stored list when it has entries; otherwise [CAR_RENTAL], which is
 * what a document stored before the field existed reads as — i.e. both
 * incumbent brands — so their surfaces render exactly as they always have.
 */
export function serviceTypesOrDefault(
  stored: ServiceType[] | null | undefined,
): ServiceType[] {
  return stored && stored.length > 0 ? stored : [ServiceType.CAR_RENTAL];
}

/** Thrown for a value that is not a service type — nothing is guessed. */
export class UnknownServiceTypeError extends Error {
  readonly values: string[];

  constructor(values: string[]) {
    super(
      `Unknown service type${values.length === 1 ? "" : "s"}: ${values.join(", ")}. Use ${SERVICE_TYPES.join(", ")}.`,
    );
    this.name = "UnknownServiceTypeError";
    this.values = values;
  }
}

function isServiceType(value: string): value is ServiceType {
  return (SERVICE_TYPES as string[]).includes(value);
}

/** The values, verified to be service types — or a refusal naming every one
 *  that is not. */
function assertServiceTypes(values: readonly string[]): ServiceType[] {
  const unknown = values.filter((v) => !isServiceType(v));
  if (unknown.length > 0) throw new UnknownServiceTypeError(unknown);
  return values as ServiceType[];
}

/**
 * A comma-separated list ("FLIGHT,HOTEL") as service types: trimmed,
 * upper-cased, blanks dropped. Any other value is refused, never ignored —
 * a typo must not quietly enable nothing.
 */
export function parseServiceTypeList(raw: string | null | undefined): ServiceType[] {
  return assertServiceTypes(
    (raw ?? "")
      .split(",")
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * The service list after ENABLING `requested`.
 *
 * Starts from what the organization sells TODAY — its stored list, or
 * [CAR_RENTAL] when none is stored (`serviceTypesOrDefault`). That base is
 * the whole point: an organization with no stored list is selling car
 * rental, and "adding" to an absent field as if it were empty (Mongo's
 * `$addToSet` does exactly that) would take car rental away from it.
 *
 * The array order is the create page's tab order, so it is preserved:
 * the existing services first, as stored, then each new one appended in the
 * order requested. Duplicates collapse to their first position. A value
 * that is not a service type is refused, stored or requested.
 */
export function mergeServiceTypes(
  stored: readonly string[] | null | undefined,
  requested: readonly string[],
): ServiceType[] {
  const base = serviceTypesOrDefault(assertServiceTypes(stored ?? []));
  return [...new Set([...base, ...assertServiceTypes(requested)])];
}

/**
 * The service list after DISABLING `remove` — the deliberate, separate
 * step (the script gates it behind its own flag). Order is preserved.
 * Refuses to leave nothing: an empty list reads as car rental, which would
 * quietly re-enable a service rather than disable the last one.
 */
export function removeServiceTypes(
  current: readonly ServiceType[],
  remove: readonly string[],
): ServiceType[] {
  const dropped = new Set(assertServiceTypes(remove));
  const next = current.filter((s) => !dropped.has(s));
  if (next.length === 0) {
    throw new Error(
      "An organization must sell at least one service — this would remove every one.",
    );
  }
  return next;
}
