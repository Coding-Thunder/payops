import Link from "next/link";
import {
  FilePenLineIcon,
  MailIcon,
  SparklesIcon,
  ZapIcon,
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
 * Two sections, and the split is the point.
 *
 * AUTOMATED emails are fired by product events — an invoice is created,
 * a payment settles — and carry an order-shaped layout with line items
 * and a payment CTA. You can rewrite their words; you can't rewrite when
 * they go, because the workflow owns that.
 *
 * CUSTOM templates are messages your team writes and reuses: a project
 * update, a meeting invite, a document request. They're sent by a person
 * from a client's profile, whenever that person decides to.
 *
 * Mixing the two is what let an operator pick "Meeting Time" from a
 * picker and receive a Payment Receipt.
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
        description="Automated emails fire on payment events — edit their wording, not their trigger. Custom templates are yours to write and send from any client."
        actions={<NewCustomTemplateButton />}
      />

      <section className="space-y-3">
        <SectionHeading
          icon={ZapIcon}
          title="Automated emails"
          subtitle="Sent automatically by the payment workflow. Customise the copy to match your brand voice; the trigger stays wired to the event."
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
          subtitle="Write once, reuse everywhere. Client and order details fill themselves in when you send."
        />
        {custom.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-start gap-3 pt-6 pb-6">
              <p className="text-[13.5px] text-muted-foreground">
                No custom templates yet. Create one for &ldquo;Project
                Update&rdquo;, &ldquo;Meeting Invitation&rdquo;, &ldquo;Document
                Request&rdquo;, or any message your team sends more than once.
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
                ? "Ready to send"
                : "Customised"
              : "Default copy"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        <p className="text-[11.5px] text-muted-foreground">
          {kind === "system"
            ? "Fires automatically on the matching payment event."
            : "Send it from any client profile."}
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
