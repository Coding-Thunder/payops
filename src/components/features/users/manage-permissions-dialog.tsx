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
  type MemberPermissionMode,
} from "@/lib/constants/permissions";
import { memberPermissionGroups } from "@/lib/constants/permission-groups";
import { PermissionDescription, PermissionLabel } from "@/lib/constants/labels";
import { cn } from "@/lib/utils";
import type { PublicUser } from "@/types";

interface ManagePermissionsDialogProps {
  user: PublicUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

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

  // Shared, exhaustive-over-MEMBER_FULL_PERMISSIONS grouping (see
  // permission-groups.ts) — the same source the read-only My Access view uses.
  const groups = useMemo(() => memberPermissionGroups(), []);

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
