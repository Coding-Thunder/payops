import { redirect } from "next/navigation";

import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { getOnboardingState } from "@/server/services/onboarding-state.service";
import { getOrganization } from "@/server/services/organization.service";
import { getSettings } from "@/server/services/settings.service";

import { SetupWizard } from "./_components/setup-wizard";

export const metadata = { title: "Set up your workspace" };
export const dynamic = "force-dynamic";

/**
 * Tenant setup wizard, a guided onboarding flow that walks a new
 * SUPER_ADMIN through the five steps that turn a brand-new workspace
 * into one that can actually take payments:
 *
 *   1. Company name (rename from synthesized "X's workspace")
 *   2. Business basics (currency + order prefix)
 *   3. Branding (display name + primary color)
 *   4. Connect Stripe (link out to /admin/gateways, auto-connect
 *      already encapsulated there; no point duplicating)
 *   5. First item type (link out to /onboarding/business-setup)
 *
 *   Final: "You're all set" with a CTA to create the first order.
 *
 * Server pre-fetches all the data the steps need so the wizard
 * renders instantly on first paint, every step is a controlled form
 * bound to existing values, so the operator never sees a flicker
 * between "loading" and "filled".
 *
 * Re-entry: if the tenant already completed everything (computed by
 * `getOnboardingState`), we redirect to /app/dashboard. The wizard
 * still lives at this URL for tenants who came back to tweak.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; force?: string }>;
}) {
  const user = await requirePermission(Permission.SETTINGS_UPDATE);
  if (!user.orgId) {
    throw new Error("Your account is not attached to an organization.");
  }

  const sp = await searchParams;
  const force = sp.force === "1";

  const [org, settings, branding, onboarding] = await Promise.all([
    getOrganization(user.orgId),
    getSettings(user.orgId),
    getBranding(user.orgId),
    getOnboardingState(user.orgId),
  ]);

  // Completed tenants bouncing past, don't trap them here unless
  // they pass ?force=1 (operators returning to tweak).
  if (onboarding.complete && !force) {
    redirect("/app/dashboard");
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <SetupWizard
        initialStep={Number(sp.step ?? "1")}
        organization={org}
        settings={{
          defaultCurrency: settings.defaultCurrency,
          orderPrefix: settings.orderPrefix,
        }}
        branding={{
          brandName: branding.brandName,
          primaryColor: branding.primaryColor,
        }}
        onboardingSteps={onboarding.steps}
      />
    </div>
  );
}
