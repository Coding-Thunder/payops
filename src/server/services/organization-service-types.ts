import "server-only";

import { ServiceType } from "@/lib/constants/enums";
import { serviceTypesOrDefault } from "@/lib/organization-service-types";
import { Organization } from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";

/**
 * The pure rule lives in `@/lib/organization-service-types`, importable
 * without a server context (the operations scripts use it). Re-exported
 * here so every existing import keeps working.
 */
export { serviceTypesOrDefault };

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
