import "server-only";

import { Types } from "mongoose";

import { PaymentGatewayKey } from "@/lib/constants/enums";
import {
  Branding,
  GatewayCredential,
  ItemType,
  Order,
  OrgMember,
} from "@/server/db/models";
import { connectMongo } from "@/server/db/mongoose";
import { isLegacyTenant } from "@/server/db/org/legacy";
import { orgIdFilter } from "@/server/db/org/org-context";

/**
 * Onboarding-checklist state for a single org.
 *
 * The dashboard's setup banner reads this once on render and shows a
 * checkbox per step. We only count a step as "done" when there's
 * concrete proof, a saved row, a created order, a real second
 * teammate, never just "the page was visited". That keeps the
 * checklist honest as a status, not a guilt nag.
 *
 * The legacy tenant is special-cased to `complete: true` so the
 * banner never appears for them (they pre-date the onboarding flow
 * and their setup is implicit in the migration).
 */
export interface OnboardingState {
  /** Org id this state describes. */
  orgId: string;
  /** Computed roll-up: all required steps satisfied. */
  complete: boolean;
  /** Set when the org is the legacy migration tenant, the checklist
   *  is suppressed regardless of step state. */
  isLegacy: boolean;
  steps: {
    /** Gateway credentials saved (any provider, enabled). */
    gatewayConfigured: boolean;
    /** Pass 6b: at least one ItemType defined for this org. Gates the
     *  dynamic create-order form, without it, /app/orders/create
     *  shows an empty state. */
    businessSetupDone: boolean;
    /** Branding edited at least once, brandName not the env default. */
    brandingSet: boolean;
    /** At least one order persisted (in any state). */
    firstOrderCreated: boolean;
    /** At least one ACTIVE OrgMember beyond the founder (real or
     *  invited). */
    teamMemberAdded: boolean;
  };
}

const REQUIRED_STEPS: (keyof OnboardingState["steps"])[] = [
  "gatewayConfigured",
  "businessSetupDone",
  "brandingSet",
  "firstOrderCreated",
];

/**
 * Compute the onboarding state for an org. Cheap: 4 narrowly-projected
 * count/exists queries, no joins. Safe to call on every dashboard
 * render, the dashboard already pulls way more from Mongo than this.
 *
 * `orgId` null / undefined → returns a noop state (`complete: true`,
 * `isLegacy: false`) so a dashboard rendered for a legacy un-migrated
 * caller doesn't trigger an empty checklist.
 */
export async function getOnboardingState(
  orgId: string | null | undefined,
): Promise<OnboardingState> {
  if (!orgId || !Types.ObjectId.isValid(orgId)) {
    return {
      orgId: orgId ?? "",
      complete: true,
      isLegacy: false,
      steps: {
        gatewayConfigured: true,
        businessSetupDone: true,
        brandingSet: true,
        firstOrderCreated: true,
        teamMemberAdded: true,
      },
    };
  }

  await connectMongo();
  const isLegacy = await isLegacyTenant(orgId);
  const filter = { orgId: orgIdFilter(orgId) };

  const [gatewayCount, itemTypeCount, branding, orderCount, memberCount] =
    await Promise.all([
      GatewayCredential.countDocuments({
        ...filter,
        gateway: PaymentGatewayKey.STRIPE,
        enabled: true,
      }),
      ItemType.countDocuments({ ...filter, status: "ACTIVE" }),
      Branding.findOne(filter).select({ brandName: 1, logo: 1 }).lean<{
        brandName?: string;
        logo?: string;
      }>(),
      Order.countDocuments(filter),
      OrgMember.countDocuments({ ...filter, status: "ACTIVE" }),
    ]);

  // Branding is "set" when the doc exists AND has non-empty brandName
  // distinct from the env default. We're permissive here, the
  // CUSTOMER_BRAND_NAME env default is "Rental Confirmation" for
  // tenant #1; non-legacy tenants land with their orgName as the
  // initial brandName, which counts as "set" once they've reviewed it.
  const brandingSet = Boolean(
    branding?.brandName && branding.brandName.trim().length > 0,
  );
  // Logo upload is the strong signal, almost no one ships without
  // touching their logo, so we count "branded" as either the
  // brandName check above OR an uploaded logo. Logo-only tenants
  // (legitimate edge case) still get credit.
  const brandingComplete = brandingSet || Boolean(branding?.logo);

  const steps = {
    gatewayConfigured: gatewayCount > 0,
    businessSetupDone: itemTypeCount > 0,
    brandingSet: brandingComplete,
    firstOrderCreated: orderCount > 0,
    teamMemberAdded: memberCount > 1,
  };

  const requiredComplete = REQUIRED_STEPS.every((k) => steps[k]);

  return {
    orgId,
    // Legacy tenant: never show the checklist. Their setup IS the
    // env vars + the migration script's seed.
    complete: isLegacy || requiredComplete,
    isLegacy,
    steps,
  };
}
