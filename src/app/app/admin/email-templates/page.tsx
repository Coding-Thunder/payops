import Link from "next/link";
import { FilePenLineIcon, MailIcon } from "lucide-react";

import { PageHeader } from "@/components/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  EMAIL_TEMPLATE_KEYS,
  type EmailTemplateKey,
} from "@/lib/constants/email-templates";
import { Permission } from "@/lib/constants/permissions";
import { formatDateTime } from "@/lib/format";
import { requirePermission } from "@/server/auth/session";
import {
  getActiveTemplate,
  listTemplateVersions,
} from "@/server/services/email-template.service";

export const metadata = { title: "Email templates" };
export const dynamic = "force-dynamic";

interface TemplateCardData {
  key: EmailTemplateKey;
  label: string;
  purpose: string;
  activeVersion: number | null;
  totalVersions: number;
  lastUpdatedAt: string | null;
}

const TEMPLATE_META: Record<
  EmailTemplateKey,
  { label: string; purpose: string }
> = {
  "payment-request": {
    label: "Payment request",
    purpose:
      "Sent by an agent from the composer. Contains the consent CTA and the Stripe payment link.",
  },
  "payment-confirmation": {
    label: "Payment confirmation",
    purpose:
      "Sent automatically after Stripe confirms a payment. The customer's receipt and booking summary.",
  },
};

/**
 * Two-template list view.
 *
 * Linear, equal-citizen layout: both `payment-request` AND
 * `payment-confirmation` are surfaced as separate first-class cards. No
 * more redirect-to-default. Each card shows the active version, total
 * version count, last-updated stamp, and an "Edit" CTA that routes to
 * the isolated editor for that template (separate version histories).
 */
export default async function AdminEmailTemplatesIndex() {
  await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);

  const cards: TemplateCardData[] = await Promise.all(
    EMAIL_TEMPLATE_KEYS.map(async (key) => {
      const [active, versions] = await Promise.all([
        getActiveTemplate(key),
        listTemplateVersions(key),
      ]);
      return {
        key,
        label: TEMPLATE_META[key].label,
        purpose: TEMPLATE_META[key].purpose,
        activeVersion: active?.version ?? null,
        totalVersions: versions.length,
        lastUpdatedAt: versions[0]?.updatedAt ?? null,
      };
    }),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Email templates"
        description="Customer transactional email copy, versioned per template. Each template has its own history and editor."
      />

      <div className="grid gap-4 md:grid-cols-2">
        {cards.map((card) => (
          <Card key={card.key} className="flex flex-col">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <MailIcon
                      className="size-4 text-muted-foreground"
                      aria-hidden
                    />
                    {card.label}
                  </CardTitle>
                  <CardDescription>{card.purpose}</CardDescription>
                </div>
                {card.activeVersion != null ? (
                  <Badge variant="info">v{card.activeVersion}</Badge>
                ) : (
                  <Badge variant="muted">System default</Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 space-y-2 text-[12.5px]">
              <Row label="Active version">
                {card.activeVersion != null
                  ? `v${card.activeVersion}`
                  : "Built-in fallback (no override saved)"}
              </Row>
              <Row label="Versions">
                {card.totalVersions === 0
                  ? "—"
                  : `${card.totalVersions} version${card.totalVersions === 1 ? "" : "s"}`}
              </Row>
              <Row label="Last updated">
                {card.lastUpdatedAt
                  ? formatDateTime(card.lastUpdatedAt)
                  : "—"}
              </Row>
            </CardContent>
            <CardFooter className="flex justify-end gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link
                  href={`/app/admin/emails?template=${card.key}`}
                  prefetch={false}
                >
                  Preview
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link href={`/app/admin/email-templates/${card.key}`}>
                  <FilePenLineIcon className="size-3.5" />
                  Edit
                </Link>
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}
