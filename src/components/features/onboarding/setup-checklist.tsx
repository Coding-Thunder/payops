import Link from "next/link";
import { ArrowRightIcon, CheckIcon, CircleDashedIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { OnboardingState } from "@/server/services/onboarding-state.service";

/**
 * Dashboard setup-checklist banner. Server-rendered (no client JS),
 * shown ONLY when the state is incomplete + the org isn't the legacy
 * tenant. A finished checklist is hidden — we don't want a permanent
 * "all done!" cheerleader on the dashboard.
 *
 * Steps render as a vertical list with a status pip + label + small
 * CTA per step. Done steps stay visible (struck through-ish) so the
 * founder sees what they've already accomplished.
 *
 * Optional step (team) is rendered separately because it isn't part
 * of the "you can take payments" critical path — most solo founders
 * never invite anyone.
 */
interface SetupChecklistProps {
  state: OnboardingState;
}

interface ChecklistItem {
  key: keyof OnboardingState["steps"];
  label: string;
  description: string;
  href: string;
  cta: string;
}

const ITEMS: ChecklistItem[] = [
  {
    key: "gatewayConfigured",
    label: "Connect Stripe",
    description:
      "Paste your secret key — we verify it and register the webhook endpoint automatically. Until you do, new orders can't generate payment links.",
    href: "/app/admin/gateways",
    cta: "Connect Stripe",
  },
  {
    key: "businessSetupDone",
    label: "Set up what you sell",
    description:
      "Pick your business type and we'll preconfigure the order form + emails. Takes 2 minutes.",
    href: "/app/onboarding/business-setup",
    cta: "Start setup",
  },
  {
    key: "brandingSet",
    label: "Brand your customer emails",
    description:
      "Set your brand name, logo, and support contact. These appear on every payment-request and confirmation email.",
    href: "/app/admin/branding",
    cta: "Edit branding",
  },
  {
    key: "firstOrderCreated",
    label: "Create your first order",
    description:
      "Capture a customer + amount, generate a payment link, and send it. The dispute-grade evidence chain starts on order creation.",
    href: "/app/orders/create",
    cta: "Create order",
  },
];

const OPTIONAL_ITEM: ChecklistItem = {
  key: "teamMemberAdded",
  label: "Invite a teammate",
  description:
    "Add a second user so your account isn't a single point of failure. (Optional — solo operators can skip.)",
  href: "/app/admin/users",
  cta: "Invite teammate",
};

export function SetupChecklist({ state }: SetupChecklistProps) {
  if (state.complete) return null;

  const completedRequired = ITEMS.filter((i) => state.steps[i.key]).length;
  const totalRequired = ITEMS.length;

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-[15px]">Finish setting up</CardTitle>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {completedRequired} of {totalRequired} complete
          </span>
        </div>
        <p className="text-[12px] text-muted-foreground leading-relaxed">
          A few quick steps before you can start collecting payments.
          Each step takes a couple of minutes.
        </p>
      </CardHeader>
      <CardContent className="pt-0">
        <ul className="divide-y divide-border/60">
          {ITEMS.map((item) => (
            <ChecklistRow
              key={item.key}
              item={item}
              done={state.steps[item.key]}
            />
          ))}
          <ChecklistRow
            item={OPTIONAL_ITEM}
            done={state.steps[OPTIONAL_ITEM.key]}
            optional
          />
        </ul>
      </CardContent>
    </Card>
  );
}

function ChecklistRow({
  item,
  done,
  optional,
}: {
  item: ChecklistItem;
  done: boolean;
  optional?: boolean;
}) {
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span
        className={cn(
          "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full",
          done
            ? "bg-emerald-500/15 text-emerald-600"
            : "bg-muted text-muted-foreground",
        )}
        aria-hidden
      >
        {done ? (
          <CheckIcon className="size-3" />
        ) : (
          <CircleDashedIcon className="size-3" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              "text-[13px] font-medium",
              done ? "text-muted-foreground line-through" : "text-foreground",
            )}
          >
            {item.label}
          </span>
          {optional ? (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 font-medium">
              Optional
            </span>
          ) : null}
        </div>
        {!done ? (
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            {item.description}
          </p>
        ) : null}
      </div>
      {!done ? (
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <Link href={item.href}>
            {item.cta}
            <ArrowRightIcon className="size-3" />
          </Link>
        </Button>
      ) : null}
    </li>
  );
}
