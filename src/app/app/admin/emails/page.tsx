import Link from "next/link";
import { render } from "@react-email/render";

import { PageHeader } from "@/components/common/page-header";
import { Permission } from "@/lib/constants/permissions";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { UniversalOrderEmail } from "@/server/email/templates/universal-order-email";
import {
  buildPaymentPreviewProps,
  buildPaymentRequestPreviewProps,
} from "@/server/email/preview-data";

export const metadata = { title: "Email previews" };
export const dynamic = "force-dynamic";

const TEMPLATES = [
  {
    key: "payment-confirmation",
    label: "Payment confirmation",
    description: "Sent automatically once Stripe confirms payment.",
  },
  {
    key: "payment-request",
    label: "Payment request",
    description: "Sent by an agent right after order creation with the Stripe link.",
  },
] as const;

type TemplateKey = (typeof TEMPLATES)[number]["key"];

function isTemplateKey(value: string | undefined): value is TemplateKey {
  return TEMPLATES.some((t) => t.key === value);
}

interface EmailsPageProps {
  searchParams: Promise<{
    template?: string;
  }>;
}

export default async function AdminEmailsPage({
  searchParams,
}: EmailsPageProps) {
  const user = await requirePermission(Permission.SETTINGS_VIEW);

  // Per-tenant: branding + settings come from THIS admin's workspace,
  // not the legacy singleton (which would env-default to "Rental
  // Confirmation" et al).
  const [branding, settings] = await Promise.all([
    getBranding(user.orgId),
    ensureSettingsDocument(user.orgId),
  ]);

  const params = await searchParams;
  const activeTemplate: TemplateKey = isTemplateKey(params.template)
    ? params.template
    : "payment-confirmation";

  const baseArgs = {
    brandName: branding.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    cancellationPolicy: settings.cancellationPolicy,
    cancellationPolicyVersion: settings.cancellationPolicyVersion,
  };

  const html =
    activeTemplate === "payment-request"
      ? await render(
          <UniversalOrderEmail {...buildPaymentRequestPreviewProps(baseArgs)} />,
        )
      : await render(
          <UniversalOrderEmail {...buildPaymentPreviewProps(baseArgs)} />,
        );

  const activeTemplateLabel = TEMPLATES.find((t) => t.key === activeTemplate)!
    .label;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Email previews"
        description="Live preview of customer-facing transactional emails. Sample data only, nothing is sent."
      />

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-3">
          <TemplateListCard activeKey={activeTemplate} />
        </aside>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight">
              {activeTemplateLabel}
            </h2>
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
            <iframe
              title="Email preview"
              srcDoc={html}
              className="block h-[820px] w-full border-0 bg-white"
              sandbox="allow-same-origin"
            />
          </div>
        </section>
      </div>
    </div>
  );
}

function TemplateListCard({ activeKey }: { activeKey: TemplateKey }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Templates
        </p>
      </div>
      <ul className="divide-y divide-border">
        {TEMPLATES.map((t) => {
          const active = t.key === activeKey;
          const search = new URLSearchParams({ template: t.key });
          return (
            <li
              key={t.key}
              className={cn(
                "text-[13px] transition-colors",
                active ? "bg-muted/40" : "hover:bg-muted/20",
              )}
            >
              <Link
                href={`/app/admin/emails?${search.toString()}`}
                className="block px-4 py-3"
              >
                <p
                  className={cn(
                    "font-medium",
                    active ? "text-foreground" : "text-foreground/85",
                  )}
                >
                  {t.label}
                </p>
                <p className="mt-1 text-[11.5px] leading-snug text-muted-foreground">
                  {t.description}
                </p>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
