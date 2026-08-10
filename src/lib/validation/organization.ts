import { z } from "zod";

/**
 * Organization switching.
 *
 * The id is shape-checked here only. Authorization is NOT a validation
 * concern and deliberately does not live in this schema: the route hands
 * the parsed id to `assertOrganizationAccess`, which resolves it against
 * the caller's own memberships. A well-formed id for someone else's
 * organization passes this schema and is then refused.
 */
export const switchOrganizationSchema = z.object({
  organizationId: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, "Select a valid organization"),
});

export type SwitchOrganizationInput = z.infer<typeof switchOrganizationSchema>;
