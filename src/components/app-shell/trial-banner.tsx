import { ClockIcon, MailIcon } from "lucide-react";

import { logger } from "@/lib/logger";
import {
  getTrialState,
  maybeFireTrialEndingSoonEmail,
} from "@/server/services/billing.service";

interface TrialBannerProps {
  orgId: string | null;
}

/**
 * Workspace-wide trial timer banner.
 *
 * Renders nothing when the trial has plenty of time left, an amber
 * "X days left" hint inside the warn window, and a red expired bar
 * once the gate has slammed shut. Server component so the banner
 * paints on first navigation without a flash from a client fetch.
 *
 * Side effect: when atRisk for the first time, atomically claims
 * Organization.trialWarnEmailSentAt + fires the one-shot trial-
 * ending-soon email. Banner-triggered (rather than cron-driven) is
 * acceptable for the current scale; the claim is atomic so concurrent
 * page loads won't double-send.
 */
export async function TrialBanner({ orgId }: TrialBannerProps) {
  const trial = await getTrialState(orgId);
  if (!trial) return null;
  if (!trial.expired && !trial.atRisk) return null;

  // Fire-and-forget heads-up email. Atomic claim inside the helper
  // guards against double-send on concurrent renders. Failure logs but
  // doesn't break the banner.
  if (trial.atRisk && orgId) {
    void maybeFireTrialEndingSoonEmail(orgId).catch((err) => {
      logger.error("trial.warn_email_dispatch_failed", {
        err: err instanceof Error ? err.message : String(err),
        orgId,
      });
    });
  }

  if (trial.expired) {
    const dayLabel = Math.abs(trial.daysRemaining);
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-2.5 text-[12.5px]"
        style={{
          background:
            "color-mix(in oklch, var(--destructive) 10%, white)",
          color: "var(--destructive)",
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ClockIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">
            Trial ended {dayLabel} day{dayLabel === 1 ? "" : "s"} ago.
          </span>
          <span className="text-foreground/70 hidden sm:inline">
            New order creation is paused, existing orders stay editable.
          </span>
        </div>
        <a
          href="mailto:earlyaccess@tracetxn.com?subject=TraceTxn%20trial%20extension"
          className="inline-flex items-center gap-1.5 font-medium underline-offset-4 hover:underline"
        >
          <MailIcon className="size-3.5" />
          Email early access to continue
        </a>
      </div>
    );
  }

  // At-risk: warn band, not a hard signal.
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-2 text-[12px]"
      style={{
        background:
          "color-mix(in oklch, var(--warning, oklch(0.7 0.16 78)) 10%, white)",
        color: "var(--warning-strong, oklch(0.42 0.16 78))",
      }}
    >
      <div className="flex items-center gap-2">
        <ClockIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">
          {trial.daysRemaining} day{trial.daysRemaining === 1 ? "" : "s"} left
          on your evaluation trial.
        </span>
      </div>
      <a
        href="mailto:earlyaccess@tracetxn.com?subject=TraceTxn%20plan%20enquiry"
        className="text-[11.5px] underline-offset-4 hover:underline"
      >
        Talk to us about a plan →
      </a>
    </div>
  );
}
