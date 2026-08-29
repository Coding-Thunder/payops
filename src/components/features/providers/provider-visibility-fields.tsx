"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api-client";
import { SERVICE_TYPES, ServiceType } from "@/lib/constants/enums";
import { ServiceTypeLabel } from "@/lib/constants/labels";
import type { OrganizationSummary } from "@/types";

/**
 * Service types + organization restriction for a catalog provider.
 *
 * THE MODEL, which is easy to get backwards:
 *
 *   serviceTypes    decides WHICH SERVICE a supplier applies to, and is the
 *                   thing that actually isolates the catalog. An airline
 *                   tagged [FLIGHT] can never appear in a car-rental
 *                   dropdown, because the CAR_RENTAL query matches only
 *                   rows that are CAR_RENTAL, absent, or empty.
 *
 *   organizationIds is an OPTIONAL RESTRICTION and nothing more. EMPTY means
 *                   GLOBAL — available to every organization — which is the
 *                   default and the correct model for shared reference data.
 *                   A supplier is a fact about the world, not the property
 *                   of whichever brand happened to add it.
 *
 * So a provider created while working in GlobeVista is reusable by
 * RentalConfirmation and TripReservations unless the operator explicitly
 * narrows it here.
 */

export interface ProviderVisibilityValue {
  serviceTypes: ServiceType[];
  /** Empty = every organization. */
  organizationIds: string[];
}

interface Props {
  value: ProviderVisibilityValue;
  onChange: (next: ProviderVisibilityValue) => void;
  disabled?: boolean;
}

/** The organizations the caller may restrict to. Reuses the endpoint the org
 *  switcher already calls; for an ADMIN that is every active organization. */
function useOrganizations() {
  return useQuery({
    queryKey: ["organizations", "for-provider-restriction"],
    queryFn: async () => {
      const data = await api.get<{ organizations: OrganizationSummary[] }>(
        "/api/organizations",
      );
      return data.organizations ?? [];
    },
    staleTime: 60_000,
  });
}

export function ProviderVisibilityFields({
  value,
  onChange,
  disabled,
}: Props) {
  const { data: organizations = [], isLoading } = useOrganizations();
  const restricted = value.organizationIds.length > 0;

  function toggleServiceType(st: ServiceType, checked: boolean) {
    const next = checked
      ? [...value.serviceTypes, st]
      : value.serviceTypes.filter((s) => s !== st);
    onChange({ ...value, serviceTypes: next });
  }

  function toggleOrganization(id: string, checked: boolean) {
    const next = checked
      ? [...value.organizationIds, id]
      : value.organizationIds.filter((o) => o !== id);
    onChange({ ...value, organizationIds: next });
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label className="text-sm font-medium">Service types</Label>
        <p className="text-xs text-muted-foreground">
          Which services this supplier can be attached to. This is what keeps
          an airline out of a car-rental order.
        </p>
        <div className="flex flex-wrap gap-4 pt-1">
          {SERVICE_TYPES.map((st) => (
            <label
              key={st}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <Checkbox
                checked={value.serviceTypes.includes(st)}
                disabled={disabled}
                onCheckedChange={(c) => toggleServiceType(st, c === true)}
              />
              {ServiceTypeLabel[st]}
            </label>
          ))}
        </div>
        {value.serviceTypes.length === 0 ? (
          <p className="text-xs text-destructive">
            Pick at least one service type.
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label className="text-sm font-medium">Organization availability</Label>
        <div className="space-y-2 pt-1">
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="provider-visibility"
              className="mt-1"
              checked={!restricted}
              disabled={disabled}
              onChange={() => onChange({ ...value, organizationIds: [] })}
            />
            <span>
              All organizations
              <span className="block text-xs text-muted-foreground">
                Recommended. The catalog is shared reference data — any brand
                selling this service can use the supplier.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="radio"
              name="provider-visibility"
              className="mt-1"
              checked={restricted}
              disabled={disabled || organizations.length === 0}
              onChange={() => {
                // Selecting "restricted" with nothing ticked would persist
                // an empty list, which means GLOBAL — the opposite of what
                // the operator just asked for. Seed with the first
                // organization so the choice is never silently inverted.
                if (value.organizationIds.length === 0 && organizations[0]) {
                  onChange({
                    ...value,
                    organizationIds: [organizations[0].id],
                  });
                }
              }}
            />
            <span>
              Selected organizations only
              <span className="block text-xs text-muted-foreground">
                Use for a supplier under contract to one brand.
              </span>
            </span>
          </label>
        </div>

        {restricted ? (
          <div className="ml-6 space-y-2 rounded-md border border-border/60 p-3">
            {isLoading ? (
              <p className="text-xs text-muted-foreground">
                Loading organizations…
              </p>
            ) : (
              organizations.map((org) => (
                <label
                  key={org.id}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <Checkbox
                    checked={value.organizationIds.includes(org.id)}
                    disabled={disabled}
                    onCheckedChange={(c) =>
                      toggleOrganization(org.id, c === true)
                    }
                  />
                  {org.name}
                  {org.brandName && org.brandName !== org.name ? (
                    <span className="text-xs text-muted-foreground">
                      ({org.brandName})
                    </span>
                  ) : null}
                </label>
              ))
            )}
            {value.organizationIds.length === 0 ? (
              <p className="text-xs text-destructive">
                Pick at least one organization, or choose “All organizations”.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Default for a NEW provider: car rental, available everywhere. Matches how
 *  every pre-existing catalog row behaves. */
export function defaultProviderVisibility(): ProviderVisibilityValue {
  return { serviceTypes: [ServiceType.CAR_RENTAL], organizationIds: [] };
}
