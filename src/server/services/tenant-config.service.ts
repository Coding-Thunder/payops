import "server-only";

import { getBranding } from "./branding.service";
import { getSettings, type OperationalSettings } from "./settings.service";
import { getOrCreateDefaultWorkflow } from "./workflow.service";
import type { BrandingDTO } from "@/types";
import type { WorkflowDTO } from "@/types/workflow";

/**
 * TenantConfig, single accessor for everything tenant-configurable.
 *
 * Phase 1 of the multi-tenant transformation: every business service
 * that needs tenant configuration reads through this aggregate
 * instead of reaching into env vars, hardcoded enums, or scattered
 * model lookups.
 *
 * Composition order matters: each piece is independently fetchable
 * (so callers that only need branding don't pay for settings + workflow),
 * but the aggregate version `getTenantConfig(orgId)` is the right
 * default for service-layer code that touches multiple surfaces.
 *
 * Future config surfaces (Roles, Forms, DocumentTemplates, TemplateRegistry,
 * AutomationRules) will land here as additional fields. Adding a new
 * surface = one new field + one new sub-fetch; no caller changes for
 * code that doesn't read the new field.
 */
export interface TenantConfig {
  /** Stable org identifier. Useful for downstream services that
   *  already had the orgId but want to pass the bundle around. */
  orgId: string;
  branding: BrandingDTO;
  settings: OperationalSettings;
  workflow: WorkflowDTO;
}

/**
 * Resolve every tenant-config surface in parallel. Each underlying
 * service is independently cached / memoized; this aggregator is just
 * the right shape for the common "I need everything about this org"
 * read pattern.
 */
export async function getTenantConfig(orgId: string): Promise<TenantConfig> {
  const [branding, settings, workflow] = await Promise.all([
    getBranding(orgId),
    getSettings(orgId),
    getOrCreateDefaultWorkflow(orgId),
  ]);
  return { orgId, branding, settings, workflow };
}
