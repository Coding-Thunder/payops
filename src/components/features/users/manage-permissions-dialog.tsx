"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ShieldCheckIcon } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/components/ui/sonner";
import { FormDialog } from "@/components/common/form-dialog";
import { api, ApiClientError } from "@/lib/api-client";
import {
  MEMBER_FULL_PERMISSIONS,
  Permission,
  type MemberPermissionMode,
} from "@/lib/constants/permissions";
import { PermissionDescription, PermissionLabel } from "@/lib/constants/labels";
import { cn } from "@/lib/utils";
import type { PublicUser } from "@/types";

interface ManagePermissionsDialogProps {
  user: PublicUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Grouping is presentational only. The SOURCE OF TRUTH for what an owner may
 * grant is MEMBER_FULL_PERMISSIONS — any member-eligible permission not
 * placed in a named group below still renders (under "More"), so the editor
 * can never silently omit a grantable capability, and a restricted
 * permission can never appear because it isn't in MEMBER_FULL_PERMISSIONS.
 */
const GROUPS: ReadonlyArray<{ label: string; permissions: Permission[] }> = [
  {
    label: "Clients",
    permissions: [Permission.CUSTOMER_VIEW, Permission.CUSTOMER_MANAGE],
  },
  {
    label: "Orders & payments",
    permissions: [
      Permission.ORDER_VIEW_OWN,
      Permission.ORDER_VIEW_ALL,
      Permission.ORDER_CREATE,
      Permission.ORDER_UPDATE,
      Permission.ORDER_REGENERATE_LINK,
    ],
  },
  {
    label: "Consent & documents",
    permissions: [
      Permission.CONSENT_VIEW,
      Permission.DOCUMENT_VIEW,
      Permission.DOCUMENT_ISSUE,
    ],
  },
  {
    label: "Catalog",
    permissions: [Permission.ITEM_TYPE_VIEW, Permission.ITEM_VIEW],
  },
  { label: "Email", permissions: [Permission.EMAIL_TEMPLATE_VIEW] },
];

export function ManagePermissionsDialog({
  user,
  open,
  onOpenChange,
}: ManagePermissionsDialogProps) {
  const router = useRouter();
  const [mode, setMode] = useState<MemberPermissionMode>(
    user.permissionMode ?? "full",
  );
  const [granted, setGranted] = useState<Set<string>>(
    () => new Set(user.permissions ?? []),
  );

  // Any grantable permission not placed in a named group above — keeps the
  // checklist exhaustive over MEMBER_FULL_PERMISSIONS even if a new key is
  // added later without touching this file's groups.
  const groups = useMemo(() => {
    const placed = new Set(GROUPS.flatMap((g) => g.permissions));
    const leftover = MEMBER_FULL_PERMISSIONS.filter((p) => !placed.has(p));
    return leftover.length > 0
      ? [...GROUPS, { label: "More", permissions: leftover }]
      : GROUPS;
  }, []);

  function toggle(permission: string, checked: boolean) {
    setGranted((prev) => {
      const next = new Set(prev);
      if (checked) next.add(permission);
      else next.delete(permission);
      return next;
    });
  }

  async function onSubmit() {
    try {
      await api.patch<PublicUser>(`/api/admin/users/${user.id}/permissions`, {
        permissionMode: mode,
        // When Full, send no grants — the server ignores them anyway, but
        // this keeps the request honest and the audit trail clean.
        permissions: mode === "custom" ? [...granted] : [],
      });
      toast.success("Permissions updated");
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : "Could not update permissions";
      toast.error(message);
    }
  }

  const grantedCount = granted.size;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Permissions for ${user.name}`}
      description="Choose what this member can do in the workspace."
      icon={<ShieldCheckIcon />}
      tone="info"
      size="lg"
      submitLabel="Save permissions"
      onSubmit={onSubmit}
      footerLeading={
        mode === "custom"
          ? `${grantedCount} of ${MEMBER_FULL_PERMISSIONS.length} selected`
          : undefined
      }
    >
      <div className="space-y-5">
        {/* Full vs Custom — a two-option segmented control (no new radio
            primitive; just buttons). */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {(
            [
              {
                value: "full" as const,
                title: "Full permissions",
                blurb: "Everything a member needs to operate the workspace.",
              },
              {
                value: "custom" as const,
                title: "Custom permissions",
                blurb: "Pick exactly what this member can do.",
              },
            ]
          ).map((opt) => {
            const active = mode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setMode(opt.value)}
                aria-pressed={active}
                className={cn(
                  "rounded-lg border px-4 py-3 text-left transition-colors",
                  active
                    ? "border-primary bg-primary/5 ring-1 ring-primary/30"
                    : "border-border bg-card hover:bg-surface-1",
                )}
              >
                <div className="text-[13px] font-medium text-foreground">
                  {opt.title}
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground leading-relaxed">
                  {opt.blurb}
                </div>
              </button>
            );
          })}
        </div>

        <p className="rounded-md border border-border bg-surface-1 px-3 py-2 text-[12px] text-muted-foreground leading-relaxed">
          Full permissions is everything a member needs to operate the
          workspace — it is <strong className="text-foreground">not</strong>{" "}
          owner access. Only the owner controls billing, gateways, team,
          workspace settings and the audit log.
        </p>

        {mode === "custom" ? (
          <div className="space-y-5">
            {groups.map((group) => (
              <div key={group.label}>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                  {group.label}
                </div>
                <div className="space-y-2.5">
                  {group.permissions.map((p) => {
                    const checked = granted.has(p);
                    return (
                      <label
                        key={p}
                        className="flex cursor-pointer items-start gap-3"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => toggle(p, v === true)}
                          className="mt-0.5"
                        />
                        <span className="min-w-0">
                          <span className="block text-[13px] text-foreground leading-tight">
                            {PermissionLabel[p] ?? p}
                          </span>
                          {PermissionDescription[p] ? (
                            <span className="block text-[11.5px] text-muted-foreground leading-snug">
                              {PermissionDescription[p]}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </FormDialog>
  );
}
