"use client";

import { useState } from "react";
import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import { Textarea } from "@/components/ui/textarea";
import { TurnstileWidget } from "@/components/common/turnstile-widget";
import { api, ApiClientError } from "@/lib/api-client";

/**
 * Waitlist form — minimal (name, email, what-you-build), posts to the
 * existing /api/quotations endpoint tagged source:"waitlist".
 *
 * The full quotation schema requires fields the waitlist UX
 * doesn't surface (companyName, country, expectedVolume). We
 * pad those with "—" placeholders client-side so the submit
 * validates without forcing a fictional company name out of
 * someone whose product is one engineer + an idea. Sales sees
 * the `source: "waitlist"` tag and treats the lead accordingly.
 */

interface WaitlistFormProps {
  turnstileSiteKey: string | null;
}

export function WaitlistForm({ turnstileSiteKey }: WaitlistFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [building, setBuilding] = useState("");
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
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required.");
      return;
    }
    setSubmitting(true);
    try {
      await api.post("/api/quotations", {
        fullName: name.trim(),
        workEmail: email.trim(),
        // Padding so the heavier landing-page schema validates. Sales
        // sees `source: "waitlist"` + ignores the placeholder fields.
        companyName: name.trim(), // best heuristic — use the name
        country: "—",
        expectedVolume: "—",
        useCase:
          building.trim() ||
          "Joined the waitlist without specifying what they build.",
        source: "waitlist",
        cfToken: cfToken ?? undefined,
      });
      setDone(true);
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? err.message
          : "Couldn't submit — please retry.";
      setError(msg);
      setCfToken(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-border bg-white p-8 text-center shadow-sm">
        <span
          className="mx-auto inline-flex size-12 items-center justify-center rounded-full"
          style={{
            background:
              "color-mix(in oklch, var(--brand-emerald) 14%, white)",
            color: "var(--brand-emerald-strong)",
          }}
        >
          <CheckCircle2Icon className="size-6" />
        </span>
        <h2 className="mt-5 font-display text-[20px] font-semibold tracking-tight">
          You&apos;re on the list.
        </h2>
        <p className="mt-3 text-[13.5px] leading-relaxed text-muted-foreground">
          We&apos;ll email{" "}
          <span className="font-medium text-foreground">{email}</span>{" "}
          when your batch opens. Usually within two weeks. You can close
          this tab.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className="space-y-5 rounded-2xl border border-border bg-white p-7 shadow-sm"
    >
      <div className="space-y-1.5">
        <Label htmlFor="wl-name" className="text-[12px]">
          Your name
        </Label>
        <Input
          id="wl-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
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

      <div className="space-y-1.5">
        <Label htmlFor="wl-building" className="text-[12px]">
          What are you building? <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="wl-building"
          value={building}
          onChange={(e) => setBuilding(e.target.value)}
          maxLength={2000}
          rows={3}
          disabled={submitting}
          placeholder="Rental SaaS for film cameras, SaaS for hotels, etc."
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
        Request invite
        <ArrowRightIcon className="size-3.5" />
      </LoadingButton>

      <p className="text-center text-[11px] text-muted-foreground">
        We&apos;ll only email about your waitlist invite. No marketing.
      </p>
    </form>
  );
}
