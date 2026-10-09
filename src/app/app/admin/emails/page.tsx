import Link from "next/link";
import { redirect } from "next/navigation";

import { PageHeader } from "@/components/common/page-header";
import { EmailPreviewControls } from "@/components/features/emails/email-preview-controls";
import { Permission } from "@/lib/constants/permissions";
import { BookingType, BOOKING_TYPES, ServiceType } from "@/lib/constants/enums";
import { ServiceTypeLabel } from "@/lib/constants/labels";
import { cn } from "@/lib/utils";
import { getSelectedOrganization } from "@/server/auth/organization";
import { requirePermission } from "@/server/auth/session";
import { ensureSettingsDocument } from "@/server/services/settings.service";
import {
  parsePreviewService,
  previewServicesFor,
  renderEmailPreview,
} from "@/server/email/preview";

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
  {
    key: "payment-authorized",
    label: "Payment authorized",
    description:
      "Sent when a manual-capture payment is held on the card, before it is charged.",
  },
] as const;

type TemplateKey = (typeof TEMPLATES)[number]["key"];

function isTemplateKey(value: string | undefined): value is TemplateKey {
  return TEMPLATES.some((t) => t.key === value);
}

interface EmailsPageProps {
  searchParams: Promise<{
    template?: string;
    provider?: string;
    bookingType?: string;
    service?: string;
  }>;
}

export default async function AdminEmailsPage({
  searchParams,
}: EmailsPageProps) {
  await requirePermission(Permission.SETTINGS_VIEW);
  await ensureSettingsDocument();

  const params = await searchParams;
  // A preview's T&C come from exactly two inputs, both explicit: the
  // selected organization, and the service named in the URL — one the
  // organization sells. A missing or unsold service is never guessed into
  // a default: the page redirects so the URL (and the selector) names it.
  const organization = await getSelectedOrganization();
  const services = await previewServicesFor(organization?.id ?? null);
  const requested = parsePreviewService(params.service);
  if (!requested || !services.includes(requested)) {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && key !== "service") next.set(key, value);
    }
    next.set("service", services[0]!);
    redirect(`/app/admin/emails?${next.toString()}`);
  }
  const activeService: ServiceType = requested;

  const activeTemplate: TemplateKey = isTemplateKey(params.template)
    ? params.template
    : "payment-confirmation";
  const activeBookingType = (
    BOOKING_TYPES as readonly string[]
  ).includes(params.bookingType ?? "")
    ? (params.bookingType as BookingType)
    : BookingType.NEW_BOOKING;

  const { html, providers, provider: activeProvider } = await renderEmailPreview({
    organizationId: organization?.id ?? null,
    serviceType: activeService,
    templateKey: activeTemplate,
    providerKey: params.provider,
    bookingType: activeBookingType,
  });

  if (!activeProvider) {
    const other = services.find((s) => s !== activeService);
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Admin"
          title="Email previews"
          description="Preview the customer transactional emails that this workspace sends."
        />
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          {`No active ${ServiceTypeLabel[activeService].toLowerCase()} providers configured. Visit `}
          <strong>Admin → Providers</strong> to set one up before previewing
          the customer emails
          {other ? (
            <>
              {", or preview the "}
              <Link className="underline" href={`?service=${other}`}>
                {ServiceTypeLabel[other].toLowerCase()} emails
              </Link>
            </>
          ) : null}
          .
        </div>
      </div>
    );
  }

  const activeTemplateLabel = TEMPLATES.find((t) => t.key === activeTemplate)!
    .label;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Email previews"
        description="Live preview of customer-facing transactional emails. Sample data only — nothing is sent."
      />

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-3">
          <TemplateListCard
            activeKey={activeTemplate}
            provider={activeProvider.key}
            bookingType={activeBookingType}
            service={activeService}
          />
          <EmailPreviewControls
            providers={providers.map((p) => ({ key: p.key, name: p.name }))}
            activeProvider={activeProvider.key}
            activeBookingType={activeBookingType}
            services={services}
            activeService={activeService}
          />
        </aside>

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight">
              {activeTemplateLabel}
            </h2>
            <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {ServiceTypeLabel[activeService]} · {activeProvider.name} ·{" "}
              {activeBookingType.replace("_", " ").toLowerCase()}
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

function TemplateListCard({
  activeKey,
  provider,
  bookingType,
  service,
}: {
  activeKey: TemplateKey;
  provider: string;
  bookingType: BookingType;
  service: ServiceType;
}) {
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
          const search = new URLSearchParams({
            template: t.key,
            provider,
            bookingType,
            service,
          });
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
