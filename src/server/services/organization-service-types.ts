import "server-only";

import { ServiceType } from "@/lib/constants/enums";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

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

/**
 * The service types of the given organization (normally the request's
 * selected one). [CAR_RENTAL] for no organization at all — a deployment
 * with none selected — and for an organization with no stored list.
 */
export async function resolveOrganizationServiceTypes(
  organizationId: string | null,
): Promise<ServiceType[]> {
  if (!organizationId) return [ServiceType.CAR_RENTAL];
  await connectMongo();
  const org = await Organization.findById(organizationId)
    .select("serviceTypes")
    .lean<{ serviceTypes?: ServiceType[] } | null>();
  return serviceTypesOrDefault(org?.serviceTypes);
}
