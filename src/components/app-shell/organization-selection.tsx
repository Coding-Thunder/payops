"use client";

import { useRouter } from "next/navigation";
import { BuildingIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { LogoLockup } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { api } from "@/lib/api-client";
import type { OrganizationSummary } from "@/types";

interface OrganizationSelectionProps {
  organizations: OrganizationSummary[];
  brand: string;
}

/**
 * Shown instead of the app when the deployment has organizations but the
 * operator has not chosen one.
 *
 * Rendering this in place of `children` (rather than redirecting to a
 * dedicated route) is deliberate: it makes it structurally impossible for a
 * page to render — and therefore for an operational workflow to run —
 * without an explicit selection. A redirect would leave the guarded pages
 * reachable if anything ever bypassed it, and would need a path exclusion
 * to avoid redirecting to itself.
 *
 * There is intentionally no "continue with the default organization"
 * affordance. An implicit default is the failure mode this whole layer
 * exists to prevent.
 */
export function OrganizationSelection({
  organizations,
  brand,
}: OrganizationSelectionProps) {
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function choose(org: OrganizationSummary) {
    setPendingId(org.id);
    try {
      await api.post("/api/organizations/switch", { organizationId: org.id });
      router.refresh();
    } catch {
      toast.error("Could not select that organization");
      setPendingId(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <LogoLockup brand={brand} subtitle="Ops console" size="md" />
        </div>

        {organizations.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-center">
            <BuildingIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
            <h1 className="text-base font-semibold">No organization access</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your account is not a member of any active organization. Ask an
              administrator to add you before continuing.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card p-6">
            <h1 className="text-base font-semibold">Choose an organization</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Everything you create and view is scoped to the organization you
              select.
            </p>
            <ul className="mt-5 space-y-2">
              {organizations.map((org) => (
                <li key={org.id}>
                  <Button
                    variant="outline"
                    className="h-auto w-full justify-between px-4 py-3"
                    disabled={pendingId !== null}
                    onClick={() => choose(org)}
                  >
                    <span className="flex min-w-0 flex-col items-start text-left">
                      <span className="truncate text-sm font-medium">
                        {org.brandName}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {org.slug}
                      </span>
                    </span>
                    <ChevronRightIcon className="size-4 shrink-0 opacity-60" />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
