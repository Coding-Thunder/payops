import { render } from "@react-email/render";

import { PageHeader } from "@/components/common/page-header";
import { EmailPreviewControls } from "@/components/features/emails/email-preview-controls";
import { Permission } from "@/lib/constants/permissions";
import { BookingType, BOOKING_TYPES } from "@/lib/constants/enums";
import { env } from "@/lib/env";
import { requirePermission } from "@/server/auth/session";
import { getBranding } from "@/server/services/branding.service";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import { listActiveProviders } from "@/server/services/provider.service";
import { PaymentConfirmationEmail } from "@/server/email/templates/payment-confirmation";
import { buildPaymentPreviewProps } from "@/server/email/preview-data";

export const metadata = { title: "Email previews" };
export const dynamic = "force-dynamic";

interface EmailsPageProps {
  searchParams: Promise<{
    provider?: string;
    bookingType?: string;
  }>;
}

export default async function AdminEmailsPage({
  searchParams,
}: EmailsPageProps) {
  await requirePermission(Permission.SETTINGS_VIEW);

  const [branding, settings, providers] = await Promise.all([
    getBranding(),
    ensureSettingsDocument(),
    listActiveProviders(),
  ]);

  const params = await searchParams;
  const activeProvider =
    providers.find((p) => p.key === params.provider) ?? providers[0] ?? null;
  const activeBookingType = (
    BOOKING_TYPES as readonly string[]
  ).includes(params.bookingType ?? "")
    ? (params.bookingType as BookingType)
    : BookingType.NEW_BOOKING;

  if (!activeProvider) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Admin"
          title="Email previews"
          description="Preview the customer transactional emails that this workspace sends."
        />
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          No active providers configured. Visit <strong>Admin → Providers</strong>{" "}
          to set one up before previewing the customer receipt.
        </div>
      </div>
    );
  }

  const props = buildPaymentPreviewProps({
    brandName: branding.brandName,
    appUrl: env.server.APP_URL,
    supportEmail: branding.supportEmail,
    supportPhone: branding.supportPhone,
    provider: {
      id: activeProvider.key,
      name: activeProvider.name,
      logo: activeProvider.logo,
      primaryColor: activeProvider.primaryColor,
      onPrimaryColor: activeProvider.onPrimaryColor,
    },
    cancellationPolicy: settings.cancellationPolicy,
    cancellationPolicyVersion: settings.cancellationPolicyVersion,
    bookingType: activeBookingType,
  });
  const html = await render(<PaymentConfirmationEmail {...props} />);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Email previews"
        description="Live preview of customer-facing transactional emails. Sample data only — nothing is sent."
      />

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-3">
          <TemplateListCard activeKey="payment-confirmation" />
          <EmailPreviewControls
            providers={providers.map((p) => ({
              key: p.key,
              name: p.name,
            }))}
            activeProvider={activeProvider.key}
            activeBookingType={activeBookingType}
          />
        </aside>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight">
              Payment confirmation
            </h2>
            <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {activeProvider.name} · {activeBookingType.replace("_", " ").toLowerCase()}
            </span>
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

function TemplateListCard({ activeKey }: { activeKey: string }) {
  const templates = [
    {
      key: "payment-confirmation",
      label: "Payment confirmation",
      description: "Sent to the customer once Stripe confirms payment.",
    },
  ] as const;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Templates
        </p>
      </div>
      <ul className="divide-y divide-border">
        {templates.map((t) => {
          const active = t.key === activeKey;
          return (
            <li
              key={t.key}
              className={`px-4 py-3 text-[13px] ${
                active ? "bg-muted/40" : ""
              }`}
            >
              <p className="font-medium text-foreground">{t.label}</p>
              <p className="mt-1 text-[11.5px] text-muted-foreground leading-snug">
                {t.description}
              </p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
