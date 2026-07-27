import Link from "next/link";
import { CheckIcon, ChevronRightIcon, MinusIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/common/section";
import { memberPermissionGroups } from "@/lib/constants/permission-groups";
import { PermissionDescription, PermissionLabel } from "@/lib/constants/labels";
import type { MemberPermissionMode, WorkspaceRole } from "@/lib/constants/permissions";
import { cn } from "@/lib/utils";

interface MyAccessCardProps {
  workspaceRole: WorkspaceRole;
  permissionMode?: MemberPermissionMode;
  /** The viewer's EFFECTIVE permission keys — what they can actually do. */
  effectivePermissions: readonly string[];
}

/**
 * Read-only transparency card. Shows a member exactly what they can do in the
 * workspace and that access is owner-controlled. Owners see a short "you
 * control everything" summary instead of the member checklist.
 */
export function MyAccessCard({
  workspaceRole,
  permissionMode,
  effectivePermissions,
}: MyAccessCardProps) {
  if (workspaceRole === "OWNER") {
    return (
      <Section
        title="My Access"
        description="What you can do in this workspace."
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge variant="success">Owner</Badge>
            <span className="text-[13px] text-foreground">
              Full workspace control
            </span>
          </div>
          <p className="text-[12.5px] text-muted-foreground leading-relaxed">
            You control everything in this workspace — branding, billing,
            gateways, team, settings, and the audit log.
          </p>
          <Link
            href="/app/admin/settings"
            className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"
          >
            Open Workspace settings
            <ChevronRightIcon className="size-4" />
          </Link>
        </div>
      </Section>
    );
  }

  const granted = new Set(effectivePermissions);
  const groups = memberPermissionGroups();

  return (
    <Section
      title="My Access"
      description="What you can do in this workspace. Your access is set by the workspace owner."
      action={
        <Badge variant={permissionMode === "custom" ? "info" : "secondary"}>
          {permissionMode === "custom" ? "Custom access" : "Full access"}
        </Badge>
      }
    >
      <div className="space-y-5">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
              {group.label}
            </div>
            <div className="space-y-2.5">
              {group.permissions.map((p) => {
                const has = granted.has(p);
                return (
                  <div key={p} className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px]",
                        has
                          ? "bg-success-soft text-success"
                          : "bg-surface-1 text-muted-foreground/50",
                      )}
                      aria-hidden
                    >
                      {has ? (
                        <CheckIcon className="size-3" />
                      ) : (
                        <MinusIcon className="size-3" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block text-[13px] leading-tight",
                          has
                            ? "text-foreground"
                            : "text-muted-foreground/70",
                        )}
                      >
                        {PermissionLabel[p] ?? p}
                      </span>
                      {PermissionDescription[p] ? (
                        <span className="block text-[11.5px] text-muted-foreground leading-snug">
                          {PermissionDescription[p]}
                        </span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <p className="rounded-md border border-border bg-surface-1 px-3 py-2 text-[12px] text-muted-foreground leading-relaxed">
          Need different access? Ask a workspace owner to update your
          permissions.
        </p>
      </div>
    </Section>
  );
}
