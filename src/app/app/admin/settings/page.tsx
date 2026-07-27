import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { Section } from "@/components/common/section";
import { MyAccountCard } from "@/components/features/settings/my-account-card";
import { SettingsForm } from "@/components/features/settings/settings-form";
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import {
  getSettings,
  ensureSettingsDocument,
} from "@/server/services/settings.service";
import { getUserById } from "@/server/services/user.service";

export const metadata = { title: "Workspace settings" };
export const dynamic = "force-dynamic";

/** Server-safe cross-link row to a standalone owner-config page. */
function CrossLinkRow({
  href,
  label,
  hint,
}: {
  href: string;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-1 px-3 py-2 text-[13px] transition-colors hover:bg-surface-2"
    >
      <span className="min-w-0">
        <span className="font-medium text-foreground">{label}</span>{" "}
        <span className="text-muted-foreground">— {hint}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

export default async function AdminSettingsPage() {
  // SETTINGS_VIEW is owner-only (MEMBER_RESTRICTED), so only a workspace
  // OWNER ever reaches this page. Members are gated out at the nav + here.
  const user = await requirePermission(Permission.SETTINGS_VIEW);
  if (!user.orgId) {
    throw new Error("Active organization required to view settings");
  }
  await ensureSettingsDocument(user.orgId);
  const [settings, branding, me] = await Promise.all([
    getSettings(user.orgId),
    getBranding(user.orgId),
    getUserById(user.id, { orgId: user.orgId }),
  ]);

  const can = (p: Permission) => user.permissions.has(p);
  const canEdit = can(Permission.SETTINGS_UPDATE);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspace settings"
        description="Everything you control as the workspace owner — branding, invoices, payments, consent, policy, your team, and your account."
      />

      <Section
        title="Workspace"
        description="Your brand name, logo, colours, and support contact — shown on emails, payment pages, and receipts."
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 py-0.5">
            <span className="text-[12.5px] text-muted-foreground">
              Brand name
            </span>
            <span className="text-[13px] font-medium text-foreground">
              {branding.brandName || "Not set"}
            </span>
          </div>
          {can(Permission.BRANDING_VIEW) ? (
            <CrossLinkRow
              href="/app/admin/branding"
              label="Manage branding"
              hint="Name, logo, colours & support contact"
            />
          ) : null}
        </div>
      </Section>

      <SettingsForm
        initial={{
          paymentExpiryHours: settings.paymentExpiryHours,
          orderPrefix: settings.orderPrefix,
          defaultCurrency: settings.defaultCurrency,
          successRedirectUrl: settings.successRedirectUrl,
          cancelRedirectUrl: settings.cancelRedirectUrl,
          cancellationPolicy: settings.cancellationPolicy,
          consentMode: settings.consentMode,
          consentMessage: settings.consentMessage,
        }}
        canEdit={canEdit}
        policyVersion={settings.cancellationPolicyVersion}
        crossLinks={{
          emailTemplates: can(Permission.EMAIL_TEMPLATE_VIEW),
          emailPreviews: can(Permission.SETTINGS_VIEW),
          workflow: can(Permission.WORKFLOW_VIEW),
          gateways: can(Permission.GATEWAY_VIEW),
        }}
      />

      {can(Permission.USER_VIEW) ? (
        <Section
          title="Team & Permissions"
          description="Who's in the workspace and exactly what each member can do."
        >
          <CrossLinkRow
            href="/app/admin/users"
            label="Manage team & permissions"
            hint="Invite members, set Full or Custom access"
          />
        </Section>
      ) : null}

      {can(Permission.AUDIT_VIEW) ? (
        <Section
          title="Advanced"
          description="The audit trail and owner-reserved capabilities. Destructive and integration actions stay with the owner."
        >
          <CrossLinkRow
            href="/app/admin/audit"
            label="Audit log"
            hint="A record of every significant action, for dispute defence"
          />
        </Section>
      ) : null}

      <MyAccountCard
        name={user.name}
        email={user.email}
        workspaceRole={user.workspaceRole}
        lastLoginAt={me.lastLoginAt ?? null}
        createdAt={me.createdAt ?? null}
      />
    </div>
  );
}
