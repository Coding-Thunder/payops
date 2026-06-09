import Link from "next/link";
import {
  FilePenLineIcon,
  MailIcon,
  PlusIcon,
  SparklesIcon,
  WrenchIcon,
} from "lucide-react";

import { NewCustomTemplateButton } from "@/components/features/email-templates/new-custom-template-button";
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
import { Permission } from "@/lib/constants/permissions";
import { requirePermission } from "@/server/auth/session";
import { listAllTemplatesSummary } from "@/server/services/email-template.service";

export const metadata = { title: "Email templates" };
export const dynamic = "force-dynamic";

/**
 * Two sections: System (platform-defined kinds, always present) and
 * Custom (tenant-defined, can be empty until the operator creates
 * one). Both render the same card shape so the visual hierarchy is
 * consistent.
 */
export default async function AdminEmailTemplatesIndex() {
  const user = await requirePermission(Permission.EMAIL_TEMPLATE_VIEW);
  if (!user.orgId) {
    return (
      <div className="space-y-6">
        <PageHeader
          eyebrow="Admin"
          title="Email templates"
          description="Active organization required."
        />
      </div>
    );
  }

  const summaries = await listAllTemplatesSummary(user.orgId);
  const system = summaries.filter((s) => s.kind === "system");
  const custom = summaries.filter((s) => s.kind === "custom");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Admin"
        title="Email templates"
        description="System templates ship with the platform; custom templates are yours to name, edit, and send manually from any order, customer, or payment screen."
        actions={<NewCustomTemplateButton />}
      />

      <section className="space-y-3">
        <SectionHeading
          icon={WrenchIcon}
          title="System templates"
          subtitle="Platform-defined, always present. Edit the copy to match your brand voice."
        />
        <div className="grid gap-4 md:grid-cols-2">
          {system.map((card) => (
            <TemplateCard
              key={card.templateKey}
              templateKey={card.templateKey}
              displayName={card.displayName}
              description={card.description}
              kind="system"
              hasActiveVersion={card.hasActiveVersion}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading
          icon={SparklesIcon}
          title="Custom templates"
          subtitle="Tenant-defined. Name them, draft the copy, then fire from any order or customer surface."
        />
        {custom.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-start gap-3 pt-6 pb-6">
              <p className="text-[13.5px] text-muted-foreground">
                No custom templates yet. Create one for &ldquo;Payment
                Reminder&rdquo;, &ldquo;Booking Confirmation&rdquo;, or any
                ad-hoc message your team sends repeatedly.
              </p>
              <NewCustomTemplateButton variant="outline" />
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {custom.map((card) => (
              <TemplateCard
                key={card.templateKey}
                templateKey={card.templateKey}
                displayName={card.displayName}
                description={card.description}
                kind="custom"
                hasActiveVersion={card.hasActiveVersion}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface TemplateCardProps {
  templateKey: string;
  displayName: string;
  description: string | null;
  kind: "system" | "custom";
  hasActiveVersion: boolean;
}

function TemplateCard({
  templateKey,
  displayName,
  description,
  kind,
  hasActiveVersion,
}: TemplateCardProps) {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <MailIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{displayName}</span>
            </CardTitle>
            <CardDescription className="break-words">
              {description ?? "Tenant-defined transactional template."}
            </CardDescription>
          </div>
          <Badge variant={hasActiveVersion ? "info" : "muted"}>
            {hasActiveVersion
              ? kind === "custom"
                ? "Live"
                : "Customised"
              : "System default"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        <p className="font-mono text-[11px] text-muted-foreground">
          key: {templateKey}
        </p>
      </CardContent>
      <CardFooter className="justify-end gap-2">
        <Button asChild size="sm">
          <Link href={`/app/admin/email-templates/${templateKey}`}>
            <FilePenLineIcon className="size-3.5" />
            Edit
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

function SectionHeading({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 size-3.5 text-muted-foreground" aria-hidden />
      <div>
        <h2 className="text-[13px] font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        <p className="text-[12px] text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}
