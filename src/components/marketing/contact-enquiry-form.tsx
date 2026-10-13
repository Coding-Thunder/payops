"use client";

import { useState } from "react";
import { CheckCircle2Icon } from "lucide-react";

import { TurnstileWidget } from "@/components/common/turnstile-widget";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingButton } from "@/components/ui/loading-button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiClientError } from "@/lib/api-client";
import {
  DATA_LAYER_EVENTS,
  pushDataLayerEvent,
} from "@/lib/analytics/data-layer";
import { GENERAL_ENQUIRY_SOURCE } from "@/lib/validation/quotation";

/**
 * General-enquiry form on /contact.
 *
 * Posts to the existing `/api/quotations` endpoint — no new API, no new
 * collection. The route already carries the protections this needs: server
 * -side zod validation, Turnstile before any write, a 5-per-5-minutes rate
 * limit and a 16 KB body cap. The record is then reviewable at
 * /admin/quotations.
 *
 * ── Four fields, and why not more ───────────────────────────────────────
 *
 * `quotationSchema` grew up serving a payment-gateway product and still
 * requires `country` and `expectedVolume` for its legacy sources. Someone
 * asking "does this fit how I work?" has neither. The schema makes both
 * conditional on `source`, and this form sends
 * `source: "contact_sales"`, so it asks for exactly what a human needs to
 * reply: who you are, how to reach you, who you work for, and what you want.
 *
 * ── On the success state ────────────────────────────────────────────────
 *
 * It says the enquiry is recorded, which is true the moment the row is
 * written — persistence is the source of truth. It does NOT promise an
 * email reached us: the internal notification is best-effort and its outcome
 * is recorded on the record for an admin to see, not guessed at here.
 *
 * The whole form carries `data-clarity-mask`. The shared `Input`/`Textarea`
 * primitives already mask, but masking the region covers anything added
 * later, and /contact is a Clarity-tracked route.
 */

/**
 * Pull the first field-level reason out of a validation error.
 *
 * The API envelope's `message` for a zod failure is "Invalid request data",
 * which is useless to the person who typed the field. The actionable text —
 * why a disposable domain was refused, which field was too short — is in
 * `details.issues`. Parsed defensively: this is an untyped server payload
 * and a malformed one must not throw inside an error handler.
 */
function fieldMessage(err: ApiClientError): string | null {
  const details = err.details as
    | { issues?: { message?: unknown }[] }
    | undefined;
  const first = details?.issues?.[0]?.message;
  return typeof first === "string" && first.trim() ? first : null;
}

interface ContactEnquiryFormProps {
  turnstileSiteKey: string | null;
}

export function ContactEnquiryForm({
  turnstileSiteKey,
}: ContactEnquiryFormProps) {
  const [fullName, setFullName] = useState("");
  const [workEmail, setWorkEmail] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [message, setMessage] = useState("");
  const [cfToken, setCfToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const requiresToken = Boolean(turnstileSiteKey);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (message.trim().length < 10) {
      setError("Please tell us a little more about what you need.");
      return;
    }
    if (requiresToken && !cfToken) {
      setError("Please complete the verification challenge first.");
      return;
    }

    setSubmitting(true);
    try {
      await api.post("/api/quotations", {
        fullName: fullName.trim(),
        workEmail: workEmail.trim(),
        companyName: companyName.trim(),
        // The schema's free-text field. Named `useCase` there for the legacy
        // sources; it is the enquiry message for this one.
        useCase: message.trim(),
        source: GENERAL_ENQUIRY_SOURCE,
        cfToken: cfToken ?? undefined,
      });
      // Only after the server accepted and stored it. No name, email, company
      // or message content — identifiers and PII do not go in the dataLayer.
      pushDataLayerEvent(DATA_LAYER_EVENTS.CONTACT_SUBMITTED);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? fieldMessage(err) ?? err.message
          : "Couldn't send that. Please email hello@tracetxn.com instead.",
      );
      setCfToken(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div
        className="rounded-xl border border-border bg-white p-6 text-center"
        role="status"
      >
        <span
          className="mx-auto inline-flex size-11 items-center justify-center rounded-full"
          style={{
            background: "color-mix(in oklch, var(--brand-emerald) 14%, white)",
            color: "var(--brand-emerald-strong)",
          }}
        >
          <CheckCircle2Icon className="size-5" />
        </span>
        <h3 className="mt-4 font-display text-[17px] font-semibold tracking-tight">
          Your enquiry is recorded.
        </h3>
        <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground">
          A person on the team reads these. Replies usually land within one
          business day, Mon&ndash;Fri. If it&apos;s urgent, email{" "}
          <a
            href="mailto:hello@tracetxn.com?subject=TraceTxn%20enquiry"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            hello@tracetxn.com
          </a>{" "}
          directly.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      data-clarity-mask="true"
      aria-labelledby="enquiry-form-heading"
      className="space-y-4 rounded-xl border border-border bg-white p-6"
    >
      <p
        id="enquiry-form-heading"
        className="font-display text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
      >
        Send an enquiry
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="enq-name" className="text-[12px]">
            Your name
          </Label>
          <Input
            id="enq-name"
            name="fullName"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={120}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="enq-company" className="text-[12px]">
            Company
          </Label>
          <Input
            id="enq-company"
            name="companyName"
            autoComplete="organization"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            maxLength={160}
            required
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="enq-email" className="text-[12px]">
          Business email
        </Label>
        <Input
          id="enq-email"
          name="workEmail"
          type="email"
          autoComplete="email"
          value={workEmail}
          onChange={(e) => setWorkEmail(e.target.value)}
          maxLength={254}
          aria-describedby="enq-email-help"
          required
        />
        {/* Say what happens to it, where it is asked for. */}
        <p id="enq-email-help" className="text-[11.5px] text-muted-foreground">
          Used only to reply to you. Not published, never added to a mailing
          list.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="enq-message" className="text-[12px]">
          What do you need?
        </Label>
        <Textarea
          id="enq-message"
          name="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="What your business does, what you're trying to keep track of, and roughly how many clients."
          aria-describedby="enq-message-help"
          required
        />
        <p
          id="enq-message-help"
          className="text-[11.5px] text-muted-foreground"
        >
          {message.trim().length < 10
            ? "A sentence or two is plenty."
            : `${message.length} / 2000`}
        </p>
      </div>

      <TurnstileWidget
        siteKey={turnstileSiteKey}
        onVerify={(t) => setCfToken(t)}
        onExpire={() => setCfToken(null)}
        onError={() => setCfToken(null)}
      />

      {/* Announced, not just coloured — a screen reader has to hear it. */}
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive"
        >
          {error}
        </p>
      ) : null}

      <LoadingButton type="submit" loading={submitting} className="w-full">
        Send enquiry
      </LoadingButton>

      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        TraceTxn is in private beta and currently invite-only — this is an
        enquiry, not a sign-up.
      </p>
    </form>
  );
}
