"use client";

import { useState } from "react";
import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import { Textarea } from "@/components/ui/textarea";
import { TurnstileWidget } from "@/components/common/turnstile-widget";
import {
  BETA_CHALLENGE_QUESTION,
  BETA_CLIENTS_MANAGED_OPTIONS,
  BetaUserType,
  BetaUserTypeLabel,
  type BetaUserType as BetaUserTypeT,
} from "@/lib/constants/beta";
import { api, ApiClientError } from "@/lib/api-client";

/**
 * Join the Beta application. Posts to /api/beta/apply, which stores a PENDING
 * application reviewed inside the admin console. No account is created here —
 * approved applicants are emailed a single-use invitation to activate.
 */

interface WaitlistFormProps {
  turnstileSiteKey: string | null;
}

const selectCls =
  "flex h-10 w-full rounded-lg border border-border bg-background px-3 text-[14px] text-foreground outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/10";

export function WaitlistForm({ turnstileSiteKey }: WaitlistFormProps) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [userType, setUserType] = useState<BetaUserTypeT>(
    BetaUserType.FREELANCER,
  );
  const [businessName, setBusinessName] = useState("");
  const [clientsManaged, setClientsManaged] = useState("");
  const [challengeAnswer, setChallengeAnswer] = useState("");
  const [cfToken, setCfToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const requiresToken = Boolean(turnstileSiteKey);
  const captchaReady = !requiresToken || Boolean(cfToken);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (requiresToken && !cfToken) {
      setError("Please complete the verification challenge first.");
      return;
    }
    if (!fullName.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/beta/apply", {
        fullName: fullName.trim(),
        email: email.trim(),
        userType,
        businessName: businessName.trim() || undefined,
        clientsManaged: clientsManaged || undefined,
        challengeAnswer: challengeAnswer.trim() || undefined,
        cfToken: cfToken ?? undefined,
      });
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Couldn't submit, please retry.",
      );
      setCfToken(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div
        /* Masked because this branch echoes the SUBMITTED EMAIL back into a
           plain text node (below). Clarity's "input values are always masked"
           rule does not reach a <span>, and this is an early return, so the
           mask on the <form> further down never applies here. Without this
           attribute the address uploads verbatim under Clarity's Relaxed mode
           and relies on an undocumented heuristic under Balanced. */
        data-clarity-mask="true"
        className="rounded-2xl border border-border bg-white p-8 text-center shadow-sm"
      >
        <span
          className="mx-auto inline-flex size-12 items-center justify-center rounded-full"
          style={{
            background: "color-mix(in oklch, var(--brand-emerald) 14%, white)",
            color: "var(--brand-emerald-strong)",
          }}
        >
          <CheckCircle2Icon className="size-6" />
        </span>
        <h2 className="mt-5 font-display text-[20px] font-semibold tracking-tight">
          Application received.
        </h2>
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
          We review every application. If you&apos;re approved, we&apos;ll email{" "}
          <span className="font-medium text-foreground">{email}</span> a private
          invitation to activate your account. You can close this tab.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      /* /waitlist is the one Clarity-tracked route that collects personal
         data (name, work email, business, free-text answer). The shared
         Input/Textarea primitives already carry `data-clarity-mask`; masking
         the region as a unit additionally covers the two raw <select>s and
         any field added here later.
         NOTE: this does NOT cover the submitted email — that is echoed by the
         `done` branch above, which returns before this element exists and
         carries its own mask. */
      data-clarity-mask="true"
      className="space-y-5 rounded-2xl border border-border bg-white p-7 shadow-sm"
    >
      <div className="space-y-1.5">
        <Label htmlFor="wl-name" className="text-[12px]">
          Full name
        </Label>
        <Input
          id="wl-name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          maxLength={160}
          required
          disabled={submitting}
          placeholder="Ada Lovelace"
          autoComplete="name"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wl-email" className="text-[12px]">
          Work email
        </Label>
        <Input
          id="wl-email"
          type="email"
          inputMode="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={254}
          required
          disabled={submitting}
          placeholder="you@company.com"
          autoComplete="email"
        />
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="wl-type" className="text-[12px]">
            I&apos;m a…
          </Label>
          <select
            id="wl-type"
            value={userType}
            onChange={(e) => setUserType(e.target.value as BetaUserTypeT)}
            disabled={submitting}
            className={selectCls}
          >
            {Object.values(BetaUserType).map((t) => (
              <option key={t} value={t}>
                {BetaUserTypeLabel[t]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="wl-clients" className="text-[12px]">
            Clients managed
          </Label>
          <select
            id="wl-clients"
            value={clientsManaged}
            onChange={(e) => setClientsManaged(e.target.value)}
            disabled={submitting}
            className={selectCls}
          >
            <option value="">Select…</option>
            {BETA_CLIENTS_MANAGED_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wl-business" className="text-[12px]">
          Business / agency name{" "}
          <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="wl-business"
          value={businessName}
          onChange={(e) => setBusinessName(e.target.value)}
          maxLength={200}
          disabled={submitting}
          placeholder="Bloom Studio"
          autoComplete="organization"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wl-challenge" className="text-[12px]">
          {BETA_CHALLENGE_QUESTION}{" "}
          <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="wl-challenge"
          value={challengeAnswer}
          onChange={(e) => setChallengeAnswer(e.target.value)}
          maxLength={4000}
          rows={3}
          disabled={submitting}
          placeholder="Losing track of what was agreed, chasing approvals across email and Slack, etc."
        />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {requiresToken ? (
        <TurnstileWidget
          siteKey={turnstileSiteKey}
          onVerify={(t) => setCfToken(t)}
          onExpire={() => setCfToken(null)}
          onError={() => setCfToken(null)}
          className="flex justify-center"
        />
      ) : null}

      <LoadingButton
        type="submit"
        className="w-full gap-1.5"
        loading={submitting}
        loadingText="Submitting"
        disabled={!captchaReady}
      >
        Apply for the beta
        <ArrowRightIcon className="size-3.5" />
      </LoadingButton>

      <p className="text-center text-[11px] text-muted-foreground">
        Free during the private beta · No credit card · We only email about your
        application.
      </p>
    </form>
  );
}
