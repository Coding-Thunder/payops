"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormDescription,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api-client";
import { UserRole } from "@/lib/constants/enums";
import type { OrganizationSummary } from "@/types";

/**
 * ADMIN and SUPER_ADMIN reach every ACTIVE organization at the
 * authorization layer (see `listMemberOrganizations`), so membership rows
 * are neither required nor meaningful for them. The forms use this to
 * decide whether the checkbox group is a real control or just a statement
 * of fact — and, critically, whether to send `organizationIds` at all.
 * Sending a list for a global role would imply a restriction the server
 * does not enforce.
 */
export function roleHasGlobalOrgAccess(role: UserRole | undefined): boolean {
  return role === UserRole.ADMIN || role === UserRole.SUPER_ADMIN;
}

interface OrganizationOptions {
  organizations: OrganizationSummary[];
  loading: boolean;
  /** True once the list has been fetched successfully. */
  ready: boolean;
}

/**
 * The organizations the caller may grant.
 *
 * Reuses GET /api/organizations rather than adding an admin-only listing
 * endpoint: that route returns the CALLER's organizations, and only ADMIN /
 * SUPER_ADMIN can reach the user-management screens at all (see
 * ADMIN_ONLY_PERMISSIONS) — both of which now resolve to every ACTIVE
 * organization. So for every operator who can open these dialogs it is
 * already the complete list.
 *
 * An empty list is meaningful and must not be treated as an error: a
 * deployment that has not been migrated to organizations has none, and on
 * one of those the server skips the membership requirement entirely. The
 * forms then render no group and submit exactly what they did before.
 */
export function useOrganizationOptions(enabled: boolean): OrganizationOptions {
  const [organizations, setOrganizations] = React.useState<
    OrganizationSummary[]
  >([]);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!enabled || ready || failed) return;
    let cancelled = false;
    api
      .get<{ organizations: OrganizationSummary[] }>("/api/organizations")
      .then((res) => {
        if (cancelled) return;
        setOrganizations(res?.organizations ?? []);
        setReady(true);
      })
      .catch(() => {
        // Left un-ready on purpose. The forms refuse to submit a
        // membership list they could not build, rather than sending an
        // empty one that would revoke access.
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, ready, failed]);

  // Derived rather than a third state flag, so nothing is set synchronously
  // inside the effect.
  return { organizations, loading: enabled && !ready && !failed, ready };
}

interface OrganizationAccessFieldProps {
  organizations: OrganizationSummary[];
  /** The currently selected organization ids. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Selected role — decides whether this is a control or a note. */
  role: UserRole | undefined;
  /** Still loading options, or the target user's current memberships. */
  loading?: boolean;
  /** Disabled for a reason outside this field (submitting, self-edit). */
  disabled?: boolean;
  /** Extra note rendered under the group (edit form uses it for load failures). */
  note?: React.ReactNode;
}

/**
 * The "Organization access" checkbox group.
 *
 * Must be rendered inside a <FormField render={...}> so FormMessage picks
 * up the field's error — the zero-selection guard lives in the dialogs'
 * submit handlers and reports through `form.setError("organizationIds")`.
 */
export function OrganizationAccessField({
  organizations,
  value,
  onChange,
  role,
  loading = false,
  disabled = false,
  note,
}: OrganizationAccessFieldProps) {
  const isGlobalRole = roleHasGlobalOrgAccess(role);
  const selected = value ?? [];
  const allSelected =
    organizations.length > 0 && selected.length === organizations.length;

  function toggle(id: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    // Preserve the displayed order so the submitted list is stable.
    onChange(organizations.map((o) => o.id).filter((o) => next.has(o)));
  }

  return (
    <FormItem>
      <div className="flex items-center justify-between gap-2">
        <FormLabel>Organization access</FormLabel>
        {!isGlobalRole ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={disabled || loading || organizations.length === 0}
            onClick={() =>
              onChange(allSelected ? [] : organizations.map((o) => o.id))
            }
          >
            {allSelected ? "Clear all" : "Select all"}
          </Button>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
          <Spinner size="xs" tone="current" />
          Loading organizations…
        </div>
      ) : (
        <div className="grid gap-2">
          {organizations.map((org) => {
            // A global role is shown every box ticked and locked, because
            // that is the truth of its access. The value itself is left
            // alone and never submitted for these roles.
            const checked = isGlobalRole ? true : selected.includes(org.id);
            return (
              <label
                key={org.id}
                className={
                  "flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-[13px] transition-colors " +
                  (isGlobalRole || disabled
                    ? "cursor-not-allowed opacity-70"
                    : "cursor-pointer hover:bg-surface-1")
                }
              >
                <Checkbox
                  checked={checked}
                  disabled={isGlobalRole || disabled}
                  onCheckedChange={(c) => toggle(org.id, c === true)}
                />
                <span className="flex-1">{org.name}</span>
                {org.brandName && org.brandName !== org.name ? (
                  <span className="text-xs text-muted-foreground">
                    {org.brandName}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      )}

      {isGlobalRole ? (
        <FormDescription>
          Admins and super admins have access to every organization. This is
          enforced by their role and cannot be narrowed here.
        </FormDescription>
      ) : (
        <FormDescription>
          Pick one or more. The user can only see and act in the
          organizations selected here.
        </FormDescription>
      )}

      {note}
      <FormMessage />
    </FormItem>
  );
}
